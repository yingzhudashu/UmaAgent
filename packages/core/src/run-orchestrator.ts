import { Semaphore } from "./runtime-support.js";

type Operation = () => Promise<void>;

type QueueEntry = {
  operation: Operation;
};

type SessionQueue = {
  pending: QueueEntry[];
  running: boolean;
  paused: boolean;
};

/** Owns per-session ordering and the cross-session concurrency budget. */
export class RunOrchestrator {
  private readonly sessions = new Map<string, SessionQueue>();
  private readonly semaphore: Semaphore;
  private readonly idleWaiters = new Set<() => void>();

  constructor(maxParallelSessions: number) {
    this.semaphore = new Semaphore(maxParallelSessions);
  }

  enqueue(sessionId: string, operation: Operation): void {
    this.enqueueEntry(sessionId, { operation }, false);
  }

  enqueueFirst(sessionId: string, operation: Operation): void {
    this.enqueueEntry(sessionId, { operation }, true);
  }

  pause(sessionId: string): void {
    this.getSession(sessionId).paused = true;
  }

  resume(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.paused = false;
    this.pump(sessionId, session);
  }

  acquire(): Promise<() => void> {
    return this.semaphore.acquire();
  }

  activeCount(): number {
    return this.semaphore.count();
  }

  async drain(): Promise<void> {
    // A stopped runtime must be able to drain a session paused for clarification.
    for (const [sessionId, session] of this.sessions) {
      session.paused = false;
      this.pump(sessionId, session);
    }
    if (this.isIdle()) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  private enqueueEntry(sessionId: string, entry: QueueEntry, first: boolean): void {
    const session = this.getSession(sessionId);
    if (first) session.pending.unshift(entry);
    else session.pending.push(entry);
    this.pump(sessionId, session);
  }

  private getSession(sessionId: string): SessionQueue {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionQueue = { pending: [], running: false, paused: false };
    this.sessions.set(sessionId, created);
    return created;
  }

  private pump(sessionId: string, session: SessionQueue): void {
    if (session.running || session.paused) return;
    const entry = session.pending.shift();
    if (!entry) {
      this.sessions.delete(sessionId);
      this.resolveIdleWaiters();
      return;
    }
    session.running = true;
    void Promise.resolve()
      .then(entry.operation)
      .catch(() => {})
      .finally(() => {
        session.running = false;
        this.pump(sessionId, session);
      });
  }

  private isIdle(): boolean {
    return [...this.sessions.values()].every((session) => !session.running && session.pending.length === 0);
  }

  private resolveIdleWaiters(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
