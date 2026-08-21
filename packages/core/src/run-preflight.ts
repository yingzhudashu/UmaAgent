import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import type { SendMessageRequest, Session } from "@uma-agent/protocol";
import Value from "typebox/value";
import type { UmaDatabase } from "./database.js";
import type { ModelRegistry } from "./models.js";
import {
  decisionFrom,
  extractJson,
  injectRuntimeFault,
  isTransientProviderError,
  TaskClassificationSchema,
} from "./runtime-support.js";
import type { PreflightDecision } from "./types.js";

/** Owns structured control-model calls and request routing. */
export class RunPreflight {
  constructor(
    private readonly database: UmaDatabase,
    private readonly models: ModelRegistry,
  ) {}

  async complete(
    runId: string,
    role: "fast" | "reasoning",
    systemPrompt: string,
    prompt: string,
    signal: AbortSignal,
    allowTransientRetries = true,
  ): Promise<AssistantMessage> {
    const model = this.models.forRole(role);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const startedAt = Date.now();
      const callId = this.database.startModelCall({
        runId,
        provider: model.provider,
        model: model.id,
        role,
      });
      injectRuntimeFault("model.started");
      try {
        const response = await this.models.models.completeSimple(
          model,
          { systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
          { signal, temperature: 0 },
        );
        const retryable =
          allowTransientRetries &&
          response.stopReason === "error" &&
          /(429|rate.?limit|5\d\d|network|timeout|econn|fetch failed)/i.test(response.errorMessage ?? "");
        this.database.finishModelCall(callId, {
          status: response.stopReason,
          durationMs: Date.now() - startedAt,
          usage: response.usage,
          ...(response.errorMessage ? { error: response.errorMessage } : {}),
        });
        injectRuntimeFault("model.completed");
        if (!retryable || attempt === 2) return response;
        lastError = new Error(response.errorMessage ?? "Provider request failed");
      } catch (error) {
        this.database.finishModelCall(callId, {
          status: signal.aborted ? "aborted" : "failed",
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        lastError = error;
        if (signal.aborted || attempt === 2 || !allowTransientRetries || !isTransientProviderError(error))
          throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Provider request failed");
  }

  async decide(
    session: Session,
    prompt: string,
    mode: SendMessageRequest["mode"],
    signal: AbortSignal,
    runId: string,
  ): Promise<PreflightDecision> {
    let taskClass: PreflightDecision["taskClass"];
    if (mode === "direct") taskClass = "simple";
    else if (mode === "plan") taskClass = "complex";
    else {
      const classify = async (repair?: string) =>
        this.complete(
          runId,
          "fast",
          'Classify the request. Return JSON only: {"taskClass":"simple|standard|complex"}. Simple is a direct answer or one obvious action; standard may need clarification; complex needs multiple ordered steps. Do not include reasoning.',
          repair ?? prompt,
          signal,
        );
      let response = await classify();
      if (response.stopReason === "error" || response.stopReason === "aborted")
        throw new Error(response.errorMessage ?? "Task classification failed");
      try {
        const value = extractJson(contentText(response.content));
        if (!Value.Check(TaskClassificationSchema, value)) throw new Error("Invalid taskClass");
        taskClass = value.taskClass;
      } catch {
        response = await classify(
          `The previous response was invalid. Return exactly one valid JSON object for this request:\n${prompt}`,
        );
        if (response.stopReason === "error" || response.stopReason === "aborted")
          throw new Error(response.errorMessage ?? "Task classification repair failed");
        let value: unknown;
        try {
          value = extractJson(contentText(response.content));
        } catch {
          throw new Error("Provider contract error: invalid task classification");
        }
        if (!Value.Check(TaskClassificationSchema, value))
          throw new Error("Provider contract error: invalid task classification");
        taskClass = value.taskClass;
      }
    }
    if (taskClass === "simple") {
      return {
        taskClass,
        route: "direct",
        goal: prompt,
        reasoningSummary: "Direct execution is sufficient",
        successCriteria: ["Satisfy the user request accurately"],
        questions: [],
        steps: [],
      };
    }
    const memory = this.database.searchMemory(session.id, prompt, 5);
    const controlPrompt = `${prompt}${memory.length ? `\n\nKnown active user facts:\n${memory.join("\n")}` : ""}`;
    const decide = async (repair?: string) =>
      this.complete(
        runId,
        "reasoning",
        "Specify an agent request. Return JSON only with taskClass (standard|complex), route (direct|clarify|plan), goal, reasoningSummary (one public sentence), successCriteria (string[]), questions (string[]), and steps (string[]). Clarify only if missing information blocks safe work. Complex work must plan unless clarification is required. Never include chain-of-thought.",
        repair ?? controlPrompt,
        signal,
      );
    let response = await decide();
    if (response.stopReason === "error" || response.stopReason === "aborted")
      throw new Error(response.errorMessage ?? "Preflight failed");
    let decision: PreflightDecision;
    try {
      decision = decisionFrom(extractJson(contentText(response.content)));
    } catch {
      response = await decide(
        `The previous response was invalid. Return exactly one valid JSON object for this request:\n${controlPrompt}`,
      );
      if (response.stopReason === "error" || response.stopReason === "aborted")
        throw new Error(response.errorMessage ?? "Preflight repair failed");
      try {
        decision = decisionFrom(extractJson(contentText(response.content)));
      } catch {
        throw new Error("Provider contract error: invalid preflight response");
      }
    }
    decision.taskClass = taskClass;
    if (taskClass === "complex" && decision.route === "direct")
      throw new Error("Provider contract error: complex tasks require a plan or clarification");
    this.database.addAudit({
      runId,
      kind: "model",
      name: `${this.models.forRole("reasoning").provider}/${this.models.forRole("reasoning").id}:preflight`,
      output: decision,
      status: response.stopReason,
      usage: response.usage,
    });
    if (decision.route === "clarify" && decision.questions.length === 0)
      throw new Error("Clarification route requires questions");
    if (decision.route === "plan" && decision.steps.length === 0) decision.steps = [decision.goal];
    return decision;
  }
}
