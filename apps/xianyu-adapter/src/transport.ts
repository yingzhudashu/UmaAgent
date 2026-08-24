import type { ExternalConversation } from "@uma-agent/protocol";
import WebSocket from "ws";
import type { XianyuInboundMessage, XianyuTransport } from "./adapter.js";
import { XianyuAuthError, type XianyuClient } from "./client.js";
import {
  buildAck,
  buildRegistration,
  buildSendMessage,
  buildSyncAck,
  parseInboundFrame,
} from "./protocol.js";

const WS_URL = "wss://wss-goofish.dingtalk.com/";

export interface XianyuTransportStatus {
  enabled: boolean;
  connected: boolean;
  authenticated: boolean;
  paused: boolean;
  ownerId: string;
  reconnectAttempt: number;
  lastError?: string;
}

export class GoofishTransport implements XianyuTransport {
  private socket: WebSocket | undefined;
  private stopping = false;
  private runner: Promise<void> | undefined;
  private onMessage: ((message: XianyuInboundMessage) => Promise<void>) | undefined;
  private readonly receivers = new Map<string, string>();
  private readonly seen = new Set<string>();
  private readonly retryWaiters = new Set<() => void>();
  private readonly pending = new Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private reconnectAttempt = 0;
  private lastError = "";
  private connectedState = false;
  private authenticated = false;
  private enabled = false;
  constructor(
    readonly client: XianyuClient,
    private readonly wsFactory: (url: string, options: WebSocket.ClientOptions) => WebSocket = (
      url,
      options,
    ) => new WebSocket(url, options),
    private readonly persistence: { seenIds?: Iterable<string>; onSeen?: (id: string) => void } = {},
  ) {
    for (const id of persistence.seenIds ?? []) this.seen.add(id);
  }
  async start(onMessage: (message: XianyuInboundMessage) => Promise<void>): Promise<void> {
    if (this.runner) return;
    this.onMessage = onMessage;
    this.stopping = false;
    this.enabled = true;
    this.runner = this.runLoop();
    await Promise.resolve();
  }
  async stop(): Promise<void> {
    this.enabled = false;
    this.stopping = true;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    for (const wake of this.retryWaiters) wake();
    this.retryWaiters.clear();
    this.failPending(new Error("闲鱼 WebSocket 已停止"));
    await this.runner;
    this.runner = undefined;
    this.connectedState = false;
    this.authenticated = false;
  }
  connected(): boolean {
    return this.connectedState;
  }
  status(): XianyuTransportStatus {
    return {
      enabled: this.enabled,
      connected: this.connectedState,
      authenticated: this.authenticated,
      paused: false,
      ownerId: this.client.ownerId,
      reconnectAttempt: this.reconnectAttempt,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
  async send(conversation: ExternalConversation, text: string): Promise<void> {
    if (!this.socket || !this.connectedState) throw new Error("闲鱼 WebSocket 未连接");
    const receiverId = this.receivers.get(conversation.conversationId);
    if (!receiverId) throw new Error(`没有会话 ${conversation.conversationId} 的买家 ID`);
    await this.sendJson(
      buildSendMessage({
        ownerId: this.client.ownerId,
        conversationId: conversation.conversationId,
        receiverId,
        kind: "text",
        value: { text },
      }),
    );
  }
  rememberReceiver(conversationId: string, receiverId: string): void {
    this.receivers.set(conversationId, receiverId);
  }
  private async runLoop(): Promise<void> {
    let delay = 1000;
    while (!this.stopping) {
      try {
        await this.connectOnce();
        delay = 1000;
        this.reconnectAttempt = 0;
      } catch (error) {
        if (this.stopping) break;
        this.lastError = error instanceof Error ? error.message : String(error);
        if (error instanceof XianyuAuthError) {
          this.authenticated = false;
          this.enabled = false;
          break;
        }
        this.reconnectAttempt += 1;
        await this.waitBeforeRetry(delay);
        delay = Math.min(60_000, delay * 2);
      }
    }
  }
  private async connectOnce(): Promise<void> {
    const token = await this.client.getAccessToken();
    const socket = this.wsFactory(WS_URL, {
      headers: {
        Cookie: this.client.cookieHeader(),
        Origin: "https://www.goofish.com",
        "User-Agent": "Mozilla/5.0",
      },
      handshakeTimeout: 20_000,
    });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN)
          void this.sendJson({ lwp: "/!", headers: { mid: String(Date.now()) } }).catch(() => socket.close());
      }, 15_000);
      const finish = (error?: Error) => {
        clearInterval(heartbeat);
        if (error && socket.readyState !== WebSocket.CLOSED) socket.close();
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve();
      };
      socket.once("open", () => {
        this.connectedState = true;
        this.authenticated = true;
        this.lastError = "";
        void this.sendJson(buildRegistration(token, this.client.deviceId))
          .then(() => this.sendJson(buildSyncAck()))
          .catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
      });
      socket.on("message", (data) => {
        void this.handleRaw(data.toString()).catch((error) =>
          finish(error instanceof Error ? error : new Error(String(error))),
        );
      });
      socket.once("error", (error) => {
        if (socket.readyState !== WebSocket.CLOSED) socket.close();
        finish(error);
      });
      socket.once("close", () => {
        this.connectedState = false;
        this.authenticated = false;
        this.failPending(new Error("闲鱼 WebSocket 已断开"));
        finish(new Error("闲鱼 WebSocket 已断开"));
      });
    });
    await new Promise<void>((resolve) => {
      const close = () => {
        this.connectedState = false;
        this.authenticated = false;
        resolve();
      };
      if (socket.readyState === WebSocket.CLOSED) return close();
      socket.once("close", close);
    });
    if (!this.stopping) throw new Error("闲鱼 WebSocket 已关闭");
  }
  private async handleRaw(raw: string): Promise<void> {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    await this.sendJson(buildAck(frame));
    const mid = String((frame.headers as Record<string, unknown> | undefined)?.mid ?? "");
    const pending = mid ? this.pending.get(mid) : undefined;
    if (pending) {
      this.pending.delete(mid);
      pending.resolve(frame);
      return;
    }
    const inbound = parseInboundFrame(frame);
    if (!inbound || inbound.senderId === this.client.ownerId) return;
    this.rememberReceiver(inbound.conversation.conversationId, inbound.senderId as string);
    if (this.seen.has(inbound.externalMessageId)) return;
    this.seen.add(inbound.externalMessageId);
    this.persistence.onSeen?.(inbound.externalMessageId);
    if (this.seen.size > 10_000) this.seen.delete(this.seen.values().next().value as string);
    await this.onMessage?.(inbound);
  }
  private async sendJson(frame: Record<string, unknown>): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("闲鱼 WebSocket 未连接");
    await new Promise<void>((resolve, reject) =>
      socket.send(JSON.stringify(frame), (error) => (error ? reject(error) : resolve())),
    );
  }

  private waitBeforeRetry(delay: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.retryWaiters.delete(wake);
        resolve();
      }, delay);
      const wake = () => {
        clearTimeout(timer);
        this.retryWaiters.delete(wake);
        resolve();
      };
      this.retryWaiters.add(wake);
      if (this.stopping) wake();
    });
  }

  private failPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private async request(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    const mid = String((frame.headers as Record<string, unknown> | undefined)?.mid ?? "");
    if (!mid) throw new Error("闲鱼 RPC 缺少 mid");
    if (!this.socket || !this.connectedState) throw new Error("闲鱼 WebSocket 未连接");
    const result = new Promise<Record<string, unknown>>((resolve, reject) =>
      this.pending.set(mid, { resolve, reject }),
    );
    try {
      await this.sendJson(frame);
      return await Promise.race([
        result,
        new Promise<Record<string, unknown>>((_, reject) =>
          setTimeout(() => reject(new Error("闲鱼 RPC 超时")), 20_000),
        ),
      ]);
    } finally {
      this.pending.delete(mid);
    }
  }

  async createChat(receiverId: string, itemId: string): Promise<string> {
    const response = await this.request({
      lwp: "/r/SingleChatConversation/create",
      headers: { mid: `${Date.now()}-${Math.random()}` },
      body: [
        {
          pairFirst: `${receiverId}@goofish`,
          pairSecond: `${this.client.ownerId}@goofish`,
          bizType: "1",
          extension: { itemId },
          ctx: { appVersion: "1.0", platform: "web" },
        },
      ],
    });
    const find = (value: unknown): string => {
      if (Array.isArray(value))
        for (const child of value) {
          const found = find(child);
          if (found) return found;
        }
      if (value && typeof value === "object") {
        const object = value as Record<string, unknown>;
        for (const key of ["cid", "conversationId", "conversation_id", "sid"]) {
          const candidate = String(object[key] ?? "");
          if (candidate) return candidate.split("@", 1)[0] ?? "";
        }
        for (const child of Object.values(object)) {
          const found = find(child);
          if (found) return found;
        }
      }
      return "";
    };
    const conversationId = find(response.body);
    if (!conversationId) throw new Error("闲鱼建聊响应缺少会话 ID");
    this.rememberReceiver(conversationId, receiverId);
    return conversationId;
  }

  async getHistory(conversationId: string): Promise<Array<Record<string, unknown>>> {
    let cursor = Number.MAX_SAFE_INTEGER;
    const result: Array<Record<string, unknown>> = [];
    while (true) {
      const mid = `${Date.now()}-${Math.random()}`;
      const response = await this.request({
        lwp: "/r/MessageManager/listUserMessages",
        headers: { mid },
        body: [`${conversationId}@goofish`, false, cursor, 20, false],
      });
      const body = response.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== "object") throw new Error("闲鱼历史响应格式错误");
      for (const model of (body.userMessageModels as unknown[] | undefined) ?? []) {
        const message = (model as Record<string, unknown>)?.message as Record<string, unknown> | undefined;
        if (!message) continue;
        const extension = (message.extension as Record<string, unknown> | undefined) ?? {};
        result.unshift({
          senderId: String(extension.senderUserId ?? ""),
          senderName: String(extension.reminderTitle ?? ""),
          messageId: String(extension.messageId ?? message.uuid ?? ""),
          content: message.content,
          createdAt: message.createTime ?? message.timestamp,
        });
      }
      if (Number(body.hasMore ?? 0) !== 1) return result;
      cursor = Number(body.nextCursor ?? 0);
      if (!cursor) throw new Error("闲鱼历史响应缺少 nextCursor");
    }
  }
}
