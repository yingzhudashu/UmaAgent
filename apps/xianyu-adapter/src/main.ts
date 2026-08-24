import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { loadUserConfig } from "@uma-agent/channel-adapter";
import { UmaClient } from "@uma-agent/client";
import type { ExternalConversation, SessionSnapshot } from "@uma-agent/protocol";
import { createXianyuAdapter, type XianyuTransport } from "./adapter.js";
import { XianyuClient } from "./client.js";
import { GoofishTransport } from "./transport.js";

function requireControlToken(request: IncomingMessage, token: string): void {
  const header = request.headers.authorization;
  if (header !== `Bearer ${token}`) throw new Error("Xianyu control authentication required");
}

function localHealthRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function allowedImageUrl(value: string): boolean {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    ["alicdn.com", "goofish.com", "mmcdn.cn", "taobao.com", "tbcdn.cn"].some(
      (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
    )
  );
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes = 2 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    size += value.byteLength;
    if (size > maxBytes) throw new Error("请求体超过限制");
    chunks.push(value);
  }
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
  core: { serverUrl: string; token: string };
}

export function createConfiguredXianyuAdapter(transport: XianyuTransport, state: ConfiguredState) {
  const client = new UmaClient({
    baseUrl: state.core.serverUrl,
    token: state.core.token,
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
    })().catch((error) => {
      // 状态写入失败不能改变渠道业务结果，但必须显式告警，便于运维发现恢复点丢失。
      console.error("Xianyu state persistence failed", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      running = false;
    });
  };
}

export async function startXianyuService(
  configPath = process.argv.find((arg) => arg.startsWith("--config="))?.slice(9) ?? "config.user.json",
) {
  const user = await loadUserConfig(configPath, "xianyu");
  const cookie = user.xianyu.cookie;
  const controlToken = user.xianyu.controlToken;
  const host = user.xianyu.host;
  const port = user.xianyu.port;
  const statePath = join(user.xianyu.stateDir, "state.json");
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
    core: user.core,
    onChange: (next) => {
      state.sessions = next.sessions;
      state.conversations = next.conversations;
      writer?.();
    },
  });
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (request.url === "/health" && request.method === "GET") {
        if (!localHealthRequest(request)) {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Local health check required" }));
          return;
        }
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
        requireControlToken(request, controlToken);
        configured.adapter.pause();
        response.writeHead(204).end();
        return;
      }
      if (request.url === "/resume" && request.method === "POST") {
        requireControlToken(request, controlToken);
        configured.adapter.resume();
        response.writeHead(204).end();
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/item/")) {
        requireControlToken(request, controlToken);
        const item = await xianyuClient.getItem(decodeURIComponent(request.url.slice("/item/".length)));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(item));
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/history/")) {
        requireControlToken(request, controlToken);
        const conversationId = decodeURIComponent(request.url.slice("/history/".length));
        const messages = await transport.getHistory(conversationId);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ conversationId, messages }));
        return;
      }
      if (request.method === "POST" && request.url === "/chat") {
        requireControlToken(request, controlToken);
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
        requireControlToken(request, controlToken);
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

if (process.argv.some((arg) => arg.startsWith("--config="))) await startXianyuService();
