import Type, { type Static } from "typebox";
import { Id, PROTOCOL_VERSION, Strict, Timestamp } from "./schema-helpers.js";

export const DurableEventTypeSchema = Type.Union([
  Type.Literal("sync.started"),
  Type.Literal("sync.completed"),
  Type.Literal("session.snapshot"),
  Type.Literal("run.updated"),
  Type.Literal("message.started"),
  Type.Literal("message.completed"),
  Type.Literal("response.started"),
  Type.Literal("response.updated"),
  Type.Literal("response.activity"),
  Type.Literal("response.attachment.updated"),
  Type.Literal("response.completed"),
  Type.Literal("plan.updated"),
  Type.Literal("tool.started"),
  Type.Literal("tool.completed"),
  Type.Literal("approval.requested"),
  Type.Literal("approval.resolved"),
  Type.Literal("server.status"),
  Type.Literal("run.awaiting_input"),
  Type.Literal("run.resumed"),
  Type.Literal("run.action_prepared"),
  Type.Literal("run.action_decided"),
  Type.Literal("run.loop_warning"),
  Type.Literal("task.updated"),
  Type.Literal("memory.updated"),
  Type.Literal("schedule.updated"),
  Type.Literal("knowledge.updated"),
]);
export const EventTypeSchema = Type.Union([DurableEventTypeSchema, Type.Literal("message.delta")]);
export type DurableAgentEventType = Static<typeof DurableEventTypeSchema>;
export type AgentEventType = Static<typeof EventTypeSchema>;

export const MessageDeltaSchema = Strict({
  messageId: Id,
  responseId: Type.Optional(Id),
  append: Type.String({ minLength: 1 }),
  updatedAt: Timestamp,
});
export type MessageDelta = Static<typeof MessageDeltaSchema>;

const DurableAgentEventEnvelopeSchema = Strict({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  sessionId: Id,
  runId: Type.Optional(Id),
  sequence: Type.Integer({ minimum: 1 }),
  timestamp: Timestamp,
  type: DurableEventTypeSchema,
  payload: Type.Unknown(),
});
const TransientMessageDeltaEnvelopeSchema = Strict({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  sessionId: Id,
  runId: Type.Optional(Id),
  sequence: Type.Literal(0),
  timestamp: Timestamp,
  transient: Type.Literal(true),
  type: Type.Literal("message.delta"),
  payload: MessageDeltaSchema,
});
export const AgentEventEnvelopeSchema = Type.Union([
  DurableAgentEventEnvelopeSchema,
  TransientMessageDeltaEnvelopeSchema,
]);
export type AgentEventEnvelope = Static<typeof AgentEventEnvelopeSchema>;
