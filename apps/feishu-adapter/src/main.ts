import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as lark from "@larksuiteoapi/node-sdk";
import { UmaClient } from "@uma-agent/client";
import type { SessionSnapshot } from "@uma-agent/protocol";
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
  port: Number(process.env.FEISHU_PORT ?? 3220),
};
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
  throw new Error("FEISHU_PORT must be a valid TCP port");

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

function cardText(snapshot: SessionSnapshot): string {
  const run = snapshot.runs.at(-1);
  const reply = snapshot.transcript.filter((item) => item.role === "assistant").at(-1)?.content ?? "";
  const status = run ? `\n\n状态: ${run.status}` : "";
  const plan = run?.plan.filter((step) => step.status === "running").at(0);
  return `${reply || "处理中..."}${status}${plan ? `\n步骤: ${plan.title}` : ""}`.slice(0, 28_000);
}

async function sendCard(
  chatId: string,
  conversationId: string,
  runId: string,
  text: string,
  final = false,
): Promise<void> {
  const key = `${conversationId}:${runId}`;
  const previous = cards.get(key);
  if (!final && previous && Date.now() - previous.lastUpdate < 1_000) return;
  if (previous?.text === text) return;
  const content = JSON.stringify({
    config: { wide_screen_mode: true },
    elements: [{ tag: "div", text: { tag: "lark_md", content: text } }],
  });
  let messageId = previous?.messageId;
  if (!previous) {
    const result = await feishu.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, content, msg_type: "interactive" },
    });
    messageId = String((result as { data?: { message_id?: string } }).data?.message_id ?? "");
    store.upsertCard(conversationId, runId, 0, final ? "completed" : "running", messageId);
  } else {
    await (feishu.im.message as unknown as { patch: (input: unknown) => Promise<unknown> }).patch({
      path: { message_id: messageId },
      data: { content },
    });
  }
  cards.set(key, { text, lastUpdate: Date.now(), ...(messageId ? { messageId } : {}) });
}

function subscribeSession(sessionId: string, chatId: string, conversationId: string): void {
  if (subscribed.has(sessionId)) return;
  subscribed.add(sessionId);
  uma.subscribe(sessionId, (event) => {
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
      void uma
        .getSession(sessionId)
        .then((snapshot) => {
          const run = snapshot.runs.at(-1);
          if (run)
            void sendCard(
              chatId,
              conversationId,
              run.id,
              cardText(snapshot),
              ["completed", "failed", "cancelled", "interrupted"].includes(run.status),
            );
        })
        .catch(() => {});
  });
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
  if (message.message_type !== "text" && message.message_type !== "post") return;
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
  let text = message.content;
  try {
    const parsed = JSON.parse(text) as { text?: string };
    text = parsed.text ?? text;
  } catch {
    /* Feishu may send plain text in test payloads. */
  }
  text = text.replace(/<at[^>]*>.*?<\/at>/gi, "").trim();
  try {
    subscribeSession(conversation.sessionId, message.chat_id, conversation.id);
    await uma.sendMessage(conversation.sessionId, text, {
      messageId: claimed.messageId,
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
    const approvalId = value.approvalId;
    const approved = value.approved === "true";
    if (approvalId) {
      const callbackHash = createHash("sha256").update(token).digest("hex");
      const callback = store.resolveApprovalCallback(callbackHash);
      if (!callback || callback.approvalId !== approvalId)
        return { toast: { type: "error", content: "操作已失效" } };
      await uma.resolveApproval(callback.approvalId, approved);
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
server.listen(config.port, "127.0.0.1");
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
