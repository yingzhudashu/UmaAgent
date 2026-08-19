import Type, { type Static } from "typebox";

export const PROTOCOL_VERSION = 1 as const;
const Id = Type.String({ minLength: 1, maxLength: 128 });
const Timestamp = Type.Integer({ minimum: 0 });
const Strict = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const ModelRefSchema = Strict({ provider: Id, id: Id });
export type ModelRef = Static<typeof ModelRefSchema>;

export const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

export const PlanStepSchema = Strict({
  id: Id,
  title: Type.String({ minLength: 1, maxLength: 500 }),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
  ]),
});
export type PlanStep = Static<typeof PlanStepSchema>;

export const AttachmentSchema = Strict({
  id: Id,
  name: Type.String({ minLength: 1 }),
  mimeType: Type.String({ minLength: 1 }),
  size: Type.Integer({ minimum: 0 }),
  createdAt: Timestamp,
});
export type Attachment = Static<typeof AttachmentSchema>;

export const TranscriptItemSchema = Strict({
  id: Id,
  sequence: Type.Integer({ minimum: 1 }),
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool")]),
  status: Type.Union([
    Type.Literal("streaming"),
    Type.Literal("complete"),
    Type.Literal("error"),
    Type.Literal("cancelled"),
  ]),
  content: Type.String(),
  name: Type.Optional(Type.String()),
  runId: Type.Optional(Id),
  attachments: Type.Array(AttachmentSchema),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type TranscriptItem = Static<typeof TranscriptItemSchema>;

export const RunStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("preflight"),
  Type.Literal("awaiting_input"),
  Type.Literal("running"),
  Type.Literal("verifying"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("interrupted"),
]);
export type RunStatus = Static<typeof RunStatusSchema>;

export const RunSchema = Strict({
  id: Id,
  sessionId: Id,
  messageId: Id,
  status: RunStatusSchema,
  route: Type.Optional(Type.Union([Type.Literal("direct"), Type.Literal("clarify"), Type.Literal("plan")])),
  reasoningSummary: Type.Optional(Type.String()),
  plan: Type.Array(PlanStepSchema),
  error: Type.Optional(Type.String()),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Run = Static<typeof RunSchema>;

export const SessionSchema = Strict({
  id: Id,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  workspace: Type.String({ minLength: 1 }),
  model: ModelRefSchema,
  thinkingLevel: ThinkingLevelSchema,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Session = Static<typeof SessionSchema>;

export const SessionSnapshotSchema = Strict({
  session: SessionSchema,
  transcript: Type.Array(TranscriptItemSchema),
  runs: Type.Array(RunSchema),
  revision: Type.Integer({ minimum: 0 }),
});
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>;

export const ApprovalSchema = Strict({
  id: Id,
  sessionId: Id,
  runId: Id,
  toolCallId: Id,
  toolName: Id,
  input: Type.Unknown(),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("approved"),
    Type.Literal("denied"),
    Type.Literal("expired"),
  ]),
  createdAt: Timestamp,
  resolvedAt: Type.Optional(Timestamp),
});
export type Approval = Static<typeof ApprovalSchema>;

export const SkillSummarySchema = Strict({
  name: Id,
  description: Type.String(),
  path: Type.String(),
  enabled: Type.Boolean(),
  diagnostics: Type.Array(Type.String()),
});
export type SkillSummary = Static<typeof SkillSummarySchema>;

export const KnowledgeSourceSchema = Strict({
  id: Id,
  name: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  documentCount: Type.Integer({ minimum: 0 }),
  createdAt: Timestamp,
});
export type KnowledgeSource = Static<typeof KnowledgeSourceSchema>;

export const EventTypeSchema = Type.Union([
  Type.Literal("session.snapshot"),
  Type.Literal("run.updated"),
  Type.Literal("message.started"),
  Type.Literal("message.delta"),
  Type.Literal("message.completed"),
  Type.Literal("plan.updated"),
  Type.Literal("tool.started"),
  Type.Literal("tool.completed"),
  Type.Literal("approval.requested"),
  Type.Literal("approval.resolved"),
  Type.Literal("server.status"),
]);
export type AgentEventType = Static<typeof EventTypeSchema>;

export const AgentEventEnvelopeSchema = Strict({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  sessionId: Id,
  runId: Type.Optional(Id),
  sequence: Type.Integer({ minimum: 1 }),
  timestamp: Timestamp,
  type: EventTypeSchema,
  payload: Type.Unknown(),
});
export type AgentEventEnvelope = Static<typeof AgentEventEnvelopeSchema>;

export const ErrorResponseSchema = Strict({
  error: Strict({ code: Id, message: Type.String(), details: Type.Optional(Type.Unknown()) }),
});
export type ErrorResponse = Static<typeof ErrorResponseSchema>;

export const CreateSessionRequestSchema = Strict({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  workspace: Type.Optional(Type.String({ minLength: 1 })),
  model: Type.Optional(ModelRefSchema),
});
export type CreateSessionRequest = Static<typeof CreateSessionRequestSchema>;

export const UpdateSessionRequestSchema = Strict({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  model: Type.Optional(ModelRefSchema),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
});
export type UpdateSessionRequest = Static<typeof UpdateSessionRequestSchema>;

export const SendMessageRequestSchema = Strict({
  messageId: Id,
  text: Type.String({ minLength: 1, maxLength: 1_000_000 }),
  attachmentIds: Type.Optional(Type.Array(Id, { maxItems: 20 })),
  mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("direct"), Type.Literal("plan")])),
});
export type SendMessageRequest = Static<typeof SendMessageRequestSchema>;

export const SendMessageResponseSchema = Strict({ runId: Id, status: RunStatusSchema });
export type SendMessageResponse = Static<typeof SendMessageResponseSchema>;

export const HealthSchema = Strict({
  status: Type.Union([Type.Literal("ok"), Type.Literal("degraded")]),
  version: Type.String(),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  activeRuns: Type.Integer({ minimum: 0 }),
});
export type Health = Static<typeof HealthSchema>;
