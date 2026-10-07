import { createHash } from "node:crypto";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

/** Bound retries for transient provider gateway failures such as HTTP 524. */
export const transientModelRetry = {
  maxRetries: 5,
  // Some OpenAI-compatible gateways return Retry-After: 60 with transient 502s.
  // Honour that bounded, server-directed backoff instead of turning it into a hard failure.
  maxRetryDelayMs: 120_000,
} as const;

/** A gateway can close a complete SSE response before sending its final marker. */
export const missingFinishReasonRetry = {
  maxRetries: 2,
  baseDelayMs: 250,
} as const;

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
      reject(new Error("Request was aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function hasStreamOutput(event: AssistantMessageEvent): boolean {
  return (
    event.type === "text_delta" ||
    event.type === "thinking_delta" ||
    event.type === "toolcall_delta" ||
    event.type === "toolcall_end"
  );
}

/** Preserve token streaming while retrying an empty, prematurely closed SSE stream. */
export function retryMissingFinishReasonStream(
  create: () => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  signal: AbortSignal,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    for (let attempt = 0; ; attempt++) {
      const source = await create();
      const pending: AssistantMessageEvent[] = [];
      let started = false;
      let shouldRetry = false;
      for await (const event of source) {
        if (event.type === "error" && isMissingFinishReasonError(event.error.errorMessage)) {
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
          shouldRetry = !started && attempt < missingFinishReasonRetry.maxRetries;
        }
        if (!started && hasStreamOutput(event)) {
          started = true;
          for (const buffered of pending) output.push(buffered);
          pending.length = 0;
        }
        if (started) output.push(event);
        else pending.push(event);
      }
      if (shouldRetry) {
        await waitForModelRetry(signal, missingFinishReasonRetry.baseDelayMs * 2 ** attempt);
        continue;
      }
      for (const buffered of pending) output.push(buffered);
      output.end();
      return;
    }
  })().catch(() => {
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
