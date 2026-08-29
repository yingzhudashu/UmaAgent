import { type AgentMessage, convertToLlm, estimateContextTokens } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ThinkingLevel } from "@earendil-works/pi-ai";
import { assertContextCapacity } from "./context-manager.js";
import type { UmaDatabase } from "./database.js";
import { transientModelOptions } from "./model-retry.js";
import type { ModelRegistry } from "./models.js";
import { injectRuntimeFault } from "./runtime-support.js";
import type { TraceContext } from "./trace.js";

export interface ModelCompletionInput {
  runId: string;
  sessionId: string;
  role: "fast" | "reasoning";
  purpose: string;
  systemPrompt: string;
  messages: AgentMessage[];
  signal: AbortSignal;
  thinkingLevel?: ThinkingLevel;
  contextSummarySequence?: number;
  trace?: TraceContext;
  jsonMode?: boolean;
}

/** Single boundary for non-agent model calls, accounting, cache affinity and diagnostics. */
export class ModelCallService {
  constructor(
    private readonly database: UmaDatabase,
    private readonly models: ModelRegistry,
  ) {}

  async complete(input: ModelCompletionInput): Promise<AssistantMessage> {
    const model = this.models.forRole(input.role);
    const messages = convertToLlm(input.messages);
    const contextTokens = estimateContextTokens(input.messages).tokens;
    assertContextCapacity(model, input.messages, input.systemPrompt);
    const span = input.trace?.child(`model.${input.purpose}`, "model", {
      provider: model.provider,
      model: model.id,
      purpose: input.purpose,
      "context.messages": messages.length,
      "context.tokens_estimated": contextTokens,
      "context.compressed": input.contextSummarySequence !== undefined,
      ...(input.contextSummarySequence !== undefined
        ? { "context.summary_sequence": input.contextSummarySequence }
        : {}),
    });
    const startedAt = Date.now();
    const callId = this.database.startModelCall({
      runId: input.runId,
      provider: model.provider,
      model: model.id,
      role: `${input.role}:${input.purpose}`,
    });
    injectRuntimeFault("model.started");
    try {
      // pi-ai owns the single retry loop. Keeping retries out of this service prevents
      // nested retry budgets while retaining Retry-After handling and abortable waits.
      const response = await this.models.models.completeSimple(
        model,
        { systemPrompt: input.systemPrompt, messages },
        {
          ...transientModelOptions(
            input.signal,
            input.sessionId,
            `${input.role}:${input.purpose}:${model.provider}:${model.id}`,
          ),
          ...(input.thinkingLevel ? { reasoning: input.thinkingLevel } : {}),
          ...(input.jsonMode && model.api === "openai-completions"
            ? { samplingParams: { response_format: { type: "json_object" } } }
            : {}),
        },
      );
      const failed = response.stopReason === "error" || response.stopReason === "aborted";
      this.database.finishModelCall(callId, {
        status: failed ? "failed" : "completed",
        durationMs: Date.now() - startedAt,
        usage: response.usage,
        ...(response.errorMessage ? { error: response.errorMessage } : {}),
      });
      span?.setAttributes({
        "usage.cache_read": response.usage.cacheRead,
        "usage.cache_write": response.usage.cacheWrite,
        "usage.input": response.usage.input,
        "usage.output": response.usage.output,
      });
      span?.finish(
        failed
          ? {
              status: "error",
              error: { name: "ModelError", message: response.errorMessage ?? response.stopReason },
            }
          : { status: "ok" },
      );
      injectRuntimeFault("model.completed");
      return response;
    } catch (error) {
      this.database.finishModelCall(callId, {
        status: "failed",
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      span?.finish({
        status: "error",
        error: { name: error instanceof Error ? error.name : "Error", message: String(error) },
      });
      throw error;
    }
  }
}
