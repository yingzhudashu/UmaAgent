import type { AgentEventEnvelope, AgentEventType } from "@uma-agent/protocol";
import type { UmaDatabase } from "./database.js";

export type EventListener = (event: AgentEventEnvelope) => void;

export class EventHub {
  private listeners = new Set<EventListener>();
  private pending: AgentEventEnvelope[] | undefined;

  constructor(private readonly database: UmaDatabase) {}

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(
    sessionId: string,
    runId: string | undefined,
    type: AgentEventType,
    payload: unknown,
  ): AgentEventEnvelope {
    if (!this.pending) throw new Error("Durable events must be emitted inside an EventHub transaction");
    const event = this.database.appendEvent(sessionId, runId, type, payload);
    this.pending.push(event);
    return event;
  }

  transaction<T>(operation: () => T): T {
    if (this.pending) return operation();
    const events: AgentEventEnvelope[] = [];
    this.pending = events;
    try {
      const result = this.database.withTransaction(operation);
      this.pending = undefined;
      for (const event of events) this.broadcast(event);
      return result;
    } catch (error) {
      this.pending = undefined;
      throw error;
    }
  }

  private broadcast(event: AgentEventEnvelope): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* Event consumers cannot break runtime state. */
      }
    }
  }
}
