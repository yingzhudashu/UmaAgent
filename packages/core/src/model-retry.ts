import { createHash } from "node:crypto";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";

/** 单次 Provider 调用（含 SDK/应用层重试）的硬时限；用户取消仍由独立 AbortSignal 即时生效。 */
export const DEFAULT_MODEL_TIMEOUT_MS = 10 * 60_000;

/** Bound retries for transient provider gateway failures such as HTTP 524. */
export const transientModelRetry = {
  maxRetries: 5,
  // Some OpenAI-compatible gateways return Retry-After: 60 with transient 502s.
  // Honour that bounded, server-directed backoff instead of turning it into a hard failure.
  maxRetryDelayMs: 120_000,
} as const;

/** A gateway can close a complete SSE response before sending its final marker. */
export const missingFinishReasonRetry = {
  maxRetries: 5,
  baseDelayMs: 500,
} as const;

/** Retry transient provider failures before any part of the response is exposed. */
export const transientStreamRetry = {
  maxRetries: 7,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
} as const;

export type ModelRetryReason = "missing_finish_reason" | "transient_provider_error";
export type ModelRetryErrorFactory = (error: unknown) => AssistantMessage;

export function modelRetryDelayMs(
  attempt: number,
  baseDelayMs: number = transientStreamRetry.baseDelayMs,
): number {
  const exponential = Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), transientStreamRetry.maxDelayMs);
  return Math.floor(exponential * (0.5 + Math.random() * 0.5));
}

export function isMissingFinishReasonError(message: string | undefined): boolean {
  return message?.trim() === "Stream ended without finish_reason";
}

/** Recover only a complete response; an empty response must still be retried/failed. */
export function recoverMissingFinishReason(message: AssistantMessage): AssistantMessage | undefined {
  if (
    !isMissingFinishReasonError(message.errorMessage) ||
    message.content.length === 0 ||
    message.content.some((block) => block.type === "toolCall")
  )
    return undefined;
  const { errorMessage: _errorMessage, ...withoutError } = message;
  return {
    ...withoutError,
    stopReason: "stop",
  };
}

export async function waitForModelRetry(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) throw new Error("Request was aborted");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Request was aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/** Bound the complete provider operation, including SDK retries and backoff. */
export function modelRequestSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

/** 在现有 Provider fetch 边界观察实际重试，不复制 SDK 的重试判定和退避策略。 */
export function traceProviderRetries(
  fetcher: typeof globalThis.fetch,
  onRetry: (attempt: number) => void,
): typeof globalThis.fetch {
  let failedAttempt = false;
  let retryCount = 0;
  return async (input, init) => {
    if (failedAttempt) {
      retryCount++;
      failedAttempt = false;
      onRetry(retryCount);
    }
    try {
      const response = await fetcher(input, init);
      if (!response.ok) failedAttempt = true;
      return response;
    } catch (error) {
      failedAttempt = true;
      throw error;
    }
  };
}

function hasStreamOutput(event: AssistantMessageEvent): boolean {
  if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")
    return event.delta.length > 0;
  if (event.type === "text_end" || event.type === "thinking_end") return event.content.length > 0;
  return event.type === "toolcall_end";
}

/** Preserve live streaming, retrying transient failures only before meaningful output. */
export function retryMissingFinishReasonStream(
  create: () => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  signal: AbortSignal,
  onRetry?: (attempt: number, reason: ModelRetryReason) => void,
  createErrorMessage?: ModelRetryErrorFactory,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  let retryCount = 0;
  let lastErrorMessage: AssistantMessage | undefined;
  void (async () => {
    for (;;) {
      let source: AssistantMessageEventStream;
      try {
        source = await create();
      } catch (error) {
        const message = createErrorMessage?.(error);
        const retryable =
          message !== undefined &&
          !signal.aborted &&
          retryCount < transientStreamRetry.maxRetries &&
          isRetryableAssistantError(message);
        if (retryable) {
          retryCount++;
          onRetry?.(retryCount, "transient_provider_error");
          await waitForModelRetry(signal, modelRetryDelayMs(retryCount));
          continue;
        }
        if (message) {
          lastErrorMessage = message;
          output.push({
            type: "error",
            reason: message.stopReason === "aborted" ? "aborted" : "error",
            error: message,
          });
        }
        output.end();
        return;
      }
      const pending: AssistantMessageEvent[] = [];
      let started = false;
      let shouldRetry = false;
      let retryReason: ModelRetryReason = "missing_finish_reason";
      let hasTerminalEvent = false;
      let lastPartial: AssistantMessage | undefined;
      let streamIterationFailed = false;
      let streamIterationError: unknown;
      try {
        for await (const event of source) {
          if ("partial" in event) lastPartial = event.partial;
          if (event.type === "error" && isMissingFinishReasonError(event.error.errorMessage)) {
            lastErrorMessage = event.error;
            hasTerminalEvent = true;
            const recovered = recoverMissingFinishReason(event.error);
            if (recovered) {
              for (const buffered of pending) output.push(buffered);
              output.push({
                type: "done",
                reason: "stop",
                message: recovered,
              });
              output.end();
              return;
            }
            shouldRetry = !started && retryCount < missingFinishReasonRetry.maxRetries;
            retryReason = "missing_finish_reason";
          } else if (event.type === "error") {
            lastErrorMessage = event.error;
            hasTerminalEvent = true;
            shouldRetry =
              !started &&
              event.error.stopReason === "error" &&
              retryCount < transientStreamRetry.maxRetries &&
              isRetryableAssistantError(event.error);
            retryReason = "transient_provider_error";
          }
          if (event.type === "done") hasTerminalEvent = true;
          if (!started && hasStreamOutput(event)) {
            started = true;
            for (const buffered of pending) output.push(buffered);
            pending.length = 0;
          }
          if (started) output.push(event);
          else pending.push(event);
        }
      } catch (error) {
        // Fetch/SSE adapters may reject the async iterator instead of emitting an error event.
        // Treat that transport close exactly like an empty transient stream, but never replay
        // after meaningful output has already reached the caller.
        streamIterationError = error;
        streamIterationFailed = true;
      }
      if (streamIterationFailed) {
        const message = createErrorMessage?.(streamIterationError);
        if (message) {
          lastErrorMessage = message;
          hasTerminalEvent = true;
          shouldRetry =
            !started && retryCount < transientStreamRetry.maxRetries && isRetryableAssistantError(message);
          retryReason = "transient_provider_error";
          const errorEvent: AssistantMessageEvent = {
            type: "error",
            reason: message.stopReason === "aborted" ? "aborted" : "error",
            error: message,
          };
          if (started) output.push(errorEvent);
          else pending.push(errorEvent);
        }
      }

      // Some transports close the socket without emitting a final event. Surface that
      // as a retryable provider failure instead of silently ending the agent stream.
      if (!hasTerminalEvent) {
        const error = new Error("Provider stream terminated before a final response");
        const message = lastPartial
          ? { ...lastPartial, stopReason: "error" as const, errorMessage: error.message }
          : createErrorMessage?.(error);
        if (message) {
          lastErrorMessage = message;
          shouldRetry =
            !started && retryCount < transientStreamRetry.maxRetries && isRetryableAssistantError(message);
          retryReason = "transient_provider_error";
          const errorEvent: AssistantMessageEvent = {
            type: "error",
            reason: "error",
            error: message,
          };
          if (started) output.push(errorEvent);
          else pending.push(errorEvent);
        }
      }

      if (shouldRetry) {
        retryCount++;
        onRetry?.(retryCount, retryReason);
        const baseDelayMs =
          retryReason === "missing_finish_reason"
            ? missingFinishReasonRetry.baseDelayMs
            : transientStreamRetry.baseDelayMs;
        await waitForModelRetry(signal, modelRetryDelayMs(retryCount, baseDelayMs));
        continue;
      }
      for (const buffered of pending) output.push(buffered);
      output.end();
      return;
    }
  })().catch((error: unknown) => {
    const message = createErrorMessage?.(error) ?? lastErrorMessage;
    if (message) {
      output.push({
        type: "error",
        reason: message.stopReason === "aborted" ? "aborted" : "error",
        error: message,
      });
    }
    output.end();
  });
  return output;
}

export function modelCacheKey(sessionId: string, namespace = "default"): string {
  return `uma-${createHash("sha256")
    .update(`uma-agent:prompt-cache:v2:${namespace}:${sessionId}`)
    .digest("hex")
    .slice(0, 48)}`;
}

export function transientModelOptions(signal: AbortSignal, sessionId?: string, namespace = "default") {
  return {
    signal,
    temperature: 0,
    headers: { "user-agent": "UmaAgent/1.0", accept: "application/json" },
    ...(sessionId
      ? { sessionId: modelCacheKey(sessionId, namespace), cacheRetention: "short" as const }
      : {}),
    ...transientModelRetry,
  } as const;
}
