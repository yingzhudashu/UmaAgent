import { randomUUID } from "node:crypto";
import type { Run, Session, TranscriptItem } from "@uma-agent/protocol";
import type { UmaDatabase } from "./database.js";
import type { EventHub } from "./events.js";
import type { ModelRegistry } from "./models.js";
import type { RunOrchestrator } from "./run-orchestrator.js";
import type { RunQualityService } from "./run-quality.js";

export interface QualityRunOptions {
  feedback?: string;
  force?: boolean;
  reset?: boolean;
}

interface RuntimeQualityDependencies {
  database: UmaDatabase;
  events: EventHub;
  orchestrator: RunOrchestrator;
  controllers: Map<string, AbortController>;
  isAcceptingRuns: () => boolean;
  getQualityService: () => RunQualityService;
  getReasoningModel: () => ReturnType<ModelRegistry["snapshot"]>;
}

/** Owns tool-free review/improve Runs while UmaRuntime remains the public facade. */
export class RuntimeQualityOperations {
  constructor(private readonly dependencies: RuntimeQualityDependencies) {}

  start(kind: "review" | "improve", targetMessageId: string, options: QualityRunOptions): Run {
    const { database, events, orchestrator } = this.dependencies;
    if (!this.dependencies.isAcceptingRuns()) throw new Error("UmaRuntime is not accepting new runs");
    let target = database.getMessage(targetMessageId);
    if (target.role !== "assistant") throw new Error("Quality operations require an assistant message");
    if (kind === "improve" && options.reset) {
      while (target.revisionOfMessageId) target = database.getMessage(target.revisionOfMessageId);
    }
    const owner = database.findMessageOwner(target.id);
    if (!owner) throw new Error("Message owner is unavailable");
    const session = database.getSession(owner.sessionId);
    const commandMessageId = randomUUID();
    const model = this.dependencies.getReasoningModel();
    const run = events.transaction(() => {
      const created = database.createRun(
        session.id,
        commandMessageId,
        model,
        session.thinkingLevel,
        kind,
      ).run;
      const command = database.insertMessage({
        id: commandMessageId,
        sessionId: session.id,
        runId: created.id,
        role: "user",
        status: "complete",
        content: kind === "review" ? "/review" : "/improve",
      });
      events.emit(session.id, created.id, "message.completed", command);
      events.emit(session.id, created.id, "run.updated", created);
      return created;
    });
    orchestrator.enqueue(session.id, () => this.execute(session, run.id, target, kind, options));
    return run;
  }

  private transitionRun(
    sessionId: string,
    runId: string,
    patch: Parameters<UmaDatabase["updateRun"]>[1],
  ): Run {
    const { database, events } = this.dependencies;
    return events.transaction(() => {
      const run = database.updateRun(runId, patch);
      events.emit(sessionId, runId, "run.updated", run);
      return run;
    });
  }

  private async execute(
    session: Session,
    runId: string,
    target: TranscriptItem,
    kind: "review" | "improve",
    options: QualityRunOptions,
  ): Promise<void> {
    const { database, events, orchestrator, controllers } = this.dependencies;
    const release = await orchestrator.acquire();
    if (database.getRun(runId).status === "cancelled") {
      release();
      return;
    }
    const controller = new AbortController();
    controllers.set(session.id, controller);
    try {
      const messages = database.listMessages(session.id);
      const targetIndex = messages.findIndex((item) => item.id === target.id);
      const question = [...messages.slice(0, targetIndex)]
        .reverse()
        .find((item) => item.role === "user")?.content;
      if (!question) throw new Error("The target answer has no preceding user message");
      this.transitionRun(session.id, runId, { status: "running", phase: "execute" });
      const quality = this.dependencies.getQualityService();
      let output = "";
      if (kind === "review") {
        const iterations = await quality.review(
          runId,
          question,
          target.content,
          options.feedback ?? "",
          controller.signal,
        );
        iterations.forEach((iteration, index) => {
          database.addQualityAssessment({
            runId,
            targetMessageId: target.id,
            passed: iteration.passed,
            issues: iteration.issues,
            suggestions: iteration.suggestions,
            iteration: index + 1,
          });
        });
        const last = iterations.at(-1);
        output =
          last?.improvedAnswer ??
          (last?.passed
            ? "Review passed: no material issues found."
            : `Review found issues:\n${(last?.issues ?? []).map((item) => `- ${item.description}`).join("\n")}`);
      } else {
        let assessments = database.listQualityForMessage(target.id);
        if (options.force || assessments.length === 0) {
          const reviewed = await quality.review(runId, question, target.content, "", controller.signal);
          reviewed.forEach((iteration, index) => {
            database.addQualityAssessment({
              runId,
              targetMessageId: target.id,
              passed: iteration.passed,
              issues: iteration.issues,
              suggestions: iteration.suggestions,
              iteration: index + 1,
            });
          });
          assessments = database.listQualityForMessage(target.id);
        }
        const suggestions = assessments.flatMap((item) => item.suggestions).filter(Boolean);
        if (!suggestions.length && !options.force) throw new Error("No quality suggestions are available");
        output = (
          await quality.improve(
            runId,
            question,
            target.content,
            suggestions.length ? suggestions : ["Improve accuracy, completeness and clarity"],
            controller.signal,
          )
        ).improvedAnswer;
      }
      events.transaction(() => {
        const message = database.insertMessage({
          sessionId: session.id,
          runId,
          role: "assistant",
          status: "complete",
          content: output,
          revisionOfMessageId: target.id,
        });
        const completed = database.updateRun(runId, { status: "completed", error: null });
        events.emit(session.id, runId, "message.completed", message);
        events.emit(session.id, runId, "run.updated", completed);
        events.invalidate("quality");
      });
    } catch (error) {
      this.transitionRun(session.id, runId, {
        status: controller.signal.aborted ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      controllers.delete(session.id);
      release();
    }
  }
}
