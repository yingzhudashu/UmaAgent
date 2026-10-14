import { type AgentMessage, convertToLlm } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { assertContextCapacity } from "./context-manager.js";
import type { UmaDatabase } from "./database.js";
import {
  DEFAULT_MODEL_TIMEOUT_MS,
  isMissingFinishReasonError,
  missingFinishReasonRetry,
  modelRequestSignal,
  recoverMissingFinishReason,
  traceProviderRetries,
  transientModelOptions,
  waitForModelRetry,
} from "./model-retry.js";
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
  thinkingLevel?: ModelThinkingLevel;
  contextSummarySequence?: number;
  trace?: TraceContext;
  jsonMode?: boolean;
  maxTokens?: number;
}

/** Single boundary for non-agent model calls, accounting, cache affinity and diagnostics. */
export class ModelCallService {
  constructor(
    private readonly database: UmaDatabase,
    private readonly models: ModelRegistry,
    private readonly modelTimeoutMs = DEFAULT_MODEL_TIMEOUT_MS,
  ) {}

  async complete(input: ModelCompletionInput): Promise<AssistantMessage> {
    const model = this.models.forRole(input.role);
    const messages = convertToLlm(input.messages);
    // 容量校验与遥测共享一次估算，长历史不再重复遍历；模型输入保持完整。
    const contextTokens = assertContextCapacity(model, input.messages, input.systemPrompt);
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
    const tracedFetch = traceProviderRetries(globalThis.fetch, (attempt) =>
      span?.addEvent("model.retry", { attempt, reason: "provider_request" }),
    );
    const startedAt = Date.now();
    const modelSignal = modelRequestSignal(input.signal, this.modelTimeoutMs);
    let callId: string | undefined;
    let finishing = false;
    try {
      callId = this.database.startModelCall({
        runId: input.runId,
        provider: model.provider,
        model: model.id,
        role: `${input.role}:${input.purpose}`,
      });
      injectRuntimeFault("model.started");
      // pi-ai owns the single retry loop. Keeping retries out of this service prevents
      // nested retry budgets while retaining Retry-After handling and abortable waits.
      let response: AssistantMessage;
      for (let attempt = 0; ; attempt++) {
        response = await this.models.models.completeSimple(
          model,
          { systemPrompt: input.systemPrompt, messages },
          {
            ...transientModelOptions(
              modelSignal,
              input.sessionId,
              `${input.role}:${input.purpose}:${model.provider}:${model.id}`,
            ),
            signal: modelSignal,
            fetch: tracedFetch,
            timeoutMs: this.modelTimeoutMs,
            ...(input.thinkingLevel && input.thinkingLevel !== "off"
              ? { reasoning: input.thinkingLevel }
              : {}),
            ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
            ...(input.jsonMode && model.api === "openai-completions"
              ? { samplingParams: { response_format: { type: "json_object" } } }
              : {}),
          },
        );
        const recovered = recoverMissingFinishReason(response);
        if (recovered) {
          response = recovered;
          break;
        }
        if (
          response.stopReason !== "error" ||
          !isMissingFinishReasonError(response.errorMessage) ||
          attempt >= missingFinishReasonRetry.maxRetries
        )
          break;
        span?.addEvent("model.retry", {
          attempt: attempt + 1,
          reason: "missing_finish_reason",
        });
        await waitForModelRetry(modelSignal, missingFinishReasonRetry.baseDelayMs * 2 ** attempt);
      }
      if (modelSignal.aborted && !input.signal.aborted)
        throw new Error(`Model request timed out after ${this.modelTimeoutMs}ms`);
      const failed = response.stopReason === "error" || response.stopReason === "aborted";
      finishing = true;
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
      const failure =
        modelSignal.aborted && !input.signal.aborted
          ? new Error(`Model request timed out after ${this.modelTimeoutMs}ms`)
          : error;
      // Trace 必须先终结；业务库创建/结算失败也不能留下永久运行中的 Span。
      span?.finish({
        status: "error",
        error: { name: failure instanceof Error ? failure.name : "Error", message: String(failure) },
      });
      if (callId && !finishing) {
        try {
          this.database.finishModelCall(callId, {
            status: "failed",
            durationMs: Date.now() - startedAt,
            error: failure instanceof Error ? failure.message : String(failure),
          });
        } catch (accountingError) {
          // 结算只尝试一次，保留原始模型失败和数据库失败，禁止盲重试未知结果的写入。
          throw new AggregateError([failure, accountingError], "Model call and accounting both failed");
        }
      }
      throw failure;
    }
  }
}
