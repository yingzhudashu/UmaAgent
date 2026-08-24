import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { UmaClient } from "@uma-agent/client";
import type { ExternalConversation, SessionSnapshot } from "@uma-agent/protocol";
import { createXianyuAdapter, type XianyuTransport } from "./adapter.js";
import { XianyuClient } from "./client.js";
import { GoofishTransport } from "./transport.js";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

function allowedImageUrl(value: string): boolean {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    ["alicdn.com", "goofish.com", "mmcdn.cn", "taobao.com", "tbcdn.cn"].some(
      (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
    )
  );
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("请求体必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

interface XianyuState {
  sessions: Record<string, string>;
  conversations: Record<string, ExternalConversation>;
  seenIds: string[];
}

interface ConfiguredState {
  initial?: Partial<XianyuState>;
  onChange?: (state: XianyuState) => void;
}

export function createConfiguredXianyuAdapter(transport: XianyuTransport, state: ConfiguredState = {}) {
  const client = new UmaClient({
    baseUrl: process.env.UMA_SERVER_URL ?? "http://127.0.0.1:3210",
    ...(process.env.UMA_TOKEN ? { token: process.env.UMA_TOKEN } : {}),
  });
  const sessions = new Map<string, string>(Object.entries(state.initial?.sessions ?? {}));
  const conversations = new Map<string, ExternalConversation>(
    Object.entries(state.initial?.conversations ?? {}),
  );
  const lastRendered = new Map<string, string>();
  let subscribeSession: ((sessionId: string, conversation: ExternalConversation) => void) | undefined;
  const keyOf = (conversation: ExternalConversation) =>
    `${conversation.tenantId}:${conversation.conversationId}:${conversation.threadId ?? ""}`;
  const adapter = createXianyuAdapter({
    transport,
    core: {
      mapConversation: async (conversation) => {
        const key = keyOf(conversation);
        const existing = sessions.get(key);
        if (existing) return existing;
        const session = await client.createSession({ title: `Xianyu ${conversation.conversationId}` });
        sessions.set(key, session.id);
        conversations.set(session.id, conversation);
        state.onChange?.({
          sessions: Object.fromEntries(sessions),
          conversations: Object.fromEntries(conversations),
          seenIds: [],
        });
        subscribeSession?.(session.id, conversation);
        return session.id;
      },
      uploadRemoteImage: async (url, sessionId) => {
        if (!allowedImageUrl(url)) throw new Error("闲鱼图片 URL 不在允许的 CDN 范围内");
        const response = await fetch(url);
        if (!response.ok) throw new Error(`闲鱼图片下载失败: HTTP ${response.status}`);
        const blob = await response.blob();
        const mime = blob.type.startsWith("image/") ? blob.type : "image/jpeg";
        const extension = mime.split("/", 2)[1] || "jpg";
        return (
          await client.upload(
            new Blob([await blob.arrayBuffer()], { type: mime }),
            `xianyu-${Date.now()}.${extension}`,
            sessionId,
          )
        ).id;
      },
      sendMessage: async (sessionId, text, source, attachmentIds) => {
        if (!source) throw new Error("Xianyu message source is required");
        await client.sendMessage(sessionId, text, {
          mode: "agent",
          source,
          ...(attachmentIds?.length ? { attachmentIds } : {}),
        });
      },
    },
  });
  const subscribe = (sessionId: string, conversation: ExternalConversation): void => {
    conversations.set(sessionId, conversation);
    client.subscribe(sessionId, async (event) => {
      if (event.type !== "message.completed") return;
      const snapshot: SessionSnapshot = await client.getSession(sessionId);
      const assistant = snapshot.transcript
        .filter((item) => item.role === "assistant" && item.status === "complete")
        .at(-1);
      if (!assistant || lastRendered.get(sessionId) === assistant.id || !assistant.content.trim()) return;
      lastRendered.set(sessionId, assistant.id);
      await transport.send(conversation, assistant.content.trim());
    });
  };
  subscribeSession = subscribe;
  for (const [sessionId, conversation] of conversations) subscribe(sessionId, conversation);
  return { adapter, client, sessions, subscribe };
}

async function loadXianyuState(path: string): Promise<XianyuState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<XianyuState>;
    return {
      sessions: parsed.sessions ?? {},
      conversations: parsed.conversations ?? {},
      seenIds: parsed.seenIds ?? [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { sessions: {}, conversations: {}, seenIds: [] };
    throw error;
  }
}

function createStateWriter(path: string, state: XianyuState): () => void {
  let pending = false;
  let running = false;
  return () => {
    pending = true;
    if (running) return;
    running = true;
    void (async () => {
      while (pending) {
        pending = false;
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.tmp`;
        await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, path);
      }
      running = false;
    })().catch(() => {
      running = false;
    });
  };
}

export async function startXianyuService() {
  const cookie = required("XIANYU_COOKIE");
  const host = process.env.XIANYU_HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.XIANYU_PORT ?? 3250);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("XIANYU_PORT must be a valid TCP port");
  const stateDir = process.env.XIANYU_STATE_DIR?.trim();
  const statePath = stateDir ? join(stateDir, "state.json") : undefined;
  const persisted = statePath
    ? await loadXianyuState(statePath)
    : { sessions: {}, conversations: {}, seenIds: [] };
  const xianyuClient = new XianyuClient(cookie);
  const state = { ...persisted };
  const writer = statePath ? createStateWriter(statePath, state) : undefined;
  const transport = new GoofishTransport(xianyuClient, undefined, {
    seenIds: state.seenIds,
    onSeen: (id) => {
      state.seenIds.push(id);
      if (state.seenIds.length > 10_000) state.seenIds.splice(0, state.seenIds.length - 10_000);
      writer?.();
    },
  });
  const configured = createConfiguredXianyuAdapter(transport, {
    initial: state,
    onChange: (next) => {
      state.sessions = next.sessions;
      state.conversations = next.conversations;
      writer?.();
    },
  });
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (request.url === "/health" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            service: "xianyu-adapter",
            ...configured.adapter.health(),
            transport: transport.status(),
          }),
        );
        return;
      }
      if (request.url === "/pause" && request.method === "POST") {
        configured.adapter.pause();
        response.writeHead(204).end();
        return;
      }
      if (request.url === "/resume" && request.method === "POST") {
        configured.adapter.resume();
        response.writeHead(204).end();
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/item/")) {
        const item = await xianyuClient.getItem(decodeURIComponent(request.url.slice("/item/".length)));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(item));
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/history/")) {
        const conversationId = decodeURIComponent(request.url.slice("/history/".length));
        const messages = await transport.getHistory(conversationId);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ conversationId, messages }));
        return;
      }
      if (request.method === "POST" && request.url === "/chat") {
        const body = await readJsonBody(request);
        const conversationId = await transport.createChat(
          String(body.receiverId ?? ""),
          String(body.itemId ?? ""),
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ conversationId }));
        return;
      }
      if (request.method === "POST" && request.url === "/publish") {
        const body = await readJsonBody(request);
        const result = await xianyuClient.publishItem({
          imagePaths: Array.isArray(body.imagePaths) ? body.imagePaths.map(String) : [],
          description: String(body.description ?? ""),
          delivery: String(body.delivery ?? "free_shipping") as
            | "free_shipping"
            | "distance_based"
            | "fixed"
            | "pickup_only",
          longitude: String(body.longitude ?? ""),
          latitude: String(body.latitude ?? ""),
          ...(body.currentPrice === undefined ? {} : { currentPrice: String(body.currentPrice) }),
          ...(body.originalPrice === undefined ? {} : { originalPrice: String(body.originalPrice) }),
          ...(body.shippingFee === undefined ? {} : { shippingFee: String(body.shippingFee) }),
          selfPickup: Boolean(body.selfPickup),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
        return;
      }
      response.writeHead(404).end();
    } catch (error) {
      if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await configured.adapter.start();
  server.listen(port, host);
  const stop = async () => {
    await configured.adapter.stop();
    server.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  return { ...configured, server, stop };
}

if (process.env.XIANYU_AUTOSTART === "1") await startXianyuService();
