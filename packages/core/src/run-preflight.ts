import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { SendMessageRequest, Session } from "@uma-agent/protocol";
import Value from "typebox/value";
import type { ContextManager } from "./context-manager.js";
import type { UmaDatabase } from "./database.js";
import type { ModelCallService } from "./model-calls.js";
import type { ModelRegistry } from "./models.js";
import { decisionFrom, extractJson, TaskClassificationSchema, textFromMessage } from "./runtime-support.js";
import type { TraceContext } from "./trace.js";
import type { PreflightDecision } from "./types.js";

function userMessage(content: string): AgentMessage {
  return { role: "user", content, timestamp: Date.now() };
}

function taskClassFromResponse(content: string): PreflightDecision["taskClass"] | undefined {
  try {
    const value = extractJson(content);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const taskClass = (value as { taskClass?: unknown }).taskClass;
    const normalized = typeof taskClass === "string" ? taskClass.trim().toLowerCase() : undefined;
    if (!Value.Check(TaskClassificationSchema, { taskClass: normalized })) return undefined;
    return normalized as PreflightDecision["taskClass"];
  } catch {
    return undefined;
  }
}

function isInvalidClassificationContract(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid task classification|classification.*contract|contract.*classification/i.test(message);
}

/** Classifies and plans a Run from the same persisted conversation used by the agent loop. */
export class RunPreflight {
  constructor(
    private readonly database: UmaDatabase,
    private readonly models: ModelRegistry,
    private readonly contextManager: ContextManager,
    private readonly modelCalls: ModelCallService,
  ) {}

  async decide(
    session: Session,
    request: Pick<SendMessageRequest, "messageId" | "text" | "mode">,
    signal: AbortSignal,
    runId: string,
    trace?: TraceContext,
  ): Promise<PreflightDecision> {
    const fastModel = this.models.forRole("fast");
    const reasoningModel = this.models.forRole("reasoning");
    const contextModel = fastModel.contextWindow <= reasoningModel.contextWindow ? fastModel : reasoningModel;
    const context = await this.contextManager.buildForMessage(
      session,
      request.messageId,
      signal,
      contextModel,
    );
    const baseMessages = [...context.messages, context.current.message];
    // Channel requests already have a fixed integration boundary. Let the agent
    // choose the channel tool directly instead of asking the generic preflight
    // model to infer what "咸鱼" refers to from the filesystem workspace.
    if (this.database.channelSession?.(session.id)?.channel === "xianyu" && request.mode === "agent") {
      return {
        taskClass: "simple",
        route: "direct",
        goal: request.text,
        reasoningSummary: "Xianyu requests execute through the channel tools",
        successCriteria: ["Use the appropriate Xianyu channel tool and report its result"],
        assumptions: [],
        questions: [],
        steps: [],
      };
    }
    let taskClass: PreflightDecision["taskClass"];
    if (request.mode === "plan") taskClass = "complex";
    else {
      const classify = async (messages: AgentMessage[]) => {
        try {
          const response = await this.modelCalls.complete({
            runId,
            sessionId: session.id,
            role: "fast",
            purpose: "classify",
            systemPrompt:
              'Classify the latest user request using the full conversation. Return JSON only: {"taskClass":"simple|standard|complex"}. Simple is a direct answer or one obvious action; standard may need clarification; complex needs multiple ordered steps. Do not include reasoning.',
            messages,
            signal,
            jsonMode: true,
            maxTokens: 64,
            ...(context.summary ? { contextSummarySequence: context.summary.throughSequence } : {}),
            ...(trace ? { trace } : {}),
          });
          if (response.stopReason === "error" || response.stopReason === "aborted") {
            if (isInvalidClassificationContract(response.errorMessage)) return undefined;
            throw new Error(response.errorMessage ?? "Task classification failed");
          }
          return taskClassFromResponse(contentText(response.content));
        } catch (error) {
          if (isInvalidClassificationContract(error)) return undefined;
          throw error;
        }
      };
      let classified = await classify(baseMessages);
      if (!classified) {
        classified = await classify([
          ...baseMessages,
          userMessage(
            "The previous response was invalid. Return exactly one valid classification JSON object.",
          ),
        ]);
      }
      // Classification only selects the preflight route. The conservative route keeps execution gated.
      taskClass = classified ?? "standard";
    }
    if (taskClass === "simple") {
      return {
        taskClass,
        route: "direct",
        goal: request.text,
        reasoningSummary: "Direct execution is sufficient",
        successCriteria: ["Satisfy the user request accurately"],
        assumptions: [],
        questions: [],
        steps: [],
      };
    }
    const memory = this.database.searchMemory(session.id, request.text, 5);
    const currentText = textFromMessage(context.current.message);
    const decisionMessages = [
      ...context.messages,
      {
        ...context.current.message,
        content: `${memory.length ? `<relevant_memory>\n${memory.join("\n")}\n</relevant_memory>\n\n` : ""}${currentText}`,
      } as AgentMessage,
    ];
    const decide = (messages: AgentMessage[]) =>
      this.modelCalls.complete({
        runId,
        sessionId: session.id,
        role: "reasoning",
        purpose: "preflight",
        systemPrompt:
          "Specify the latest request execution contract using the full conversation. Return JSON only with taskClass (standard|complex), goal, reasoningSummary (one public sentence), successCriteria (string[]), assumptions (string[]), questions (string[]), and steps (string[]). Put a question only when information is missing from both the conversation and relevant memory and it blocks safe work. For non-blocking uncertainty choose the safest reversible default and record it in assumptions. Never include chain-of-thought or an execution route; the server derives the route from the user's mode. Each step must be an actionable, verifiable plan item under 500 characters: first line is a concise action title, followed by short lines labelled '范围/输入：', '预期产出：', and '验证：'. Describe concrete scope, inputs, output, and completion check; avoid vague summaries, duplicate work, and internal reasoning.",
        messages,
        signal,
        ...(context.summary ? { contextSummarySequence: context.summary.throughSequence } : {}),
        ...(session.thinkingLevel === "off" ? {} : { thinkingLevel: session.thinkingLevel }),
        ...(trace ? { trace } : {}),
      });
    let response = await decide(decisionMessages);
    if (response.stopReason === "error" || response.stopReason === "aborted")
      throw new Error(response.errorMessage ?? "Preflight failed");
    let decision: Omit<PreflightDecision, "route">;
    try {
      decision = decisionFrom(extractJson(contentText(response.content)));
    } catch {
      response = await decide([
        ...decisionMessages,
        userMessage(
          "The previous response was invalid. Return exactly one valid execution-contract JSON object.",
        ),
      ]);
      if (response.stopReason === "error" || response.stopReason === "aborted")
        throw new Error(response.errorMessage ?? "Preflight repair failed");
      try {
        decision = decisionFrom(extractJson(contentText(response.content)));
      } catch {
        throw new Error("Provider contract error: invalid preflight response");
      }
    }
    decision.taskClass = taskClass;
    const route: PreflightDecision["route"] = decision.questions.length
      ? "clarify"
      : request.mode === "plan"
        ? "plan"
        : "direct";
    if (route === "plan" && decision.steps.length === 0) decision.steps = [decision.goal];
    const resolved: PreflightDecision = { ...decision, route };
    this.database.addAudit({
      runId,
      kind: "model",
      name: `${reasoningModel.provider}/${reasoningModel.id}:preflight`,
      output: resolved,
      status: response.stopReason,
      usage: response.usage,
    });
    return resolved;
  }
}
