import { randomUUID } from "node:crypto";
import type { Run, RunAction, Session } from "@uma-agent/protocol";
import type { TraceParent } from "@uma-agent/telemetry";
import type { UmaDatabase } from "./database.js";
import type { EventHub } from "./events.js";
import type { ModelRegistry } from "./models.js";
import type { RunApprovals } from "./run-approvals.js";
import type { RunOrchestrator } from "./run-orchestrator.js";
import type { TraceContext, TraceService } from "./trace.js";

interface CommandDependencies {
  database: UmaDatabase;
  events: EventHub;
  orchestrator: RunOrchestrator;
  approvals: RunApprovals;
  controllers: Map<string, AbortController>;
  activeTraces: Map<string, TraceContext>;
  isAcceptingRuns(): boolean;
  snapshotModel: ModelRegistry["snapshot"];
  waitForSideEffectGate(sessionId: string, runId: string): Promise<void>;
  transitionRun(sessionId: string, runId: string, patch: Parameters<UmaDatabase["updateRun"]>[1]): Run;
  executeRecoveredAction(
    run: Run,
    action: RunAction,
    automatic: boolean,
    signal?: AbortSignal,
  ): Promise<RunAction>;
  trace: TraceService;
}

/** Core shell 命令有独立的审批、Action Ledger 和终态规则，不与普通 Agent loop 混合。 */
export class RuntimeCommandOperations {
  constructor(private readonly dependencies: CommandDependencies) {}

  start(
    sessionId: string,
    command: string,
    messageId: string = randomUUID(),
    traceParent?: TraceParent,
  ): Run {
    const deps = this.dependencies;
    const normalized = command.trim();
    if (!normalized) throw new Error("Command is required");
    if (!deps.isAcceptingRuns()) throw new Error("UmaRuntime is not accepting new runs");
    const session = deps.database.getSession(sessionId);
    const existing = deps.database.findMessageOwner(messageId);
    if (existing) {
      if (existing.sessionId !== sessionId || !existing.runId)
        throw new Error("messageId is already used by another message");
      return deps.database.getRun(existing.runId);
    }
    if (deps.database.listQueuedRuns(sessionId).length >= 100) throw new Error("Session queue is full");
    const run = deps.events.transaction(() => {
      const created = deps.database.createRun(
        sessionId,
        messageId,
        deps.snapshotModel(session.model),
        session.thinkingLevel,
        "command",
        "agent",
      ).run;
      const message = deps.database.insertMessage({
        id: messageId,
        sessionId,
        runId: created.id,
        role: "user",
        status: "complete",
        content: `!${normalized}`,
      });
      deps.events.emit(sessionId, created.id, "message.completed", message);
      deps.events.emit(sessionId, created.id, "run.updated", created);
      return created;
    });
    const queuedTrace = deps.trace.startQueued(
      run.id,
      session.id,
      "command",
      { "run.kind": "command" },
      traceParent,
    );
    deps.activeTraces.set(run.id, queuedTrace.root);
    deps.orchestrator.enqueue(sessionId, () =>
      queuedTrace.run(() => this.execute(session, run.id, normalized)),
    );
    return run;
  }

  private async execute(session: Session, runId: string, command: string): Promise<void> {
    const deps = this.dependencies;
    const rootTrace = deps.activeTraces.get(runId) ?? deps.trace.startRoot(runId, session.id, "command");
    deps.activeTraces.set(runId, rootTrace);
    let release: (() => void) | undefined;
    let controller: AbortController | undefined;
    try {
      await deps.waitForSideEffectGate(session.id, runId);
      release = await deps.orchestrator.acquire();
      if (deps.database.getRun(runId).status === "cancelled") {
        rootTrace.setStatus({ status: "cancelled" });
        return;
      }
      controller = new AbortController();
      deps.controllers.set(session.id, controller);
      const toolCallId = randomUUID();
      deps.transitionRun(session.id, runId, { status: "running", phase: "execute", error: null });
      const action = deps.events.transaction(() => {
        const value = deps.database.createRunAction({
          runId,
          checkpointId: deps.database.getLatestCheckpoint(runId)?.id,
          toolCallId,
          toolName: "shell",
          toolClass: "shell",
          idempotencyKey: `${runId}:command`,
          input: { command },
        });
        deps.events.emit(session.id, runId, "run.action_prepared", value);
        return value;
      });
      const approvalTrace = rootTrace.child("approval", "approval", { tool: "shell" });
      let approved = false;
      try {
        approved = await deps.approvals.request({
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
        deps.events.transaction(() => {
          const rejected = deps.database.transitionRunAction(action.id, ["prepared"], {
            status: "rejected",
            error: "Command execution was not approved",
          }).action;
          deps.events.emit(session.id, runId, "run.action_decided", { action: rejected, decision: "reject" });
        });
        throw new Error("Command execution was not approved");
      }
      deps.database.createToolCall({ id: toolCallId, runId, name: "shell", args: { command } });
      const toolTrace = rootTrace.child("tool", "tool", { tool: "shell" });
      let result: RunAction;
      try {
        result = await deps.executeRecoveredAction(
          deps.database.getRun(runId),
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
      deps.events.transaction(() => {
        const message = deps.database.insertMessage({
          sessionId: session.id,
          runId,
          role: "assistant",
          status: "complete",
          content: output,
        });
        const completed = deps.database.updateRun(runId, { status: "completed", error: null });
        deps.events.emit(session.id, runId, "message.completed", message);
        deps.events.emit(session.id, runId, "run.updated", completed);
        const response = deps.database.responseForRun(runId);
        if (response) {
          deps.database.updateResponseAttachmentStatus(response.id, "sent");
          const updated = deps.database.updateResponse(response.id, { status: "completed", content: output });
          deps.events.emit(session.id, runId, "response.completed", updated);
        }
      });
    } catch (error) {
      rootTrace.setStatus({
        status: "error",
        error: { name: error instanceof Error ? error.name : "Error", message: String(error) },
      });
      const interrupted = deps.database.listRunActions(runId).some((action) => action.status === "uncertain");
      deps.transitionRun(session.id, runId, {
        status: interrupted ? "interrupted" : controller?.signal.aborted ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      rootTrace.finish();
      deps.activeTraces.delete(runId);
      deps.controllers.delete(session.id);
      release?.();
    }
  }
}
