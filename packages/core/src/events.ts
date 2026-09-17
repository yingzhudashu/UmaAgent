import {
  type AgentEventEnvelope,
  type DurableAgentEventType,
  type MessageDelta,
  MessageDeltaSchema,
  PROTOCOL_VERSION,
  type ResourceInvalidated,
  type ResourceKind,
  type SessionSnapshot,
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
  private readonly streaming = new Map<
    string,
    { runId: string | undefined; content: string; updatedAt: number }
  >();

  constructor(private readonly database: UmaDatabase) {}

  /** 临时正文不写业务库，但进入会话或重连时必须能取得完整的当前前缀。 */
  overlaySnapshot(snapshot: SessionSnapshot): SessionSnapshot {
    return {
      ...snapshot,
      transcript: snapshot.transcript.map((item) => {
        const draft = this.streaming.get(item.id);
        return draft ? { ...item, content: draft.content, updatedAt: draft.updatedAt } : item;
      }),
    };
  }

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
    const payload = event.payload as Record<string, unknown>;
    if (event.type === "message.started" && payload.status === "streaming")
      this.streaming.set(String(payload.id), {
        runId: event.runId,
        content: String(payload.content ?? ""),
        updatedAt: event.timestamp,
      });
    else if (event.type === "message.delta") {
      const delta = event.payload as MessageDelta;
      const draft = this.streaming.get(delta.messageId);
      if (draft && delta.offset === draft.content.length) {
        draft.content += delta.append;
        draft.updatedAt = delta.updatedAt;
      }
    } else if (event.type === "message.completed")
      this.streaming.delete(String(payload.id ?? payload.messageId));
    else if (
      event.type === "run.updated" &&
      ["completed", "failed", "cancelled", "interrupted"].includes(String(payload.status))
    ) {
      for (const [id, draft] of this.streaming) if (draft.runId === event.runId) this.streaming.delete(id);
    }
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
