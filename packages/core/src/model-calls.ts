import { type AgentMessage, convertToLlm } from "@earendil-works/pi-agent-core";
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
  maxTokens?: number;
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
    const startedAt = Date.now();
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
          ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
          ...(input.jsonMode && model.api === "openai-completions"
            ? { samplingParams: { response_format: { type: "json_object" } } }
            : {}),
        },
      );
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
      // Trace 必须先终结；业务库创建/结算失败也不能留下永久运行中的 Span。
      span?.finish({
        status: "error",
        error: { name: error instanceof Error ? error.name : "Error", message: String(error) },
      });
      if (callId && !finishing) {
        try {
          this.database.finishModelCall(callId, {
            status: "failed",
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
        } catch (accountingError) {
          // 结算只尝试一次，保留原始模型失败和数据库失败，禁止盲重试未知结果的写入。
          throw new AggregateError([error, accountingError], "Model call and accounting both failed");
        }
      }
      throw error;
    }
  }
}
