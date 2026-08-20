import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  estimateContextTokens,
  generateSummary,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  contentText,
  type Message,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type {
  Approval,
  Attachment,
  BackgroundTask,
  CreateSessionRequest,
  ModelRef,
  Run,
  RunAction,
  RunActionDecision,
  RunCheckpoint,
  SendMessageRequest,
  Session,
  SessionSnapshot,
  SkillSummary,
  TranscriptItem,
} from "@uma-agent/protocol";
import { UmaDatabase } from "./database.js";
import { EventHub, type EventListener } from "./events.js";
import { KnowledgeService } from "./knowledge.js";
import { McpManager } from "./mcp.js";
import { ModelRegistry } from "./models.js";
import { PermissionPolicy } from "./permissions.js";
import { SkillRegistry } from "./skills.js";
import { StateLock } from "./state-lock.js";
import { createBuiltinTools } from "./tools.js";
import type {
  ContextSummary,
  PreflightDecision,
  RuntimeHealth,
  StoredAgentMessage,
  UmaConfig,
} from "./types.js";
import { WorkspacePolicy } from "./workspace.js";

class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    return () => {
      this.active--;
      this.waiting.shift()?.();
    };
  }
  count(): number {
    return this.active;
  }
}

type PendingApproval = { resolve: (approved: boolean) => void; timer: NodeJS.Timeout };

function textFromMessage(message: AgentMessage): string {
  if (message.role === "assistant") return contentText(message.content);
  if (message.role === "user")
    return typeof message.content === "string"
      ? message.content
      : message.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
  if (message.role === "toolResult")
    return message.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
  return "";
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  return JSON.parse((fenced ?? text).trim());
}

function decisionFrom(value: unknown): PreflightDecision {
  if (!value || typeof value !== "object") throw new Error("Preflight response is not an object");
  const data = value as Record<string, unknown>;
  if (data.route !== "direct" && data.route !== "clarify" && data.route !== "plan")
    throw new Error("Preflight route is invalid");
  const strings = (input: unknown) =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [];
  const goal = typeof data.goal === "string" ? data.goal : "";
  if (!goal) throw new Error("Preflight goal is missing");
  return {
    route: data.route,
    goal,
    reasoningSummary: typeof data.reasoningSummary === "string" ? data.reasoningSummary : "",
    successCriteria: strings(data.successCriteria),
    questions: strings(data.questions),
    steps: strings(data.steps),
  };
}

function isSecretLike(value: string): boolean {
  return /(api[_-]?key|bearer\s+|password|secret|token\s*[:=]|-----BEGIN)/i.test(value);
}

export class UmaRuntime {
  readonly database: UmaDatabase;
  readonly knowledge: KnowledgeService;
  readonly models: ModelRegistry;
  readonly skills: SkillRegistry;
  readonly mcp = new McpManager();
  readonly workspacePolicy: WorkspacePolicy;
  private readonly events: EventHub;
  private readonly semaphore: Semaphore;
  private readonly queueTails = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly stateLock: StateLock;
  readonly permissions = new PermissionPolicy();
  private readonly taskSemaphore = new Semaphore(4);
  private readonly taskControllers = new Map<string, AbortController>();
  private started = false;
  private stopping = false;
  private stopPromise: Promise<void> | undefined;

  constructor(readonly config: UmaConfig) {
    this.stateLock = StateLock.acquire(config.server.stateDir);
    try {
      this.database = new UmaDatabase(config.server.stateDir);
    } catch (error) {
      this.stateLock.release();
      throw error;
    }
    this.knowledge = new KnowledgeService(this.database);
    this.models = new ModelRegistry(config);
    this.skills = new SkillRegistry(config.skillsDirs);
    this.workspacePolicy = new WorkspacePolicy(config.server.workspaceRoots);
    this.events = new EventHub(this.database);
    this.semaphore = new Semaphore(config.runtime.maxParallelSessions);
  }

  async start(): Promise<void> {
    if (this.stopping || this.stopPromise) throw new Error("UmaRuntime cannot restart after stopping");
    if (this.started) throw new Error("UmaRuntime is already started");
    await this.workspacePolicy.initialize();
    await this.skills.refresh();
    await this.mcp.connect(this.config.mcpServers, this.config.runtime.toolTimeoutMs);
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopPromise ??= this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    this.stopping = true;
    for (const id of [...this.approvals.keys()]) this.resolveApproval(id, false);
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.queueTails.values());
    await this.mcp.close();
    this.database.close();
    this.stateLock.release();
    this.started = false;
  }

  health(): RuntimeHealth {
    return { activeRuns: this.semaphore.count(), started: this.started };
  }
  subscribe(listener: EventListener): () => void {
    return this.events.subscribe(listener);
  }
  listSessions(): Session[] {
    return this.database.listSessions();
  }
  getSnapshot(id: string): SessionSnapshot {
    return this.database.getSnapshot(id);
  }
  listModels(): ModelRef[] {
    return this.models.list();
  }
  listTasks(): BackgroundTask[] {
    return this.database.listBackgroundTasks();
  }
  listSessionEvents(sessionId: string, afterSequence: number, limit?: number) {
    return this.database.listEvents(sessionId, afterSequence, limit);
  }
  listSessionHistory(sessionId: string, beforeSequence?: number, limit?: number) {
    return this.database.listHistory(sessionId, beforeSequence, limit);
  }
  getRun(runId: string): Run {
    return this.database.getRun(runId);
  }
  listRunActions(runId: string): RunAction[] {
    this.database.getRun(runId);
    return this.database.listRunActions(runId);
  }
  listRunCheckpoints(runId: string): RunCheckpoint[] {
    return this.database.listRunCheckpoints(runId);
  }
  resumeRun(runId: string): Run {
    const run = this.database.getRun(runId);
    if (run.status !== "interrupted") throw new Error("Only interrupted runs can be resumed");
    if (run.resume?.state === "needs_confirmation") throw new Error("Run has actions requiring confirmation");
    const message = this.database.getMessage(run.messageId);
    const session = this.database.getSession(run.sessionId);
    const resumed = this.events.transaction(() => {
      const value = this.database.updateRun(runId, { status: "queued", error: null });
      this.events.emit(session.id, runId, "run.resumed", value);
      return value;
    });
    const previous = this.queueTails.get(session.id) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        await this.replaySafeActions(run);
        await this.executeRun(
          session,
          runId,
          { messageId: message.id, text: message.content },
          undefined,
          true,
        );
      });
    const tail = next.finally(() => {
      if (this.queueTails.get(session.id) === tail) this.queueTails.delete(session.id);
    });
    this.queueTails.set(session.id, tail);
    return resumed;
  }
  async decideRunAction(
    runId: string,
    actionId: string,
    decision: RunActionDecision["decision"],
  ): Promise<RunAction> {
    const run = this.database.getRun(runId);
    const action = this.database.getRunAction(actionId);
    if (action.runId !== runId) throw new Error("Action does not belong to run");
    if (!["prepared", "uncertain"].includes(action.status)) return action;
    if (decision === "acknowledge" && action.status !== "uncertain")
      throw new Error("Only uncertain actions can be acknowledged");
    if (decision === "approve" && action.status !== "prepared")
      throw new Error("Only prepared actions can be approved");
    if (decision === "reject") {
      return this.events.transaction(() => {
        const transition = this.database.transitionRunAction(actionId, ["prepared", "uncertain"], {
          status: "rejected",
          error: "Rejected by user",
        });
        if (!transition.changed) return transition.action;
        const updated = transition.action;
        const failed = this.database.updateRun(runId, {
          status: "failed",
          error: "Pending action rejected",
        });
        this.events.emit(run.sessionId, runId, "run.action_decided", { action: updated, decision });
        this.events.emit(run.sessionId, runId, "run.updated", failed);
        return updated;
      });
    }
    if (decision === "acknowledge") {
      return this.events.transaction(() => {
        const transition = this.database.transitionRunAction(actionId, ["uncertain"], {
          status: "acknowledged",
        });
        if (!transition.changed) return transition.action;
        const updated = transition.action;
        this.events.emit(run.sessionId, runId, "run.action_decided", { action: updated, decision });
        return updated;
      });
    }
    return this.executePreparedAction(run, action);
  }

  async compactSession(sessionId: string): Promise<{ throughSequence: number; content: string }> {
    const session = this.database.getSession(sessionId);
    const result = await this.compactContext(
      session,
      this.database.listAgentMessages(sessionId),
      new AbortController().signal,
      true,
    );
    if (!result.summary) throw new Error("Session has insufficient history to compact");
    return { throughSequence: result.summary.throughSequence, content: result.summary.content };
  }
  getTask(id: string): BackgroundTask {
    return this.database.getBackgroundTask(id);
  }
  async createTask(prompt: string, parentSessionId?: string): Promise<BackgroundTask> {
    if (!prompt.trim()) throw new Error("Task prompt is required");
    const parent = parentSessionId ? this.database.getSession(parentSessionId) : undefined;
    const session = await this.createSession({
      mode: parent?.mode ?? "assistant",
      ...(parent?.workspace ? { workspace: parent.workspace } : {}),
      ...(parent?.model ? { model: parent.model } : {}),
    });
    const task = this.events.transaction(() => {
      const value = this.database.createBackgroundTask({
        id: randomUUID(),
        sessionId: session.id,
        prompt,
        ...(parentSessionId ? { parentSessionId } : {}),
      });
      this.events.emit(session.id, undefined, "task.updated", value);
      return value;
    });
    void this.executeTask(task.id);
    return task;
  }
  cancelTask(id: string): BackgroundTask {
    const task = this.database.getBackgroundTask(id);
    this.taskControllers.get(id)?.abort();
    if (task.status === "running") {
      try {
        this.cancel(task.sessionId);
      } catch {
        /* task may be between runs */
      }
    }
    if (["pending", "running"].includes(task.status)) {
      return this.events.transaction(() => {
        const updated = this.database.updateBackgroundTask(id, {
          status: "cancelled",
          error: "Cancelled by user",
        });
        this.events.emit(task.sessionId, undefined, "task.updated", updated);
        return updated;
      });
    }
    return task;
  }
  listMemoryFacts(status?: "active" | "candidate" | "rejected") {
    return this.database.listMemoryFacts(status);
  }
  reviewMemoryFact(id: string, status: "active" | "candidate" | "rejected") {
    return this.events.transaction(() => {
      const fact = this.database.updateMemoryFact(id, status);
      if (fact.sourceRunId) {
        const run = this.database.getRun(fact.sourceRunId);
        this.events.emit(run.sessionId, run.id, "memory.updated", fact);
      }
      return fact;
    });
  }
  deleteMemoryFact(id: string): void {
    this.database.deleteMemoryFact(id);
  }
  audit(runId: string) {
    return this.database.listAudit(runId);
  }
  listSkills(): SkillSummary[] {
    return this.skills.list();
  }
  refreshSkills(): Promise<SkillSummary[]> {
    return this.skills.refresh();
  }

  private transitionRun(
    sessionId: string,
    runId: string,
    patch: Parameters<UmaDatabase["updateRun"]>[1],
  ): Run {
    return this.events.transaction(() => {
      const run = this.database.updateRun(runId, patch);
      this.events.emit(sessionId, runId, "run.updated", run);
      return run;
    });
  }

  async createSession(input: CreateSessionRequest = {}): Promise<Session> {
    const mode = input.mode ?? "workspace";
    const workspace =
      mode === "workspace"
        ? await this.workspacePolicy.validateWorkspace(
            input.workspace ?? (this.config.server.workspaceRoots[0] as string),
          )
        : undefined;
    if (mode === "assistant" && input.workspace)
      throw new Error("Assistant sessions cannot bind a workspace");
    const model = input.model ?? this.config.defaultModel;
    this.models.get(model);
    return this.database.createSession({
      mode,
      title: input.title ?? "New session",
      ...(workspace ? { workspace } : {}),
      model,
      thinkingLevel: this.config.defaultThinkingLevel,
    });
  }

  private async executeTask(id: string): Promise<void> {
    const release = await this.taskSemaphore.acquire();
    const task = this.database.getBackgroundTask(id);
    if (task.status !== "pending") {
      release();
      return;
    }
    const controller = new AbortController();
    this.taskControllers.set(id, controller);
    try {
      this.events.transaction(() => {
        const value = this.database.updateBackgroundTask(id, { status: "running" });
        this.events.emit(value.sessionId, undefined, "task.updated", value);
        return value;
      });
      const run = this.sendMessage(task.sessionId, { messageId: randomUUID(), text: task.prompt });
      await new Promise<void>((resolve) => {
        const off = this.subscribe((event) => {
          if (event.runId !== run.id || event.type !== "run.updated") return;
          const status = (event.payload as Run).status;
          if (!["completed", "failed", "cancelled", "interrupted"].includes(status)) return;
          off();
          const snapshot = this.database.getSnapshot(task.sessionId);
          const final = [...snapshot.transcript]
            .reverse()
            .find((item) => item.runId === run.id && item.role === "assistant");
          this.events.transaction(() => {
            const updated = this.database.updateBackgroundTask(
              id,
              status === "completed"
                ? { status, ...(final?.content ? { result: final.content } : {}) }
                : {
                    status: status as BackgroundTask["status"],
                    ...((event.payload as Run).error ? { error: (event.payload as Run).error } : {}),
                  },
            );
            this.events.emit(task.sessionId, undefined, "task.updated", updated);
          });
          resolve();
        });
        controller.signal.addEventListener(
          "abort",
          () => {
            off();
            resolve();
          },
          { once: true },
        );
      });
    } catch (error) {
      this.events.transaction(() => {
        const updated = this.database.updateBackgroundTask(id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        this.events.emit(task.sessionId, undefined, "task.updated", updated);
      });
    } finally {
      this.taskControllers.delete(id);
      release();
    }
  }

  updateSession(
    id: string,
    patch: { title?: string; model?: ModelRef; thinkingLevel?: ThinkingLevel },
  ): Session {
    if (patch.model) this.models.get(patch.model);
    return this.events.transaction(() => {
      const session = this.database.updateSession(id, patch);
      this.events.emit(id, undefined, "session.snapshot", this.database.getSnapshot(id));
      return session;
    });
  }

  deleteSession(id: string): void {
    if (this.controllers.has(id)) throw new Error("Cannot delete a session with an active run");
    this.database.deleteSession(id);
  }

  sendMessage(sessionId: string, input: SendMessageRequest): Run {
    if (!this.started || this.stopping) throw new Error("UmaRuntime is not accepting new runs");
    const session = this.database.getSession(sessionId);
    const existing = this.database.findMessageOwner(input.messageId);
    if (existing) {
      if (existing.sessionId !== sessionId) throw new Error("messageId is already used by another session");
      if (!existing.runId) throw new Error("messageId is already used by a non-run message");
      return this.database.getRun(existing.runId);
    }
    const attachmentIds = input.attachmentIds ?? [];
    for (const id of attachmentIds) this.database.validateAttachmentForSession(id, sessionId);
    const awaiting = this.database.findAwaitingRun(sessionId);
    if (awaiting && (awaiting.clarificationCount ?? 0) >= 3) {
      this.events.transaction(() => {
        const failed = this.database.updateRun(awaiting.id, {
          status: "failed",
          error: "Clarification limit exceeded",
        });
        this.events.emit(sessionId, awaiting.id, "run.updated", failed);
      });
      throw new Error("Clarification limit exceeded; send a new message to start another run");
    }
    const continuation = awaiting && (awaiting.clarificationCount ?? 0) < 3 ? awaiting : undefined;
    const { run, created } = this.events.transaction(() => {
      const result = continuation
        ? { run: continuation, created: true }
        : this.database.createRun(sessionId, input.messageId);
      if (!result.created) return result;
      this.database.insertMessage({
        id: input.messageId,
        sessionId,
        runId: result.run.id,
        role: "user",
        status: "complete",
        content: input.text,
        payload: { role: "user", content: input.text, timestamp: Date.now() },
        attachmentIds,
        ...(input.source ? { source: input.source } : {}),
      });
      if (continuation) {
        this.database.updateRun(result.run.id, {
          clarificationCount: (result.run.clarificationCount ?? 0) + 1,
          status: "queued",
        });
        this.events.emit(sessionId, result.run.id, "run.resumed", {
          run: this.database.getRun(result.run.id),
          clarification: input.text,
        });
      }
      this.events.emit(
        sessionId,
        result.run.id,
        "message.completed",
        this.database.getMessage(input.messageId),
      );
      return result;
    });
    if (!created) return run;
    const previous = this.queueTails.get(sessionId) ?? Promise.resolve();
    const originalPrompt = continuation
      ? this.database.getMessage(continuation.messageId).content
      : undefined;
    const next = previous
      .catch(() => {})
      .then(() =>
        this.executeRun(
          session,
          run.id,
          input,
          continuation ? `${originalPrompt}\n\nClarification: ${input.text}` : undefined,
        ),
      );
    const tail = next.finally(() => {
      if (this.queueTails.get(sessionId) === tail) this.queueTails.delete(sessionId);
    });
    this.queueTails.set(sessionId, tail);
    return run;
  }

  cancel(sessionId: string): void {
    const controller = this.controllers.get(sessionId);
    if (!controller) throw new Error("Session has no active run");
    controller.abort();
  }

  resolveApproval(id: string, approved: boolean): Approval {
    const approval = this.events.transaction(() => {
      const value = this.database.resolveApproval(id, approved);
      this.database.addAudit({
        runId: value.runId,
        kind: "approval",
        name: value.toolName,
        input: { toolCallId: value.toolCallId },
        status: approved ? "approved" : "denied",
      });
      this.events.emit(value.sessionId, value.runId, "approval.resolved", value);
      return value;
    });
    const pending = this.approvals.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.approvals.delete(id);
      pending.resolve(approved);
    }
    return approval;
  }

  async addAttachment(input: {
    sessionId?: string;
    name: string;
    mimeType: string;
    data: Uint8Array;
  }): Promise<Attachment> {
    if (input.data.byteLength > this.config.server.maxUploadBytes)
      throw new Error("Upload exceeds configured size limit");
    if (input.sessionId) this.database.getSession(input.sessionId);
    const directory = join(this.config.server.stateDir, "uploads", randomUUID());
    await mkdir(directory, { recursive: true });
    const safeName = input.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "upload";
    const storagePath = join(directory, safeName);
    await import("node:fs/promises").then((fs) => fs.writeFile(storagePath, input.data));
    return this.database.addAttachment({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      name: safeName,
      mimeType: input.mimeType,
      size: input.data.byteLength,
      storagePath,
    });
  }

  private async preflight(
    session: Session,
    prompt: string,
    mode: SendMessageRequest["mode"],
    signal: AbortSignal,
    runId: string,
  ): Promise<PreflightDecision> {
    const force =
      mode === "direct"
        ? "You must choose direct."
        : mode === "plan"
          ? "You must choose plan."
          : "Choose the cheapest suitable route.";
    const startedAt = Date.now();
    const response = await this.models.models.completeSimple(
      this.models.get(session.model),
      {
        systemPrompt:
          "You route an agent request. Return JSON only with route (direct|clarify|plan), goal, reasoningSummary (one short sentence), successCriteria (string[]), questions (string[]), and steps (string[]). Clarify only when missing information blocks safe execution. Plan for multi-step work. Never include private chain-of-thought.",
        messages: [{ role: "user", content: `${force}\n\n${prompt}`, timestamp: Date.now() }],
      },
      { signal, temperature: 0 },
    );
    this.database.addModelCall({
      runId,
      provider: session.model.provider,
      model: session.model.id,
      role: "default",
      status: response.stopReason,
      durationMs: Date.now() - startedAt,
    });
    if (response.stopReason === "error" || response.stopReason === "aborted")
      throw new Error(response.errorMessage ?? "Preflight failed");
    const decision = decisionFrom(extractJson(contentText(response.content)));
    this.database.addAudit({
      runId,
      kind: "model",
      name: `${session.model.provider}/${session.model.id}:preflight`,
      output: decision,
      status: response.stopReason,
      usage: response.usage,
      durationMs: Date.now() - startedAt,
    });
    if (decision.route === "clarify" && decision.questions.length === 0)
      throw new Error("Clarification route requires questions");
    if (decision.route === "plan" && decision.steps.length === 0) decision.steps = [decision.goal];
    return decision;
  }

  private async executeRun(
    sessionAtQueueTime: Session,
    runId: string,
    input: SendMessageRequest,
    promptOverride?: string,
    resumeFromCheckpoint = false,
  ): Promise<void> {
    const release = await this.semaphore.acquire();
    if (this.stopping) {
      this.transitionRun(sessionAtQueueTime.id, runId, {
        status: "cancelled",
        error: "Server is shutting down",
      });
      release();
      return;
    }
    const controller = new AbortController();
    this.controllers.set(sessionAtQueueTime.id, controller);
    try {
      const session = this.database.getSession(sessionAtQueueTime.id);
      this.events.transaction(() => {
        const preflightRun = this.database.updateRun(runId, { status: "preflight", error: null });
        this.database.addAudit({
          runId,
          kind: "run",
          name: "status",
          input: { status: "preflight" },
          status: "started",
        });
        this.events.emit(session.id, runId, "run.updated", preflightRun);
      });
      const currentRun = this.database.getRun(runId);
      const decision =
        resumeFromCheckpoint && currentRun.route && currentRun.route !== "clarify"
          ? {
              route: currentRun.route,
              goal: input.text,
              reasoningSummary: currentRun.reasoningSummary ?? "Resuming from checkpoint",
              successCriteria: [],
              questions: [],
              steps: currentRun.plan.map((step) => step.title),
            }
          : await this.preflight(
              session,
              promptOverride ?? input.text,
              input.mode ?? "auto",
              controller.signal,
              runId,
            );
      this.events.transaction(() => {
        const routed = this.database.updateRun(runId, {
          route: decision.route,
          reasoningSummary: decision.reasoningSummary,
        });
        this.database.createCheckpoint({
          runId,
          phase: "preflight",
          turnCount: 0,
          lastMessageSequence: this.database.getMessage(input.messageId).sequence,
          contextSummarySequence: this.database.getContextSummary(session.id)?.throughSequence,
          safeToResume: true,
        });
        this.events.emit(session.id, runId, "run.updated", routed);
      });
      if (decision.route === "clarify") {
        const content = decision.questions.map((question, index) => `${index + 1}. ${question}`).join("\n");
        this.events.transaction(() => {
          const message = this.database.insertMessage({
            sessionId: session.id,
            runId,
            role: "assistant",
            status: "complete",
            content,
            payload: {
              role: "assistant",
              content: [{ type: "text", text: content }],
              api: session.model.provider,
              provider: session.model.provider,
              model: session.model.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            } as AssistantMessage,
          });
          const awaiting = this.database.updateRun(runId, { status: "awaiting_input", error: null });
          this.events.emit(session.id, runId, "message.completed", message);
          this.events.emit(session.id, runId, "run.updated", awaiting);
          this.events.emit(session.id, runId, "run.awaiting_input", {
            run: awaiting,
            questions: decision.questions,
          });
        });
        return;
      }
      if (decision.route === "plan" && currentRun.plan.length === 0) {
        this.events.transaction(() => {
          this.database.setPlan(runId, decision.steps);
          this.database.createCheckpoint({
            runId,
            phase: "plan",
            turnCount: 0,
            lastMessageSequence: this.database.latestMessageSequence(session.id),
            contextSummarySequence: this.database.getContextSummary(session.id)?.throughSequence,
            safeToResume: true,
          });
          this.events.emit(session.id, runId, "plan.updated", this.database.getRun(runId).plan);
        });
      }
      this.transitionRun(session.id, runId, { status: "running", error: null });
      const budget = { turns: this.database.getLatestCheckpoint(runId)?.turnCount ?? 0 };
      if (decision.route === "plan") {
        for (const step of this.database.listPlan(runId)) {
          if (step.status === "completed") continue;
          this.events.transaction(() => {
            this.database.updatePlanStep(step.id, "running");
            this.database.createCheckpoint({
              runId,
              phase: "step",
              planStepId: step.id,
              turnCount: budget.turns,
              lastMessageSequence: this.database.latestMessageSequence(session.id),
              contextSummarySequence: this.database.getContextSummary(session.id)?.throughSequence,
              safeToResume: true,
            });
            this.events.emit(session.id, runId, "plan.updated", this.database.getRun(runId).plan);
          });
          await this.runAgent(
            session,
            runId,
            input,
            decision,
            controller.signal,
            `Execute only plan step ${step.position + 1}: ${step.title}. Preserve completed work and finish this step with a concise progress result.`,
            budget,
          );
          this.events.transaction(() => {
            this.database.updatePlanStep(step.id, "completed");
            this.database.createCheckpoint({
              runId,
              phase: "step",
              planStepId: step.id,
              turnCount: budget.turns,
              lastMessageSequence: this.database.latestMessageSequence(session.id),
              contextSummarySequence: this.database.getContextSummary(session.id)?.throughSequence,
              safeToResume: true,
            });
            this.events.emit(session.id, runId, "plan.updated", this.database.getRun(runId).plan);
          });
          if (budget.turns >= 400) throw new Error("Run turn limit exceeded (400)");
        }
      } else {
        await this.runAgent(session, runId, input, decision, controller.signal, promptOverride, budget);
      }
      if (controller.signal.aborted) throw new DOMException("Run cancelled", "AbortError");
      if (decision.route === "plan") {
        this.transitionRun(session.id, runId, { status: "verifying" });
        await this.verifyAndCorrect(session, runId, decision, controller.signal);
        this.events.transaction(() => {
          this.database.createCheckpoint({
            runId,
            phase: "verify",
            turnCount: budget.turns,
            lastMessageSequence: this.database.latestMessageSequence(session.id),
            contextSummarySequence: this.database.getContextSummary(session.id)?.throughSequence,
            safeToResume: true,
          });
          this.events.emit(session.id, runId, "plan.updated", this.database.getRun(runId).plan);
        });
      }
      await this.extractMemories(session, runId, controller.signal);
      this.events.transaction(() => {
        const completed = this.database.updateRun(runId, { status: "completed", error: null });
        this.database.addAudit({
          runId,
          kind: "run",
          name: "status",
          input: { status: "completed" },
          status: "completed",
        });
        this.events.emit(session.id, runId, "run.updated", completed);
      });
    } catch (error) {
      const cancelled =
        controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      this.events.transaction(() => {
        const failed = this.database.updateRun(runId, {
          status: cancelled ? "cancelled" : "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        this.database.addAudit({
          runId,
          kind: "run",
          name: "status",
          input: { status: cancelled ? "cancelled" : "failed" },
          status: cancelled ? "cancelled" : "failed",
          ...(error instanceof Error ? { error: error.message } : {}),
        });
        for (const step of this.database.listPlan(runId)) {
          if (step.status === "running" || step.status === "pending")
            this.database.updatePlanStep(
              step.id,
              "failed",
              error instanceof Error ? error.message : String(error),
            );
        }
        this.events.emit(sessionAtQueueTime.id, runId, "run.updated", failed);
        if (failed.plan.length) this.events.emit(sessionAtQueueTime.id, runId, "plan.updated", failed.plan);
      });
    } finally {
      this.controllers.delete(sessionAtQueueTime.id);
      release();
    }
  }

  private async extractMemories(session: Session, runId: string, signal: AbortSignal): Promise<void> {
    try {
      const transcript = this.database
        .getSnapshot(session.id)
        .transcript.filter((item) => item.runId === runId && item.role === "user")
        .map((item) => item.content)
        .join("\n");
      if (!transcript) return;
      const response = await this.models.models.completeSimple(
        this.models.forRole("reasoning"),
        {
          systemPrompt:
            "Extract durable user facts only. Return JSON array of objects with content, confidence (0..1), and scope (global|session). Return [] when none. Never extract secrets or hidden reasoning.",
          messages: [{ role: "user", content: transcript, timestamp: Date.now() }],
        },
        { signal, temperature: 0 },
      );
      if (response.stopReason === "error" || response.stopReason === "aborted") return;
      const values = extractJson(contentText(response.content));
      if (!Array.isArray(values)) return;
      for (const value of values) {
        if (!value || typeof value !== "object") continue;
        const item = value as Record<string, unknown>;
        const content = typeof item.content === "string" ? item.content.trim() : "";
        const confidence = typeof item.confidence === "number" ? item.confidence : 0;
        const scope = item.scope === "global" ? "global" : "session";
        if (!content || isSecretLike(content) || confidence < 0 || confidence > 1) continue;
        this.events.transaction(() => {
          const fact = this.database.addMemoryFact({
            ...(scope === "session" ? { sessionId: session.id } : {}),
            scope,
            content,
            confidence,
            sourceRunId: runId,
            status: confidence >= 0.95 ? "active" : "candidate",
          });
          this.events.emit(session.id, runId, "memory.updated", fact);
        });
      }
    } catch {
      // Memory extraction is advisory and never changes run success.
    }
  }

  private toolsForSession(session: Session): AgentTool[] {
    return [
      ...createBuiltinTools({
        session,
        database: this.database,
        knowledge: this.knowledge,
        workspacePolicy: this.workspacePolicy,
        toolTimeoutMs: this.config.runtime.toolTimeoutMs,
      }),
      ...(session.mode === "workspace" ? this.mcp.tools() : []),
    ];
  }

  private async executePreparedAction(run: Run, action: RunAction): Promise<RunAction> {
    if (run.status !== "interrupted")
      throw new Error("Prepared actions can only be decided on interrupted runs");
    return this.executeRecoveredAction(run, action, false);
  }

  private async replaySafeActions(run: Run): Promise<void> {
    const safe = this.database
      .listRunActions(run.id)
      .filter(
        (action) =>
          ["prepared", "uncertain"].includes(action.status) &&
          ["read", "attachment_read"].includes(action.toolClass),
      );
    for (const action of safe) await this.executeRecoveredAction(run, action, true);
  }

  private async executeRecoveredAction(run: Run, action: RunAction, automatic: boolean): Promise<RunAction> {
    const session = this.database.getSession(run.sessionId);
    const tool = this.toolsForSession(session).find((candidate) => candidate.name === action.toolName);
    if (!tool) throw new Error(`Tool is unavailable: ${action.toolName}`);
    const running = this.events.transaction(() => {
      const transition = this.database.transitionRunAction(
        action.id,
        automatic ? ["prepared", "uncertain"] : ["prepared"],
        { status: "running", error: null },
      );
      if (!transition.changed) return transition.action;
      if (!automatic) {
        this.events.emit(run.sessionId, run.id, "run.action_decided", {
          action: transition.action,
          decision: "approve",
        });
      }
      this.events.emit(run.sessionId, run.id, "tool.started", {
        toolCallId: action.toolCallId,
        action: transition.action,
        recovered: true,
      });
      return transition.action;
    });
    if (running.status !== "running") return running;
    const controller = new AbortController();
    try {
      const toolInput = this.database.getToolCallInput(action.toolCallId);
      const result = await tool.execute(action.toolCallId, toolInput as never, controller.signal);
      return this.events.transaction(() => {
        this.database.completeToolCall(action.toolCallId, result, false);
        const completed = this.database.transitionRunAction(action.id, ["running"], {
          status: "completed",
          result,
          error: null,
        }).action;
        const toolMessage: ToolResultMessage = {
          role: "toolResult",
          toolCallId: action.toolCallId,
          toolName: action.toolName,
          content:
            result && typeof result === "object" && "content" in result
              ? (result as ToolResultMessage).content
              : [{ type: "text", text: JSON.stringify(result) }],
          isError: false,
          timestamp: Date.now(),
        };
        const item = this.database.insertMessage({
          sessionId: run.sessionId,
          runId: run.id,
          role: "tool",
          status: "complete",
          name: action.toolName,
          content: textFromMessage(toolMessage),
          payload: toolMessage,
        });
        this.database.addAudit({
          runId: run.id,
          kind: "tool",
          name: action.toolName,
          output: result,
          status: "completed",
        });
        this.database.createCheckpoint({
          runId: run.id,
          phase: "tool",
          turnCount: this.database.getLatestCheckpoint(run.id)?.turnCount ?? 0,
          lastMessageSequence: this.database.latestMessageSequence(run.sessionId),
          contextSummarySequence: this.database.getContextSummary(run.sessionId)?.throughSequence,
          safeToResume: true,
        });
        this.events.emit(run.sessionId, run.id, "tool.completed", {
          toolCallId: action.toolCallId,
          action: completed,
          item,
          recovered: true,
        });
        return completed;
      });
    } catch (error) {
      return this.events.transaction(() => {
        this.database.completeToolCall(
          action.toolCallId,
          { error: error instanceof Error ? error.message : String(error) },
          true,
        );
        const failed = this.database.transitionRunAction(action.id, ["running"], {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }).action;
        const toolMessage: ToolResultMessage = {
          role: "toolResult",
          toolCallId: action.toolCallId,
          toolName: action.toolName,
          content: [{ type: "text", text: failed.error ?? "Recovered tool execution failed" }],
          isError: true,
          timestamp: Date.now(),
        };
        const item = this.database.insertMessage({
          sessionId: run.sessionId,
          runId: run.id,
          role: "tool",
          status: "error",
          name: action.toolName,
          content: textFromMessage(toolMessage),
          payload: toolMessage,
        });
        this.database.addAudit({
          runId: run.id,
          kind: "tool",
          name: action.toolName,
          status: "error",
          ...(failed.error ? { error: failed.error } : {}),
        });
        this.events.emit(run.sessionId, run.id, "tool.completed", {
          toolCallId: action.toolCallId,
          action: failed,
          item,
          isError: true,
          recovered: true,
        });
        return failed;
      });
    }
  }

  private async runAgent(
    session: Session,
    runId: string,
    input: SendMessageRequest,
    decision: PreflightDecision,
    signal: AbortSignal,
    promptOverride?: string,
    budget: { turns: number } = { turns: 0 },
  ): Promise<void> {
    const userMessage = this.database.getMessage(input.messageId);
    const historyState = await this.compactContext(
      session,
      this.database.listAgentMessages(session.id, userMessage.sequence),
      signal,
    );
    const memory = this.database.searchMemory(session.id, input.text, 5);
    const knowledge = this.knowledge.search(input.text, 3);
    const context = [
      memory.length ? `<relevant_memory>\n${memory.join("\n")}\n</relevant_memory>` : "",
      knowledge.length
        ? `<relevant_knowledge>\n${knowledge.map((item) => `${item.filePath}\n${item.content}`).join("\n\n")}\n</relevant_knowledge>`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    const planText =
      decision.route === "plan"
        ? `\n\nApproved execution plan:\n${decision.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`
        : "";
    const attachmentText = input.attachmentIds?.length
      ? `\n\nAttachments: ${input.attachmentIds.join(", ")}. Use attachment_read when needed.`
      : "";
    const prompt = `${promptOverride ?? input.text}${planText}${attachmentText}`;
    const tools = this.toolsForSession(session);
    let stepTurns = 0;
    const turnLimit = decision.route === "plan" ? 48 : 400;
    const agent = new Agent({
      initialState: {
        systemPrompt: `You are UmaAgent, a precise server-side assistant. Operate only inside the provided workspace. Use tools when needed and verify changes. Do not reveal private chain-of-thought.${this.skills.systemPrompt()}${historyState.summary ? `\n\n<conversation_summary>\n${historyState.summary.content}\n</conversation_summary>` : ""}${context ? `\n\n${context}` : ""}`,
        model: this.models.get(session.model),
        thinkingLevel: session.thinkingLevel,
        tools,
        messages: historyState.messages,
      },
      streamFn: this.models.models.streamSimple.bind(this.models.models),
      toolExecution: "parallel",
      shouldStopAfterTurn: () => {
        stepTurns++;
        budget.turns++;
        return stepTurns >= turnLimit || budget.turns >= 400;
      },
      beforeToolCall: async ({ toolCall, args }, toolSignal) => {
        const permission = this.permissions.decide(session.mode, toolCall.name);
        if (!permission.allowed) return { block: true, reason: permission.reason };
        const action =
          this.database.getRunActionByToolCall(runId, toolCall.id) ??
          this.database.createRunAction({
            runId,
            checkpointId: this.database.getLatestCheckpoint(runId)?.id,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            toolClass: this.permissions.classify(toolCall.name),
            idempotencyKey: `${runId}:${toolCall.id}`,
            input: args,
          });
        if (permission.requiresApproval) {
          const approved = await this.requestApproval(
            session.id,
            runId,
            toolCall.id,
            toolCall.name,
            args,
            toolSignal ?? signal,
          );
          if (!approved) return { block: true, reason: "Tool execution was not approved" };
        }
        this.database.updateRunAction(action.id, { status: "running" });
        return undefined;
      },
    });
    this.bindAgentEvents(agent, session.id, runId, () => budget.turns);
    const abort = () => agent.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      await agent.prompt(prompt);
      if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  private async compactContext(
    session: Session,
    entries: StoredAgentMessage[],
    signal: AbortSignal,
    force = false,
  ): Promise<{ messages: AgentMessage[]; summary?: ContextSummary }> {
    let summary = this.database.getContextSummary(session.id);
    let pending = entries.filter((entry) => entry.sequence > (summary?.throughSequence ?? 0));
    const summaryMessage: AgentMessage[] = summary
      ? [{ role: "user", content: `Conversation summary:\n${summary.content}`, timestamp: summary.updatedAt }]
      : [];
    const model = this.models.get(session.model);
    const contextTokens = estimateContextTokens([
      ...summaryMessage,
      ...pending.map((entry) => entry.message),
    ]).tokens;
    if ((!force && contextTokens < model.contextWindow * 0.65) || pending.length < 6) {
      return { messages: pending.map((entry) => entry.message), ...(summary ? { summary } : {}) };
    }

    const keepRecentTokens = Math.min(20_000, Math.floor(model.contextWindow * 0.2));
    let retainedTokens = 0;
    let cut = pending.length;
    while (cut > 0 && retainedTokens < keepRecentTokens) {
      cut--;
      const entry = pending[cut];
      if (entry) retainedTokens += estimateContextTokens([entry.message]).tokens;
    }
    if (cut < 2) return { messages: pending.map((entry) => entry.message), ...(summary ? { summary } : {}) };
    const toSummarize = pending.slice(0, cut);
    try {
      const generated = await generateSummary(
        toSummarize.map((entry) => entry.message),
        this.models.models,
        model,
        Math.min(8_192, Math.max(1_024, Math.floor(model.contextWindow * 0.05))),
        signal,
        "Preserve goals, decisions, constraints, file changes, tool outcomes, and unresolved work.",
        summary?.content,
        session.thinkingLevel,
      );
      if (generated.ok) {
        const last = toSummarize.at(-1);
        if (last) summary = this.database.putContextSummary(session.id, last.sequence, generated.value);
        pending = pending.slice(cut);
      }
    } catch {
      // Context compaction is advisory; the normal model call will report a hard context failure.
    }
    return { messages: pending.map((entry) => entry.message), ...(summary ? { summary } : {}) };
  }

  private bindAgentEvents(
    agent: Agent,
    sessionId: string,
    runId: string,
    turnCount: () => number = () => 0,
  ): void {
    let assistantItem: TranscriptItem | undefined;
    let pendingAssistant: AssistantMessage | undefined;
    let flushTimer: NodeJS.Timeout | undefined;
    const toolMessages = new Map<string, string>();
    const toolActions = new Map<string, string>();
    const flushAssistant = () => {
      if (!assistantItem || !pendingAssistant) return;
      const message = pendingAssistant;
      this.events.transaction(() => {
        assistantItem = this.database.updateMessage(assistantItem?.id as string, {
          content: textFromMessage(message),
          payload: message,
        });
        this.events.emit(sessionId, runId, "message.delta", assistantItem);
      });
      pendingAssistant = undefined;
      flushTimer = undefined;
    };
    agent.subscribe((event: AgentEvent) => {
      if (event.type === "message_start" && event.message.role === "assistant") {
        assistantItem = this.events.transaction(() => {
          const item = this.database.insertMessage({
            sessionId,
            runId,
            role: "assistant",
            status: "streaming",
            content: textFromMessage(event.message),
          });
          this.events.emit(sessionId, runId, "message.started", item);
          return item;
        });
      } else if (event.type === "message_update" && event.message.role === "assistant" && assistantItem) {
        pendingAssistant = event.message;
        assistantItem = {
          ...assistantItem,
          content: textFromMessage(event.message),
          updatedAt: Date.now(),
        };
        flushTimer ??= setTimeout(flushAssistant, 250);
      } else if (event.type === "message_end" && event.message.role === "assistant" && assistantItem) {
        const message = event.message;
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = undefined;
        pendingAssistant = undefined;
        const status =
          message.stopReason === "error"
            ? "error"
            : message.stopReason === "aborted"
              ? "cancelled"
              : "complete";
        const session = this.database.getSession(sessionId);
        this.events.transaction(() => {
          const item = this.database.updateMessage(assistantItem?.id as string, {
            content: textFromMessage(message),
            status,
            payload: message,
          });
          this.database.addModelCall({
            runId,
            provider: session.model.provider,
            model: session.model.id,
            role: "default",
            status: message.stopReason,
            usage: message.usage,
            ...(message.errorMessage ? { error: message.errorMessage } : {}),
          });
          this.database.addAudit({
            runId,
            kind: "model",
            name: `${session.model.provider}/${session.model.id}`,
            output: { text: item.content },
            status: message.stopReason,
            usage: message.usage,
            ...(message.errorMessage ? { error: message.errorMessage } : {}),
          });
          this.database.createCheckpoint({
            runId,
            phase: "model",
            turnCount: turnCount(),
            lastMessageSequence: item.sequence,
            contextSummarySequence: this.database.getContextSummary(sessionId)?.throughSequence,
            safeToResume: true,
          });
          this.events.emit(sessionId, runId, "message.completed", item);
        });
        assistantItem = undefined;
      } else if (event.type === "tool_execution_start") {
        const created = this.events.transaction(() => {
          this.database.createToolCall({
            id: event.toolCallId,
            runId,
            name: event.toolName,
            args: event.args,
          });
          const action =
            this.database.getRunActionByToolCall(runId, event.toolCallId) ??
            this.database.createRunAction({
              runId,
              checkpointId: this.database.getLatestCheckpoint(runId)?.id,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              toolClass: this.permissions.classify(event.toolName),
              idempotencyKey: `${runId}:${event.toolCallId}`,
              input: event.args,
            });
          this.database.addAudit({
            runId,
            kind: "tool",
            name: event.toolName,
            input: event.args,
            status: "started",
          });
          const item = this.database.insertMessage({
            sessionId,
            runId,
            role: "tool",
            status: "streaming",
            name: event.toolName,
            content: JSON.stringify(event.args, null, 2),
          });
          this.events.emit(sessionId, runId, "tool.started", {
            item,
            action,
            toolCallId: event.toolCallId,
            input: event.args,
          });
          return { actionId: action.id, messageId: item.id };
        });
        toolActions.set(event.toolCallId, created.actionId);
        toolMessages.set(event.toolCallId, created.messageId);
      } else if (event.type === "tool_execution_end") {
        const messageId = toolMessages.get(event.toolCallId);
        if (messageId) {
          const content =
            event.result && typeof event.result === "object" && "content" in event.result
              ? textFromMessage({
                  role: "toolResult",
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  content: (event.result as ToolResultMessage).content,
                  isError: event.isError,
                  timestamp: Date.now(),
                })
              : JSON.stringify(event.result);
          this.events.transaction(() => {
            this.database.completeToolCall(event.toolCallId, event.result, event.isError);
            const actionId = toolActions.get(event.toolCallId);
            if (actionId)
              this.database.updateRunAction(actionId, {
                status: event.isError ? "failed" : "completed",
                result: event.result,
              });
            this.database.addAudit({
              runId,
              kind: "tool",
              name: event.toolName,
              output: event.result,
              status: event.isError ? "error" : "completed",
            });
            const item = this.database.updateMessage(messageId, {
              content,
              status: event.isError ? "error" : "complete",
            });
            this.database.createCheckpoint({
              runId,
              phase: "tool",
              turnCount: turnCount(),
              lastMessageSequence: item.sequence,
              contextSummarySequence: this.database.getContextSummary(sessionId)?.throughSequence,
              safeToResume: !event.isError,
            });
            this.events.emit(sessionId, runId, "tool.completed", {
              item,
              toolCallId: event.toolCallId,
              isError: event.isError,
            });
          });
        }
      } else if (event.type === "message_end" && event.message.role === "toolResult") {
        const messageId = toolMessages.get(event.message.toolCallId);
        if (messageId) this.database.updateMessage(messageId, { payload: event.message });
      }
    });
  }

  private async verifyAndCorrect(
    session: Session,
    runId: string,
    decision: PreflightDecision,
    signal: AbortSignal,
  ): Promise<void> {
    const snapshot = this.database.getSnapshot(session.id);
    const final = [...snapshot.transcript]
      .reverse()
      .find((item) => item.runId === runId && item.role === "assistant" && item.status === "complete");
    if (!final) throw new Error("Planned run produced no final response");
    const response = await this.models.models.completeSimple(
      this.models.get(session.model),
      {
        systemPrompt:
          'Verify whether the result satisfies the goal and success criteria. Return JSON only: {"accepted":boolean,"feedback":string}. Do not include chain-of-thought.',
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              goal: decision.goal,
              successCriteria: decision.successCriteria,
              result: final.content,
            }),
            timestamp: Date.now(),
          },
        ],
      },
      { signal, temperature: 0 },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted")
      throw new Error(response.errorMessage ?? "Verification failed");
    const verdict = extractJson(contentText(response.content)) as Record<string, unknown>;
    if (verdict.accepted === true) return;
    const feedback =
      typeof verdict.feedback === "string"
        ? verdict.feedback
        : "Review the result and correct remaining issues.";
    const internal: Message = {
      role: "user",
      content: `Verifier feedback: ${feedback}\nCorrect the result once, using tools if necessary.`,
      timestamp: Date.now(),
    };
    this.database.insertMessage({
      sessionId: session.id,
      runId,
      role: "tool",
      status: "complete",
      name: "verification",
      content: feedback,
      payload: internal,
    });
    const history = this.database.listAgentMessages(session.id).map((stored) => stored.message);
    const agent = new Agent({
      initialState: {
        systemPrompt:
          "Correct the preceding result according to verifier feedback. Do not expose private chain-of-thought.",
        model: this.models.get(session.model),
        thinkingLevel: session.thinkingLevel,
        tools: [] as AgentTool[],
        messages: history.slice(0, -1),
      },
      streamFn: this.models.models.streamSimple.bind(this.models.models),
    });
    this.bindAgentEvents(agent, session.id, runId);
    await agent.prompt(internal);
    if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
  }

  private requestApproval(
    sessionId: string,
    runId: string,
    toolCallId: string,
    toolName: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<boolean> {
    let waiting: Promise<boolean> | undefined;
    this.events.transaction(() => {
      const approval = this.database.createApproval({ sessionId, runId, toolCallId, toolName, args });
      this.database.addAudit({
        runId,
        kind: "approval",
        name: toolName,
        input: { toolCallId },
        status: "pending",
      });
      waiting = new Promise<boolean>((resolve) => {
        const finish = (approved: boolean) => {
          signal.removeEventListener("abort", abort);
          resolve(approved);
        };
        const abort = () => {
          const pending = this.approvals.get(approval.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.approvals.delete(approval.id);
          this.events.transaction(() => {
            const expired = this.database.expireApproval(approval.id);
            this.database.addAudit({
              runId,
              kind: "approval",
              name: toolName,
              input: { toolCallId },
              status: "expired",
            });
            this.events.emit(sessionId, runId, "approval.resolved", expired);
          });
          finish(false);
        };
        const timer = setTimeout(abort, this.config.runtime.approvalTimeoutMs);
        this.approvals.set(approval.id, { resolve: finish, timer });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      this.events.emit(sessionId, runId, "approval.requested", approval);
    });
    return waiting as Promise<boolean>;
  }
}
