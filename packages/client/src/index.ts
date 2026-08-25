import type {
  AgentEventEnvelope,
  AgentProfile,
  Approval,
  Attachment,
  AuditRecord,
  BackgroundTask,
  CreateEvaluationReport,
  CreateScheduledTaskRequest,
  CreateSessionRequest,
  DiagnosticsReport,
  EvaluationReport,
  EvaluationTrend,
  Health,
  KnowledgeSearchHit,
  KnowledgeSource,
  MemoryFact,
  ModelRef,
  OperationsReport,
  OptimizationApplication,
  OptimizationProposal,
  PublicConfig,
  QualityAssessment,
  ReloadResult,
  ResourceInvalidated,
  ResourceResyncRequired,
  ResourceSnapshot,
  ScheduledTask,
  ScheduledTaskRun,
  SendMessageRequest,
  SendMessageResponse,
  Session,
  SessionEventPage,
  SessionHistoryPage,
  SessionSnapshot,
  SkillInstallRequest,
  SkillPackage,
  SkillSummary,
  SyncBootstrap,
  TraceQuery,
  TraceQueryPage,
  UpdateScheduledTaskRequest,
  UpdateSessionRequest,
} from "@uma-agent/protocol";
import { PROTOCOL_VERSION } from "@uma-agent/protocol";

export class UmaClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly requestId?: string,
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

export interface UmaRegistration {
  userId: string;
  token: string;
  tokenId: string;
  expiresAt: number;
}

export interface UmaAuthMe {
  userId: string;
  role: "admin" | "user";
  method: "web" | "access_token";
  scopes: string[];
  tokens: Array<{
    id: string;
    label: string;
    scopes: string[];
    expiresAt: number;
    revokedAt?: number;
    createdAt: number;
    lastUsedAt?: number;
  }>;
}

type Listener = (event: AgentEventEnvelope) => void;
type ResourceListener = (event: ResourceInvalidated | ResourceResyncRequired) => void;
export type EventConnectionState = "disconnected" | "connecting" | "connected";
export type SessionSubscription = { id: string; lastSequence?: number };

export class UmaClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly subscriptions = new Set<string>();
  private readonly resourceListeners = new Set<ResourceListener>();
  private readonly lastSequences = new Map<string, number>();
  private readonly recoveryTargets = new Map<string, number>();
  private socket: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private closed = false;
  private eventConnectionState: EventConnectionState = "disconnected";

  constructor(private readonly options: UmaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get serverOrigin(): string {
    return new URL(this.baseUrl).origin;
  }

  eventState(): EventConnectionState {
    return this.eventConnectionState;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.options.token) headers.set("authorization", `Bearer ${this.options.token}`);
    if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
    const response = await this.fetchFn(`${this.baseUrl}/api/v13${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
    if (!response.ok) {
      const body = (await response
        .json()
        .catch(() => ({ error: { code: "http_error", message: response.statusText } }))) as {
        error?: { code?: string; message?: string; retryable?: boolean; requestId?: string };
      };
      throw new UmaClientError(
        response.status,
        body.error?.code ?? "http_error",
        body.error?.message ?? response.statusText,
        body.error?.retryable ?? false,
        body.error?.requestId,
      );
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  health(): Promise<Health> {
    return this.request("/health/ready");
  }
  async login(token: string): Promise<{ ok: boolean }> {
    this.closed = false;
    const result = await this.request<{ ok: boolean }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    this.restartEvents();
    return result;
  }

  register(label = "primary"): Promise<UmaRegistration> {
    this.closed = false;
    return this.request("/auth/register", { method: "POST", body: JSON.stringify({ label }) });
  }

  authMe(): Promise<UmaAuthMe> {
    return this.request("/auth/me");
  }

  syncBootstrap(): Promise<SyncBootstrap> {
    return this.request("/sync/bootstrap", { method: "POST" });
  }

  createToken(
    label = "token",
    expiresInDays = 90,
  ): Promise<{ token: string; tokenId: string; expiresAt: number }> {
    return this.request("/auth/tokens", {
      method: "POST",
      body: JSON.stringify({ label, expiresInDays }),
    });
  }

  revokeToken(id: string): Promise<void> {
    return this.request(`/auth/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  authorizeWithToken(
    token: string,
    clientId: string,
    redirectUri: string,
    codeChallenge: string,
  ): Promise<{ code: string; expiresAt: number }> {
    return this.request("/auth/authorize", {
      method: "POST",
      body: JSON.stringify({ token, clientId, redirectUri, codeChallenge }),
    });
  }

  exchangeAuthorizationCode(
    code: string,
    clientId: string,
    redirectUri: string,
    codeVerifier: string,
  ): Promise<{ token: string; id: string; expiresAt: number }> {
    return this.request("/auth/token", {
      method: "POST",
      body: JSON.stringify({ code, clientId, redirectUri, codeVerifier }),
    });
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
    return this.request(`/sessions/${encodeURIComponent(id)}/snapshot`);
  }
  getSessionHistory(sessionId: string, beforeSequence?: number, limit = 100): Promise<SessionHistoryPage> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (beforeSequence !== undefined) query.set("before", String(beforeSequence));
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/history?${query}`);
  }
  getSessionEvents(sessionId: string, afterSequence: number, limit = 500): Promise<SessionEventPage> {
    return this.request(
      `/sessions/${encodeURIComponent(sessionId)}/events?after=${afterSequence}&limit=${limit}`,
    );
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
    input: Pick<SendMessageRequest, "mode"> & Partial<Omit<SendMessageRequest, "text" | "mode">>,
  ): Promise<SendMessageResponse> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ ...input, messageId: input.messageId ?? crypto.randomUUID(), text }),
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
  async listSkills(): Promise<SkillSummary[]> {
    return (await this.skillState()).available;
  }
  skillState(): Promise<{ available: SkillSummary[]; packages: SkillPackage[] }> {
    return this.request("/skills");
  }
  refreshSkills(): Promise<SkillSummary[]> {
    return this.request("/skills/refresh", { method: "POST" });
  }
  reloadConfig(): Promise<ReloadResult> {
    return this.request("/admin/reload", { method: "POST" });
  }
  publicConfig(): Promise<PublicConfig> {
    return this.request("/admin/config");
  }
  searchSkills(query: string): Promise<Array<Record<string, unknown>>> {
    return this.request(`/skills/search?q=${encodeURIComponent(query)}`);
  }
  installSkill(input: SkillInstallRequest): Promise<SkillPackage> {
    return this.request("/skills/install", { method: "POST", body: JSON.stringify(input) });
  }
  setSkillStatus(id: string, action: "enable" | "disable" | "reject"): Promise<SkillPackage> {
    return this.request(`/skills/${encodeURIComponent(id)}/${action}`, { method: "POST" });
  }
  getAgentProfile(): Promise<AgentProfile> {
    return this.request("/profile");
  }
  updateAgentProfile(content: string): Promise<AgentProfile> {
    return this.request("/profile", { method: "PUT", body: JSON.stringify({ content }) });
  }
  searchHistory(
    sessionId: string,
    query: string,
    limit = 20,
  ): Promise<import("@uma-agent/protocol").TranscriptItem[]> {
    return this.request(
      `/sessions/${encodeURIComponent(sessionId)}/history/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
  }
  listActivity(sessionId: string, limit = 200): Promise<Array<Record<string, unknown>>> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/activity?limit=${limit}`);
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
  indexKnowledgeAttachment(name: string, attachmentId: string, sessionId: string): Promise<KnowledgeSource> {
    return this.request("/knowledge", {
      method: "POST",
      body: JSON.stringify({ name, attachmentId, sessionId }),
    });
  }
  deleteKnowledge(id: string): Promise<void> {
    return this.request(`/knowledge/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  searchKnowledge(query: string, sourceId?: string, limit = 20): Promise<KnowledgeSearchHit[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (sourceId) params.set("sourceId", sourceId);
    return this.request(`/knowledge/search?${params}`);
  }
  reindexKnowledge(id: string): Promise<KnowledgeSource> {
    return this.request(`/knowledge/${encodeURIComponent(id)}/reindex`, { method: "POST" });
  }
  listTasks(): Promise<BackgroundTask[]> {
    return this.request("/tasks");
  }
  createTask(prompt: string, parentSessionId?: string): Promise<BackgroundTask> {
    return this.request("/tasks", {
      method: "POST",
      body: JSON.stringify({ prompt, ...(parentSessionId ? { parentSessionId } : {}) }),
    });
  }
  getTask(id: string): Promise<BackgroundTask> {
    return this.request(`/tasks/${encodeURIComponent(id)}`);
  }
  cancelTask(id: string): Promise<BackgroundTask> {
    return this.request(`/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }
  deleteTask(id: string): Promise<void> {
    return this.request(`/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  listSchedules(): Promise<ScheduledTask[]> {
    return this.request("/schedules");
  }
  createSchedule(input: CreateScheduledTaskRequest): Promise<ScheduledTask> {
    return this.request("/schedules", { method: "POST", body: JSON.stringify(input) });
  }
  updateSchedule(id: string, input: UpdateScheduledTaskRequest): Promise<ScheduledTask> {
    return this.request(`/schedules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }
  deleteSchedule(id: string): Promise<void> {
    return this.request(`/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  runSchedule(id: string): Promise<ScheduledTaskRun> {
    return this.request(`/schedules/${encodeURIComponent(id)}/run`, { method: "POST" });
  }
  listScheduleRuns(id: string): Promise<ScheduledTaskRun[]> {
    return this.request(`/schedules/${encodeURIComponent(id)}/runs`);
  }
  getScheduleRun(id: string): Promise<ScheduledTaskRun> {
    return this.request(`/schedule-runs/${encodeURIComponent(id)}`);
  }
  cancelScheduleRun(id: string): Promise<ScheduledTaskRun> {
    return this.request(`/schedule-runs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }
  operationsReport(from?: number, to?: number): Promise<OperationsReport> {
    const query = new URLSearchParams();
    if (from !== undefined) query.set("from", String(from));
    if (to !== undefined) query.set("to", String(to));
    return this.request(`/reports/operations${query.size ? `?${query}` : ""}`);
  }
  diagnosticsReport(from?: number, to?: number): Promise<DiagnosticsReport> {
    const query = new URLSearchParams();
    if (from !== undefined) query.set("from", String(from));
    if (to !== undefined) query.set("to", String(to));
    return this.request(`/reports/diagnostics${query.size ? `?${query}` : ""}`);
  }
  queryTraces(query: TraceQuery): Promise<TraceQueryPage> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    return this.request(`/traces?${params}`);
  }
  resourceReport(from?: number, to?: number, limit = 500): Promise<ResourceSnapshot[]> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (from !== undefined) query.set("from", String(from));
    if (to !== undefined) query.set("to", String(to));
    return this.request(`/reports/resources?${query}`);
  }
  listEvaluationReports(limit = 100): Promise<EvaluationReport[]> {
    return this.request(`/evaluations?limit=${limit}`);
  }
  listEvaluationTrends(
    from?: number,
    to?: number,
    groupBy: "day" | "suite" | "mode" = "day",
  ): Promise<EvaluationTrend[]> {
    const query = new URLSearchParams({ groupBy });
    if (from !== undefined) query.set("from", String(from));
    if (to !== undefined) query.set("to", String(to));
    return this.request(`/evaluations/trends?${query}`);
  }
  getEvaluationReport(id: string): Promise<EvaluationReport> {
    return this.request(`/evaluations/${encodeURIComponent(id)}`);
  }
  createEvaluationReport(input: CreateEvaluationReport): Promise<EvaluationReport> {
    return this.request("/evaluations", { method: "POST", body: JSON.stringify(input) });
  }
  listOptimizationProposals(): Promise<OptimizationProposal[]> {
    return this.request("/optimization-proposals");
  }
  generateOptimizationProposals(from?: number, to?: number): Promise<OptimizationProposal[]> {
    return this.request("/optimization-proposals/generate", {
      method: "POST",
      body: JSON.stringify({ ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }),
    });
  }
  decideOptimizationProposal(id: string, status: "accepted" | "rejected"): Promise<OptimizationProposal> {
    return this.request(`/optimization-proposals/${encodeURIComponent(id)}/decision`, {
      method: "POST",
      body: JSON.stringify({ status }),
    });
  }
  previewOptimization(input: {
    proposalId: string;
    workspace: string;
    changes: Array<{ path: string; content: string }>;
    validationCommand: "test" | "check" | "build" | "test:eval:faux" | "test:perf";
    approved?: boolean;
  }): Promise<unknown> {
    return this.request("/optimization-proposals/preview", { method: "POST", body: JSON.stringify(input) });
  }
  applyOptimization(input: {
    proposalId: string;
    workspace: string;
    changes: Array<{ path: string; content: string }>;
    validationCommand: "test" | "check" | "build" | "test:eval:faux" | "test:perf";
    approved?: boolean;
  }): Promise<unknown> {
    return this.request("/optimization-proposals/apply", { method: "POST", body: JSON.stringify(input) });
  }
  listOptimizationApplications(limit = 100): Promise<OptimizationApplication[]> {
    return this.request(`/optimization-applications?limit=${limit}`);
  }
  rollbackOptimization(id: string): Promise<{ application: OptimizationApplication; rolledBack: boolean }> {
    return this.request(`/optimization-applications/${encodeURIComponent(id)}/rollback`, { method: "POST" });
  }
  listMemoryFacts(status?: MemoryFact["status"]): Promise<MemoryFact[]> {
    return this.request(`/memory${status ? `?status=${status}` : ""}`);
  }
  createMemoryFact(
    sessionId: string,
    content: string,
    scope: MemoryFact["scope"] = "session",
  ): Promise<MemoryFact> {
    return this.request("/memory", {
      method: "POST",
      body: JSON.stringify({ sessionId, content, scope }),
    });
  }
  reviewMemoryFact(id: string, status: MemoryFact["status"]): Promise<MemoryFact> {
    return this.request(`/memory/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ status }),
    });
  }
  deleteMemoryFact(id: string): Promise<void> {
    return this.request(`/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  listAudit(runId: string): Promise<AuditRecord[]> {
    return this.request(`/audit/runs/${encodeURIComponent(runId)}`);
  }
  reviewMessage(messageId: string, feedback?: string): Promise<SendMessageResponse> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/review`, {
      method: "POST",
      body: JSON.stringify(feedback ? { feedback } : {}),
    });
  }
  improveMessage(
    messageId: string,
    options: { force?: boolean; reset?: boolean } = {},
  ): Promise<SendMessageResponse> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/improve`, {
      method: "POST",
      body: JSON.stringify(options),
    });
  }
  listRunQuality(runId: string): Promise<QualityAssessment[]> {
    return this.request(`/runs/${encodeURIComponent(runId)}/quality`);
  }
  sendCommand(sessionId: string, command: string, messageId?: string): Promise<SendMessageResponse> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/commands`, {
      method: "POST",
      body: JSON.stringify({ command, ...(messageId ? { messageId } : {}) }),
    });
  }
  executeShortcut(sessionId: string, command: string): Promise<{ command: string; output: string }> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/shortcuts`, {
      method: "POST",
      body: JSON.stringify({ command }),
    });
  }
  getRun(runId: string): Promise<import("@uma-agent/protocol").Run> {
    return this.request(`/runs/${encodeURIComponent(runId)}`);
  }
  async waitForRun(
    runId: string,
    options: { signal?: AbortSignal; pollMs?: number } = {},
  ): Promise<import("@uma-agent/protocol").Run> {
    const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "awaiting_input"]);
    while (true) {
      if (options.signal?.aborted) throw new DOMException("Run wait cancelled", "AbortError");
      const run = await this.getRun(runId);
      if (terminal.has(run.status)) return run;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException("Run wait cancelled", "AbortError"));
        };
        const timer = setTimeout(() => {
          options.signal?.removeEventListener("abort", abort);
          resolve();
        }, options.pollMs ?? 1_000);
        options.signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
  listRunActions(runId: string): Promise<import("@uma-agent/protocol").RunAction[]> {
    return this.request(`/runs/${encodeURIComponent(runId)}/actions`);
  }
  listRunCheckpoints(runId: string): Promise<import("@uma-agent/protocol").RunCheckpoint[]> {
    return this.request(`/runs/${encodeURIComponent(runId)}/checkpoints`);
  }
  resumeRun(runId: string): Promise<import("@uma-agent/protocol").Run> {
    return this.request(`/runs/${encodeURIComponent(runId)}/resume`, { method: "POST" });
  }
  cancelRun(runId: string): Promise<import("@uma-agent/protocol").Run> {
    return this.request(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
  }
  decideRunAction(
    runId: string,
    actionId: string,
    decision: import("@uma-agent/protocol").RunActionDecision["decision"],
  ): Promise<import("@uma-agent/protocol").RunAction> {
    return this.request(`/runs/${encodeURIComponent(runId)}/actions/${encodeURIComponent(actionId)}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
  }
  compactSession(sessionId: string): Promise<{ throughSequence: number; content: string }> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/compact`, { method: "POST" });
  }

  async upload(file: Blob, name: string, sessionId?: string): Promise<Attachment> {
    const form = new FormData();
    form.append("file", file, name);
    if (sessionId) form.append("sessionId", sessionId);
    return this.request("/uploads", { method: "POST", body: form });
  }

  async attachmentContent(id: string): Promise<Blob> {
    const headers = new Headers();
    if (this.options.token) headers.set("authorization", `Bearer ${this.options.token}`);
    const response = await this.fetchFn(
      `${this.baseUrl}/api/v13/attachments/${encodeURIComponent(id)}/content`,
      { headers, credentials: "include" },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as
        | { error?: { code?: string; message?: string; retryable?: boolean; requestId?: string } }
        | undefined;
      throw new UmaClientError(
        response.status,
        body?.error?.code ?? "http_error",
        body?.error?.message ?? response.statusText,
        body?.error?.retryable ?? false,
        body?.error?.requestId,
      );
    }
    return response.blob();
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

  subscribeSessions(sessions: SessionSubscription[], listener: Listener): () => void {
    const unsubscribers = sessions.map((session) => {
      if (session.lastSequence !== undefined && !this.lastSequences.has(session.id))
        this.lastSequences.set(session.id, session.lastSequence);
      return this.subscribe(session.id, listener);
    });
    return () => {
      unsubscribers.forEach((unsubscribe) => {
        unsubscribe();
      });
    };
  }

  subscribeResources(listener: ResourceListener): () => void {
    this.resourceListeners.add(listener);
    return () => this.resourceListeners.delete(listener);
  }

  connectEvents(): void {
    if (this.socket || this.closed) return;
    this.eventConnectionState = "connecting";
    const url = new URL("/api/v13/events", this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = this.options.webSocketFactory
      ? this.options.webSocketFactory(url.toString())
      : new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.closed) return;
      this.eventConnectionState = "connected";
      this.reconnectAttempt = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }
      if (this.options.token) socket.send(JSON.stringify({ type: "auth", token: this.options.token }));
      this.sendSubscriptions();
      for (const sessionId of this.subscriptions) {
        if (this.lastSequences.get(sessionId) === undefined) void this.recoverSnapshot(sessionId, 0);
      }
    });
    socket.addEventListener("message", (message) => {
      try {
        const parsed = JSON.parse(String(message.data)) as Record<string, unknown>;
        if (parsed.type === "sync.started" || parsed.type === "sync.completed") return;
        if (parsed.type === "resource.invalidated" || parsed.type === "resource.resync_required") {
          for (const listener of this.resourceListeners)
            listener(parsed as unknown as ResourceInvalidated | ResourceResyncRequired);
          return;
        }
        this.dispatch(parsed as unknown as AgentEventEnvelope);
      } catch {
        /* Ignore malformed remote frames. */
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.eventConnectionState = "disconnected";
      this.socket = undefined;
      if (!this.closed) this.scheduleReconnect();
    });
    // Node's undici WebSocket may dispatch `error` while it is already
    // closing. Calling close() from that callback recursively re-enters the
    // error/close dispatch path and can overflow the stack. The native close
    // event owns teardown and reconnect scheduling; leave the socket alone.
    socket.addEventListener("error", () => {
      this.eventConnectionState = "disconnected";
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.eventConnectionState = "disconnected";
  }

  private dispatch(event: AgentEventEnvelope): void {
    if (!this.subscriptions.has(event.sessionId)) return;
    const recoveringTo = this.recoveryTargets.get(event.sessionId);
    if (recoveringTo !== undefined) {
      this.recoveryTargets.set(event.sessionId, Math.max(recoveringTo, event.sequence));
      return;
    }
    const previous = this.lastSequences.get(event.sessionId);
    if (previous !== undefined && event.sequence <= previous) return;
    if (previous !== undefined && event.sequence !== previous + 1) {
      void this.recoverEvents(event.sessionId, previous, event.sequence);
      return;
    }
    this.lastSequences.set(event.sessionId, event.sequence);
    this.notify(event);
  }

  private async recoverEvents(sessionId: string, after: number, observed: number): Promise<void> {
    if (this.recoveryTargets.has(sessionId)) return;
    this.recoveryTargets.set(sessionId, observed);
    try {
      let cursor = after;
      let expected = after + 1;
      while (true) {
        const page = await this.getSessionEvents(sessionId, cursor, 1000);
        if (!Array.isArray(page.events)) throw new Error("Invalid event page");
        for (const event of page.events) {
          if (event.sequence !== expected) throw new Error("Event sequence gap");
          this.lastSequences.set(sessionId, event.sequence);
          this.notify(event);
          expected++;
        }
        cursor = page.nextSequence;
        const target = Math.max(observed, this.recoveryTargets.get(sessionId) ?? observed);
        if (page.events.length === 0 && cursor < target) throw new Error("Event cursor did not advance");
        if (page.hasMore || cursor < target) continue;
        break;
      }
    } catch {
      try {
        const snapshot = await this.getSession(sessionId);
        this.notify({
          protocolVersion: PROTOCOL_VERSION,
          sessionId,
          sequence: Math.max(1, snapshot.snapshotSequence),
          timestamp: Date.now(),
          type: "session.snapshot",
          payload: snapshot,
        });
        this.lastSequences.set(sessionId, snapshot.snapshotSequence);
      } catch {
        this.lastSequences.delete(sessionId);
      }
    } finally {
      this.recoveryTargets.delete(sessionId);
    }
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
      let latestSnapshotSequence = sequence;
      while (this.subscriptions.has(sessionId)) {
        const requestedThrough = this.recoveryTargets.get(sessionId) ?? observed;
        const snapshot = await this.getSession(sessionId);
        const current = this.recoveryTargets.get(sessionId) ?? observed;
        this.notify({
          protocolVersion: PROTOCOL_VERSION,
          sessionId,
          sequence: Math.max(1, snapshot.snapshotSequence),
          timestamp: Date.now(),
          type: "session.snapshot",
          payload: snapshot,
        });
        latestSnapshotSequence = snapshot.snapshotSequence;
        observed = current;
        if (current === requestedThrough) break;
      }
      this.lastSequences.set(sessionId, Math.max(observed, latestSnapshotSequence));
    } catch {
      this.lastSequences.delete(sessionId);
    } finally {
      this.recoveryTargets.delete(sessionId);
    }
  }

  private sendSubscriptions(): void {
    if (this.socket?.readyState === 1)
      this.socket.send(
        JSON.stringify({
          type: "subscribe",
          sessions: [...this.subscriptions].map((id) => ({
            id,
            lastSequence: this.lastSequences.get(id) ?? 0,
          })),
        }),
      );
  }

  private restartEvents(): void {
    const socket = this.socket;
    const wasClosed = this.closed;
    this.closed = true;
    this.socket = undefined;
    socket?.close();
    this.closed = wasClosed;
    if (!this.closed) this.connectEvents();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed || this.socket) return;
    const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectEvents();
    }, delay);
  }
}
