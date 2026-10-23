import Type, { type Static } from "typebox";
import { AgentEventEnvelopeSchema } from "./event-contract.js";
import { Id, PROTOCOL_VERSION, Strict, Timestamp } from "./schema-helpers.js";
import { SkillSummarySchema } from "./skill-contract.js";

export * from "./agent-profile-contract.js";
export * from "./channel-contract.js";
export * from "./command-contract.js";
export * from "./diagnostics-contract.js";
export * from "./event-contract.js";
export * from "./knowledge-contract.js";
export * from "./memory-contract.js";
export * from "./resource-contract.js";
export { PROTOCOL_VERSION } from "./schema-helpers.js";
export * from "./skill-contract.js";
export * from "./trace-contract.js";

export const ModelRefSchema = Strict({ provider: Id, id: Id });
export type ModelRef = Static<typeof ModelRefSchema>;

export const ModelCapabilitiesSchema = Strict({
  tools: Type.Boolean(),
  vision: Type.Boolean(),
  reasoning: Type.Boolean(),
  structuredOutput: Type.Boolean(),
});

export const ModelSnapshotSchema = Strict({
  ref: ModelRefSchema,
  name: Type.String({ minLength: 1 }),
  api: Type.String({ minLength: 1 }),
  contextWindow: Type.Integer({ minimum: 1 }),
  maxOutputTokens: Type.Integer({ minimum: 1 }),
  capabilities: ModelCapabilitiesSchema,
});
export type ModelSnapshot = Static<typeof ModelSnapshotSchema>;

export const InteractionModeSchema = Type.Union([Type.Literal("plan"), Type.Literal("agent")]);
export type InteractionMode = Static<typeof InteractionModeSchema>;

export const QueueModeSchema = Type.Union([Type.Literal("queue"), Type.Literal("preemptive")]);
export type QueueMode = Static<typeof QueueModeSchema>;

// 已结束的历史 Run 仍可能携带已下线的 kind；新建执行只由运行时开放 agent/command。
export const RunKindSchema = Type.Union([
  Type.Literal("agent"),
  Type.Literal("command"),
  Type.Literal("review"),
  Type.Literal("improve"),
]);
export type RunKind = Static<typeof RunKindSchema>;

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
  position: Type.Integer({ minimum: 0 }),
  title: Type.String({ minLength: 1, maxLength: 500 }),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
  ]),
  startedAt: Type.Optional(Timestamp),
  completedAt: Type.Optional(Timestamp),
  error: Type.Optional(Type.String()),
});
export type PlanStep = Static<typeof PlanStepSchema>;

export const AttachmentSchema = Strict({
  id: Id,
  name: Type.String({ minLength: 1 }),
  mimeType: Type.String({ minLength: 1 }),
  size: Type.Integer({ minimum: 0 }),
  createdAt: Timestamp,
  ownerUserId: Type.Optional(Id),
  responseId: Type.Optional(Id),
  sha256: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })),
  status: Type.Optional(
    Type.Union([
      Type.Literal("preparing"),
      Type.Literal("ready"),
      Type.Literal("sending"),
      Type.Literal("sent"),
      Type.Literal("failed"),
      Type.Literal("expired"),
      Type.Literal("revoked"),
    ]),
  ),
  expiresAt: Type.Optional(Timestamp),
});
export type Attachment = Static<typeof AttachmentSchema>;

export const ResponseStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("thinking"),
  Type.Literal("clarifying"),
  Type.Literal("planning"),
  Type.Literal("awaiting_confirmation"),
  Type.Literal("executing"),
  Type.Literal("awaiting_approval"),
  Type.Literal("verifying"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);
export type ResponseStatus = Static<typeof ResponseStatusSchema>;

export const ResponseActivitySchema = Strict({
  id: Id,
  responseId: Id,
  kind: Type.Union([
    Type.Literal("status"),
    Type.Literal("text"),
    Type.Literal("tool"),
    Type.Literal("approval"),
    Type.Literal("file"),
  ]),
  status: Type.Optional(ResponseStatusSchema),
  text: Type.Optional(Type.String()),
  toolName: Type.Optional(Id),
  attachmentId: Type.Optional(Id),
  createdAt: Timestamp,
});
export type ResponseActivity = Static<typeof ResponseActivitySchema>;

export const ResponseSchema = Strict({
  id: Id,
  sessionId: Id,
  runId: Id,
  messageId: Id,
  status: ResponseStatusSchema,
  content: Type.String(),
  activities: Type.Array(ResponseActivitySchema),
  attachments: Type.Array(AttachmentSchema),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Response = Static<typeof ResponseSchema>;

export const MessageSourceSchema = Strict({
  adapter: Id,
  conversationId: Id,
  externalMessageId: Id,
  senderId: Type.Optional(Id),
});
export type MessageSource = Static<typeof MessageSourceSchema>;

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
  parentMessageId: Type.Optional(Id),
  attachments: Type.Array(AttachmentSchema),
  source: Type.Optional(MessageSourceSchema),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type TranscriptItem = Static<typeof TranscriptItemSchema>;

export const RunStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("preflight"),
  Type.Literal("awaiting_input"),
  Type.Literal("awaiting_confirmation"),
  Type.Literal("running"),
  Type.Literal("verifying"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("interrupted"),
]);
export type RunStatus = Static<typeof RunStatusSchema>;

export const RunPhaseSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("preflight"),
  Type.Literal("clarify"),
  Type.Literal("execute"),
  Type.Literal("verify"),
  Type.Literal("correct"),
]);

export const TaskClassSchema = Type.Union([
  Type.Literal("simple"),
  Type.Literal("standard"),
  Type.Literal("complex"),
]);

export const RunSchema = Strict({
  id: Id,
  sessionId: Id,
  messageId: Id,
  targetMessageId: Type.Optional(Id),
  resultMessageId: Type.Optional(Id),
  branchRevision: Type.Integer({ minimum: 1 }),
  supersededByRunId: Type.Optional(Id),
  terminalReason: Type.Optional(Type.String()),
  queuePosition: Type.Optional(Type.Integer({ minimum: 1 })),
  interactionMode: InteractionModeSchema,
  kind: RunKindSchema,
  status: RunStatusSchema,
  phase: RunPhaseSchema,
  taskClass: Type.Optional(TaskClassSchema),
  goal: Type.Optional(Type.String()),
  successCriteria: Type.Array(Type.String()),
  assumptions: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 32 }),
  model: ModelSnapshotSchema,
  thinkingLevel: ThinkingLevelSchema,
  turnCount: Type.Integer({ minimum: 0, maximum: 400 }),
  correctionCount: Type.Union([Type.Literal(0), Type.Literal(1)]),
  route: Type.Optional(Type.Union([Type.Literal("direct"), Type.Literal("clarify"), Type.Literal("plan")])),
  reasoningSummary: Type.Optional(Type.String()),
  clarificationCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
  resume: Type.Optional(
    Strict({
      state: Type.Union([
        Type.Literal("none"),
        Type.Literal("available"),
        Type.Literal("needs_confirmation"),
        Type.Literal("exhausted"),
      ]),
      checkpointId: Type.Optional(Id),
      pendingActionIds: Type.Array(Id),
      lastSafePhase: Type.Optional(
        Type.Union([
          Type.Literal("preflight"),
          Type.Literal("plan"),
          Type.Literal("step"),
          Type.Literal("model"),
          Type.Literal("tool"),
          Type.Literal("verify"),
        ]),
      ),
    }),
  ),
  plan: Type.Array(PlanStepSchema),
  error: Type.Optional(Type.String()),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Run = Static<typeof RunSchema>;

export const SessionSchema = Strict({
  id: Id,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  assistantName: Type.String({ minLength: 1, maxLength: 100 }),
  assistantAvatarAttachmentId: Type.Optional(Id),
  workspace: Type.Optional(Type.String({ minLength: 1 })),
  model: ModelRefSchema,
  thinkingLevel: ThinkingLevelSchema,
  queueMode: QueueModeSchema,
  activeBranchId: Type.Optional(Id),
  branchRevision: Type.Integer({ minimum: 1 }),
  queueRevision: Type.Integer({ minimum: 1 }),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Session = Static<typeof SessionSchema>;

export const SyncSessionSchema = Strict({
  session: SessionSchema,
  lastSequence: Type.Integer({ minimum: 0 }),
});
export type SyncSession = Static<typeof SyncSessionSchema>;

export const SyncBootstrapSchema = Strict({
  user: Strict({
    id: Id,
    role: Type.Union([Type.Literal("admin"), Type.Literal("user")]),
  }),
  sessions: Type.Array(SyncSessionSchema),
  serverTime: Timestamp,
});
export type SyncBootstrap = Static<typeof SyncBootstrapSchema>;

export const ChannelSessionMetadataSchema = Strict({
  channel: Type.Literal("xianyu"),
  tenantId: Type.String({ minLength: 1, maxLength: 200 }),
  conversationId: Type.String({ minLength: 1, maxLength: 500 }),
  threadId: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  kind: Type.Union([Type.Literal("control"), Type.Literal("buyer")]),
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  externalUserId: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  itemId: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  unreadCount: Type.Integer({ minimum: 0 }),
  lastInboundAt: Type.Optional(Timestamp),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ChannelSessionMetadata = Static<typeof ChannelSessionMetadataSchema>;

export const XianyuWorkspaceSessionSchema = Strict({
  session: SessionSchema,
  metadata: ChannelSessionMetadataSchema,
  lastSequence: Type.Integer({ minimum: 0 }),
  draftMessageIds: Type.Array(Id),
});
export type XianyuWorkspaceSession = Static<typeof XianyuWorkspaceSessionSchema>;

export const XianyuWorkspaceBootstrapSchema = Strict({
  workspace: Type.Literal("xianyu"),
  autoReplyEnabled: Type.Boolean(),
  service: Type.Unknown(),
  login: Type.Unknown(),
  sessions: Type.Array(XianyuWorkspaceSessionSchema),
  serverTime: Timestamp,
});
export type XianyuWorkspaceBootstrap = Static<typeof XianyuWorkspaceBootstrapSchema>;

export const XianyuAutoReplyRequestSchema = Strict({ enabled: Type.Boolean() });
export type XianyuAutoReplyRequest = Static<typeof XianyuAutoReplyRequestSchema>;

export const XianyuInternalSessionRequestSchema = Strict({
  sessionId: Type.Optional(Id),
  tenantId: Type.String({ minLength: 1, maxLength: 200 }),
  conversationId: Type.String({ minLength: 1, maxLength: 500 }),
  threadId: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  externalUserId: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  itemId: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
});
export type XianyuInternalSessionRequest = Static<typeof XianyuInternalSessionRequestSchema>;

export const XianyuInternalInboundRequestSchema = Strict({
  sessionId: Id,
  externalMessageId: Type.String({ minLength: 1, maxLength: 500 }),
  senderId: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  text: Type.String({ maxLength: 1_000_000 }),
  attachmentIds: Type.Optional(Type.Array(Id, { maxItems: 20 })),
});
export type XianyuInternalInboundRequest = Static<typeof XianyuInternalInboundRequestSchema>;

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

export const SessionSnapshotSchema = Strict({
  session: SessionSchema,
  transcript: Type.Array(TranscriptItemSchema),
  recentRuns: Type.Array(RunSchema),
  pendingApprovals: Type.Array(ApprovalSchema),
  snapshotSequence: Type.Integer({ minimum: 0 }),
  history: Strict({
    oldestMessageSequence: Type.Integer({ minimum: 0 }),
    hasMoreBefore: Type.Boolean(),
  }),
  responses: Type.Optional(Type.Array(ResponseSchema)),
  branches: Type.Array(
    Strict({
      id: Id,
      sessionId: Id,
      name: Type.String({ minLength: 1, maxLength: 200 }),
      headMessageId: Type.Optional(Id),
      active: Type.Boolean(),
      createdAt: Timestamp,
      updatedAt: Timestamp,
    }),
  ),
  queue: Type.Array(
    Strict({
      run: RunSchema,
      message: TranscriptItemSchema,
      position: Type.Integer({ minimum: 1 }),
      queueRevision: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
  ),
});
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>;

export const ErrorCodeSchema = Type.Union([
  Type.Literal("auth_required"),
  Type.Literal("forbidden"),
  Type.Literal("not_found"),
  Type.Literal("conflict"),
  Type.Literal("validation_failed"),
  Type.Literal("provider_error"),
  Type.Literal("provider_contract_error"),
  Type.Literal("rate_limited"),
  Type.Literal("resume_required"),
  Type.Literal("cancelled"),
  Type.Literal("internal_error"),
]);

export const ErrorResponseSchema = Strict({
  error: Strict({
    code: ErrorCodeSchema,
    message: Type.String(),
    retryable: Type.Boolean(),
    requestId: Id,
  }),
});
export type ErrorResponse = Static<typeof ErrorResponseSchema>;

export const CreateSessionRequestSchema = Strict({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  workspace: Type.Optional(Type.String({ minLength: 1 })),
  model: Type.Optional(ModelRefSchema),
  queueMode: Type.Optional(QueueModeSchema),
});
export type CreateSessionRequest = Static<typeof CreateSessionRequestSchema>;

export const UpdateSessionRequestSchema = Strict({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  model: Type.Optional(ModelRefSchema),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  queueMode: Type.Optional(QueueModeSchema),
  assistantName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  assistantAvatarAttachmentId: Type.Optional(Type.Union([Id, Type.Null()])),
});
export type UpdateSessionRequest = Static<typeof UpdateSessionRequestSchema>;

export const SendMessageRequestSchema = Strict({
  messageId: Id,
  text: Type.String({ minLength: 1, maxLength: 1_000_000 }),
  attachmentIds: Type.Optional(Type.Array(Id, { maxItems: 20 })),
  mode: InteractionModeSchema,
  source: Type.Optional(MessageSourceSchema),
  parentMessageId: Type.Optional(Id),
});
export type SendMessageRequest = Static<typeof SendMessageRequestSchema>;

export const SendMessageResponseSchema = Strict({
  runId: Id,
  responseId: Type.Optional(Id),
  status: RunStatusSchema,
});
export type SendMessageResponse = Static<typeof SendMessageResponseSchema>;

export const HealthSchema = Strict({
  status: Type.Union([Type.Literal("ok"), Type.Literal("degraded")]),
  version: Type.String(),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  activeRuns: Type.Integer({ minimum: 0 }),
});
export type Health = Static<typeof HealthSchema>;

export const BackgroundTaskStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("interrupted"),
]);
export type BackgroundTaskStatus = Static<typeof BackgroundTaskStatusSchema>;

export const BackgroundTaskSchema = Strict({
  id: Id,
  parentSessionId: Type.Optional(Id),
  sessionId: Id,
  runId: Type.Optional(Id),
  source: Type.Optional(
    Strict({
      type: Type.Literal("schedule"),
      scheduleId: Id,
      scheduleRunId: Id,
    }),
  ),
  prompt: Type.String({ minLength: 1, maxLength: 1_000_000 }),
  status: BackgroundTaskStatusSchema,
  result: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type BackgroundTask = Static<typeof BackgroundTaskSchema>;

export const ScheduleDefinitionSchema = Type.Union([
  Strict({ kind: Type.Literal("once"), at: Timestamp }),
  Strict({ kind: Type.Literal("interval"), everyMs: Type.Integer({ minimum: 60_000 }) }),
  Strict({
    kind: Type.Literal("cron"),
    expression: Type.String({ minLength: 1, maxLength: 200 }),
    timezone: Type.String({ minLength: 1, maxLength: 100 }),
  }),
]);
export type ScheduleDefinition = Static<typeof ScheduleDefinitionSchema>;

export const ScheduledTaskSchema = Strict({
  id: Id,
  name: Type.String({ minLength: 1, maxLength: 200 }),
  prompt: Type.String({ minLength: 1, maxLength: 1_000_000 }),
  messageMode: Type.Literal("agent"),
  schedule: ScheduleDefinitionSchema,
  enabled: Type.Boolean(),
  nextRunAt: Type.Optional(Timestamp),
  lastRunAt: Type.Optional(Timestamp),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ScheduledTask = Static<typeof ScheduledTaskSchema>;

export const CreateScheduledTaskRequestSchema = Strict({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  prompt: Type.String({ minLength: 1, maxLength: 1_000_000 }),
  messageMode: Type.Optional(Type.Literal("agent")),
  schedule: ScheduleDefinitionSchema,
  enabled: Type.Optional(Type.Boolean()),
});
export type CreateScheduledTaskRequest = Static<typeof CreateScheduledTaskRequestSchema>;

export const UpdateScheduledTaskRequestSchema = Strict({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000_000 })),
  messageMode: Type.Optional(Type.Literal("agent")),
  schedule: Type.Optional(ScheduleDefinitionSchema),
  enabled: Type.Optional(Type.Boolean()),
});
export type UpdateScheduledTaskRequest = Static<typeof UpdateScheduledTaskRequestSchema>;

export const ScheduledTaskRunStatusSchema = Type.Union([
  Type.Literal("claimed"),
  Type.Literal("running"),
  Type.Literal("awaiting_resume"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);
export type ScheduledTaskRunStatus = Static<typeof ScheduledTaskRunStatusSchema>;

export const ScheduledTaskRunSchema = Strict({
  id: Id,
  scheduledTaskId: Id,
  trigger: Type.Union([Type.Literal("scheduled"), Type.Literal("catchup"), Type.Literal("manual")]),
  backgroundTaskId: Type.Optional(Id),
  runId: Type.Optional(Id),
  status: ScheduledTaskRunStatusSchema,
  resume: Type.Optional(RunSchema.properties.resume),
  scheduledFor: Timestamp,
  startedAt: Type.Optional(Timestamp),
  completedAt: Type.Optional(Timestamp),
  error: Type.Optional(Type.String()),
});
export type ScheduledTaskRun = Static<typeof ScheduledTaskRunSchema>;

export const EvaluationCaseResultSchema = Strict({
  name: Type.String({ minLength: 1, maxLength: 500 }),
  category: Type.Union([
    Type.Literal("security"),
    Type.Literal("prompt_injection"),
    Type.Literal("tool_selection"),
    Type.Literal("schema"),
    Type.Literal("regression"),
    Type.Literal("cost"),
  ]),
  passed: Type.Boolean(),
  durationMs: Type.Integer({ minimum: 0 }),
  runId: Type.Optional(Id),
  status: Type.Optional(RunStatusSchema),
  error: Type.Optional(Type.String({ maxLength: 4_000 })),
});
export type EvaluationCaseResult = Static<typeof EvaluationCaseResultSchema>;

export const EvaluationReportSchema = Strict({
  id: Id,
  mode: Type.Union([Type.Literal("faux"), Type.Literal("real")]),
  suiteVersion: Type.String({ minLength: 1, maxLength: 100 }),
  status: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
  totals: Strict({
    total: Type.Integer({ minimum: 0 }),
    passed: Type.Integer({ minimum: 0 }),
    failed: Type.Integer({ minimum: 0 }),
    skipped: Type.Integer({ minimum: 0 }),
  }),
  durationMs: Type.Integer({ minimum: 0 }),
  cases: Type.Array(EvaluationCaseResultSchema, { maxItems: 10_000 }),
  createdAt: Timestamp,
});
export type EvaluationReport = Static<typeof EvaluationReportSchema>;

export const EvaluationTrendSchema = Strict({
  group: Type.String({ minLength: 1, maxLength: 200 }),
  from: Timestamp,
  to: Timestamp,
  reports: Type.Integer({ minimum: 0 }),
  totalCases: Type.Integer({ minimum: 0 }),
  passedCases: Type.Integer({ minimum: 0 }),
  failedCases: Type.Integer({ minimum: 0 }),
  passRate: Type.Number({ minimum: 0, maximum: 1 }),
  durationMs: Strict({
    p50: Type.Number({ minimum: 0 }),
    p95: Type.Number({ minimum: 0 }),
  }),
  failures: Type.Array(
    Strict({ category: Type.String({ minLength: 1 }), count: Type.Integer({ minimum: 0 }) }),
  ),
});
export type EvaluationTrend = Static<typeof EvaluationTrendSchema>;

export const CreateEvaluationReportSchema = Strict({
  mode: EvaluationReportSchema.properties.mode,
  suiteVersion: EvaluationReportSchema.properties.suiteVersion,
  status: EvaluationReportSchema.properties.status,
  totals: EvaluationReportSchema.properties.totals,
  durationMs: EvaluationReportSchema.properties.durationMs,
  cases: EvaluationReportSchema.properties.cases,
});
export type CreateEvaluationReport = Static<typeof CreateEvaluationReportSchema>;

export const PublicConfigSchema = Strict({
  revision: Type.String({ minLength: 1 }),
  defaultModel: ModelRefSchema,
  roles: Strict({
    default: ModelRefSchema,
    reasoning: ModelRefSchema,
    fast: ModelRefSchema,
    vision: ModelRefSchema,
  }),
  models: Type.Array(ModelRefSchema),
  skills: Type.Array(SkillSummarySchema),
  mcp: Type.Array(Strict({ name: Id, connected: Type.Boolean(), toolCount: Type.Integer({ minimum: 0 }) })),
});
export type PublicConfig = Static<typeof PublicConfigSchema>;

export const ResourceKindSchema = Type.Union([
  Type.Literal("execution-settings"),
  Type.Literal("tasks"),
  Type.Literal("schedules"),
  Type.Literal("memory"),
  Type.Literal("knowledge"),
  Type.Literal("skills"),
  Type.Literal("profile"),
  Type.Literal("config"),
  Type.Literal("evaluations"),
  Type.Literal("optimization"),
]);
export type ResourceKind = Static<typeof ResourceKindSchema>;

export const ResourceInvalidatedSchema = Strict({
  type: Type.Literal("resource.invalidated"),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  resource: ResourceKindSchema,
  ownerId: Type.Optional(Id),
  timestamp: Timestamp,
});
export type ResourceInvalidated = Static<typeof ResourceInvalidatedSchema>;

export const ResourceChangedSchema = Strict({
  type: Type.Literal("resource.changed"),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  resource: ResourceKindSchema,
  resourceId: Id,
  ownerId: Id,
  revision: Type.Integer({ minimum: 1 }),
  deleted: Type.Boolean(),
  timestamp: Timestamp,
});
export type ResourceChanged = Static<typeof ResourceChangedSchema>;

export const ResourceResyncRequiredSchema = Strict({
  type: Type.Literal("resource.resync_required"),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  resources: Type.Array(ResourceKindSchema),
  timestamp: Timestamp,
});
export type ResourceResyncRequired = Static<typeof ResourceResyncRequiredSchema>;

export const EditMessageRequestSchema = Strict({
  text: Type.String({ minLength: 1, maxLength: 1_000_000 }),
});
export type EditMessageRequest = Static<typeof EditMessageRequestSchema>;

export const QueueReorderRequestSchema = Strict({
  runIds: Type.Array(Id, { minItems: 0, maxItems: 100 }),
  queueRevision: Type.Integer({ minimum: 1 }),
});
export type QueueReorderRequest = Static<typeof QueueReorderRequestSchema>;
export const ReloadResultSchema = Strict({
  applied: Type.Array(Type.String()),
  restartRequired: Type.Array(Type.String()),
});
export type ReloadResult = Static<typeof ReloadResultSchema>;

export const OptimizationProposalSchema = Strict({
  id: Id,
  title: Type.String({ minLength: 1 }),
  evidence: Type.Array(Type.String()),
  risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  recommendation: Type.String({ minLength: 1 }),
  validation: Type.Array(Type.String()),
  status: Type.Union([Type.Literal("pending"), Type.Literal("accepted"), Type.Literal("rejected")]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type OptimizationProposal = Static<typeof OptimizationProposalSchema>;

export const AuditRecordSchema = Strict({
  id: Id,
  runId: Id,
  kind: Type.Union([
    Type.Literal("model"),
    Type.Literal("tool"),
    Type.Literal("approval"),
    Type.Literal("run"),
  ]),
  name: Id,
  input: Type.Optional(Type.Unknown()),
  output: Type.Optional(Type.Unknown()),
  status: Type.String({ minLength: 1 }),
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  usage: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.String()),
  createdAt: Timestamp,
});
export type AuditRecord = Static<typeof AuditRecordSchema>;

export const OptimizationApplicationSchema = Strict({
  id: Id,
  proposalId: Id,
  workspace: Type.String({ minLength: 1 }),
  changes: Type.Array(Strict({ path: Type.String({ minLength: 1 }), bytes: Type.Integer({ minimum: 0 }) })),
  backups: Type.Array(Strict({ path: Type.String({ minLength: 1 }), existed: Type.Boolean() })),
  validationCommand: Type.String({ minLength: 1 }),
  validationStatus: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
  validationOutput: Type.Optional(Type.String({ maxLength: 4_000 })),
  status: Type.Union([Type.Literal("applied"), Type.Literal("rolled_back"), Type.Literal("failed")]),
  rollbackStatus: Type.Union([
    Type.Literal("not_requested"),
    Type.Literal("completed"),
    Type.Literal("failed"),
  ]),
  error: Type.Optional(Type.String({ maxLength: 2_000 })),
  createdAt: Timestamp,
  completedAt: Type.Optional(Timestamp),
});
export type OptimizationApplication = Static<typeof OptimizationApplicationSchema>;

export const OptimizationValidationSchema = Strict({
  command: Type.Union([
    Type.Literal("test"),
    Type.Literal("check"),
    Type.Literal("build"),
    Type.Literal("test:eval:faux"),
    Type.Literal("test:perf"),
  ]),
});
export type OptimizationValidation = Static<typeof OptimizationValidationSchema>;

export const OptimizationRollbackResultSchema = Strict({
  application: OptimizationApplicationSchema,
  rolledBack: Type.Boolean(),
});
export type OptimizationRollbackResult = Static<typeof OptimizationRollbackResultSchema>;

export const SessionEventPageSchema = Strict({
  sessionId: Id,
  fromSequence: Type.Integer({ minimum: 0 }),
  toSequence: Type.Integer({ minimum: 0 }),
  nextSequence: Type.Integer({ minimum: 0 }),
  hasMore: Type.Boolean(),
  events: Type.Array(AgentEventEnvelopeSchema),
  snapshotSequence: Type.Integer({ minimum: 0 }),
});
export type SessionEventPage = Static<typeof SessionEventPageSchema>;

export const RunActionStatusSchema = Type.Union([
  Type.Literal("prepared"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("uncertain"),
  Type.Literal("acknowledged"),
  Type.Literal("rejected"),
]);

export const RunActionSchema = Strict({
  id: Id,
  runId: Id,
  checkpointId: Type.Optional(Id),
  toolCallId: Id,
  toolName: Id,
  toolClass: Type.String({ minLength: 1 }),
  idempotencyKey: Id,
  input: Type.Optional(Type.Unknown()),
  result: Type.Optional(Type.Unknown()),
  status: RunActionStatusSchema,
  startedAt: Type.Optional(Timestamp),
  completedAt: Type.Optional(Timestamp),
  error: Type.Optional(Type.String()),
});
export type RunAction = Static<typeof RunActionSchema>;

export const RunCheckpointSchema = Strict({
  id: Id,
  runId: Id,
  checkpointNo: Type.Integer({ minimum: 1 }),
  phase: Type.Union([
    Type.Literal("preflight"),
    Type.Literal("plan"),
    Type.Literal("step"),
    Type.Literal("model"),
    Type.Literal("tool"),
    Type.Literal("verify"),
  ]),
  planStepId: Type.Optional(Id),
  turnCount: Type.Integer({ minimum: 0, maximum: 400 }),
  lastMessageSequence: Type.Integer({ minimum: 0 }),
  contextSummarySequence: Type.Optional(Type.Integer({ minimum: 0 })),
  safeToResume: Type.Boolean(),
  createdAt: Timestamp,
});
export type RunCheckpoint = Static<typeof RunCheckpointSchema>;

export const RunActionDecisionSchema = Strict({
  decision: Type.Union([Type.Literal("approve"), Type.Literal("reject"), Type.Literal("acknowledge")]),
});
export type RunActionDecision = Static<typeof RunActionDecisionSchema>;

export const SessionHistoryPageSchema = Strict({
  sessionId: Id,
  items: Type.Array(TranscriptItemSchema),
  responses: Type.Array(ResponseSchema),
  runs: Type.Array(RunSchema),
  activeBranchId: Type.Optional(Id),
  branchRevision: Type.Integer({ minimum: 0 }),
  oldestSequence: Type.Integer({ minimum: 0 }),
  hasMore: Type.Boolean(),
});
export type SessionHistoryPage = Static<typeof SessionHistoryPageSchema>;
