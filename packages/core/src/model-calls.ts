import { type AgentMessage, convertToLlm } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { assertContextCapacity } from "./context-manager.js";
import type { UmaDatabase } from "./database.js";
import {
  DEFAULT_MODEL_TIMEOUT_MS,
  isMissingFinishReasonError,
  isRetryableModelError,
  missingFinishReasonRetry,
  modelRequestSignal,
  modelRetryDelayMs,
  recoverMissingFinishReason,
  traceProviderRetries,
  transientModelOptions,
  transientStreamRetry,
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
      // pi-ai owns HTTP status retries and Retry-After handling. This separate bounded
      // budget recovers transient failures returned after the SDK has exhausted that attempt.
      let response: AssistantMessage;
      let retryCount = 0;
      let missingFinishRetryCount = 0;
      for (;;) {
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
          response.stopReason === "error" &&
          isMissingFinishReasonError(response.errorMessage) &&
          missingFinishRetryCount < missingFinishReasonRetry.maxRetries &&
          retryCount < transientStreamRetry.maxRetries
        ) {
          retryCount++;
          missingFinishRetryCount++;
          span?.addEvent("model.retry", {
            attempt: retryCount,
            reason: "missing_finish_reason",
          });
          await waitForModelRetry(
            modelSignal,
            modelRetryDelayMs(retryCount, missingFinishReasonRetry.baseDelayMs),
          );
          continue;
        }
        if (
          response.stopReason === "error" &&
          !isMissingFinishReasonError(response.errorMessage) &&
          !modelSignal.aborted &&
          retryCount < transientStreamRetry.maxRetries &&
          isRetryableModelError(response)
        ) {
          retryCount++;
          span?.addEvent("model.retry", {
            attempt: retryCount,
            reason: "transient_provider_error",
          });
          await waitForModelRetry(modelSignal, modelRetryDelayMs(retryCount));
          continue;
        }
        break;
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
