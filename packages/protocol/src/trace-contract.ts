import Type, { type Static } from "typebox";
import { Id, Strict, Timestamp } from "./schema-helpers.js";

export const TraceSpanEventSchema = Strict({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  occurredAt: Timestamp,
  attributes: Type.Record(
    Type.String({ maxLength: 80 }),
    Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
  ),
});
export type TraceSpanEvent = Static<typeof TraceSpanEventSchema>;

export const TraceSpanSchema = Strict({
  traceId: Id,
  spanId: Id,
  parentSpanId: Type.Optional(Id),
  runId: Type.Optional(Id),
  sessionId: Type.Optional(Id),
  depth: Type.Integer({ minimum: 0 }),
  service: Type.String({ minLength: 1, maxLength: 80 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  kind: Type.String({ minLength: 1, maxLength: 40 }),
  status: Type.Union([Type.Literal("ok"), Type.Literal("error"), Type.Literal("cancelled")]),
  startedAt: Timestamp,
  durationMs: Type.Integer({ minimum: 0 }),
  attributes: Type.Record(
    Type.String({ maxLength: 80 }),
    Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
  ),
  errorType: Type.Optional(Type.String({ maxLength: 200 })),
  errorMessage: Type.Optional(Type.String({ maxLength: 2_000 })),
  events: Type.Array(TraceSpanEventSchema, { maxItems: 64 }),
  endedAt: Timestamp,
});
export type TraceSpan = Static<typeof TraceSpanSchema>;

export const TraceQuerySchema = Strict({
  runId: Type.Optional(Id),
  traceId: Type.Optional(Id),
  from: Type.Optional(Timestamp),
  to: Type.Optional(Timestamp),
  status: Type.Optional(Type.Union([Type.Literal("ok"), Type.Literal("error"), Type.Literal("cancelled")])),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  service: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  kind: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});
export type TraceQuery = Static<typeof TraceQuerySchema>;

export const TraceQueryPageSchema = Strict({
  traceId: Id,
  runId: Type.Optional(Id),
  sessionId: Type.Optional(Id),
  rootSpanId: Type.Optional(Id),
  spans: Type.Array(TraceSpanSchema),
  hasMore: Type.Boolean(),
  nextOffset: Type.Integer({ minimum: 0 }),
});
export type TraceQueryPage = Static<typeof TraceQueryPageSchema>;
