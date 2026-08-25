import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Agent, type AgentEvent, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  contentText,
  type Message,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type {
  AgentProfile,
  Approval,
  Attachment,
  BackgroundTask,
  CreateEvaluationReport,
  CreateScheduledTaskRequest,
  CreateSessionRequest,
  EvaluationTrend,
  InteractionMode,
  ModelRef,
  OptimizationProposal,
  PublicConfig,
  QualityAssessment,
  ReloadResult,
  ResourceSnapshot,
  Run,
  RunAction,
  RunActionDecision,
  RunCheckpoint,
  SendMessageRequest,
  Session,
  SessionSnapshot,
  SkillInstallRequest,
  SkillPackage,
  SkillSummary,
  TraceQuery,
  TranscriptItem,
  UpdateScheduledTaskRequest,
} from "@uma-agent/protocol";
import Value from "typebox/value";
import { ContextManager } from "./context-manager.js";
import { UmaDatabase } from "./database.js";
import { EmbeddingService } from "./embedding.js";
import { EventHub, type EventListener, type ResourceListener } from "./events.js";
import { KnowledgeService } from "./knowledge.js";
import { McpManager } from "./mcp.js";
import { ModelRegistry } from "./models.js";
import { PermissionPolicy } from "./permissions.js";
import { RunApprovals } from "./run-approvals.js";
import { RunContextBuilder } from "./run-context.js";
import { RunOrchestrator } from "./run-orchestrator.js";
import { RunPreflight } from "./run-preflight.js";
import { RunQualityService } from "./run-quality.js";
import { RuntimeOptimizationService } from "./runtime-optimization.js";
import { RuntimeOptimizationExecutionService } from "./runtime-optimization-execution.js";
import { RuntimeQualityOperations } from "./runtime-quality-operations.js";
import { RuntimeResourceService } from "./runtime-resources.js";
import { RuntimeShortcutService } from "./runtime-shortcuts.js";
import {
  extractJson,
  injectRuntimeFault,
  isSecretLike,
  MemoryExtractionSchema,
  Semaphore,
  textFromMessage,
  VerificationSchema,
} from "./runtime-support.js";
import { SchedulerService } from "./scheduler.js";
import { SearchService } from "./search.js";
import { SkillPackageService } from "./skill-packages.js";
import { SkillRegistry } from "./skills.js";
import { StateLock } from "./state-lock.js";
import { ToolLoopGuard } from "./tool-loop-guard.js";
import { createBuiltinTools } from "./tools.js";
import { type TraceContext, TraceService } from "./trace.js";
import type { PreflightDecision, RuntimeHealth, UmaConfig } from "./types.js";
import { WorkspacePolicy } from "./workspace.js";

export class UmaRuntime {
  readonly database: UmaDatabase;
  readonly knowledge: KnowledgeService;
  models: ModelRegistry;
  readonly skills: SkillRegistry;
  readonly skillPackages: SkillPackageService;
  readonly scheduler: SchedulerService;
  readonly search = new SearchService();
  readonly embedding: EmbeddingService;
  mcp = new McpManager();
  readonly workspacePolicy: WorkspacePolicy;
  private contextManager: ContextManager;
  private readonly events: EventHub;
  private readonly orchestrator: RunOrchestrator;
  private contextBuilder: RunContextBuilder;
  private preflight: RunPreflight;
  private quality: RunQualityService;
  private readonly qualityOperations: RuntimeQualityOperations;
  private readonly optimization: RuntimeOptimizationService;
  readonly optimizationExecution: RuntimeOptimizationExecutionService;
  private readonly resources: RuntimeResourceService;
  private readonly shortcuts: RuntimeShortcutService;
  private readonly controllers = new Map<string, AbortController>();
  private readonly preemptedRuns = new Set<string>();
  private readonly approvals: RunApprovals;
  private readonly stateLock: StateLock;
  readonly permissions = new PermissionPolicy();
  private readonly taskSemaphore = new Semaphore(4);
  private readonly taskControllers = new Map<string, AbortController>();
  private resourceTimer: NodeJS.Timeout | undefined;
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private previousCpu = process.cpuUsage();
  private readonly trace: TraceService;
  private readonly activeTraces = new Map<string, TraceContext>();
  private started = false;
  private stopping = false;
  private stopPromise: Promise<void> | undefined;

  config: UmaConfig;

  constructor(config: UmaConfig) {
    this.config = config;
    this.stateLock = StateLock.acquire(config.server.stateDir);
    try {
      this.database = new UmaDatabase(config.server.stateDir);
      this.trace = new TraceService(this.database);
    } catch (error) {
      this.stateLock.release();
      throw error;
    }
    this.events = new EventHub(this.database);
    this.embedding = new EmbeddingService(config.embedding);
    this.knowledge = new KnowledgeService(
      this.database,
      config.server.workspaceRoots,
      config.server.stateDir,
      this.embedding,
      () => this.invalidateResource("knowledge"),
    );
    this.models = new ModelRegistry(config);
    this.skills = new SkillRegistry(config.skillsDirs, { includeBuiltins: true });
    this.skillPackages = new SkillPackageService(config.server.stateDir, this.database, this.skills, () =>
      this.invalidateResource("skills"),
    );
    this.contextManager = new ContextManager(this.database, this.models);
    this.contextBuilder = new RunContextBuilder(
      this.database,
      this.models,
      this.contextManager,
      this.knowledge,
      this.skills,
      this.permissions,
    );
    this.preflight = new RunPreflight(this.database, this.models);
    this.quality = new RunQualityService(this.preflight);
    this.orchestrator = new RunOrchestrator(config.runtime.maxParallelSessions);
    this.qualityOperations = new RuntimeQualityOperations({
      database: this.database,
      events: this.events,
      orchestrator: this.orchestrator,
      controllers: this.controllers,
      isAcceptingRuns: () => this.started && !this.stopping,
      getQualityService: () => this.quality,
      getReasoningModel: () => this.models.snapshot(this.config.roles.reasoning),
      trace: this.trace,
    });
    this.optimization = new RuntimeOptimizationService(this.database, () =>
      this.invalidateResource("optimization"),
    );
    this.approvals = new RunApprovals(this.database, this.events, config.runtime.approvalTimeoutMs);
    this.scheduler = new SchedulerService(this.database, this, () => this.invalidateResource("schedules"));
    this.workspacePolicy = new WorkspacePolicy(config.server.workspaceRoots);
    this.optimizationExecution = new RuntimeOptimizationExecutionService(this.database, this.workspacePolicy);
    this.resources = new RuntimeResourceService({
      database: this.database,
      events: this.events,
      models: this.models,
      mcp: this.mcp,
      scheduler: this.scheduler,
      skills: this.skills,
      skillPackages: this.skillPackages,
      optimization: this.optimization,
      config: () => this.config,
      invalidate: (resource) => this.invalidateResource(resource),
    });
    this.shortcuts = new RuntimeShortcutService({
      database: this.database,
      health: () => this.health(),
      listModels: () => this.listModels(),
      publicConfig: () => this.publicConfig(),
      getSnapshot: (sessionId) => this.getSnapshot(sessionId),
      listTasks: (ownerId) => this.listTasks(ownerId),
      listScheduledTasks: (ownerId) => this.listScheduledTasks(ownerId),
      listMemoryFacts: (status, ownerId) => this.listMemoryFacts(status, ownerId),
      listEvaluationReports: (limit) => this.listEvaluationReports(limit),
      listOptimizationProposals: () => this.listOptimizationProposals(),
      listKnowledge: (ownerId) => this.listKnowledge(ownerId),
      refreshSkills: async () => this.refreshSkills(),
      getTask: (id) => this.getTask(id),
      cancelTask: (id) => this.cancelTask(id),
      deleteTask: (id) => this.deleteTask(id),
      listKnowledgeSearch: (query, ownerId) => this.knowledge.search(query, 20, undefined, ownerId),
    });
  }

  async start(): Promise<void> {
    if (this.stopping || this.stopPromise) throw new Error("UmaRuntime cannot restart after stopping");
    if (this.started) throw new Error("UmaRuntime is already started");
    await this.workspacePolicy.initialize();
    await this.skillPackages.initialize();
    await this.skills.refresh();
    this.skills.startWatching(() => this.invalidateResource("skills"));
    await this.mcp.connect(this.config.mcpServers, this.config.runtime.toolTimeoutMs);
    this.scheduler.start();
    this.eventLoopDelay.enable();
    this.resourceTimer = setInterval(() => this.captureResourceSnapshot(), 30_000);
    this.captureResourceSnapshot();
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopPromise ??= this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    this.stopping = true;
    this.scheduler.stop();
    if (this.resourceTimer) clearInterval(this.resourceTimer);
    this.resourceTimer = undefined;
    this.eventLoopDelay.disable();
    this.skills.stopWatching();
    this.approvals.rejectAll();
    for (const controller of this.controllers.values()) controller.abort();
    await this.orchestrator.drain();
    await this.scheduler.drain();
    await this.mcp.close();
    this.database.close();
    this.stateLock.release();
    this.started = false;
  }

  health(): RuntimeHealth {
    return {
      activeRuns: this.orchestrator.activeCount(),
      started: this.started,
      databaseReady: this.database.isReady(),
    };
  }

  private captureResourceSnapshot(): void {
    try {
      const currentCpu = process.cpuUsage();
      const cpuUserMicros = Math.max(0, currentCpu.user - this.previousCpu.user);
      const cpuSystemMicros = Math.max(0, currentCpu.system - this.previousCpu.system);
      this.previousCpu = currentCpu;
      const memory = process.memoryUsage();
      let walBytes = 0;
      try {
        walBytes = statSync(`${this.config.server.stateDir}/state.db-wal`).size;
      } catch {
        /* WAL may be checkpointed. */
      }
      const queuedRuns = this.database
        .listSessions()
        .reduce((sum, session) => sum + this.database.listQueuedRuns(session.id).length, 0);
      const snapshot: ResourceSnapshot = {
        id: randomUUID(),
        capturedAt: Date.now(),
        cpuUserMicros,
        cpuSystemMicros,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
        eventLoopDelayMs: Number(this.eventLoopDelay.mean / 1e6 || 0),
        walBytes,
        activeRuns: this.orchestrator.activeCount(),
        queuedRuns,
      };
      this.database.insertResourceSnapshot(snapshot);
      this.eventLoopDelay.reset();
    } catch (error) {
      process.emitWarning(
        `Resource snapshot failed: ${error instanceof Error ? error.name : "UnknownError"}`,
        {
          code: "UMA_RESOURCE_SNAPSHOT",
        },
      );
    }
  }

  async reloadConfig(next: UmaConfig): Promise<ReloadResult> {
    const applied: string[] = [];
    const restartRequired: string[] = [];
    const changed = (left: unknown, right: unknown) => JSON.stringify(left) !== JSON.stringify(right);
    if (changed(this.config.server, next.server)) restartRequired.push("server");
    if (changed(this.config.auth, next.auth)) restartRequired.push("auth");
    if (changed(this.config.runtime, next.runtime)) restartRequired.push("runtime");
    if (changed(this.config.embedding, next.embedding)) restartRequired.push("embedding");
    const modelChanged = changed(
      {
        models: this.config.models,
        defaultModel: this.config.defaultModel,
        defaultThinkingLevel: this.config.defaultThinkingLevel,
        roles: this.config.roles,
      },
      {
        models: next.models,
        defaultModel: next.defaultModel,
        defaultThinkingLevel: next.defaultThinkingLevel,
        roles: next.roles,
      },
    );
    const skillsChanged = changed(this.config.skillsDirs, next.skillsDirs);
    const mcpChanged = changed(this.config.mcpServers, next.mcpServers);
    const hasQueued = this.database
      .listSessions()
      .some((session) =>
        this.database
          .listRuns(session.id)
          .some((run) =>
            ["queued", "preflight", "running", "verifying", "awaiting_input"].includes(run.status),
          ),
      );
    if (hasQueued && modelChanged) restartRequired.push("models", "roles");
    if (hasQueued && mcpChanged) restartRequired.push("mcpServers");
    const nextModels = !hasQueued && modelChanged ? new ModelRegistry(next) : this.models;
    let nextMcp: McpManager | undefined;
    if (!hasQueued && mcpChanged) {
      nextMcp = new McpManager();
      await nextMcp.connect(next.mcpServers, next.runtime.toolTimeoutMs);
      if (nextMcp.status().some((server) => !server.connected)) {
        const errors = nextMcp
          .status()
          .filter((server) => !server.connected)
          .map((server) => server.error);
        await nextMcp.close();
        throw new Error(`MCP reload failed: ${errors.join("; ")}`);
      }
    }
    const previousMcp = this.mcp;
    if (!hasQueued && modelChanged) {
      this.models = nextModels;
      this.contextManager = new ContextManager(this.database, this.models);
      this.contextBuilder = new RunContextBuilder(
        this.database,
        this.models,
        this.contextManager,
        this.knowledge,
        this.skills,
        this.permissions,
      );
      this.preflight = new RunPreflight(this.database, this.models);
      this.quality = new RunQualityService(this.preflight);
      applied.push("models", "roles");
    }
    if (!hasQueued && nextMcp) {
      this.mcp = nextMcp;
      applied.push("mcpServers");
      await previousMcp.close();
    }
    if (skillsChanged) {
      this.skills.stopWatching();
      this.skillPackages.reconfigureRoots(next.skillsDirs);
      await this.skills.refresh();
      this.skills.startWatching(() => this.invalidateResource("skills"));
      applied.push("skills");
    }
    this.config = {
      ...this.config,
      ...(!hasQueued && modelChanged
        ? {
            models: next.models,
            defaultModel: next.defaultModel,
            defaultThinkingLevel: next.defaultThinkingLevel,
            roles: next.roles,
          }
        : {}),
      ...(skillsChanged ? { skillsDirs: next.skillsDirs } : {}),
      ...(!hasQueued && mcpChanged ? { mcpServers: next.mcpServers } : {}),
    };
    this.invalidateResource("config");
    if (skillsChanged) this.invalidateResource("skills");
    return { applied, restartRequired: [...new Set(restartRequired)] };
  }
  subscribe(listener: EventListener): () => void {
    return this.events.subscribe(listener);
  }
  subscribeResources(listener: ResourceListener): () => void {
    return this.events.subscribeResources(listener);
  }
  invalidateResource(
    resource:
      | "tasks"
      | "schedules"
      | "memory"
      | "knowledge"
      | "skills"
      | "profile"
      | "quality"
      | "config"
      | "evaluations"
      | "optimization",
    ownerId?: string,
  ): void {
    this.events.transaction(() => this.events.invalidate(resource, ownerId));
  }
  listSessions(userId?: string): Session[] {
    return userId ? this.database.listUserSessions(userId) : this.resources.listSessions();
  }
  getSnapshot(id: string): SessionSnapshot {
    return this.resources.getSnapshot(id);
  }
  listModels(): ModelRef[] {
    return this.resources.listModels();
  }
  listTasks(userId?: string): BackgroundTask[] {
    return this.resources.listTasks(userId);
  }
  deleteTask(id: string): void {
    this.resources.deleteTask(id);
  }
  listEvaluationReports(limit?: number) {
    return this.resources.listEvaluationReports(limit);
  }

  listEvaluationTrends(from: number, to: number, groupBy: "day" | "suite" | "mode"): EvaluationTrend[] {
    return this.resources.listEvaluationTrends(from, to, groupBy);
  }
  getEvaluationReport(id: string) {
    return this.resources.getEvaluationReport(id);
  }
  createEvaluationReport(input: CreateEvaluationReport) {
    return this.resources.createEvaluationReport(input);
  }
  publicConfig(): PublicConfig {
    return this.resources.publicConfig();
  }
  listScheduledTasks(ownerId?: string) {
    return this.resources.listScheduledTasks(ownerId);
  }
  createScheduledTask(input: CreateScheduledTaskRequest, ownerId?: string) {
    return this.resources.createScheduledTask(input, ownerId);
  }
  updateScheduledTask(id: string, input: UpdateScheduledTaskRequest) {
    return this.resources.updateScheduledTask(id, input);
  }
  deleteScheduledTask(id: string): void {
    this.resources.deleteScheduledTask(id);
  }
  runScheduledTask(id: string) {
    return this.resources.runScheduledTask(id);
  }
  listScheduledTaskRuns(id: string) {
    return this.resources.listScheduledTaskRuns(id);
  }
  getScheduledTaskRun(id: string) {
    return this.resources.getScheduledTaskRun(id);
  }
  cancelScheduledTaskRun(id: string) {
    return this.resources.cancelScheduledTaskRun(id);
  }
  listSessionEvents(sessionId: string, afterSequence: number, limit?: number) {
    return this.resources.listSessionEvents(sessionId, afterSequence, limit);
  }
  listSessionHistory(sessionId: string, beforeSequence?: number, limit?: number) {
    return this.resources.listSessionHistory(sessionId, beforeSequence, limit);
  }
  getRun(runId: string): Run {
    return this.resources.getRun(runId);
  }
  listRunActions(runId: string): RunAction[] {
    return this.resources.listRunActions(runId);
  }
  listRunCheckpoints(runId: string): RunCheckpoint[] {
    return this.resources.listRunCheckpoints(runId);
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
    const backgroundTask = this.database.findBackgroundTaskByRunId(runId);
    if (backgroundTask) {
      this.events.transaction(() => {
        const updated = this.database.updateBackgroundTask(backgroundTask.id, {
          status: "running",
          error: null,
        });
        this.events.emit(updated.sessionId, undefined, "task.updated", updated);
        this.events.invalidate("tasks");
      });
      this.watchResumedBackgroundTask(backgroundTask.id, runId);
      this.scheduler.onRunResumed(runId);
    }
    this.orchestrator.enqueue(session.id, async () => {
      await this.replaySafeActions(run);
      await this.executeRun(
        session,
        runId,
        { messageId: message.id, text: message.content, mode: run.interactionMode },
        undefined,
        true,
      );
    });
    return resumed;
  }

  confirmPlan(runId: string): Run {
    const run = this.database.getRun(runId);
    if (run.status !== "awaiting_confirmation") throw new Error("Run is not awaiting plan confirmation");
    const message = this.database.getMessage(run.messageId);
    const session = this.database.getSession(run.sessionId);
    const confirmed = this.events.transaction(() => {
      const value = this.database.updateRun(runId, { status: "queued", error: null });
      this.events.emit(session.id, runId, "run.resumed", value);
      return value;
    });
    this.orchestrator.enqueue(session.id, () =>
      this.executeRun(
        session,
        runId,
        { messageId: message.id, text: message.content, mode: "plan" },
        undefined,
        true,
      ),
    );
    return confirmed;
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
      const acknowledged = this.events.transaction(() => {
        const transition = this.database.transitionRunAction(actionId, ["uncertain"], {
          status: "acknowledged",
        });
        if (!transition.changed) return transition.action;
        const updated = transition.action;
        this.events.emit(run.sessionId, runId, "run.action_decided", { action: updated, decision });
        return updated;
      });
      if (acknowledged.status === "acknowledged") await this.reconcileAcknowledgedAction(run, acknowledged);
      return acknowledged;
    }
    return this.executePreparedAction(run, action);
  }

  async compactSession(sessionId: string): Promise<{ throughSequence: number; content: string }> {
    const session = this.database.getSession(sessionId);
    const result = await this.contextManager.compact(
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
  async createTask(
    prompt: string,
    parentSessionId?: string,
    source?: BackgroundTask["source"],
    ownerId?: string,
  ): Promise<BackgroundTask> {
    if (!prompt.trim()) throw new Error("Task prompt is required");
    if (!ownerId || ownerId === "system") throw new Error("Task owner is required");
    const parent = parentSessionId ? this.database.getSession(parentSessionId) : undefined;
    const session = await this.createSession(
      {
        ...(parent?.workspace ? { workspace: parent.workspace } : {}),
        ...(parent?.model ? { model: parent.model } : {}),
      },
      ownerId,
    );
    const task = this.events.transaction(() => {
      const value = this.database.createBackgroundTask({
        id: randomUUID(),
        sessionId: session.id,
        prompt,
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(source ? { source } : {}),
      });
      this.events.emit(session.id, undefined, "task.updated", value);
      this.events.invalidate("tasks");
      return value;
    });
    void this.executeTask(task.id);
    return task;
  }
  prepareScheduledTask(prompt: string, source: NonNullable<BackgroundTask["source"]>): BackgroundTask {
    if (!prompt.trim()) throw new Error("Task prompt is required");
    const ownerId = this.database.scheduledTaskOwner(source.scheduleId);
    if (!ownerId) throw new Error("Scheduled task owner is missing");
    const session = this.database.createSession({
      userId: ownerId,
      title: "Scheduled task",
      workspace: this.config.server.workspaceRoots[0] as string,
      model: this.config.defaultModel,
      thinkingLevel: this.config.defaultThinkingLevel,
    });
    return this.database.createBackgroundTask({
      id: randomUUID(),
      sessionId: session.id,
      prompt,
      source,
    });
  }
  startTask(id: string): void {
    void this.executeTask(id);
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
        this.events.invalidate("tasks");
        return updated;
      });
    }
    return task;
  }
  listMemoryFacts(status?: "active" | "candidate" | "superseded" | "rejected", ownerId?: string) {
    return this.resources.listMemoryFacts(status, ownerId);
  }
  listKnowledge(ownerId?: string) {
    return this.knowledge.list(ownerId);
  }
  createMemoryFact(sessionId: string, scope: "global" | "session", content: string, ownerId?: string) {
    this.database.getSession(sessionId);
    const owner = ownerId ?? this.database.sessionOwner(sessionId) ?? "system";
    const normalized = content.trim();
    if (!normalized) throw new Error("Memory content is required");
    if (isSecretLike(normalized)) throw new Error("Memory content appears to contain a secret");
    return this.events.transaction(() => {
      const fact = this.database.addMemoryFact({
        ownerId: owner,
        sessionId,
        scope,
        key: `explicit.${normalized
          .slice(0, 80)
          .normalize("NFKC")
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, ".")}`,
        value: normalized,
        category: "explicit",
        confidence: 1,
        evidence: normalized,
        status: "active",
      });
      this.events.emit(sessionId, undefined, "memory.updated", fact);
      this.events.invalidate("memory", owner);
      return fact;
    });
  }
  reviewMemoryFact(id: string, status: "active" | "candidate" | "superseded" | "rejected") {
    return this.events.transaction(() => {
      const fact = this.database.updateMemoryFact(id, status);
      if (fact.sessionId) {
        this.events.emit(fact.sessionId, fact.sourceRunId, "memory.updated", fact);
      } else if (fact.sourceRunId) {
        const run = this.database.getRun(fact.sourceRunId);
        this.events.emit(run.sessionId, run.id, "memory.updated", fact);
      }
      this.events.invalidate("memory", this.database.memoryOwner(id));
      return fact;
    });
  }
  deleteMemoryFact(id: string): void {
    const fact = this.database.getMemoryFact(id);
    const owner = this.database.memoryOwner(id);
    if (!fact.sessionId) {
      this.database.deleteMemoryFact(id);
      this.invalidateResource("memory", owner);
      return;
    }
    this.events.transaction(() => {
      this.database.deleteMemoryFact(id);
      this.events.emit(fact.sessionId as string, fact.sourceRunId, "memory.updated", {
        ...fact,
        deleted: true,
      });
      this.events.invalidate("memory", owner);
    });
  }
  audit(runId: string) {
    return this.resources.audit(runId);
  }
  listTrace(query: TraceQuery) {
    return this.database.listTrace(query);
  }
  listResourceSnapshots(from = 0, to = Date.now(), limit = 500) {
    return this.database.listResourceSnapshots(from, to, limit);
  }
  listSkills(): SkillSummary[] {
    return this.resources.listSkills();
  }
  refreshSkills(): Promise<SkillSummary[]> {
    return this.resources.refreshSkills();
  }

  listSkillPackages(): SkillPackage[] {
    return this.resources.listSkillPackages();
  }

  searchSkills(query: string): Promise<Array<Record<string, unknown>>> {
    return this.resources.searchSkills(query);
  }

  installSkill(input: SkillInstallRequest): Promise<SkillPackage> {
    return this.resources.installSkill(input);
  }

  setSkillStatus(id: string, status: "enabled" | "disabled" | "rejected"): Promise<SkillPackage> {
    return this.resources.setSkillStatus(id, status);
  }

  getAgentProfile(userId = "system"): AgentProfile {
    return this.resources.getAgentProfile(userId);
  }

  updateAgentProfile(content: string, userId = "system"): AgentProfile {
    return this.resources.updateAgentProfile(content, userId);
  }

  searchHistory(sessionId: string, query: string, limit?: number): TranscriptItem[] {
    return this.resources.searchHistory(sessionId, query, limit);
  }

  listActivity(sessionId: string, limit?: number): Array<Record<string, unknown>> {
    return this.resources.listActivity(sessionId, limit);
  }

  listOptimizationProposals(): OptimizationProposal[] {
    return this.resources.listOptimizationProposals();
  }

  generateOptimizationProposals(from = 0, to = Date.now()): OptimizationProposal[] {
    return this.resources.generateOptimizationProposals(from, to);
  }

  decideOptimizationProposal(id: string, status: "accepted" | "rejected"): OptimizationProposal {
    return this.resources.decideOptimizationProposal(id, status);
  }

  executeShortcut(
    sessionId: string,
    command: string,
    ownerId: string | undefined,
    reloadConfig?: () => Promise<ReloadResult>,
  ) {
    return this.shortcuts.execute(sessionId, command, ownerId, reloadConfig);
  }

  listQualityAssessments(runId: string): QualityAssessment[] {
    return this.resources.listQualityAssessments(runId);
  }

  private transitionRun(
    sessionId: string,
    runId: string,
    patch: Parameters<UmaDatabase["updateRun"]>[1],
  ): Run {
    return this.events.transaction(() => {
      const run = this.database.updateRun(runId, patch);
      this.events.emit(sessionId, runId, "run.updated", run);
      const response = this.database.responseForRun(runId);
      if (response) {
        const status =
          run.status === "queued"
            ? "queued"
            : run.status === "preflight"
              ? "thinking"
              : run.status === "awaiting_input"
                ? "clarifying"
                : run.status === "awaiting_confirmation"
                  ? "awaiting_confirmation"
                  : run.status === "verifying"
                    ? "verifying"
                    : run.status === "running"
                      ? "executing"
                      : run.status === "completed"
                        ? "completed"
                        : run.status === "cancelled"
                          ? "cancelled"
                          : run.status === "failed" || run.status === "interrupted"
                            ? "failed"
                            : undefined;
        if (status) {
          const updated = this.database.updateResponse(response.id, {
            status,
            ...(run.error ? { content: run.error } : {}),
          });
          this.database.addResponseActivity({
            responseId: response.id,
            kind: "status",
            status,
            ...(run.error ? { text: run.error } : {}),
          });
          this.events.emit(sessionId, runId, "response.updated", updated);
          this.events.emit(sessionId, runId, "response.activity", {
            responseId: response.id,
            status,
            ...(run.error ? { text: run.error } : {}),
          });
        }
      }
      return run;
    });
  }

  async createSession(input: CreateSessionRequest = {}, ownerId: string): Promise<Session> {
    if (!ownerId || ownerId === "system") throw new Error("Session owner is required");
    const userWorkspace = join(this.config.server.workspaceRoots[0] as string, "users", ownerId);
    await mkdir(userWorkspace, { recursive: true });
    const requestedWorkspace = process.env.NODE_ENV === "test" ? input.workspace : undefined;
    const workspace = await this.workspacePolicy.validateWorkspace(requestedWorkspace ?? userWorkspace);
    const model = input.model ?? this.config.defaultModel;
    this.models.get(model);
    return this.database.createSession({
      userId: ownerId,
      title: input.title ?? "New session",
      ...(workspace ? { workspace } : {}),
      model,
      thinkingLevel: this.config.defaultThinkingLevel,
      ...(input.queueMode ? { queueMode: input.queueMode } : {}),
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
        this.events.invalidate("tasks");
        return value;
      });
      const run = this.sendMessage(task.sessionId, {
        messageId: randomUUID(),
        text: task.prompt,
        mode: "agent",
      });
      this.events.transaction(() => {
        const updated = this.database.updateBackgroundTask(id, { runId: run.id });
        this.events.emit(task.sessionId, undefined, "task.updated", updated);
        this.events.invalidate("tasks");
      });
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
            this.events.invalidate("tasks");
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
        this.events.invalidate("tasks");
      });
    } finally {
      this.taskControllers.delete(id);
      release();
    }
  }

  private watchResumedBackgroundTask(taskId: string, runId: string): void {
    const off = this.subscribe((event) => {
      if (event.runId !== runId || event.type !== "run.updated") return;
      const run = event.payload as Run;
      if (!["completed", "failed", "cancelled", "interrupted"].includes(run.status)) return;
      off();
      const task = this.database.getBackgroundTask(taskId);
      const snapshot = this.database.getSnapshot(task.sessionId);
      const final = [...snapshot.transcript]
        .reverse()
        .find((item) => item.runId === runId && item.role === "assistant");
      this.events.transaction(() => {
        const updated = this.database.updateBackgroundTask(
          taskId,
          run.status === "completed"
            ? { status: "completed", ...(final?.content ? { result: final.content } : {}) }
            : {
                status:
                  run.status === "failed" || run.status === "cancelled" || run.status === "interrupted"
                    ? run.status
                    : "failed",
                ...(run.error ? { error: run.error } : {}),
              },
        );
        this.events.emit(task.sessionId, undefined, "task.updated", updated);
        this.events.invalidate("tasks");
      });
    });
  }

  updateSession(
    id: string,
    patch: {
      title?: string;
      model?: ModelRef;
      thinkingLevel?: ThinkingLevel;
      queueMode?: Session["queueMode"];
    },
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
    const hasImages = attachmentIds.some((id) =>
      this.database.getAttachment(id)?.mimeType.startsWith("image/"),
    );
    const runModel = this.models.snapshot(hasImages ? this.config.roles.vision : session.model);
    if (hasImages && !runModel.capabilities.vision)
      throw new Error("Configured vision model does not support image input");
    const awaiting = this.database.findAwaitingRun(sessionId);
    if (awaiting && hasImages && !awaiting.model.capabilities.vision)
      throw new Error("The awaiting run model does not support image input; start a new vision run");
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
    if (!continuation && session.queueMode === "preemptive") {
      const active = this.database
        .listRuns(sessionId)
        .find((candidate) => ["preflight", "running", "verifying"].includes(candidate.status));
      if (active) {
        this.events.transaction(() => {
          const pending = this.database.interruptRunActions(
            active.id,
            "Run was preempted by a newer message",
          );
          for (const action of pending) this.events.emit(sessionId, active.id, "run.action_prepared", action);
        });
        this.preemptedRuns.add(active.id);
      }
      this.controllers.get(sessionId)?.abort();
      for (const queued of this.database.listQueuedRuns(sessionId)) {
        this.events.transaction(() => {
          const cancelled = this.database.updateRun(queued.id, {
            status: "cancelled",
            error: "Superseded by a newer message",
          });
          this.events.emit(sessionId, queued.id, "run.updated", cancelled);
        });
      }
    } else if (!continuation && this.database.listQueuedRuns(sessionId).length >= 100) {
      throw new Error("Session queue is full");
    }
    const { run, created } = this.events.transaction(() => {
      const result = continuation
        ? { run: continuation, created: true }
        : this.database.createRun(
            sessionId,
            input.messageId,
            runModel,
            session.thinkingLevel,
            "agent",
            input.mode,
          );
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
      const response = continuation
        ? this.database.responseForRun(result.run.id)
        : this.database.createResponse({
            sessionId,
            runId: result.run.id,
            messageId: input.messageId,
            status: "queued",
          });
      if (continuation && response) {
        const updated = this.database.updateResponse(response.id, { status: "queued" });
        this.events.emit(sessionId, result.run.id, "response.updated", updated);
      }
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
      if (response) this.events.emit(sessionId, result.run.id, "response.started", response);
      return result;
    });
    if (!created) return run;
    const prompt =
      continuation &&
      `${this.database.getMessage(continuation.messageId).content}\n\nClarification: ${input.text}`;
    const enqueue = continuation
      ? this.orchestrator.enqueueFirst.bind(this.orchestrator)
      : this.orchestrator.enqueue.bind(this.orchestrator);
    enqueue(sessionId, () => this.executeRun(session, run.id, input, prompt));
    if (continuation) this.orchestrator.resume(sessionId);
    return run;
  }
  reviewMessage(messageId: string, feedback = ""): Run {
    return this.qualityOperations.start("review", messageId, { feedback });
  }
  improveMessage(messageId: string, options: { force?: boolean; reset?: boolean } = {}): Run {
    return this.qualityOperations.start("improve", messageId, options);
  }
  sendCommand(sessionId: string, command: string, messageId: string = randomUUID()): Run {
    const normalized = command.trim();
    if (!normalized) throw new Error("Command is required");
    if (!this.started || this.stopping) throw new Error("UmaRuntime is not accepting new runs");
    const session = this.database.getSession(sessionId);
    const existing = this.database.findMessageOwner(messageId);
    if (existing) {
      if (existing.sessionId !== sessionId || !existing.runId)
        throw new Error("messageId is already used by another message");
      return this.database.getRun(existing.runId);
    }
    if (this.database.listQueuedRuns(sessionId).length >= 100) throw new Error("Session queue is full");
    const run = this.events.transaction(() => {
      const created = this.database.createRun(
        sessionId,
        messageId,
        this.models.snapshot(session.model),
        session.thinkingLevel,
        "command",
        "agent",
      ).run;
      const message = this.database.insertMessage({
        id: messageId,
        sessionId,
        runId: created.id,
        role: "user",
        status: "complete",
        content: `!${normalized}`,
      });
      this.events.emit(sessionId, created.id, "message.completed", message);
      this.events.emit(sessionId, created.id, "run.updated", created);
      return created;
    });
    this.orchestrator.enqueue(sessionId, () => this.executeCommand(session, run.id, normalized));
    return run;
  }
  private async executeCommand(session: Session, runId: string, command: string): Promise<void> {
    const rootTrace = this.trace.startRoot(runId, session.id, "command", { "run.kind": "command" });
    this.activeTraces.set(runId, rootTrace);
    await this.waitForSideEffectGate(session.id, runId);
    const release = await this.orchestrator.acquire();
    if (this.database.getRun(runId).status === "cancelled") {
      try {
        rootTrace.finish({ status: "cancelled" });
      } finally {
        this.activeTraces.delete(runId);
        release();
      }
      return;
    }
    const controller = new AbortController();
    this.controllers.set(session.id, controller);
    const toolCallId = randomUUID();
    try {
      this.transitionRun(session.id, runId, { status: "running", phase: "execute", error: null });
      const action = this.events.transaction(() => {
        const value = this.database.createRunAction({
          runId,
          checkpointId: this.database.getLatestCheckpoint(runId)?.id,
          toolCallId,
          toolName: "shell",
          toolClass: "shell",
          idempotencyKey: `${runId}:command`,
          input: { command },
        });
        this.events.emit(session.id, runId, "run.action_prepared", value);
        return value;
      });
      const approvalTrace = rootTrace.child("approval", "approval", { tool: "shell" });
      let approved: boolean;
      try {
        approved = await this.approvals.request({
          sessionId: session.id,
          runId,
          toolCallId,
          toolName: "shell",
          args: { command },
          signal: controller.signal,
        });
        approvalTrace.finish(
          approved
            ? { status: "ok" }
            : { status: "error", error: { name: "ApprovalRejected", message: "Approval was rejected" } },
        );
      } catch (error) {
        approvalTrace.finish({
          status: "error",
          error: { name: error instanceof Error ? error.name : "Error", message: String(error) },
        });
        throw error;
      }
      if (!approved) {
        this.events.transaction(() => {
          const rejected = this.database.transitionRunAction(action.id, ["prepared"], {
            status: "rejected",
            error: "Command execution was not approved",
          }).action;
          this.events.emit(session.id, runId, "run.action_decided", { action: rejected, decision: "reject" });
        });
        throw new Error("Command execution was not approved");
      }
      this.database.createToolCall({ id: toolCallId, runId, name: "shell", args: { command } });
      const toolTrace = rootTrace.child("tool", "tool", { tool: "shell" });
      let result: { status: string; error?: string; result?: unknown };
      try {
        result = await this.executeRecoveredAction(
          this.database.getRun(runId),
          action,
          false,
          controller.signal,
        );
        toolTrace.finish({ status: result.status === "completed" ? "ok" : "error" });
      } catch (error) {
        toolTrace.finish({
          status: "error",
          error: { name: error instanceof Error ? error.name : "Error", message: String(error) },
        });
        throw error;
      }
      if (result.status !== "completed") throw new Error(result.error ?? "Command execution failed");
      const output =
        result.result && typeof result.result === "object"
          ? JSON.stringify(result.result, null, 2)
          : String(result.result ?? "Command completed");
      this.events.transaction(() => {
        const message = this.database.insertMessage({
          sessionId: session.id,
          runId,
          role: "assistant",
          status: "complete",
          content: output,
        });
        const completed = this.database.updateRun(runId, { status: "completed", error: null });
        this.events.emit(session.id, runId, "message.completed", message);
        this.events.emit(session.id, runId, "run.updated", completed);
        const response = this.database.responseForRun(runId);
        if (response) {
          this.database.updateResponseAttachmentStatus(response.id, "sent");
          const updated = this.database.updateResponse(response.id, { status: "completed", content: output });
          this.events.emit(session.id, runId, "response.completed", updated);
        }
      });
    } catch (error) {
      rootTrace.setStatus({
        status: "error",
        error: { name: error instanceof Error ? error.name : "Error", message: String(error) },
      });
      const interrupted = this.database.listRunActions(runId).some((action) => action.status === "uncertain");
      this.transitionRun(session.id, runId, {
        status: interrupted ? "interrupted" : controller.signal.aborted ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      try {
        rootTrace.finish();
      } finally {
        this.activeTraces.delete(runId);
        this.controllers.delete(session.id);
        release();
      }
    }
  }

  private async waitForSideEffectGate(sessionId: string, runId: string): Promise<void> {
    while (this.database.hasPendingSideEffects(sessionId)) {
      if (this.stopping || this.database.getRun(runId).status === "cancelled") return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  cancel(sessionId: string): void {
    const controller = this.controllers.get(sessionId);
    if (!controller) throw new Error("Session has no active run");
    controller.abort();
  }

  cancelRun(runId: string): Run {
    const run = this.database.getRun(runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) return run;
    if (run.status === "queued") {
      return this.events.transaction(() => {
        const cancelled = this.database.updateRun(runId, {
          status: "cancelled",
          error: "Cancelled before execution",
        });
        this.events.emit(run.sessionId, runId, "run.updated", cancelled);
        return cancelled;
      });
    }
    const controller = this.controllers.get(run.sessionId);
    if (controller) {
      controller.abort();
      return this.database.getRun(runId);
    }
    throw new Error("Run is not cancellable");
  }

  resolveApproval(id: string, approved: boolean): Approval {
    return this.approvals.resolve(id, approved);
  }

  async addAttachment(input: {
    sessionId?: string;
    responseId?: string;
    name: string;
    mimeType: string;
    data: Uint8Array;
  }): Promise<Attachment> {
    if (input.data.byteLength > this.config.server.maxUploadBytes)
      throw new Error("Upload exceeds configured size limit");
    const extension = input.name.split(".").pop()?.toLowerCase();
    if (["exe", "dll", "so", "dylib", "bat", "cmd", "ps1", "sh", "com"].includes(extension ?? ""))
      throw new Error("Executable attachments are not allowed");
    if (input.responseId) {
      const response = this.database.getResponse(input.responseId);
      const total = response.attachments.reduce((sum, item) => sum + item.size, 0);
      if (total + input.data.byteLength > 100 * 1024 * 1024)
        throw new Error("Response attachment total exceeds 100 MiB");
    }
    const ownerId = input.sessionId ? this.database.sessionOwner(input.sessionId) : undefined;
    if (input.sessionId) this.database.getSession(input.sessionId);
    if (!input.sessionId && process.env.NODE_ENV !== "test") throw new Error("sessionId is required");
    const directory = join(this.config.server.stateDir, "uploads", ownerId ?? "unowned", randomUUID());
    await mkdir(directory, { recursive: true });
    const safeName = input.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "upload";
    const storagePath = join(directory, safeName);
    await import("node:fs/promises").then((fs) => fs.writeFile(storagePath, input.data));
    const attachment = this.database.addAttachment({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.responseId ? { responseId: input.responseId } : {}),
      ...(ownerId ? { ownerUserId: ownerId } : {}),
      name: safeName,
      mimeType: input.mimeType,
      size: input.data.byteLength,
      storagePath,
      sha256: createHash("sha256").update(input.data).digest("hex"),
      status: "ready",
    });
    if (input.responseId && input.sessionId) {
      this.events.transaction(() => {
        const response = this.database.getResponse(input.responseId as string);
        const updated = this.database.updateResponse(response.id, { content: response.content });
        this.database.addResponseActivity({
          responseId: response.id,
          kind: "file",
          status: "completed",
          attachmentId: attachment.id,
          text: attachment.name,
        });
        this.events.emit(input.sessionId as string, response.runId, "response.attachment.updated", {
          responseId: response.id,
          attachment,
          status: "ready",
        });
        this.events.emit(input.sessionId as string, response.runId, "response.updated", updated);
      });
    }
    return attachment;
  }

  getAttachment(id: string): Attachment | undefined {
    return this.database.getAttachment(id);
  }

  getAttachmentPath(id: string): string {
    return this.database.getAttachmentPath(id);
  }

  private async executeRun(
    sessionAtQueueTime: Session,
    runId: string,
    input: SendMessageRequest,
    promptOverride?: string,
    resumeFromCheckpoint = false,
  ): Promise<void> {
    const rootTrace = this.trace.startRoot(runId, sessionAtQueueTime.id, "run", { "run.kind": "agent" });
    this.activeTraces.set(runId, rootTrace);
    await this.waitForSideEffectGate(sessionAtQueueTime.id, runId);
    const release = await this.orchestrator.acquire();
    if (this.database.getRun(runId).status === "cancelled") {
      try {
        rootTrace.finish({ status: "cancelled" });
      } finally {
        this.activeTraces.delete(runId);
        release();
      }
      return;
    }
    if (this.stopping) {
      this.transitionRun(sessionAtQueueTime.id, runId, {
        status: "cancelled",
        error: "Server is shutting down",
      });
      try {
        rootTrace.finish({ status: "cancelled" });
      } finally {
        this.activeTraces.delete(runId);
        release();
      }
      return;
    }
    const controller = new AbortController();
    this.controllers.set(sessionAtQueueTime.id, controller);
    try {
      const storedSession = this.database.getSession(sessionAtQueueTime.id);
      const frozenRun = this.database.getRun(runId);
      const session: Session = {
        ...storedSession,
        model: frozenRun.model.ref,
        thinkingLevel: frozenRun.thinkingLevel,
      };
      this.events.transaction(() => {
        const preflightRun = this.database.updateRun(runId, {
          status: "preflight",
          phase: "preflight",
          error: null,
        });
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
      const preflightTrace = rootTrace.child("preflight", "run");
      const decision =
        resumeFromCheckpoint && currentRun.route && currentRun.route !== "clarify"
          ? {
              route: currentRun.route,
              taskClass: currentRun.taskClass ?? "standard",
              goal: currentRun.goal ?? input.text,
              reasoningSummary: currentRun.reasoningSummary ?? "Resuming from checkpoint",
              successCriteria: currentRun.successCriteria,
              assumptions: currentRun.assumptions,
              questions: [],
              steps: currentRun.plan.map((step) => step.title),
            }
          : await this.preflight.decide(
              session,
              promptOverride ?? input.text,
              input.mode,
              controller.signal,
              runId,
            );
      this.events.transaction(() => {
        const routed = this.database.updateRun(runId, {
          route: decision.route,
          taskClass: decision.taskClass,
          goal: decision.goal,
          successCriteria: decision.successCriteria,
          assumptions: decision.assumptions,
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
      injectRuntimeFault("checkpoint.created");
      injectRuntimeFault("preflight.completed");
      if (decision.route === "clarify") {
        this.orchestrator.pause(session.id);
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
          const awaiting = this.database.updateRun(runId, {
            status: "awaiting_input",
            phase: "clarify",
            error: null,
          });
          this.events.emit(session.id, runId, "message.completed", message);
          this.events.emit(session.id, runId, "run.updated", awaiting);
          this.events.emit(session.id, runId, "run.awaiting_input", {
            run: awaiting,
            questions: decision.questions,
          });
        });
        preflightTrace.finish({ status: "ok" });
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
      preflightTrace.finish({ status: "ok" });
      if (decision.route === "plan" && input.mode === "plan" && !resumeFromCheckpoint) {
        this.events.transaction(() => {
          const awaiting = this.database.updateRun(runId, {
            status: "awaiting_confirmation",
            phase: "preflight",
            error: null,
          });
          const response = this.database.responseForRun(runId);
          if (response) {
            const updated = this.database.updateResponse(response.id, { status: "awaiting_confirmation" });
            this.database.addResponseActivity({
              responseId: response.id,
              kind: "status",
              status: "awaiting_confirmation",
              text: "等待确认执行计划",
            });
            this.events.emit(session.id, runId, "response.updated", updated);
          }
          this.events.emit(session.id, runId, "run.updated", awaiting);
          this.events.emit(session.id, runId, "run.awaiting_input", {
            run: awaiting,
            confirmationRequired: true,
            plan: awaiting.plan,
          });
        });
        return;
      }
      this.transitionRun(session.id, runId, { status: "running", phase: "execute", error: null });
      const budget = { turns: this.database.getRun(runId).turnCount };
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
        this.transitionRun(session.id, runId, { status: "verifying", phase: "verify" });
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
        injectRuntimeFault("verify.completed");
      }
      if (input.mode === "agent" || input.mode === "plan") {
        this.persistTurnRollup(session.id, runId);
        await this.extractMemories(session, runId, controller.signal);
      }
      this.appendAssumptionsToResult(session.id, runId);
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
        const response = this.database.responseForRun(runId);
        if (response) {
          this.database.updateResponseAttachmentStatus(response.id, "sent");
          const final = [...this.database.listMessages(session.id)]
            .reverse()
            .find((item) => item.runId === runId && item.role === "assistant");
          const updated = this.database.updateResponse(response.id, {
            status: "completed",
            ...(final ? { content: final.content } : {}),
          });
          this.events.emit(session.id, runId, "response.completed", updated);
        }
      });
    } catch (error) {
      const wasPreempted = this.preemptedRuns.delete(runId);
      const pendingSideEffect = this.database
        .listRunActions(runId)
        .some((action) => action.status === "uncertain");
      const cancelled =
        controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      rootTrace.setStatus(
        cancelled
          ? { status: "cancelled" }
          : {
              status: "error",
              error: { name: error instanceof Error ? error.name : "Error", message: String(error) },
            },
      );
      this.events.transaction(() => {
        const failed = this.database.updateRun(runId, {
          status: wasPreempted && pendingSideEffect ? "interrupted" : cancelled ? "cancelled" : "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        this.database.addAudit({
          runId,
          kind: "run",
          name: "status",
          input: {
            status: wasPreempted && pendingSideEffect ? "interrupted" : cancelled ? "cancelled" : "failed",
          },
          status: wasPreempted && pendingSideEffect ? "interrupted" : cancelled ? "cancelled" : "failed",
          ...(error instanceof Error ? { error: error.message } : {}),
        });
        for (const step of this.database.listPlan(runId)) {
          if (step.status === "running")
            this.database.updatePlanStep(
              step.id,
              "failed",
              error instanceof Error ? error.message : String(error),
            );
        }
        this.events.emit(sessionAtQueueTime.id, runId, "run.updated", failed);
        if (failed.plan.length) this.events.emit(sessionAtQueueTime.id, runId, "plan.updated", failed.plan);
        const response = this.database.responseForRun(runId);
        if (response) {
          const updated = this.database.updateResponse(response.id, {
            status: cancelled ? "cancelled" : "failed",
            content: failed.error ?? "运行失败",
          });
          this.events.emit(sessionAtQueueTime.id, runId, "response.completed", updated);
        }
      });
    } finally {
      try {
        rootTrace.finish();
      } finally {
        this.activeTraces.delete(runId);
        this.controllers.delete(sessionAtQueueTime.id);
        release();
      }
    }
  }

  private persistTurnRollup(sessionId: string, runId: string): void {
    const items = this.database.listMessages(sessionId).filter((item) => item.runId === runId);
    if (!items.length) return;
    const publicText = items
      .filter((item) => item.role !== "tool")
      .map((item) => `${item.role}: ${item.content}`)
      .join("\n")
      .slice(0, 4_000);
    this.database.addMemoryRollup({
      sessionId,
      kind: "turn",
      fromSequence: items[0]?.sequence ?? 1,
      toSequence: items.at(-1)?.sequence ?? 1,
      summary: publicText,
    });
    const all = this.database.listMessages(sessionId);
    const latest = all.at(-1);
    if (!latest) return;
    const day = new Date(latest.createdAt).toISOString().slice(0, 10);
    const daily = all.filter((item) => new Date(item.createdAt).toISOString().startsWith(day));
    const summarize = (values: TranscriptItem[], limit: number) =>
      values
        .filter((item) => item.role !== "tool")
        .slice(-limit)
        .map((item) => `${item.role}: ${item.content}`)
        .join("\n")
        .slice(0, 8_000);
    if (daily.length)
      this.database.replaceAggregateRollup({
        sessionId,
        kind: "day",
        fromSequence: daily[0]?.sequence ?? 1,
        toSequence: daily.at(-1)?.sequence ?? 1,
        summary: `${day}\n${summarize(daily, 100)}`,
      });
    this.database.replaceAggregateRollup({
      sessionId,
      kind: "session",
      fromSequence: all[0]?.sequence ?? 1,
      toSequence: latest.sequence,
      summary: summarize(all, 50),
    });
    this.database.maintainMemoryRollups(sessionId);
  }

  private async extractMemories(session: Session, runId: string, signal: AbortSignal): Promise<void> {
    const ownerId = this.database.sessionOwner(session.id);
    if (!ownerId) throw new Error("Session owner is missing");
    const model = this.models.forRole("reasoning");
    const transcript = this.database
      .getSnapshot(session.id)
      .transcript.filter((item) => item.runId === runId && item.role === "user")
      .map((item) => item.content)
      .join("\n");
    if (!transcript) return;
    const invoke = async (systemPrompt: string, prompt: string) => {
      const startedAt = Date.now();
      const callId = this.database.startModelCall({
        runId,
        provider: model.provider,
        model: model.id,
        role: "reasoning:memory",
      });
      try {
        const response = await this.models.models.completeSimple(
          model,
          {
            systemPrompt,
            messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
          },
          { signal, temperature: 0, headers: { "user-agent": "UmaAgent/1.0", accept: "application/json" } },
        );
        this.database.finishModelCall(callId, {
          status:
            response.stopReason === "error" || response.stopReason === "aborted" ? "failed" : "completed",
          durationMs: Date.now() - startedAt,
          usage: response.usage,
          ...(response.errorMessage ? { error: response.errorMessage } : {}),
        });
        return response;
      } catch (error) {
        this.database.finishModelCall(callId, {
          status: "failed",
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
    try {
      const systemPrompt =
        "Extract durable user facts only. Return JSON array of objects with key, value, category, optional evidence, confidence (0..1), and scope (global|session). Use stable dotted keys. Return [] when none. Never extract secrets or hidden reasoning.";
      let response = await invoke(systemPrompt, transcript);
      if (response.stopReason === "error" || response.stopReason === "aborted") return;
      let values: unknown;
      try {
        values = extractJson(contentText(response.content));
        if (!Value.Check(MemoryExtractionSchema, values)) throw new Error("Invalid memory extraction");
      } catch {
        response = await invoke(
          "Return exactly one valid JSON array of memory facts, or []. Do not include Markdown or commentary.",
          transcript,
        );
        if (response.stopReason === "error" || response.stopReason === "aborted") return;
        try {
          values = extractJson(contentText(response.content));
        } catch {
          throw new Error("Provider contract error: invalid memory extraction response");
        }
        if (!Value.Check(MemoryExtractionSchema, values))
          throw new Error("Provider contract error: invalid memory extraction response");
      }
      for (const value of values) {
        const content = value.value.trim();
        const { confidence, scope } = value;
        if (!content || isSecretLike(content)) continue;
        this.events.transaction(() => {
          const fact = this.database.addMemoryFact({
            ownerId,
            sessionId: session.id,
            scope,
            key: value.key.trim(),
            value: content,
            category: value.category.trim(),
            ...(value.evidence ? { evidence: value.evidence.trim() } : {}),
            confidence,
            sourceRunId: runId,
            status: confidence >= 0.95 ? "active" : "candidate",
          });
          this.events.emit(session.id, runId, "memory.updated", fact);
          this.events.invalidate("memory");
        });
      }
    } catch (error) {
      if (error instanceof Error && /provider contract/i.test(error.message)) throw error;
      // Provider availability must not discard an otherwise completed user task.
    }
  }

  private toolsForSession(session: Session, mode: InteractionMode, runId?: string): AgentTool[] {
    if (mode !== "agent" && mode !== "plan") return [];
    return [
      ...createBuiltinTools({
        session,
        database: this.database,
        knowledge: this.knowledge,
        skills: this.skills,
        workspacePolicy: this.workspacePolicy,
        toolTimeoutMs: this.config.runtime.toolTimeoutMs,
        search: this.search,
        scheduleManage: (params) => {
          const ownerId = this.database.sessionOwner(session.id);
          if (!ownerId) throw new Error("Session owner is missing");
          return this.manageScheduleTool(params, ownerId);
        },
        memoryWrite: (scope, content) => this.createMemoryFact(session.id, scope, content),
        attachmentCreateFromWorkspace: async (path) => {
          const data = await import("node:fs/promises").then((fs) => fs.readFile(path));
          const extension = basename(path).split(".").pop()?.toLowerCase();
          const mimeType =
            extension === "png"
              ? "image/png"
              : extension === "jpg" || extension === "jpeg"
                ? "image/jpeg"
                : extension === "pdf"
                  ? "application/pdf"
                  : "application/octet-stream";
          const responseId = runId ? this.database.responseForRun(runId)?.id : undefined;
          return this.addAttachment({
            sessionId: session.id,
            ...(responseId ? { responseId } : {}),
            name: basename(path),
            mimeType,
            data,
          });
        },
      }),
      ...this.mcp.tools(),
    ];
  }

  private manageScheduleTool(params: Record<string, unknown>, ownerId: string): unknown {
    const operation = String(params.operation ?? "");
    if (operation === "list") return this.listScheduledTasks(ownerId);
    const id = typeof params.id === "string" ? params.id : undefined;
    if (id && this.database.scheduledTaskOwner(id) !== ownerId) throw new Error("Scheduled task not found");
    if (operation === "run") {
      if (!id) throw new Error("schedule_manage run requires id");
      return this.runScheduledTask(id);
    }
    if (operation === "delete") {
      if (!id) throw new Error("schedule_manage delete requires id");
      this.deleteScheduledTask(id);
      return { deleted: id };
    }
    const schedule = (() => {
      if (params.kind === "once" && typeof params.at === "number")
        return { kind: "once" as const, at: params.at };
      if (params.kind === "interval" && typeof params.everyMs === "number")
        return { kind: "interval" as const, everyMs: params.everyMs };
      if (
        params.kind === "cron" &&
        typeof params.expression === "string" &&
        typeof params.timezone === "string"
      )
        return {
          kind: "cron" as const,
          expression: params.expression,
          timezone: params.timezone,
        };
      return undefined;
    })();
    if (operation === "create") {
      if (typeof params.name !== "string" || typeof params.prompt !== "string" || !schedule)
        throw new Error("schedule_manage create requires name, prompt, and a complete schedule");
      return this.createScheduledTask(
        {
          name: params.name,
          prompt: params.prompt,
          schedule,
          ...(typeof params.enabled === "boolean" ? { enabled: params.enabled } : {}),
        },
        ownerId,
      );
    }
    if (operation === "update") {
      if (!id) throw new Error("schedule_manage update requires id");
      return this.updateScheduledTask(id, {
        ...(typeof params.name === "string" ? { name: params.name } : {}),
        ...(typeof params.prompt === "string" ? { prompt: params.prompt } : {}),
        ...(typeof params.enabled === "boolean" ? { enabled: params.enabled } : {}),
        ...(schedule ? { schedule } : {}),
      });
    }
    throw new Error(`Unsupported schedule operation: ${operation}`);
  }

  private async executePreparedAction(run: Run, action: RunAction): Promise<RunAction> {
    if (run.status !== "interrupted")
      throw new Error("Prepared actions can only be decided on interrupted runs");
    return this.executeRecoveredAction(run, action, false);
  }

  private async reconcileAcknowledgedAction(run: Run, action: RunAction): Promise<void> {
    const stored = this.database.getSession(run.sessionId);
    const session: Session = {
      ...stored,
      model: run.model.ref,
      thinkingLevel: run.thinkingLevel,
    };
    const prompt = [
      `A side-effect action may already have executed before interruption: ${action.toolName}.`,
      `Recorded input: ${JSON.stringify(action.input ?? {})}`,
      "Use only read-only tools to inspect the current state. Do not repeat or compensate for the action. Summarize what can be observed so a later explicit resume can continue safely.",
    ].join("\n");
    await this.runAgent(
      session,
      run.id,
      { messageId: run.messageId, text: prompt, mode: "agent" },
      {
        taskClass: "simple",
        route: "direct",
        goal: "Reconcile an uncertain side effect using read-only inspection",
        reasoningSummary: "Read-only reconciliation after an acknowledged uncertain action",
        successCriteria: ["Do not repeat the uncertain action", "Report only observed state"],
        assumptions: [],
        questions: [],
        steps: [],
      },
      new AbortController().signal,
      prompt,
      { turns: run.turnCount },
      true,
    );
    this.events.transaction(() => {
      this.database.createCheckpoint({
        runId: run.id,
        phase: "tool",
        turnCount: this.database.getRun(run.id).turnCount,
        lastMessageSequence: this.database.latestMessageSequence(run.sessionId),
        contextSummarySequence: this.database.getContextSummary(run.sessionId)?.throughSequence,
        safeToResume: true,
      });
      this.events.emit(run.sessionId, run.id, "run.updated", this.database.getRun(run.id));
    });
  }

  private async replaySafeActions(run: Run): Promise<void> {
    const safe = this.database
      .listRunActions(run.id)
      .filter(
        (action) => action.status === "prepared" && ["read", "attachment_read"].includes(action.toolClass),
      );
    for (const action of safe) await this.executeRecoveredAction(run, action, true);
  }

  private async executeRecoveredAction(
    run: Run,
    action: RunAction,
    automatic: boolean,
    signal?: AbortSignal,
  ): Promise<RunAction> {
    const session = this.database.getSession(run.sessionId);
    const tool = this.toolsForSession(session, run.interactionMode, run.id).find(
      (candidate) => candidate.name === action.toolName,
    );
    if (!tool) throw new Error(`Tool is unavailable: ${action.toolName}`);
    const running = this.events.transaction(() => {
      const transition = this.database.transitionRunAction(action.id, ["prepared"], {
        status: "running",
        error: null,
      });
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
    const controller = signal ? undefined : new AbortController();
    try {
      const toolInput = action.input;
      const result = await tool.execute(action.toolCallId, toolInput as never, signal ?? controller?.signal);
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
    readOnly = false,
  ): Promise<void> {
    const context = await this.contextBuilder.build({
      session,
      runId,
      request: input,
      decision,
      signal,
      tools: this.toolsForSession(session, input.mode, runId),
      ...(promptOverride ? { promptOverride } : {}),
      readOnly,
    });
    let stepTurns = 0;
    let turnLimitReached = false;
    let loopFailure: string | undefined;
    const loopGuard = new ToolLoopGuard(this.database.listRunActions(runId));
    const turnLimit = decision.route === "plan" ? 48 : 400;
    const agent = new Agent({
      initialState: {
        systemPrompt: context.systemPrompt,
        model: context.model,
        thinkingLevel: session.thinkingLevel,
        tools: context.tools,
        messages: context.messages,
      },
      streamFn: (model, modelContext, options) =>
        this.models.models.streamSimple(model, modelContext, {
          ...options,
          headers: { ...(options?.headers ?? {}), "user-agent": "UmaAgent/1.0", accept: "application/json" },
        }),
      toolExecution: "parallel",
      shouldStopAfterTurn: () => {
        stepTurns++;
        budget.turns++;
        this.database.updateRun(runId, { turnCount: budget.turns });
        if (loopFailure) return true;
        const reached = stepTurns >= turnLimit || budget.turns >= 400;
        if (reached) turnLimitReached = true;
        return reached;
      },
      beforeToolCall: async ({ toolCall, args }, toolSignal) => {
        const permission = this.permissions.decide(input.mode, toolCall.name);
        if (!permission.allowed) return { block: true, reason: permission.reason };
        const idempotencyKey = `${runId}:${toolCall.id}`;
        const loop = loopGuard.check(toolCall.name, args, idempotencyKey);
        if (loop) {
          this.events.transaction(() => {
            this.database.addAudit({
              runId,
              kind: "run",
              name: "tool_loop",
              output: {
                pattern: loop.pattern,
                count: loop.count,
                signature: loop.signature,
              },
              status: loop.level,
              error: loop.message,
            });
            this.events.emit(session.id, runId, "run.loop_warning", loop);
          });
          if (loop.level === "critical") loopFailure = "tool_loop_detected";
          return { block: true, reason: loop.message };
        }
        const action =
          this.database.getRunActionByToolCall(runId, toolCall.id) ??
          this.events.transaction(() => {
            const prepared = this.database.createRunAction({
              runId,
              checkpointId: this.database.getLatestCheckpoint(runId)?.id,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              toolClass: this.permissions.classify(toolCall.name),
              idempotencyKey,
              input: args,
            });
            this.events.emit(session.id, runId, "run.action_prepared", prepared);
            return prepared;
          });
        injectRuntimeFault("tool.prepared");
        if (permission.requiresApproval) {
          const approvalTrace = this.activeTraces
            .get(runId)
            ?.child("approval", "approval", { tool: toolCall.name });
          let approved: boolean;
          try {
            approved = await this.approvals.request({
              sessionId: session.id,
              runId,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              args,
              signal: toolSignal ?? signal,
            });
            approvalTrace?.finish(
              approved
                ? { status: "ok" }
                : { status: "error", error: { name: "ApprovalRejected", message: "Approval was rejected" } },
            );
          } catch (error) {
            approvalTrace?.finish({
              status: "error",
              error: { name: error instanceof Error ? error.name : "Error", message: String(error) },
            });
            throw error;
          }
          if (!approved) {
            this.events.transaction(() => {
              const rejected = this.database.transitionRunAction(action.id, ["prepared"], {
                status: "rejected",
                error: "Tool execution was not approved",
              });
              if (rejected.changed)
                this.events.emit(session.id, runId, "run.action_decided", {
                  action: rejected.action,
                  decision: "reject",
                });
            });
            return { block: true, reason: "Tool execution was not approved" };
          }
        }
        this.events.transaction(() => {
          const running = this.database.transitionRunAction(action.id, ["prepared"], {
            status: "running",
            error: null,
          });
          if (running.changed) this.events.emit(session.id, runId, "run.action_prepared", running.action);
        });
        injectRuntimeFault("tool.started");
        return undefined;
      },
    });
    this.bindAgentEvents(agent, session.id, runId, () => budget.turns, loopGuard);
    const abort = () => agent.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      await agent.prompt(context.prompt, context.images);
      if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
      if (loopFailure) throw new Error(loopFailure);
      if (turnLimitReached)
        throw new Error(
          budget.turns >= 400 ? "Run turn limit exceeded (400)" : "Plan step turn limit exceeded (48)",
        );
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  /**
   * 在终态前统一披露影响结果的非敏感假设，避免依赖模型是否记得提示词要求。
   * 假设来自严格 schema，仍需再次过滤疑似凭据；空假设不会修改用户结果。
   */
  private appendAssumptionsToResult(sessionId: string, runId: string): void {
    const run = this.database.getRun(runId);
    const assumptions = run.assumptions.filter((item) => !isSecretLike(item));
    if (!assumptions.length) return;
    const final = [...this.database.listMessages(sessionId)]
      .reverse()
      .find((item) => item.runId === runId && item.role === "assistant" && item.status === "complete");
    if (!final || final.content.includes("执行假设：")) return;
    const content = `${final.content}\n\n执行假设：\n${assumptions.map((item) => `- ${item}`).join("\n")}`;
    this.events.transaction(() => {
      const updated = this.database.updateMessage(final.id, { content });
      this.events.emit(sessionId, runId, "message.delta", updated);
    });
  }

  private bindAgentEvents(
    agent: Agent,
    sessionId: string,
    runId: string,
    turnCount: () => number = () => 0,
    loopGuard?: ToolLoopGuard,
  ): void {
    let assistantItem: TranscriptItem | undefined;
    let pendingAssistant: AssistantMessage | undefined;
    let flushTimer: NodeJS.Timeout | undefined;
    const toolMessages = new Map<string, string>();
    const toolActions = new Map<string, string>();
    let activeModelCall: { id: string; startedAt: number } | undefined;
    let activeModelTrace: TraceContext | undefined;
    const toolTraces = new Map<string, TraceContext>();
    const rootTrace = this.activeTraces.get(runId);
    const responseId = this.database.responseForRun(runId)?.id;
    const flushAssistant = () => {
      if (!assistantItem || !pendingAssistant) return;
      const message = pendingAssistant;
      this.events.transaction(() => {
        assistantItem = this.database.updateMessage(assistantItem?.id as string, {
          content: textFromMessage(message),
          payload: message,
        });
        this.events.emit(sessionId, runId, "message.delta", assistantItem);
        if (responseId) {
          const updated = this.database.updateResponse(responseId, { content: textFromMessage(message) });
          this.database.addResponseActivity({
            responseId,
            kind: "text",
            text: textFromMessage(message),
          });
          this.events.emit(sessionId, runId, "response.delta", updated);
        }
      });
      pendingAssistant = undefined;
      flushTimer = undefined;
    };
    agent.subscribe((event: AgentEvent) => {
      if (event.type === "turn_start") {
        const run = this.database.getRun(runId);
        activeModelCall = {
          id: this.database.startModelCall({
            runId,
            provider: run.model.ref.provider,
            model: run.model.ref.id,
            role: "default",
          }),
          startedAt: Date.now(),
        };
        activeModelTrace = rootTrace?.child("model", "model", {
          provider: run.model.ref.provider,
          model: run.model.ref.id,
        });
        injectRuntimeFault("model.started");
      } else if (event.type === "message_start" && event.message.role === "assistant") {
        assistantItem = this.events.transaction(() => {
          const item = this.database.insertMessage({
            sessionId,
            runId,
            role: "assistant",
            status: "streaming",
            content: textFromMessage(event.message),
          });
          this.events.emit(sessionId, runId, "message.started", item);
          if (responseId)
            this.events.emit(sessionId, runId, "response.activity", {
              responseId,
              kind: "status",
              status: "thinking",
              text: "正在生成回复",
            });
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
        const run = this.database.getRun(runId);
        this.events.transaction(() => {
          const item = this.database.updateMessage(assistantItem?.id as string, {
            content: textFromMessage(message),
            status,
            payload: message,
          });
          if (activeModelCall)
            this.database.finishModelCall(activeModelCall.id, {
              status:
                message.stopReason === "error" || message.stopReason === "aborted" ? "failed" : "completed",
              durationMs: Date.now() - activeModelCall.startedAt,
              usage: message.usage,
              ...(message.errorMessage ? { error: message.errorMessage } : {}),
            });
          activeModelTrace?.finish({
            status: message.stopReason === "error" || message.stopReason === "aborted" ? "error" : "ok",
          });
          activeModelTrace = undefined;
          this.database.addAudit({
            runId,
            kind: "model",
            name: `${run.model.ref.provider}/${run.model.ref.id}`,
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
        injectRuntimeFault("model.completed");
        activeModelCall = undefined;
        assistantItem = undefined;
      } else if (event.type === "tool_execution_start") {
        const toolTrace = rootTrace?.child("tool", "tool", { tool: event.toolName });
        if (toolTrace) toolTraces.set(event.toolCallId, toolTrace);
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
          if (responseId) {
            this.database.addResponseActivity({
              responseId,
              kind: "tool",
              toolName: event.toolName,
              text: "正在调用工具",
              status: "executing",
            });
            this.events.emit(sessionId, runId, "response.activity", {
              responseId,
              kind: "tool",
              toolName: event.toolName,
              status: "executing",
            });
          }
          return { actionId: action.id, messageId: item.id };
        });
        toolActions.set(event.toolCallId, created.actionId);
        toolMessages.set(event.toolCallId, created.messageId);
      } else if (event.type === "tool_execution_end") {
        loopGuard?.recordResult(`${runId}:${event.toolCallId}`, event.result);
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
              this.database.transitionRunAction(actionId, ["running"], {
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
            if (responseId) {
              this.database.addResponseActivity({
                responseId,
                kind: "tool",
                toolName: event.toolName,
                text: event.isError ? "工具执行失败" : "工具执行完成",
                status: event.isError ? "failed" : "completed",
              });
              this.events.emit(sessionId, runId, "response.activity", {
                responseId,
                kind: "tool",
                toolName: event.toolName,
                status: event.isError ? "failed" : "completed",
              });
            }
            toolTraces.get(event.toolCallId)?.finish({ status: event.isError ? "error" : "ok" });
            toolTraces.delete(event.toolCallId);
          });
          injectRuntimeFault("tool.completed");
        }
      } else if (event.type === "message_end" && event.message.role === "toolResult") {
        const messageId = toolMessages.get(event.message.toolCallId);
        if (messageId) this.database.updateMessage(messageId, { payload: event.message });
      } else if (event.type === "agent_end" && activeModelCall) {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = undefined;
        pendingAssistant = undefined;
        this.database.finishModelCall(activeModelCall.id, {
          status: "failed",
          durationMs: Date.now() - activeModelCall.startedAt,
          error: "Agent ended before the model response completed",
        });
        if (assistantItem)
          this.database.updateMessage(assistantItem.id, {
            status: "error",
            content: assistantItem.content,
          });
        activeModelCall = undefined;
        activeModelTrace?.finish({
          status: "error",
          error: { name: "AgentError", message: "Agent ended before model response" },
        });
        activeModelTrace = undefined;
        assistantItem = undefined;
      }
    });
  }

  private async verifyAndCorrect(
    session: Session,
    runId: string,
    decision: PreflightDecision,
    signal: AbortSignal,
  ): Promise<void> {
    const final = [...this.database.listMessages(session.id)]
      .reverse()
      .find((item) => item.runId === runId && item.role === "assistant" && item.status === "complete");
    if (!final) throw new Error("Planned run produced no final response");
    const verificationInput = JSON.stringify({
      goal: decision.goal,
      successCriteria: decision.successCriteria,
      result: final.content,
    });
    let response = await this.preflight.complete(
      runId,
      "reasoning",
      'Verify whether the result satisfies the goal and success criteria. Return JSON only: {"accepted":boolean,"feedback":string}. Do not include chain-of-thought.',
      verificationInput,
      signal,
      false,
    );
    if (response.stopReason === "error" || response.stopReason === "aborted")
      throw new Error(response.errorMessage ?? "Verification failed");
    let verdict: { accepted: boolean; feedback: string };
    try {
      const value = extractJson(contentText(response.content));
      if (!Value.Check(VerificationSchema, value)) throw new Error("Invalid verification verdict");
      verdict = value;
    } catch {
      response = await this.preflight.complete(
        runId,
        "reasoning",
        'Return exactly one JSON object: {"accepted":boolean,"feedback":string}.',
        verificationInput,
        signal,
        false,
      );
      if (response.stopReason === "error" || response.stopReason === "aborted")
        throw new Error(response.errorMessage ?? "Verification repair failed");
      let value: unknown;
      try {
        value = extractJson(contentText(response.content));
      } catch {
        throw new Error("Provider contract error: invalid verification response");
      }
      if (!Value.Check(VerificationSchema, value))
        throw new Error("Provider contract error: invalid verification response");
      verdict = value;
    }
    if (verdict.accepted === true) return;
    const feedback = verdict.feedback || "Review the result and correct remaining issues.";
    const internal: Message = {
      role: "user",
      content: `Verifier feedback: ${feedback}\nCorrect the result once, using tools if necessary.`,
      timestamp: Date.now(),
    };
    const correctionMessage = this.database.insertMessage({
      sessionId: session.id,
      runId,
      role: "tool",
      status: "complete",
      name: "verification",
      content: feedback,
      payload: internal,
    });
    this.transitionRun(session.id, runId, {
      status: "running",
      phase: "correct",
      correctionCount: 1,
    });
    const current = this.database.getRun(runId);
    await this.runAgent(
      session,
      runId,
      { messageId: correctionMessage.id, text: String(internal.content), mode: current.interactionMode },
      { ...decision, route: "direct" },
      signal,
      String(internal.content),
      { turns: current.turnCount },
    );
  }
}
