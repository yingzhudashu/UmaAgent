import { Semaphore } from "./runtime-support.js";

/** Owns per-session FIFO ordering and the cross-session concurrency budget. */
export class RunOrchestrator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly semaphore: Semaphore;

  constructor(maxParallelSessions: number) {
    this.semaphore = new Semaphore(maxParallelSessions);
  }

  enqueue(sessionId: string, operation: () => Promise<void>): void {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    const tail = next.finally(() => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    });
    this.tails.set(sessionId, tail);
  }

  acquire(): Promise<() => void> {
    return this.semaphore.acquire();
  }

  activeCount(): number {
    return this.semaphore.count();
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.tails.values());
  }
}
