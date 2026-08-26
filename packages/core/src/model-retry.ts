/** Bound retries for transient provider gateway failures such as HTTP 524. */
export const transientModelRetry = {
  maxRetries: 2,
  // Some OpenAI-compatible gateways return Retry-After: 60 with transient 502s.
  // Honour that bounded, server-directed backoff instead of turning it into a hard failure.
  maxRetryDelayMs: 60_000,
} as const;

export function transientModelOptions(signal: AbortSignal) {
  return {
    signal,
    temperature: 0,
    headers: { "user-agent": "UmaAgent/1.0", accept: "application/json" },
    ...transientModelRetry,
  } as const;
}
