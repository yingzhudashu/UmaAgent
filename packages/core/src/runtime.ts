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
  CreateSessionRequest,
  ModelRef,
  Run,
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
import { SkillRegistry } from "./skills.js";
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
  private started = false;

  constructor(readonly config: UmaConfig) {
    this.database = new UmaDatabase(config.server.stateDir);
    this.knowledge = new KnowledgeService(this.database);
    this.models = new ModelRegistry(config);
    this.skills = new SkillRegistry(config.skillsDirs);
    this.workspacePolicy = new WorkspacePolicy(config.server.workspaceRoots);
    this.events = new EventHub(this.database);
    this.semaphore = new Semaphore(config.runtime.maxParallelSessions);
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("UmaRuntime is already started");
    await this.workspacePolicy.initialize();
    await this.skills.refresh();
    await this.mcp.connect(this.config.mcpServers, this.config.runtime.toolTimeoutMs);
    this.started = true;
  }

  async stop(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.queueTails.values());
    for (const [id, pending] of this.approvals) {
      clearTimeout(pending.timer);
      pending.resolve(false);
      this.approvals.delete(id);
    }
    await this.mcp.close();
    this.database.close();
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
  listSkills(): SkillSummary[] {
    return this.skills.list();
  }
  refreshSkills(): Promise<SkillSummary[]> {
    return this.skills.refresh();
  }

  async createSession(input: CreateSessionRequest = {}): Promise<Session> {
    const workspace = await this.workspacePolicy.validateWorkspace(
      input.workspace ?? (this.config.server.workspaceRoots[0] as string),
    );
    const model = input.model ?? this.config.defaultModel;
    this.models.get(model);
    return this.database.createSession({
      title: input.title ?? "New session",
      workspace,
      model,
      thinkingLevel: this.config.defaultThinkingLevel,
    });
  }

  updateSession(
    id: string,
    patch: { title?: string; model?: ModelRef; thinkingLevel?: ThinkingLevel },
  ): Session {
    if (patch.model) this.models.get(patch.model);
    const session = this.database.updateSession(id, patch);
    this.events.emit(id, undefined, "session.snapshot", this.database.getSnapshot(id));
    return session;
  }

  deleteSession(id: string): void {
    if (this.controllers.has(id)) throw new Error("Cannot delete a session with an active run");
    this.database.deleteSession(id);
  }

  sendMessage(sessionId: string, input: SendMessageRequest): Run {
    const session = this.database.getSession(sessionId);
    const attachmentIds = input.attachmentIds ?? [];
    for (const id of attachmentIds) this.database.validateAttachmentForSession(id, sessionId);
    const { run, created } = this.database.createRun(sessionId, input.messageId);
    if (!created) return run;
    this.database.insertMessage({
      id: input.messageId,
      sessionId,
      runId: run.id,
      role: "user",
      status: "complete",
      content: input.text,
      payload: { role: "user", content: input.text, timestamp: Date.now() },
      attachmentIds,
    });
    this.events.emit(sessionId, run.id, "message.completed", this.database.getMessage(input.messageId));
    const previous = this.queueTails.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.executeRun(session, run.id, input));
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
    const approval = this.database.resolveApproval(id, approved);
    const pending = this.approvals.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.approvals.delete(id);
      pending.resolve(approved);
    }
    this.events.emit(approval.sessionId, approval.runId, "approval.resolved", approval);
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
  ): Promise<PreflightDecision> {
    const force =
      mode === "direct"
        ? "You must choose direct."
        : mode === "plan"
          ? "You must choose plan."
          : "Choose the cheapest suitable route.";
    const response = await this.models.models.completeSimple(
      this.models.get(session.model),
      {
        systemPrompt:
          "You route an agent request. Return JSON only with route (direct|clarify|plan), goal, reasoningSummary (one short sentence), successCriteria (string[]), questions (string[]), and steps (string[]). Clarify only when missing information blocks safe execution. Plan for multi-step work. Never include private chain-of-thought.",
        messages: [{ role: "user", content: `${force}\n\n${prompt}`, timestamp: Date.now() }],
      },
      { signal, temperature: 0 },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted")
      throw new Error(response.errorMessage ?? "Preflight failed");
    const decision = decisionFrom(extractJson(contentText(response.content)));
    if (decision.route === "clarify" && decision.questions.length === 0)
      throw new Error("Clarification route requires questions");
    if (decision.route === "plan" && decision.steps.length === 0) decision.steps = [decision.goal];
    return decision;
  }

  private async executeRun(
    sessionAtQueueTime: Session,
    runId: string,
    input: SendMessageRequest,
  ): Promise<void> {
    const release = await this.semaphore.acquire();
    const controller = new AbortController();
    this.controllers.set(sessionAtQueueTime.id, controller);
    try {
      const session = this.database.getSession(sessionAtQueueTime.id);
      this.database.updateRun(runId, { status: "preflight" });
      this.events.emit(session.id, runId, "run.updated", this.database.getRun(runId));
      const decision = await this.preflight(session, input.text, input.mode ?? "auto", controller.signal);
      this.database.updateRun(runId, { route: decision.route, reasoningSummary: decision.reasoningSummary });
      if (decision.route === "clarify") {
        const content = decision.questions.map((question, index) => `${index + 1}. ${question}`).join("\n");
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
        this.database.updateRun(runId, { status: "awaiting_input" });
        this.events.emit(session.id, runId, "message.completed", message);
        this.events.emit(session.id, runId, "run.updated", this.database.getRun(runId));
        return;
      }
      if (decision.route === "plan") {
        this.database.setPlan(runId, decision.steps);
        this.events.emit(session.id, runId, "plan.updated", this.database.getRun(runId).plan);
      }
      this.database.updateRun(runId, { status: "running" });
      this.events.emit(session.id, runId, "run.updated", this.database.getRun(runId));
      await this.runAgent(session, runId, input, decision, controller.signal);
      if (controller.signal.aborted) throw new DOMException("Run cancelled", "AbortError");
      if (decision.route === "plan") {
        this.database.updateRun(runId, { status: "verifying" });
        this.events.emit(session.id, runId, "run.updated", this.database.getRun(runId));
        await this.verifyAndCorrect(session, runId, decision, controller.signal);
        for (const step of this.database.listPlan(runId)) this.database.updatePlanStep(step.id, "completed");
        this.events.emit(session.id, runId, "plan.updated", this.database.getRun(runId).plan);
      }
      this.database.updateRun(runId, { status: "completed" });
      this.events.emit(session.id, runId, "run.updated", this.database.getRun(runId));
    } catch (error) {
      const cancelled =
        controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      this.database.updateRun(runId, {
        status: cancelled ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      this.events.emit(sessionAtQueueTime.id, runId, "run.updated", this.database.getRun(runId));
    } finally {
      this.controllers.delete(sessionAtQueueTime.id);
      release();
    }
  }

  private async runAgent(
    session: Session,
    runId: string,
    input: SendMessageRequest,
    decision: PreflightDecision,
    signal: AbortSignal,
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
    const prompt = `${input.text}${planText}${attachmentText}`;
    const tools = [
      ...createBuiltinTools({
        session,
        database: this.database,
        knowledge: this.knowledge,
        workspacePolicy: this.workspacePolicy,
        toolTimeoutMs: this.config.runtime.toolTimeoutMs,
      }),
      ...this.mcp.tools(),
    ];
    let turns = 0;
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
      shouldStopAfterTurn: () => ++turns >= 40,
      beforeToolCall: async ({ toolCall, args }, toolSignal) => {
        if (toolCall.name !== "shell" && !toolCall.name.startsWith("mcp_")) return undefined;
        const approved = await this.requestApproval(
          session.id,
          runId,
          toolCall.id,
          toolCall.name,
          args,
          toolSignal ?? signal,
        );
        return approved ? undefined : { block: true, reason: "Tool execution was not approved" };
      },
    });
    this.bindAgentEvents(agent, session.id, runId);
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
    if (contextTokens < model.contextWindow * 0.65 || pending.length < 6) {
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

  private bindAgentEvents(agent: Agent, sessionId: string, runId: string): void {
    let assistantItem: TranscriptItem | undefined;
    let pendingAssistant: AssistantMessage | undefined;
    let flushTimer: NodeJS.Timeout | undefined;
    const toolMessages = new Map<string, string>();
    const flushAssistant = () => {
      if (!assistantItem || !pendingAssistant) return;
      assistantItem = this.database.updateMessage(assistantItem.id, {
        content: textFromMessage(pendingAssistant),
        payload: pendingAssistant,
      });
      pendingAssistant = undefined;
      flushTimer = undefined;
    };
    agent.subscribe((event: AgentEvent) => {
      if (event.type === "message_start" && event.message.role === "assistant") {
        assistantItem = this.database.insertMessage({
          sessionId,
          runId,
          role: "assistant",
          status: "streaming",
          content: textFromMessage(event.message),
        });
        this.events.emit(sessionId, runId, "message.started", assistantItem);
      } else if (event.type === "message_update" && event.message.role === "assistant" && assistantItem) {
        pendingAssistant = event.message;
        assistantItem = {
          ...assistantItem,
          content: textFromMessage(event.message),
          updatedAt: Date.now(),
        };
        this.events.emit(sessionId, runId, "message.delta", assistantItem);
        flushTimer ??= setTimeout(flushAssistant, 250);
      } else if (event.type === "message_end" && event.message.role === "assistant" && assistantItem) {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = undefined;
        pendingAssistant = undefined;
        const status =
          event.message.stopReason === "error"
            ? "error"
            : event.message.stopReason === "aborted"
              ? "cancelled"
              : "complete";
        const item = this.database.updateMessage(assistantItem.id, {
          content: textFromMessage(event.message),
          status,
          payload: event.message,
        });
        this.events.emit(sessionId, runId, "message.completed", item);
        assistantItem = undefined;
      } else if (event.type === "tool_execution_start") {
        this.database.createToolCall({ id: event.toolCallId, runId, name: event.toolName, args: event.args });
        const item = this.database.insertMessage({
          sessionId,
          runId,
          role: "tool",
          status: "streaming",
          name: event.toolName,
          content: JSON.stringify(event.args, null, 2),
        });
        toolMessages.set(event.toolCallId, item.id);
        this.events.emit(sessionId, runId, "tool.started", {
          item,
          toolCallId: event.toolCallId,
          input: event.args,
        });
      } else if (event.type === "tool_execution_end") {
        this.database.completeToolCall(event.toolCallId, event.result, event.isError);
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
          const item = this.database.updateMessage(messageId, {
            content,
            status: event.isError ? "error" : "complete",
          });
          this.events.emit(sessionId, runId, "tool.completed", {
            item,
            toolCallId: event.toolCallId,
            isError: event.isError,
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
    const approval = this.database.createApproval({ sessionId, runId, toolCallId, toolName, args });
    this.events.emit(sessionId, runId, "approval.requested", approval);
    return new Promise<boolean>((resolve) => {
      const finish = (approved: boolean) => {
        signal.removeEventListener("abort", abort);
        resolve(approved);
      };
      const abort = () => {
        const pending = this.approvals.get(approval.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.approvals.delete(approval.id);
        const expired = this.database.expireApproval(approval.id);
        this.events.emit(sessionId, runId, "approval.resolved", expired);
        finish(false);
      };
      const timer = setTimeout(abort, this.config.runtime.approvalTimeoutMs);
      this.approvals.set(approval.id, { resolve: finish, timer });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
