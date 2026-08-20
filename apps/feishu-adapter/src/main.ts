import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as lark from "@larksuiteoapi/node-sdk";
import { retryWithBackoff } from "@uma-agent/channel-adapter";
import { UmaClient } from "@uma-agent/client";
import type { Approval, RunAction, RunActionDecision, SessionSnapshot } from "@uma-agent/protocol";
import { AdapterStore } from "./store.js";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const config = {
  appId: required("FEISHU_APP_ID"),
  appSecret: required("FEISHU_APP_SECRET"),
  verificationToken: required("FEISHU_VERIFICATION_TOKEN"),
  encryptKey: required("FEISHU_ENCRYPT_KEY"),
  umaUrl: required("UMA_SERVER_URL"),
  umaToken: required("UMA_TOKEN"),
  stateDir: process.env.FEISHU_STATE_DIR?.trim() || ".uma-feishu",
  host: process.env.FEISHU_HOST?.trim() || "127.0.0.1",
  port: Number(process.env.FEISHU_PORT ?? 3220),
  maxAttachmentBytes: Number(process.env.FEISHU_MAX_ATTACHMENT_BYTES ?? 25 * 1024 * 1024),
};
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
  throw new Error("FEISHU_PORT must be a valid TCP port");
if (!Number.isSafeInteger(config.maxAttachmentBytes) || config.maxAttachmentBytes < 1)
  throw new Error("FEISHU_MAX_ATTACHMENT_BYTES must be a positive integer");

const store = new AdapterStore(config.stateDir);
const uma = new UmaClient({ baseUrl: config.umaUrl, token: config.umaToken });
const feishu = new lark.Client({
  appId: config.appId,
  appSecret: config.appSecret,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
});
const cards = new Map<string, { text: string; lastUpdate: number; messageId?: string }>();
const subscribed = new Set<string>();

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
  const run = snapshot.runs.at(-1);
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
  let previous = cards.get(key);
  if (!previous) {
    const persisted = store.getCard(conversationId, runId);
    if (persisted?.messageId) {
      previous = { text: "", lastUpdate: 0, messageId: persisted.messageId };
      cards.set(key, previous);
    }
  }
  if (!final && controls.length === 0 && previous && Date.now() - previous.lastUpdate < 1_000)
    return previous.messageId;
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
      const result = await retryWithBackoff(() =>
        feishu.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: { receive_id: chatId, content, msg_type: "interactive" },
        }),
      );
      messageId = String((result as { data?: { message_id?: string } }).data?.message_id ?? "");
    } else {
      await retryWithBackoff(() =>
        (feishu.im.message as unknown as { patch: (input: unknown) => Promise<unknown> }).patch({
          path: { message_id: messageId },
          data: { content },
        }),
      );
    }
    store.upsertCard(conversationId, runId, sequence, final ? "completed" : "running", messageId);
  } catch (error) {
    store.markCardFailed(conversationId, runId, error instanceof Error ? error.message : String(error));
    throw error;
  }
  cards.set(key, { text, lastUpdate: Date.now(), ...(messageId ? { messageId } : {}) });
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
        expiresAt: Date.now() + 10 * 60_000,
      });
  return messageId;
}

async function renderSession(
  sessionId: string,
  chatId: string,
  conversationId: string,
  approval?: Approval,
): Promise<void> {
  const snapshot = await uma.getSession(sessionId);
  const run = snapshot.runs.at(-1);
  if (!run) return;
  const actions = run.status === "interrupted" ? await uma.listRunActions(run.id) : [];
  const pending = actions.find((action) => ["prepared", "uncertain"].includes(action.status));
  const controls: CardControl[] = approval
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
  await sendCard(
    chatId,
    conversationId,
    run.id,
    cardText(snapshot, actions),
    snapshot.snapshotSequence,
    ["completed", "failed", "cancelled"].includes(run.status),
    controls,
  );
}

function subscribeSession(sessionId: string, chatId: string, conversationId: string, lastSequence = 0): void {
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
  const resource = await retryWithBackoff(() =>
    feishu.im.messageResource.get({
      params: { type: messageType },
      path: { message_id: messageId, file_key: key },
    }),
  );
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

async function processMessage(data: {
  tenant_key?: string;
  sender?: { sender_id?: { open_id?: string; user_id?: string } };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    root_id?: string;
    mentions?: Array<{ id: { open_id?: string; user_id?: string }; key: string }>;
  };
}): Promise<void> {
  const message = data.message;
  if (!["text", "post", "image", "file"].includes(message.message_type)) return;
  const isGroup = message.chat_type === "group";
  const mentioned = Boolean(message.mentions?.length);
  if (isGroup && !mentioned && !message.root_id) return;
  const key = {
    tenant: data.tenant_key ?? "",
    chatType: message.chat_type,
    chatId: message.chat_id,
    threadRoot: message.root_id ?? "",
  };
  let conversation = store.getConversation(key);
  if (!conversation) {
    const session = await uma.createSession({ mode: "assistant", title: `Feishu ${message.chat_id}` });
    conversation = store.createConversation(key, session.id);
  }
  const senderId = data.sender?.sender_id?.open_id ?? data.sender?.sender_id?.user_id;
  const claimed = store.claimInbound(message.message_id, conversation.id, senderId, message.message_type);
  if (!claimed.fresh) return;
  let text = inboundText(message.message_type, message.content);
  text = text.replace(/<at[^>]*>.*?<\/at>/gi, "").trim();
  try {
    subscribeSession(conversation.sessionId, message.chat_id, conversation.id);
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
      messageId: claimed.messageId,
      ...(attachmentIds.length ? { attachmentIds } : {}),
      source: {
        adapter: "feishu",
        conversationId: `${message.chat_type}:${message.chat_id}:${message.root_id ?? ""}`,
        externalMessageId: message.message_id,
        ...(senderId ? { senderId } : {}),
      },
    });
    store.markInbound(claimed.messageId, "processed");
  } catch (error) {
    store.markInbound(claimed.messageId, "failed", error instanceof Error ? error.message : String(error));
  }
}

const eventDispatcher = new lark.EventDispatcher({
  verificationToken: config.verificationToken,
  encryptKey: config.encryptKey,
}).register({ "im.message.receive_v1": processMessage });

const cardDispatcher = new lark.CardActionHandler(
  { verificationToken: config.verificationToken, encryptKey: config.encryptKey },
  async (event: { action?: { value?: Record<string, string> } }) => {
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

const eventHandler = lark.adaptDefault("/webhook/event", eventDispatcher);
const cardHandler = lark.adaptDefault("/webhook/card", cardDispatcher);

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "feishu-adapter" }));
    return;
  }
  if (req.url === "/webhook/event" && req.method === "POST") return void eventHandler(req, res);
  if (req.url === "/webhook/card" && req.method === "POST") return void cardHandler(req, res);
  res.writeHead(404).end();
});

uma.connectEvents();
for (const conversation of store.listConversations())
  subscribeSession(
    conversation.sessionId,
    conversation.chatId,
    conversation.id,
    store.latestConversationSequence(conversation.id),
  );
server.listen(config.port, config.host);
process.once("SIGINT", () => {
  store.close();
  uma.close();
  server.close();
});
process.once("SIGTERM", () => {
  store.close();
  uma.close();
  server.close();
});
