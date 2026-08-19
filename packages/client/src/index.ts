import type {
  AgentEventEnvelope,
  Approval,
  Attachment,
  CreateSessionRequest,
  Health,
  KnowledgeSource,
  ModelRef,
  SendMessageRequest,
  SendMessageResponse,
  Session,
  SessionSnapshot,
  SkillSummary,
  UpdateSessionRequest,
} from "@uma-agent/protocol";

export class UmaClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UmaClientError";
  }
}

export interface UmaClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  webSocketFactory?: (url: string) => WebSocket;
}

type Listener = (event: AgentEventEnvelope) => void;

export class UmaClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly subscriptions = new Set<string>();
  private readonly lastSequences = new Map<string, number>();
  private readonly recoveryTargets = new Map<string, number>();
  private socket: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private closed = false;

  constructor(private readonly options: UmaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.options.token) headers.set("authorization", `Bearer ${this.options.token}`);
    if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
    const response = await this.fetchFn(`${this.baseUrl}/api/v1${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
    if (!response.ok) {
      const body = (await response
        .json()
        .catch(() => ({ error: { code: "http_error", message: response.statusText } }))) as {
        error?: { code?: string; message?: string };
      };
      throw new UmaClientError(
        response.status,
        body.error?.code ?? "http_error",
        body.error?.message ?? response.statusText,
      );
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  health(): Promise<Health> {
    return this.request("/health");
  }
  async login(token: string): Promise<{ ok: boolean }> {
    const result = await this.request<{ ok: boolean }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    this.restartEvents();
    return result;
  }
  logout(): Promise<void> {
    return this.request("/auth/logout", { method: "POST" });
  }
  listSessions(): Promise<Session[]> {
    return this.request("/sessions");
  }
  createSession(input: CreateSessionRequest = {}): Promise<Session> {
    return this.request("/sessions", { method: "POST", body: JSON.stringify(input) });
  }
  getSession(id: string): Promise<SessionSnapshot> {
    return this.request(`/sessions/${encodeURIComponent(id)}`);
  }
  updateSession(id: string, patch: UpdateSessionRequest): Promise<Session> {
    return this.request(`/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }
  deleteSession(id: string): Promise<void> {
    return this.request(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  sendMessage(
    sessionId: string,
    text: string,
    input: Omit<SendMessageRequest, "messageId" | "text"> = {},
  ): Promise<SendMessageResponse> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ ...input, messageId: crypto.randomUUID(), text }),
    });
  }
  cancel(sessionId: string): Promise<void> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: "POST" });
  }
  resolveApproval(id: string, approved: boolean): Promise<Approval> {
    return this.request(`/approvals/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ approved }),
    });
  }
  listModels(): Promise<ModelRef[]> {
    return this.request("/models");
  }
  listSkills(): Promise<SkillSummary[]> {
    return this.request("/skills");
  }
  refreshSkills(): Promise<SkillSummary[]> {
    return this.request("/skills/refresh", { method: "POST" });
  }
  mcpStatus(): Promise<Array<{ name: string; connected: boolean; toolCount: number; error?: string }>> {
    return this.request("/mcp");
  }
  listKnowledge(): Promise<KnowledgeSource[]> {
    return this.request("/knowledge");
  }
  indexKnowledge(name: string, path: string): Promise<KnowledgeSource> {
    return this.request("/knowledge", { method: "POST", body: JSON.stringify({ name, path }) });
  }

  async upload(file: Blob, name: string, sessionId?: string): Promise<Attachment> {
    const form = new FormData();
    form.append("file", file, name);
    if (sessionId) form.append("sessionId", sessionId);
    return this.request("/uploads", { method: "POST", body: form });
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    this.subscriptions.add(sessionId);
    const listeners = this.listeners.get(sessionId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    this.sendSubscriptions();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(sessionId);
        this.subscriptions.delete(sessionId);
        this.lastSequences.delete(sessionId);
        this.recoveryTargets.delete(sessionId);
      }
      this.sendSubscriptions();
    };
  }

  connectEvents(): void {
    if (this.socket || this.closed) return;
    const url = new URL("/api/v1/events", this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = this.options.webSocketFactory
      ? this.options.webSocketFactory(url.toString())
      : new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      if (this.options.token) socket.send(JSON.stringify({ type: "auth", token: this.options.token }));
      this.sendSubscriptions();
      for (const sessionId of this.subscriptions) {
        this.lastSequences.delete(sessionId);
        void this.recoverSnapshot(sessionId, 0);
      }
    });
    socket.addEventListener("message", (message) => {
      try {
        this.dispatch(JSON.parse(String(message.data)) as AgentEventEnvelope);
      } catch {
        /* Ignore malformed remote frames. */
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = undefined;
      if (!this.closed) this.scheduleReconnect();
    });
    socket.addEventListener("error", () => socket.close());
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = undefined;
  }

  private dispatch(event: AgentEventEnvelope): void {
    if (!this.subscriptions.has(event.sessionId)) return;
    const recoveringTo = this.recoveryTargets.get(event.sessionId);
    if (recoveringTo !== undefined) {
      this.recoveryTargets.set(event.sessionId, Math.max(recoveringTo, event.sequence));
      return;
    }
    const previous = this.lastSequences.get(event.sessionId);
    if (previous !== undefined && event.sequence !== previous + 1) {
      void this.recoverSnapshot(event.sessionId, Math.max(previous, event.sequence));
      return;
    }
    this.lastSequences.set(event.sessionId, event.sequence);
    this.notify(event);
  }

  private notify(event: AgentEventEnvelope): void {
    for (const listener of this.listeners.get(event.sessionId) ?? []) listener(event);
  }

  private async recoverSnapshot(sessionId: string, sequence: number): Promise<void> {
    if (this.recoveryTargets.has(sessionId)) {
      const current = this.recoveryTargets.get(sessionId) ?? 0;
      this.recoveryTargets.set(sessionId, Math.max(current, sequence));
      return;
    }
    this.recoveryTargets.set(sessionId, sequence);
    try {
      let observed = sequence;
      while (this.subscriptions.has(sessionId)) {
        const requestedThrough = this.recoveryTargets.get(sessionId) ?? observed;
        const snapshot = await this.getSession(sessionId);
        const current = this.recoveryTargets.get(sessionId) ?? observed;
        this.notify({
          protocolVersion: 1,
          sessionId,
          sequence: Math.max(1, current),
          timestamp: Date.now(),
          type: "session.snapshot",
          payload: snapshot,
        });
        observed = current;
        if (current === requestedThrough) break;
      }
      this.lastSequences.set(sessionId, observed);
    } catch {
      this.lastSequences.delete(sessionId);
    } finally {
      this.recoveryTargets.delete(sessionId);
    }
  }

  private sendSubscriptions(): void {
    if (this.socket?.readyState === 1)
      this.socket.send(JSON.stringify({ type: "subscribe", sessionIds: [...this.subscriptions] }));
  }

  private restartEvents(): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    if (!this.closed) this.connectEvents();
  }

  private scheduleReconnect(): void {
    const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => this.connectEvents(), delay);
  }
}
