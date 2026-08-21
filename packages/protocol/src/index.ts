import Type, { type Static } from "typebox";

export const PROTOCOL_VERSION = 10 as const;
const Id = Type.String({ minLength: 1, maxLength: 128 });
const Timestamp = Type.Integer({ minimum: 0 });
const Strict = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

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

export const SessionModeSchema = Type.Union([Type.Literal("workspace"), Type.Literal("assistant")]);
export type SessionMode = Static<typeof SessionModeSchema>;

export const QueueModeSchema = Type.Union([Type.Literal("queue"), Type.Literal("preemptive")]);
export type QueueMode = Static<typeof QueueModeSchema>;

export const RunKindSchema = Type.Union([
  Type.Literal("agent"),
  Type.Literal("review"),
  Type.Literal("improve"),
  Type.Literal("command"),
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
});
export type Attachment = Static<typeof AttachmentSchema>;

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
  revisionOfMessageId: Type.Optional(Id),
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
  kind: RunKindSchema,
  status: RunStatusSchema,
  phase: RunPhaseSchema,
  taskClass: Type.Optional(TaskClassSchema),
  goal: Type.Optional(Type.String()),
  successCriteria: Type.Array(Type.String()),
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
  mode: SessionModeSchema,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  workspace: Type.Optional(Type.String({ minLength: 1 })),
  model: ModelRefSchema,
  thinkingLevel: ThinkingLevelSchema,
  queueMode: QueueModeSchema,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Session = Static<typeof SessionSchema>;

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
});
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>;

export const SkillSummarySchema = Strict({
  name: Id,
  description: Type.String(),
  enabled: Type.Boolean(),
  diagnostics: Type.Array(Type.String()),
});
export type SkillSummary = Static<typeof SkillSummarySchema>;

export const SkillPackageSchema = Strict({
  id: Id,
  name: Id,
  version: Type.String({ minLength: 1, maxLength: 100 }),
  source: Strict({
    type: Type.Union([Type.Literal("local"), Type.Literal("clawhub")]),
    reference: Type.String({ minLength: 1 }),
  }),
  contentHash: Type.String({ minLength: 64, maxLength: 64 }),
  status: Type.Union([
    Type.Literal("staged"),
    Type.Literal("enabled"),
    Type.Literal("disabled"),
    Type.Literal("rejected"),
  ]),
  risk: Type.Union([
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("extreme"),
  ]),
  diagnostics: Type.Array(Type.String()),
  installedAt: Timestamp,
  updatedAt: Timestamp,
});
export type SkillPackage = Static<typeof SkillPackageSchema>;

export const AgentProfileSchema = Strict({
  content: Type.String({ maxLength: 50_000 }),
  updatedAt: Timestamp,
});
export type AgentProfile = Static<typeof AgentProfileSchema>;

export const QualityIssueSchema = Strict({
  type: Type.Union([
    Type.Literal("knowledge_error"),
    Type.Literal("logic_error"),
    Type.Literal("clarity"),
    Type.Literal("omission"),
  ]),
  description: Type.String({ minLength: 1, maxLength: 2_000 }),
});
export type QualityIssue = Static<typeof QualityIssueSchema>;

export const QualityAssessmentSchema = Strict({
  id: Id,
  runId: Id,
  targetMessageId: Id,
  passed: Type.Boolean(),
  issues: Type.Array(QualityIssueSchema),
  suggestions: Type.Array(Type.String()),
  iteration: Type.Integer({ minimum: 1, maximum: 3 }),
  createdAt: Timestamp,
});
export type QualityAssessment = Static<typeof QualityAssessmentSchema>;

export const MemoryRollupSchema = Strict({
  id: Id,
  sessionId: Id,
  kind: Type.Union([Type.Literal("turn"), Type.Literal("day"), Type.Literal("session")]),
  fromSequence: Type.Integer({ minimum: 1 }),
  toSequence: Type.Integer({ minimum: 1 }),
  summary: Type.String(),
  createdAt: Timestamp,
});
export type MemoryRollup = Static<typeof MemoryRollupSchema>;

export const KnowledgeSourceSchema = Strict({
  id: Id,
  name: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  documentCount: Type.Integer({ minimum: 0 }),
  status: Type.Union([
    Type.Literal("queued"),
    Type.Literal("parsing"),
    Type.Literal("indexed"),
    Type.Literal("failed"),
  ]),
  error: Type.Optional(Type.String()),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type KnowledgeSource = Static<typeof KnowledgeSourceSchema>;

export const KnowledgeSearchHitSchema = Strict({
  sourceId: Id,
  sourceName: Type.String({ minLength: 1 }),
  filePath: Type.String({ minLength: 1 }),
  content: Type.String(),
});
export type KnowledgeSearchHit = Static<typeof KnowledgeSearchHitSchema>;

export const SearchCitationSchema = Strict({
  title: Type.String({ minLength: 1 }),
  url: Type.String({ minLength: 1 }),
  snippet: Type.String(),
  source: Type.Union([Type.Literal("tavily"), Type.Literal("stackexchange")]),
});
export type SearchCitation = Static<typeof SearchCitationSchema>;

export const EventTypeSchema = Type.Union([
  Type.Literal("sync.started"),
  Type.Literal("sync.completed"),
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
  mode: Type.Optional(SessionModeSchema),
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
});
export type UpdateSessionRequest = Static<typeof UpdateSessionRequestSchema>;

export const SendMessageRequestSchema = Strict({
  messageId: Id,
  text: Type.String({ minLength: 1, maxLength: 1_000_000 }),
  attachmentIds: Type.Optional(Type.Array(Id, { maxItems: 20 })),
  mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("direct"), Type.Literal("plan")])),
  source: Type.Optional(MessageSourceSchema),
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
  sessionMode: SessionModeSchema,
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
  sessionMode: Type.Optional(SessionModeSchema),
  schedule: ScheduleDefinitionSchema,
  enabled: Type.Optional(Type.Boolean()),
});
export type CreateScheduledTaskRequest = Static<typeof CreateScheduledTaskRequestSchema>;

export const UpdateScheduledTaskRequestSchema = Strict({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000_000 })),
  sessionMode: Type.Optional(SessionModeSchema),
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

export const OperationsReportSchema = Strict({
  from: Timestamp,
  to: Timestamp,
  runs: Strict({
    total: Type.Integer({ minimum: 0 }),
    completed: Type.Integer({ minimum: 0 }),
    failed: Type.Integer({ minimum: 0 }),
    cancelled: Type.Integer({ minimum: 0 }),
    interrupted: Type.Integer({ minimum: 0 }),
  }),
  model: Strict({
    calls: Type.Integer({ minimum: 0 }),
    failed: Type.Integer({ minimum: 0 }),
    totalTokens: Type.Integer({ minimum: 0 }),
    averageDurationMs: Type.Number({ minimum: 0 }),
  }),
  tools: Strict({
    calls: Type.Integer({ minimum: 0 }),
    failed: Type.Integer({ minimum: 0 }),
  }),
  approvals: Strict({ requested: Type.Integer({ minimum: 0 }), denied: Type.Integer({ minimum: 0 }) }),
  recoveries: Type.Integer({ minimum: 0 }),
});
export type OperationsReport = Static<typeof OperationsReportSchema>;

export const DiagnosticsReportSchema = Strict({
  from: Timestamp,
  to: Timestamp,
  summary: OperationsReportSchema,
  slowModels: Type.Array(
    Strict({
      provider: Id,
      model: Id,
      calls: Type.Integer({ minimum: 0 }),
      averageDurationMs: Type.Number({ minimum: 0 }),
    }),
  ),
  toolFailures: Type.Array(
    Strict({ tool: Id, failures: Type.Integer({ minimum: 0 }), latestError: Type.Optional(Type.String()) }),
  ),
  recoveryFrequency: Type.Number({ minimum: 0 }),
  approvalBottlenecks: Type.Array(
    Strict({ tool: Id, requested: Type.Integer({ minimum: 0 }), denied: Type.Integer({ minimum: 0 }) }),
  ),
});
export type DiagnosticsReport = Static<typeof DiagnosticsReportSchema>;

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
  Type.Literal("tasks"),
  Type.Literal("schedules"),
  Type.Literal("memory"),
  Type.Literal("knowledge"),
  Type.Literal("skills"),
  Type.Literal("profile"),
  Type.Literal("quality"),
  Type.Literal("config"),
  Type.Literal("evaluations"),
  Type.Literal("optimization"),
]);
export type ResourceKind = Static<typeof ResourceKindSchema>;

export const ResourceInvalidatedSchema = Strict({
  type: Type.Literal("resource.invalidated"),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  resource: ResourceKindSchema,
  timestamp: Timestamp,
});
export type ResourceInvalidated = Static<typeof ResourceInvalidatedSchema>;

export const ResourceResyncRequiredSchema = Strict({
  type: Type.Literal("resource.resync_required"),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  resources: Type.Array(ResourceKindSchema),
  timestamp: Timestamp,
});
export type ResourceResyncRequired = Static<typeof ResourceResyncRequiredSchema>;

export const MemoryFactSchema = Strict({
  id: Id,
  sessionId: Type.Optional(Id),
  scope: Type.Union([Type.Literal("global"), Type.Literal("session")]),
  key: Type.String({ minLength: 1, maxLength: 500 }),
  value: Type.String({ minLength: 1 }),
  category: Type.String({ minLength: 1, maxLength: 100 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  evidence: Type.Optional(Type.String()),
  sourceRunId: Type.Optional(Id),
  status: Type.Union([
    Type.Literal("active"),
    Type.Literal("candidate"),
    Type.Literal("superseded"),
    Type.Literal("rejected"),
  ]),
  supersedes: Type.Optional(Id),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type MemoryFact = Static<typeof MemoryFactSchema>;

export const ReviewMessageRequestSchema = Strict({
  feedback: Type.Optional(Type.String({ maxLength: 10_000 })),
});
export type ReviewMessageRequest = Static<typeof ReviewMessageRequestSchema>;

export const ImproveMessageRequestSchema = Strict({
  force: Type.Optional(Type.Boolean()),
  reset: Type.Optional(Type.Boolean()),
});
export type ImproveMessageRequest = Static<typeof ImproveMessageRequestSchema>;

export const CommandRequestSchema = Strict({
  command: Type.String({ minLength: 1, maxLength: 100_000 }),
  messageId: Type.Optional(Id),
});
export type CommandRequest = Static<typeof CommandRequestSchema>;

export const SkillInstallRequestSchema = Strict({
  source: Type.Union([Type.Literal("local"), Type.Literal("clawhub")]),
  reference: Type.String({ minLength: 1, maxLength: 2_000 }),
  version: Type.Optional(Type.String({ maxLength: 100 })),
});
export type SkillInstallRequest = Static<typeof SkillInstallRequestSchema>;

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
  oldestSequence: Type.Integer({ minimum: 0 }),
  hasMore: Type.Boolean(),
});
export type SessionHistoryPage = Static<typeof SessionHistoryPageSchema>;

export interface AdapterHealth {
  status: "ok" | "degraded" | "stopped";
  connected: boolean;
  lastInboundAt?: number;
  lastError?: string;
}

export interface ExternalConversation {
  adapter: string;
  tenantId: string;
  conversationId: string;
  threadId?: string;
  kind: "direct" | "group";
}

export interface ChannelInboundMessage {
  conversation: ExternalConversation;
  externalMessageId: string;
  senderId?: string;
  text: string;
  attachmentIds?: string[];
}

export interface ChannelAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): AdapterHealth;
  mapConversation(input: ExternalConversation): Promise<string>;
  handleInbound(input: ChannelInboundMessage): Promise<void>;
  renderEvent(event: AgentEventEnvelope): Promise<void>;
}
