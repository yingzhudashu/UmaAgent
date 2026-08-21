import {
  type AgentEventEnvelope,
  type AgentEventType,
  PROTOCOL_VERSION,
  type ResourceInvalidated,
  type ResourceKind,
} from "@uma-agent/protocol";
import type { UmaDatabase } from "./database.js";

export type EventListener = (event: AgentEventEnvelope) => void;
export type ResourceListener = (event: ResourceInvalidated) => void;

export class EventHub {
  private listeners = new Set<EventListener>();
  private resourceListeners = new Set<ResourceListener>();
  private pending: AgentEventEnvelope[] | undefined;
  private pendingResources: Set<ResourceKind> | undefined;

  constructor(private readonly database: UmaDatabase) {}

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeResources(listener: ResourceListener): () => void {
    this.resourceListeners.add(listener);
    return () => this.resourceListeners.delete(listener);
  }

  invalidate(resource: ResourceKind): void {
    if (!this.pendingResources)
      throw new Error("Resource invalidations must be emitted inside an EventHub transaction");
    this.pendingResources.add(resource);
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
    const resources = new Set<ResourceKind>();
    this.pending = events;
    this.pendingResources = resources;
    try {
      const result = this.database.withTransaction(operation);
      this.pending = undefined;
      this.pendingResources = undefined;
      for (const event of events) this.broadcast(event);
      for (const resource of resources) this.broadcastResource(resource);
      return result;
    } catch (error) {
      this.pending = undefined;
      this.pendingResources = undefined;
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

  private broadcastResource(resource: ResourceKind): void {
    const event: ResourceInvalidated = {
      type: "resource.invalidated",
      protocolVersion: PROTOCOL_VERSION,
      resource,
      timestamp: Date.now(),
    };
    for (const listener of this.resourceListeners) {
      try {
        listener(event);
      } catch {
        /* Resource consumers cannot break runtime state. */
      }
    }
  }
}
