import { createHash } from "node:crypto";

/** Bound retries for transient provider gateway failures such as HTTP 524. */
export const transientModelRetry = {
  maxRetries: 2,
  // Some OpenAI-compatible gateways return Retry-After: 60 with transient 502s.
  // Honour that bounded, server-directed backoff instead of turning it into a hard failure.
  maxRetryDelayMs: 60_000,
} as const;

export function modelCacheKey(sessionId: string): string {
  return `uma-${createHash("sha256").update(`uma-agent:prompt-cache:v1:${sessionId}`).digest("hex").slice(0, 48)}`;
}

export function transientModelOptions(signal: AbortSignal, sessionId?: string) {
  return {
    signal,
    temperature: 0,
    headers: { "user-agent": "UmaAgent/1.0", accept: "application/json" },
    ...(sessionId ? { sessionId: modelCacheKey(sessionId), cacheRetention: "short" as const } : {}),
    ...transientModelRetry,
  } as const;
}
