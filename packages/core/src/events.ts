import {
  type AgentEventEnvelope,
  type DurableAgentEventType,
  type MessageDelta,
  MessageDeltaSchema,
  PROTOCOL_VERSION,
  type ResourceInvalidated,
  type ResourceKind,
} from "@uma-agent/protocol";
import Value from "typebox/value";
import type { UmaDatabase } from "./database.js";

export type EventListener = (event: AgentEventEnvelope) => void;
export type ResourceListener = (event: ResourceInvalidated) => void;

export class EventHub {
  private listeners = new Set<EventListener>();
  private resourceListeners = new Set<ResourceListener>();
  private pending: AgentEventEnvelope[] | undefined;
  private pendingResources: Map<ResourceKind, string | undefined> | undefined;

  constructor(private readonly database: UmaDatabase) {}

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeResources(listener: ResourceListener): () => void {
    this.resourceListeners.add(listener);
    return () => this.resourceListeners.delete(listener);
  }

  invalidate(resource: ResourceKind, ownerId?: string): void {
    if (!this.pendingResources)
      throw new Error("Resource invalidations must be emitted inside an EventHub transaction");
    this.pendingResources.set(resource, ownerId);
  }

  emit(
    sessionId: string,
    runId: string | undefined,
    type: DurableAgentEventType,
    payload: unknown,
  ): AgentEventEnvelope {
    if (!this.pending) throw new Error("Durable events must be emitted inside an EventHub transaction");
    const event = this.database.appendEvent(sessionId, runId, type, payload);
    this.pending.push(event);
    return event;
  }

  emitTransientDelta(sessionId: string, runId: string | undefined, payload: MessageDelta): void {
    if (!Value.Check(MessageDeltaSchema, payload)) throw new Error("Invalid message.delta payload");
    this.broadcast({
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      ...(runId ? { runId } : {}),
      sequence: 0,
      timestamp: Date.now(),
      transient: true,
      type: "message.delta",
      payload,
    });
  }

  transaction<T>(operation: () => T): T {
    if (this.pending) return operation();
    const events: AgentEventEnvelope[] = [];
    const resources = new Map<ResourceKind, string | undefined>();
    this.pending = events;
    this.pendingResources = resources;
    try {
      const result = this.database.withTransaction(operation);
      this.pending = undefined;
      this.pendingResources = undefined;
      for (const event of events) this.broadcast(event);
      for (const [resource, ownerId] of resources) this.broadcastResource(resource, ownerId);
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

  private broadcastResource(resource: ResourceKind, ownerId?: string): void {
    const event: ResourceInvalidated = {
      type: "resource.invalidated",
      protocolVersion: PROTOCOL_VERSION,
      resource,
      ...(ownerId ? { ownerId } : {}),
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
