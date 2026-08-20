export type {
  AdapterHealth,
  ChannelAdapter,
  ChannelInboundMessage,
  ExternalConversation,
} from "@uma-agent/protocol";

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 500;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || options.signal?.aborted) break;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(30_000, baseDelayMs * 2 ** attempt));
        options.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("Retry cancelled", "AbortError"));
          },
          { once: true },
        );
      });
    }
  }
  throw lastError;
}

export class UpdateThrottle {
  private lastUpdate = 0;
  constructor(private readonly intervalMs: number) {}
  ready(now = Date.now()): boolean {
    if (now - this.lastUpdate < this.intervalMs) return false;
    this.lastUpdate = now;
    return true;
  }
}
