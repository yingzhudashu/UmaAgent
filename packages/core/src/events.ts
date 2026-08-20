import type { AgentEventEnvelope, AgentEventType } from "@uma-agent/protocol";
import type { UmaDatabase } from "./database.js";

export type EventListener = (event: AgentEventEnvelope) => void;

export class EventHub {
  private listeners = new Set<EventListener>();

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
    const event = this.database.appendEvent(sessionId, runId, type, payload);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* Event consumers cannot break runtime state. */
      }
    }
    return event;
  }
}
