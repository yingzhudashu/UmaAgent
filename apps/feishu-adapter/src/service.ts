import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as lark from "@larksuiteoapi/node-sdk";
import { loadUserConfig, retryWithBackoff } from "@uma-agent/channel-adapter";
import { UmaClient } from "@uma-agent/client";
import type { Approval, RunAction, RunActionDecision, SessionSnapshot } from "@uma-agent/protocol";
import { createFeishuAdapter } from "./adapter.js";
import { type CoreGateway, LarkFeishuGateway } from "./gateways.js";
import { acceptsInbound, isAllowedOpenId } from "./inbound-policy.js";
import { AdapterStore } from "./store.js";

export async function startFeishuService(
  configPath = process.argv.find((arg) => arg.startsWith("--config="))?.slice(9) ?? "config.user.json",
) {
  const user = await loadUserConfig(configPath, "feishu");
  const config = {
    appId: user.feishu.appId,
    appSecret: user.feishu.appSecret,
    verificationToken: user.feishu.verificationToken,
    encryptKey: user.feishu.encryptKey,
    umaUrl: user.core.serverUrl,
    umaToken: user.core.token,
    stateDir: user.feishu.stateDir,
    host: user.feishu.host,
    port: user.feishu.port,
    maxAttachmentBytes: user.feishu.maxAttachmentBytes,
    allowedOpenIds: new Set(user.feishu.allowedOpenIds),
  };
  const cardCallbacksEnabled = Boolean(config.verificationToken && config.encryptKey);
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new Error("user config.feishu.port must be a valid TCP port");
  if (!Number.isSafeInteger(config.maxAttachmentBytes) || config.maxAttachmentBytes < 1)
    throw new Error("user config.feishu.maxAttachmentBytes must be a positive integer");
  if (config.allowedOpenIds.size === 0)
    throw new Error("user config.feishu.allowedOpenIds must contain at least one Open ID");

  const storeInstance = new AdapterStore(config.stateDir);
  const coreGateway: CoreGateway = new UmaClient({ baseUrl: config.umaUrl, token: config.umaToken });
  const feishuSdk = new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: lark.Domain.Feishu,
  });
  const feishuGateway = new LarkFeishuGateway(feishuSdk);
  let eventDispatcher: lark.EventDispatcher;
  let longConnection: lark.WSClient | undefined;
  let longConnected = false;
  let stopping = false;
  let serviceStarted = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reportFailure: (error: unknown) => void = () => {};
  let startLongConnection: () => Promise<void>;
  const scheduleReconnect = (error?: unknown): void => {
    if (error) reportFailure(error);
    longConnected = false;
    if (stopping || !serviceStarted || reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt++);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void startLongConnection().catch(() => {});
    }, delay);
  };
  startLongConnection = async () => {
    if (stopping) return;
    const connection = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: lark.Domain.Feishu,
      // Keep reconnection ownership here. The SDK's close/error interaction
      // can recurse when its internal reconnect loop races shutdown.
      autoReconnect: false,
      onReady: () => {
        if (longConnection !== connection || stopping) return;
        longConnected = true;
        reconnectAttempt = 0;
      },
      onError: (error) => {
        if (longConnection === connection) {
          longConnection = undefined;
          scheduleReconnect(error);
        }
      },
    });
    longConnection = connection;
    try {
      await connection.start({ eventDispatcher });
    } catch (error) {
      if (longConnection === connection) longConnection = undefined;
      scheduleReconnect(error);
      throw error;
    }
  };
  const stopLongConnection = (): void => {
    stopping = true;
    serviceStarted = false;
    longConnected = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    const connection = longConnection;
    longConnection = undefined;
    connection?.close({ force: true });
  };
  const adapter = createFeishuAdapter({
    core: coreGateway,
    feishu: feishuGateway,
    store: storeInstance,
    connection: {
      start: async () => {
        stopping = false;
        await startLongConnection();
      },
      stop: stopLongConnection,
      connected: () => longConnected,
    },
    onStart: () => {
      coreGateway.connectEvents();
      for (const pending of storeInstance.listPendingInbound<FeishuInbound>()) scheduleInbound(pending);
      for (const conversation of storeInstance.listConversations())
        subscribeSession(
          conversation.sessionId,
          conversation.chatId,
          conversation.id,
          storeInstance.latestConversationSequence(conversation.id),
        );
    },
    onStop: () => {
      for (const timer of cardTimers.values()) clock.clearTimeout(timer);
      coreGateway.close();
      storeInstance.close();
    },
  });
  reportFailure = (error) => adapter.failed(error);
  const { core: uma, feishu, store, clock } = adapter;
  const cards = new Map<string, { text: string; lastUpdate: number; messageId?: string }>();
  const pendingCards = new Map<string, Parameters<typeof sendCardNow>>();
  const cardTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const subscribed = new Set<string>();

  interface FeishuInbound {
    tenant_key?: string;
    sender?: { sender_id?: { open_id?: string; user_id?: string } };
    message: {
      message_id: string;
      chat_id: string;
      chat_type: string;
      message_type: string;
      content: string;
      root_id?: string;
      parent_id?: string;
      mentions?: Array<{ id: { open_id?: string; user_id?: string }; key: string }>;
    };
  }

  type CardControl =
    | { label: string; kind: "approval"; targetId: string; decision: "approve" | "reject" }
    | { label: string; kind: "resume"; targetId: string; runId: string }
    | {
        label: string;
        kind: "run_action";
        targetId: string;
        runId: string;
        decision: RunActionDecision["decision"];
      };

  function cardText(snapshot: SessionSnapshot, actions: RunAction[] = []): string {
    const run = snapshot.recentRuns.at(-1);
    const reply = snapshot.transcript.filter((item) => item.role === "assistant").at(-1)?.content ?? "";
    const status = run ? `\n\n状态: ${run.status}` : "";
    const plan = run?.plan.filter((step) => step.status === "running").at(0);
    const pending = actions
      .filter((action) => ["prepared", "uncertain"].includes(action.status))
      .map((action) => `- ${action.toolName}: ${action.status}`)
      .join("\n");
    return `${reply || "处理中..."}${status}${plan ? `\n步骤: ${plan.title}` : ""}${pending ? `\n\n待确认动作:\n${pending}` : ""}`.slice(
      0,
      28_000,
    );
  }

  function inboundText(messageType: string, content: string): string {
    if (messageType === "image" || messageType === "file") return "";
    try {
      const parsed = JSON.parse(content) as unknown;
      if (parsed && typeof parsed === "object" && "text" in parsed) {
        const value = (parsed as { text?: unknown }).text;
        if (typeof value === "string") return value;
      }
      const values: string[] = [];
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) for (const item of value) visit(item);
        else if (value && typeof value === "object") {
          const object = value as Record<string, unknown>;
          if (typeof object.text === "string") values.push(object.text);
          else for (const item of Object.values(object)) visit(item);
        }
      };
      visit(parsed);
      return values.join("\n");
    } catch {
      return content;
    }
  }

  async function sendCardNow(
    chatId: string,
    conversationId: string,
    runId: string,
    text: string,
    sequence: number,
    final = false,
    controls: CardControl[] = [],
  ): Promise<string | undefined> {
    const key = `${conversationId}:${runId}`;
    let previous = cards.get(key);
    if (!previous) {
      const persisted = store.getCard(conversationId, runId);
      if (persisted?.messageId) {
        previous = { text: "", lastUpdate: 0, messageId: persisted.messageId };
        cards.set(key, previous);
      }
    }
    if (controls.length === 0 && previous?.text === text) return previous.messageId;
    const elements: unknown[] = [{ tag: "div", text: { tag: "lark_md", content: text } }];
    const callbacks = controls.map((control) => ({
      control,
      token: randomBytes(24).toString("base64url"),
    }));
    if (callbacks.length)
      elements.push({
        tag: "action",
        actions: callbacks.map(({ control, token }, index) => ({
          tag: "button",
          ...(index === callbacks.length - 1 ? { type: "primary" } : {}),
          text: { tag: "plain_text", content: control.label },
          value: { token },
        })),
      });
    const content = JSON.stringify({
      config: { wide_screen_mode: true },
      elements,
    });
    let messageId = previous?.messageId;
    try {
      if (!messageId) {
        messageId = await retryWithBackoff(() => feishu.createCard(chatId, content));
      } else {
        await retryWithBackoff(() => feishu.updateCard(messageId as string, content));
      }
      store.upsertCard(conversationId, runId, sequence, final ? "completed" : "running", messageId);
    } catch (error) {
      store.markCardFailed(conversationId, runId, error instanceof Error ? error.message : String(error));
      throw error;
    }
    cards.set(key, { text, lastUpdate: clock.now(), ...(messageId ? { messageId } : {}) });
    if (messageId)
      for (const { control, token } of callbacks)
        store.putActionCallback({
          id: randomUUID(),
          kind: control.kind,
          targetId: control.targetId,
          ...(control.kind !== "approval" ? { runId: control.runId } : {}),
          ...(control.kind === "approval" || control.kind === "run_action"
            ? { decision: control.decision }
            : {}),
          feishuMessageId: messageId,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          expiresAt: clock.now() + 10 * 60_000,
        });
    return messageId;
  }

  async function sendCard(
    chatId: string,
    conversationId: string,
    runId: string,
    text: string,
    sequence: number,
    final = false,
    controls: CardControl[] = [],
  ): Promise<string | undefined> {
    const key = `${conversationId}:${runId}`;
    const previous = cards.get(key);
    const args: Parameters<typeof sendCardNow> = [
      chatId,
      conversationId,
      runId,
      text,
      sequence,
      final,
      controls,
    ];
    if (!final && controls.length === 0 && previous && clock.now() - previous.lastUpdate < 1_000) {
      pendingCards.set(key, args);
      if (!cardTimers.has(key)) {
        const remaining = Math.max(1, 1_000 - (clock.now() - previous.lastUpdate));
        cardTimers.set(
          key,
          clock.setTimeout(() => {
            cardTimers.delete(key);
            const pending = pendingCards.get(key);
            pendingCards.delete(key);
            if (pending) void sendCardNow(...pending).catch(() => {});
          }, remaining),
        );
      }
      return previous.messageId;
    }
    const timer = cardTimers.get(key);
    if (timer) clock.clearTimeout(timer);
    cardTimers.delete(key);
    pendingCards.delete(key);
    return sendCardNow(...args);
  }

  async function renderSession(
    sessionId: string,
    chatId: string,
    conversationId: string,
    approval?: Approval,
  ): Promise<void> {
    const snapshot = await uma.getSession(sessionId);
    const run = snapshot.recentRuns.at(-1);
    if (!run) return;
    const actions = run.status === "interrupted" ? await uma.listRunActions(run.id) : [];
    const pending = actions.find((action) => ["prepared", "uncertain"].includes(action.status));
    const controls: CardControl[] = !cardCallbacksEnabled
      ? []
      : approval
        ? [
            { label: "拒绝", kind: "approval", targetId: approval.id, decision: "reject" },
            { label: "允许", kind: "approval", targetId: approval.id, decision: "approve" },
          ]
        : pending
          ? [
              {
                label: "拒绝并结束",
                kind: "run_action",
                targetId: pending.id,
                runId: run.id,
                decision: "reject",
              },
              {
                label: pending.status === "prepared" ? "确认执行一次" : "确认可能已执行",
                kind: "run_action",
                targetId: pending.id,
                runId: run.id,
                decision: pending.status === "prepared" ? "approve" : "acknowledge",
              },
            ]
          : run.status === "interrupted" && run.resume?.state === "available"
            ? [{ label: "继续运行", kind: "resume", targetId: run.id, runId: run.id }]
            : [];
    const callbackHint =
      !cardCallbacksEnabled && (approval || pending || run.status === "interrupted")
        ? "\n\n交互回调未启用，请在 Web 或 CLI 中完成审批/恢复。"
        : "";
    await sendCard(
      chatId,
      conversationId,
      run.id,
      `${cardText(snapshot, actions)}${callbackHint}`,
      snapshot.snapshotSequence,
      ["completed", "failed", "cancelled"].includes(run.status),
      controls,
    );
  }

  function subscribeSession(
    sessionId: string,
    chatId: string,
    conversationId: string,
    lastSequence = 0,
  ): void {
    if (subscribed.has(sessionId)) return;
    subscribed.add(sessionId);
    uma.subscribeSessions([{ id: sessionId, lastSequence }], (event) => {
      if (event.type === "approval.requested") {
        const approval = event.payload as Approval;
        void renderSession(sessionId, chatId, conversationId, approval).catch(() => {});
        return;
      }
      if (
        [
          "message.delta",
          "message.completed",
          "run.updated",
          "plan.updated",
          "approval.requested",
          "run.resumed",
        ].includes(event.type)
      )
        void renderSession(sessionId, chatId, conversationId).catch(() => {});
    });
  }

  async function downloadAttachment(
    messageId: string,
    messageType: "image" | "file",
    content: string,
    sessionId: string,
  ): Promise<string> {
    const parsed = JSON.parse(content) as { image_key?: string; file_key?: string; file_name?: string };
    const key = messageType === "image" ? parsed.image_key : parsed.file_key;
    if (!key) throw new Error(`Feishu ${messageType} message has no resource key`);
    const resource = await retryWithBackoff(() => feishu.downloadResource(messageId, key, messageType));
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of resource.getReadableStream()) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      size += chunk.byteLength;
      if (size > config.maxAttachmentBytes) throw new Error("Feishu attachment exceeds configured limit");
      chunks.push(chunk);
    }
    const bytes = Uint8Array.from(Buffer.concat(chunks));
    const name = parsed.file_name?.trim() || `feishu-${messageId}.${messageType === "image" ? "jpg" : "bin"}`;
    const attachment = await uma.upload(
      new Blob([bytes], { type: messageType === "image" ? "image/jpeg" : "application/octet-stream" }),
      name,
      sessionId,
    );
    return attachment.id;
  }

  async function processStoredMessage(data: FeishuInbound, umaMessageId: string): Promise<void> {
    const message = data.message;
    const key = {
      tenant: data.tenant_key ?? "",
      chatType: message.chat_type,
      chatId: message.chat_id,
      threadRoot: message.root_id ?? "",
    };
    let conversation = store.getConversation(key);
    if (!conversation) {
      const session = await uma.createSession({ title: `Feishu ${message.chat_id}` });
      conversation = store.createConversation(key, session.id);
    }
    store.attachInboundConversation(message.message_id, conversation.id);
    const senderId = data.sender?.sender_id?.open_id;
    let text = inboundText(message.message_type, message.content);
    text = text.replace(/<at[^>]*>.*?<\/at>/gi, "").trim();
    try {
      subscribeSession(conversation.sessionId, message.chat_id, conversation.id);
      if (text.startsWith("/")) {
        const shortcut = await uma.executeShortcut(conversation.sessionId, text);
        await retryWithBackoff(() =>
          feishu.createCard(
            message.chat_id,
            JSON.stringify({
              config: { wide_screen_mode: true },
              elements: [{ tag: "div", text: { tag: "lark_md", content: shortcut.output.slice(0, 28_000) } }],
            }),
          ),
        );
        store.markInbound(umaMessageId, "processed");
        return;
      }
      const attachmentIds =
        message.message_type === "image" || message.message_type === "file"
          ? [
              await downloadAttachment(
                message.message_id,
                message.message_type,
                message.content,
                conversation.sessionId,
              ),
            ]
          : [];
      if (!text && attachmentIds.length)
        text = `请处理这个飞书${message.message_type === "image" ? "图片" : "文件"}附件。`;
      await uma.sendMessage(conversation.sessionId, text, {
        messageId: umaMessageId,
        mode: "agent",
        ...(attachmentIds.length ? { attachmentIds } : {}),
        source: {
          adapter: "feishu",
          conversationId: `${message.chat_type}:${message.chat_id}:${message.root_id ?? ""}`,
          externalMessageId: message.message_id,
          ...(senderId ? { senderId } : {}),
        },
      });
      store.markInbound(umaMessageId, "processed");
    } catch (error) {
      store.markInbound(umaMessageId, "failed", error instanceof Error ? error.message : String(error));
    }
  }

  let inboundQueue = Promise.resolve();

  function scheduleInbound(input: { externalId: string; messageId: string; payload: FeishuInbound }): void {
    inboundQueue = inboundQueue
      .then(async () => {
        if (!store.startInbound(input.externalId)) return;
        try {
          await processStoredMessage(input.payload, input.messageId);
        } catch (error) {
          store.markInbound(
            input.messageId,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .catch(() => {});
  }

  async function enqueueMessage(data: FeishuInbound): Promise<void> {
    const message = data.message;
    if (!acceptsInbound(data, config.allowedOpenIds, (id) => store.isOutboundMessage(id))) return;
    adapter.inbound();
    const senderId = data.sender?.sender_id?.open_id;
    const claimed = store.claimInbound({
      externalId: message.message_id,
      senderId: senderId as string,
      rawType: message.message_type,
      payload: data,
    });
    if (claimed.fresh)
      scheduleInbound({
        externalId: message.message_id,
        messageId: claimed.messageId,
        payload: data,
      });
  }

  eventDispatcher = new lark.EventDispatcher({
    ...(config.verificationToken ? { verificationToken: config.verificationToken } : {}),
    ...(config.encryptKey ? { encryptKey: config.encryptKey } : {}),
  }).register({ "im.message.receive_v1": enqueueMessage });

  const cardDispatcher = new lark.CardActionHandler(
    {
      ...(config.verificationToken ? { verificationToken: config.verificationToken } : {}),
      ...(config.encryptKey ? { encryptKey: config.encryptKey } : {}),
    },
    async (event: { operator?: { open_id?: string }; action?: { value?: Record<string, string> } }) => {
      if (!isAllowedOpenId(event.operator?.open_id, config.allowedOpenIds))
        return { toast: { type: "error", content: "无权执行此操作" } };
      const value = event.action?.value ?? {};
      const token = value.token;
      if (!token) return { toast: { type: "error", content: "操作已失效" } };
      const callbackHash = createHash("sha256").update(token).digest("hex");
      const callback = store.claimActionCallback(callbackHash);
      if (!callback) return { toast: { type: "error", content: "操作已失效" } };
      if (callback.used) return { toast: { type: "success", content: "已处理" } };
      try {
        if (callback.kind === "approval")
          await uma.resolveApproval(callback.targetId, callback.decision === "approve");
        else if (callback.kind === "resume") await uma.resumeRun(callback.targetId);
        else if (callback.runId)
          await uma.decideRunAction(
            callback.runId,
            callback.targetId,
            callback.decision as RunActionDecision["decision"],
          );
      } catch (error) {
        store.releaseActionCallback(callbackHash);
        throw error;
      }
      return { toast: { type: "success", content: "已处理" } };
    },
  );

  const cardHandler = lark.adaptDefault("/webhook/card", cardDispatcher);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...adapter.health(), service: "feishu-adapter" }));
      return;
    }
    if (req.url === "/webhook/card" && req.method === "POST") {
      if (!cardCallbacksEnabled) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "card callbacks are disabled" }));
        return;
      }
      return void cardHandler(req, res);
    }
    res.writeHead(404).end();
  });

  await adapter.start();
  serviceStarted = true;
  server.listen(config.port, config.host);
  const stop = async () => {
    await adapter.stop();
    server.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  return { adapter, server, stop };
}
