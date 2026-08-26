/** Bound retries for transient provider gateway failures such as HTTP 524. */
export const transientModelRetry = {
  maxRetries: 2,
  maxRetryDelayMs: 30_000,
} as const;

export function transientModelOptions(signal: AbortSignal) {
  return {
    signal,
    temperature: 0,
    headers: { "user-agent": "UmaAgent/1.0", accept: "application/json" },
    ...transientModelRetry,
  } as const;
}
