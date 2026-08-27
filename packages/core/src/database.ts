import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  AgentProfile,
  Approval,
  Attachment,
  AuditRecord,
  BackgroundTask,
  CreateEvaluationReport,
  DiagnosticsReport,
  EvaluationReport,
  EvaluationTrend,
  KnowledgeSource,
  MemoryFact,
  MemoryRollup,
  MessageSource,
  ModelRef,
  ModelSnapshot,
  OperationsReport,
  OptimizationApplication,
  OptimizationProposal,
  PlanStep,
  QualityAssessment,
  ResourceSnapshot,
  Response,
  ResponseActivity,
  ResponseStatus,
  Run,
  RunAction,
  RunCheckpoint,
  RunStatus,
  ScheduleDefinition,
  ScheduledTask,
  ScheduledTaskRun,
  Session,
  SessionEventPage,
  SessionHistoryPage,
  SessionSnapshot,
  SkillPackage,
  TranscriptItem,
} from "@uma-agent/protocol";
import { type AgentEventEnvelope, type DurableAgentEventType, PROTOCOL_VERSION } from "@uma-agent/protocol";
import { AuditEvaluationRepository } from "./audit-evaluation-repository.js";
import {
  ftsQuery,
  integer,
  parseJson,
  type Row,
  redactAudit,
  row,
  rows,
  text,
  toAttachment,
  toPlanStep,
  toRunAction,
  toRunCheckpoint,
  toScheduledTask,
  toScheduledTaskRun,
} from "./database-utils.js";
import { MessageRepository } from "./message-repository.js";
import { validateSchema } from "./schema-validation.js";
import { SessionRepository } from "./session-repository.js";
import type { ContextSummary, StoredAgentMessage } from "./types.js";

const SCHEMA_VERSION = 20;
export class UmaDatabase {
  readonly db: DatabaseSync;
  readonly stateDir: string;
  private readonly auditEvaluations: AuditEvaluationRepository;
  private readonly messages: MessageRepository;
  private readonly sessions: SessionRepository;
  private transactionDepth = 0;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    mkdirSync(stateDir, { recursive: true });
    this.db = new DatabaseSync(join(stateDir, "state.db"));
    this.messages = new MessageRepository(this.db);
    this.sessions = new SessionRepository(this.db);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const version = integer(row(this.db.prepare("PRAGMA user_version"))?.user_version);
    if (version === 0) {
      this.db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    } else if (version !== SCHEMA_VERSION) {
      // schema 20 是唯一支持的持久化格式。启动阶段拒绝旧/未来版本，
      // 避免未经发布验证的隐式改写影响会话、附件或认证令牌。
      this.db.close();
      throw new Error(`Unsupported database schema ${version}; expected ${SCHEMA_VERSION}.`);
    }
    validateSchema(this.db);
    this.auditEvaluations = new AuditEvaluationRepository(this.db, (operation) =>
      this.withTransaction(operation),
    );
    const interrupted = rows(
      this.db.prepare(
        "SELECT id,session_id FROM runs WHERE status IN ('queued','preflight','running','verifying')",
      ),
    );
    this.withTransaction(() => {
      const now = Date.now();
      this.db
        .prepare(
          "UPDATE runs SET status = 'interrupted', error = 'Server restarted during execution', updated_at = ? WHERE status IN ('queued','preflight','running','verifying')",
        )
        .run(now);
      this.db
        .prepare("UPDATE messages SET status = 'cancelled', updated_at = ? WHERE status = 'streaming'")
        .run(now);
      this.markUncertainActions();
      this.markActiveBackgroundTasksInterrupted();
      this.db
        .prepare(
          "UPDATE model_calls SET status='abandoned',error='Server restarted during model request',updated_at=? WHERE status='started'",
        )
        .run(now);
      for (const value of interrupted) {
        const runId = text(value.id);
        this.appendEvent(text(value.session_id), runId, "run.updated", this.getRun(runId));
      }
    });
  }

  close(): void {
    this.db.close();
  }

  /**
   * Cheap readiness probe used by the server health endpoint. Keeping this
   * behind the database facade prevents transport code from reaching into the
   * SQLite connection or depending on a storage implementation detail.
   */
  isReady(): boolean {
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  withTransaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  listSessions(): Session[] {
    return this.sessions.list();
  }

  listUserSessions(userId: string): Session[] {
    return this.sessions.list(userId);
  }

  sessionOwner(id: string): string | undefined {
    const value = row(this.db.prepare("SELECT user_id FROM sessions WHERE id=?"), id);
    return value?.user_id ? text(value.user_id) : undefined;
  }

  runOwner(id: string): string | undefined {
    const value = row(
      this.db.prepare("SELECT s.user_id FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.id=?"),
      id,
    );
    return value?.user_id ? text(value.user_id) : undefined;
  }

  messageOwner(id: string): string | undefined {
    const value = row(
      this.db.prepare("SELECT s.user_id FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.id=?"),
      id,
    );
    return value?.user_id ? text(value.user_id) : undefined;
  }

  taskOwner(id: string): string | undefined {
    const value = row(
      this.db.prepare(
        "SELECT s.user_id FROM background_tasks t JOIN sessions s ON s.id=t.session_id WHERE t.id=?",
      ),
      id,
    );
    return value?.user_id ? text(value.user_id) : undefined;
  }

  attachmentOwner(id: string): string | undefined {
    const value = row(
      this.db.prepare(
        "SELECT COALESCE(a.owner_user_id,s.user_id) AS user_id FROM attachments a LEFT JOIN sessions s ON s.id=a.session_id WHERE a.id=?",
      ),
      id,
    );
    return value?.user_id ? text(value.user_id) : undefined;
  }

  approvalOwner(id: string): string | undefined {
    const value = row(
      this.db.prepare("SELECT s.user_id FROM approvals a JOIN sessions s ON s.id=a.session_id WHERE a.id=?"),
      id,
    );
    return value?.user_id ? text(value.user_id) : undefined;
  }

  createUser(role: "admin" | "user" = "user"): { id: string; role: "admin" | "user"; status: "active" } {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare("INSERT INTO users(id,role,status,created_at,updated_at) VALUES(?,?,?,?,?)")
      .run(id, role, "active", now, now);
    return { id, role, status: "active" };
  }

  countUsers(): number {
    return integer(row(this.db.prepare("SELECT COUNT(*) AS count FROM users"))?.count);
  }

  getUser(id: string): { id: string; role: "admin" | "user"; status: "active" | "disabled" } | undefined {
    const value = row(this.db.prepare("SELECT id,role,status FROM users WHERE id=?"), id);
    if (!value) return undefined;
    return {
      id: text(value.id),
      role: text(value.role) as "admin" | "user",
      status: text(value.status) as "active" | "disabled",
    };
  }

  touchUserLogin(id: string): void {
    const now = Date.now();
    this.db.prepare("UPDATE users SET last_login_at=?,updated_at=? WHERE id=?").run(now, now, id);
  }

  putAuthToken(input: {
    id: string;
    userId: string;
    tokenHash: string;
    label: string;
    scopes: string[];
  }): void {
    this.db
      .prepare(
        "INSERT INTO auth_tokens(id,user_id,token_hash,label,scopes_json,expires_at,created_at) VALUES(?,?,?,?,?,NULL,?)",
      )
      .run(input.id, input.userId, input.tokenHash, input.label, JSON.stringify(input.scopes), Date.now());
  }

  findAuthToken(
    id: string,
    tokenHash: string,
  ): { id: string; userId: string; role: "admin" | "user"; scopes: string[] } | undefined {
    const value = row(
      this.db.prepare(
        "SELECT t.id,t.user_id,u.role,u.status,t.scopes_json,t.expires_at,t.revoked_at FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.id=? AND t.token_hash=?",
      ),
      id,
      tokenHash,
    );
    if (
      !value ||
      text(value.status) !== "active" ||
      (value.revoked_at !== null && value.revoked_at !== undefined)
    )
      return undefined;
    this.db.prepare("UPDATE auth_tokens SET last_used_at=? WHERE id=?").run(Date.now(), id);
    return {
      id: text(value.id),
      userId: text(value.user_id),
      role: text(value.role) as "admin" | "user",
      scopes: parseJson<string[]>(value.scopes_json, ["user"]),
    };
  }

  listAuthTokens(userId: string): Array<{
    id: string;
    label: string;
    scopes: string[];
    expiresAt?: number;
    revokedAt?: number;
    createdAt: number;
    lastUsedAt?: number;
  }> {
    return rows(
      this.db.prepare(
        "SELECT id,label,scopes_json,expires_at,revoked_at,created_at,last_used_at FROM auth_tokens WHERE user_id=? ORDER BY created_at DESC",
      ),
      userId,
    ).map((value) => ({
      id: text(value.id),
      label: text(value.label),
      scopes: parseJson<string[]>(value.scopes_json, ["user"]),
      ...(value.expires_at !== null && value.expires_at !== undefined
        ? { expiresAt: integer(value.expires_at) }
        : {}),
      ...(value.revoked_at ? { revokedAt: integer(value.revoked_at) } : {}),
      createdAt: integer(value.created_at),
      ...(value.last_used_at ? { lastUsedAt: integer(value.last_used_at) } : {}),
    }));
  }

  revokeAuthToken(userId: string, id: string): boolean {
    return (
      this.db
        .prepare("UPDATE auth_tokens SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL")
        .run(Date.now(), id, userId).changes > 0
    );
  }

  putAuthorizationCode(input: {
    code: string;
    userId: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    expiresAt: number;
  }): void {
    this.db
      .prepare(
        "INSERT INTO oauth_authorization_codes(code,user_id,client_id,redirect_uri,code_challenge,expires_at,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        input.code,
        input.userId,
        input.clientId,
        input.redirectUri,
        input.codeChallenge,
        input.expiresAt,
        Date.now(),
      );
  }

  consumeAuthorizationCode(code: string):
    | {
        userId: string;
        clientId: string;
        redirectUri: string;
        codeChallenge: string;
        expiresAt: number;
      }
    | undefined {
    const value = row(this.db.prepare("SELECT * FROM oauth_authorization_codes WHERE code=?"), code);
    this.db.prepare("DELETE FROM oauth_authorization_codes WHERE code=?").run(code);
    if (!value) return undefined;
    return {
      userId: text(value.user_id),
      clientId: text(value.client_id),
      redirectUri: text(value.redirect_uri),
      codeChallenge: text(value.code_challenge),
      expiresAt: integer(value.expires_at),
    };
  }

  createSession(input: {
    userId: string;
    title: string;
    workspace?: string;
    model: ModelRef;
    thinkingLevel: ThinkingLevel;
    queueMode?: Session["queueMode"];
  }): Session {
    return this.sessions.create(input);
  }

  getSession(id: string): Session {
    return this.sessions.get(id);
  }

  updateSession(
    id: string,
    patch: {
      title?: string;
      model?: ModelRef;
      thinkingLevel?: ThinkingLevel;
      queueMode?: Session["queueMode"];
    },
  ): Session {
    return this.sessions.update(id, patch);
  }

  deleteSession(id: string): void {
    this.sessions.delete(id);
  }

  private allocateMessageSequence(sessionId: string): number {
    const value = row(
      this.db.prepare(
        "UPDATE sessions SET next_sequence=next_sequence+1, updated_at=? WHERE id=? RETURNING next_sequence-1 AS sequence",
      ),
      Date.now(),
      sessionId,
    );
    if (!value) throw new Error(`Session not found: ${sessionId}`);
    return integer(value.sequence);
  }

  allocateEventSequence(sessionId: string): number {
    const value = row(
      this.db.prepare(
        "UPDATE sessions SET next_event_sequence=next_event_sequence+1 WHERE id=? RETURNING next_event_sequence-1 AS sequence",
      ),
      sessionId,
    );
    if (!value) throw new Error(`Session not found: ${sessionId}`);
    return integer(value.sequence);
  }

  insertMessage(input: {
    id?: string;
    sessionId: string;
    runId?: string;
    role: TranscriptItem["role"];
    status: TranscriptItem["status"];
    content: string;
    name?: string;
    payload?: AgentMessage;
    attachmentIds?: string[];
    source?: MessageSource;
    revisionOfMessageId?: string;
  }): TranscriptItem {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    const sequence = this.allocateMessageSequence(input.sessionId);
    this.db
      .prepare(
        "INSERT INTO messages(id,session_id,run_id,sequence,role,status,name,content,payload_json,source_json,revision_of_message_id,attachment_ids_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.sessionId,
        input.runId ?? null,
        sequence,
        input.role,
        input.status,
        input.name ?? null,
        input.content,
        input.payload ? JSON.stringify(input.payload) : null,
        input.source ? JSON.stringify(input.source) : null,
        input.revisionOfMessageId ?? null,
        JSON.stringify(input.attachmentIds ?? []),
        now,
        now,
      );
    this.db
      .prepare("INSERT INTO history_fts(message_id,session_id,sequence,content) VALUES(?,?,?,?)")
      .run(id, input.sessionId, sequence, input.content);
    return this.messages.getMessage(id);
  }

  updateMessage(
    id: string,
    patch: { content?: string; status?: TranscriptItem["status"]; payload?: AgentMessage },
  ): TranscriptItem {
    const current = row(this.db.prepare("SELECT * FROM messages WHERE id=?"), id);
    if (!current) throw new Error(`Message not found: ${id}`);
    this.db
      .prepare("UPDATE messages SET content=?, status=?, payload_json=?, updated_at=? WHERE id=?")
      .run(
        patch.content ?? text(current.content),
        patch.status ?? text(current.status),
        patch.payload
          ? JSON.stringify(patch.payload)
          : current.payload_json
            ? text(current.payload_json)
            : null,
        Date.now(),
        id,
      );
    if (patch.content !== undefined) {
      this.db.prepare("DELETE FROM history_fts WHERE message_id=?").run(id);
      this.db
        .prepare("INSERT INTO history_fts(message_id,session_id,sequence,content) VALUES(?,?,?,?)")
        .run(id, text(current.session_id), integer(current.sequence), patch.content);
    }
    return this.messages.getMessage(id);
  }

  findMessageOwner(id: string): { sessionId: string; runId?: string } | undefined {
    return this.messages.findMessageOwner(id);
  }

  listMessages(sessionId: string): TranscriptItem[] {
    return this.messages.listMessages(sessionId);
  }

  listHistory(sessionId: string, beforeSequence?: number, limit = 100): SessionHistoryPage {
    this.getSession(sessionId);
    return this.messages.listHistory(sessionId, beforeSequence, limit);
  }

  listAgentMessages(
    sessionId: string,
    options?: { beforeSequence?: number; afterSequence?: number },
  ): StoredAgentMessage[] {
    return this.messages.listAgentMessages(sessionId, options);
  }

  getMessage(id: string): TranscriptItem {
    return this.messages.getMessage(id);
  }

  private listMessagesByIds(ids: string[]): TranscriptItem[] {
    return this.messages.listByIds(ids);
  }

  getContextSummary(sessionId: string): ContextSummary | undefined {
    const value = row(this.db.prepare("SELECT * FROM context_summaries WHERE session_id=?"), sessionId);
    if (!value) return undefined;
    return {
      sessionId,
      throughSequence: integer(value.through_sequence),
      content: text(value.content),
      updatedAt: integer(value.updated_at),
    };
  }

  putContextSummary(sessionId: string, throughSequence: number, content: string): ContextSummary {
    this.db
      .prepare(
        "INSERT INTO context_summaries(session_id,through_sequence,content,updated_at) VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET through_sequence=excluded.through_sequence,content=excluded.content,updated_at=excluded.updated_at WHERE excluded.through_sequence > context_summaries.through_sequence",
      )
      .run(sessionId, throughSequence, content, Date.now());
    return this.getContextSummary(sessionId) as ContextSummary;
  }

  createRun(
    sessionId: string,
    messageId: string,
    model: ModelSnapshot,
    thinkingLevel: Run["thinkingLevel"],
    kind: Run["kind"],
    interactionMode: Run["interactionMode"],
  ): { run: Run; created: boolean } {
    const existing = row(this.db.prepare("SELECT id,session_id FROM runs WHERE message_id=?"), messageId);
    if (existing) {
      if (text(existing.session_id) !== sessionId)
        throw new Error("messageId is already used by another session");
      return { run: this.getRun(text(existing.id)), created: false };
    }
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO runs(id,session_id,message_id,interaction_mode,kind,status,phase,model_snapshot_json,thinking_level,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        sessionId,
        messageId,
        interactionMode,
        kind,
        "queued",
        "queued",
        JSON.stringify(model),
        thinkingLevel,
        now,
        now,
      );
    return { run: this.getRun(id), created: true };
  }

  updateRun(
    id: string,
    patch: {
      status?: RunStatus;
      phase?: Run["phase"];
      taskClass?: Run["taskClass"];
      goal?: string;
      successCriteria?: string[];
      assumptions?: string[];
      turnCount?: number;
      correctionCount?: 0 | 1;
      route?: Run["route"];
      reasoningSummary?: string;
      error?: string | null;
      clarificationCount?: number;
    },
  ): Run {
    const current = this.getRun(id);
    this.db
      .prepare(
        "UPDATE runs SET status=?,phase=?,task_class=?,goal=?,success_criteria_json=?,assumptions_json=?,turn_count=?,correction_count=?,route=?,reasoning_summary=?,error=?,clarification_count=?,updated_at=? WHERE id=?",
      )
      .run(
        patch.status ?? current.status,
        patch.phase ?? current.phase,
        patch.taskClass ?? current.taskClass ?? null,
        patch.goal ?? current.goal ?? null,
        JSON.stringify(patch.successCriteria ?? current.successCriteria),
        JSON.stringify(patch.assumptions ?? current.assumptions),
        patch.turnCount ?? current.turnCount,
        patch.correctionCount ?? current.correctionCount,
        patch.route ?? current.route ?? null,
        patch.reasoningSummary ?? current.reasoningSummary ?? null,
        patch.error === undefined ? (current.error ?? null) : patch.error,
        patch.clarificationCount ?? current.clarificationCount ?? 0,
        Date.now(),
        id,
      );
    return this.getRun(id);
  }

  setRunKind(id: string, kind: Run["kind"]): Run {
    const result = this.db
      .prepare("UPDATE runs SET kind=?,updated_at=? WHERE id=?")
      .run(kind, Date.now(), id);
    if (!result.changes) throw new Error(`Run not found: ${id}`);
    return this.getRun(id);
  }

  setPlan(runId: string, titles: string[]): PlanStep[] {
    this.db.prepare("DELETE FROM plan_steps WHERE run_id=?").run(runId);
    const insert = this.db.prepare(
      "INSERT INTO plan_steps(id,run_id,position,title,status) VALUES(?,?,?,?,?)",
    );
    titles.forEach((title, position) => {
      insert.run(randomUUID(), runId, position, title, "pending");
    });
    return this.listPlan(runId);
  }

  updatePlanStep(id: string, status: PlanStep["status"], error?: string): void {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE plan_steps SET status=?, started_at=CASE WHEN ?='running' AND started_at IS NULL THEN ? ELSE started_at END, completed_at=CASE WHEN ? IN ('completed','failed') THEN ? ELSE completed_at END, error=? WHERE id=?",
      )
      .run(status, status, now, status, now, error ?? null, id);
  }

  listPlan(runId: string): PlanStep[] {
    return rows(this.db.prepare("SELECT * FROM plan_steps WHERE run_id=? ORDER BY position"), runId).map(
      toPlanStep,
    );
  }

  getRun(id: string): Run {
    const value = row(this.db.prepare("SELECT * FROM runs WHERE id=?"), id);
    if (!value) throw new Error(`Run not found: ${id}`);
    const resume = this.getRunResume(id, text(value.status) as RunStatus);
    return {
      id: text(value.id),
      sessionId: text(value.session_id),
      messageId: text(value.message_id),
      interactionMode: text(value.interaction_mode) as Run["interactionMode"],
      kind: text(value.kind || "agent") as Run["kind"],
      status: text(value.status) as RunStatus,
      phase: text(value.phase) as Run["phase"],
      ...(value.task_class ? { taskClass: text(value.task_class) as NonNullable<Run["taskClass"]> } : {}),
      ...(value.goal ? { goal: text(value.goal) } : {}),
      successCriteria: parseJson<string[]>(value.success_criteria_json, []),
      assumptions: parseJson<string[]>(value.assumptions_json, []),
      model: parseJson<ModelSnapshot>(value.model_snapshot_json, {} as ModelSnapshot),
      thinkingLevel: text(value.thinking_level) as Run["thinkingLevel"],
      turnCount: integer(value.turn_count),
      correctionCount: integer(value.correction_count) === 1 ? 1 : 0,
      ...(value.route ? { route: text(value.route) as Exclude<Run["route"], undefined> } : {}),
      ...(value.reasoning_summary ? { reasoningSummary: text(value.reasoning_summary) } : {}),
      clarificationCount: integer(value.clarification_count),
      ...(resume ? { resume } : {}),
      plan: this.listPlan(id),
      ...(value.error ? { error: text(value.error) } : {}),
      createdAt: integer(value.created_at),
      updatedAt: integer(value.updated_at),
    };
  }

  private getRunResume(runId: string, status: RunStatus): Run["resume"] {
    if (status !== "interrupted") return undefined;
    const checkpoint = row(
      this.db.prepare("SELECT * FROM run_checkpoints WHERE run_id=? ORDER BY checkpoint_no DESC LIMIT 1"),
      runId,
    );
    const pending = rows(
      this.db.prepare(
        "SELECT id FROM run_actions WHERE run_id=? AND status IN ('uncertain','prepared','running') AND tool_class NOT IN ('read','attachment_read')",
      ),
      runId,
    ).map((value) => text(value.id));
    const phase = checkpoint ? text(checkpoint.phase) : undefined;
    const base = {
      state: pending.length ? "needs_confirmation" : checkpoint ? "available" : "exhausted",
      ...(checkpoint ? { checkpointId: text(checkpoint.id) } : {}),
      pendingActionIds: pending,
    };
    return (
      phase ? { ...base, lastSafePhase: phase as NonNullable<Run["resume"]>["lastSafePhase"] } : base
    ) as NonNullable<Run["resume"]>;
  }

  createCheckpoint(input: {
    runId: string;
    phase: NonNullable<Run["resume"]>["lastSafePhase"];
    planStepId?: string | undefined;
    turnCount: number;
    lastMessageSequence: number;
    contextSummarySequence?: number | undefined;
    safeToResume: boolean;
  }): { id: string; checkpointNo: number } {
    const current = row(
      this.db.prepare(
        "SELECT COALESCE(MAX(checkpoint_no),0) AS checkpoint_no FROM run_checkpoints WHERE run_id=?",
      ),
      input.runId,
    );
    const checkpointNo = integer(current?.checkpoint_no) + 1;
    const id = randomUUID();
    const phase = input.phase;
    if (!phase) throw new Error("Checkpoint phase is required");
    this.db
      .prepare(
        "INSERT INTO run_checkpoints(id,run_id,checkpoint_no,phase,plan_step_id,turn_count,last_message_sequence,context_summary_sequence,safe_to_resume,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.runId,
        checkpointNo,
        phase,
        input.planStepId ?? null,
        input.turnCount,
        input.lastMessageSequence,
        input.contextSummarySequence ?? null,
        input.safeToResume ? 1 : 0,
        Date.now(),
      );
    return { id, checkpointNo };
  }

  getLatestCheckpoint(runId: string): { id: string; phase: string; turnCount: number } | undefined {
    const value = row(
      this.db.prepare(
        "SELECT id,phase,turn_count FROM run_checkpoints WHERE run_id=? ORDER BY checkpoint_no DESC LIMIT 1",
      ),
      runId,
    );
    return value
      ? { id: text(value.id), phase: text(value.phase), turnCount: integer(value.turn_count) }
      : undefined;
  }

  listRunCheckpoints(runId: string): RunCheckpoint[] {
    this.getRun(runId);
    return rows(
      this.db.prepare("SELECT * FROM run_checkpoints WHERE run_id=? ORDER BY checkpoint_no"),
      runId,
    ).map(toRunCheckpoint);
  }

  latestMessageSequence(sessionId: string): number {
    return integer(
      row(
        this.db.prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM messages WHERE session_id=?"),
        sessionId,
      )?.sequence,
    );
  }

  createRunAction(input: {
    runId: string;
    checkpointId?: string | undefined;
    toolCallId: string;
    toolName: string;
    toolClass: string;
    idempotencyKey: string;
    input?: unknown;
  }): RunAction {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO run_actions(id,run_id,checkpoint_id,tool_call_id,tool_name,tool_class,idempotency_key,input_json,status,started_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.runId,
        input.checkpointId ?? null,
        input.toolCallId,
        input.toolName,
        input.toolClass,
        input.idempotencyKey,
        input.input === undefined ? null : JSON.stringify(redactAudit(input.input)),
        "prepared",
        null,
      );
    return this.getRunAction(id);
  }

  getRunAction(id: string): RunAction {
    const value = row(this.db.prepare("SELECT * FROM run_actions WHERE id=?"), id);
    if (!value) throw new Error(`Run action not found: ${id}`);
    return toRunAction(value);
  }

  getRunActionByToolCall(runId: string, toolCallId: string): RunAction | undefined {
    const value = row(
      this.db.prepare("SELECT * FROM run_actions WHERE run_id=? AND tool_call_id=?"),
      runId,
      toolCallId,
    );
    return value ? toRunAction(value) : undefined;
  }

  listRunActions(runId: string): RunAction[] {
    return rows(
      this.db.prepare("SELECT * FROM run_actions WHERE run_id=? ORDER BY COALESCE(started_at,0), id"),
      runId,
    ).map(toRunAction);
  }

  updateRunAction(
    id: string,
    patch: { status?: RunAction["status"]; result?: unknown; error?: string | null },
  ): RunAction {
    const current = this.getRunAction(id);
    this.db
      .prepare(
        "UPDATE run_actions SET status=?,result_json=?,error=?,started_at=CASE WHEN ?='running' AND started_at IS NULL THEN ? ELSE started_at END,completed_at=CASE WHEN ? IN ('completed','failed','rejected','acknowledged') THEN ? ELSE completed_at END WHERE id=?",
      )
      .run(
        patch.status ?? current.status,
        patch.result === undefined
          ? current.result === undefined
            ? null
            : JSON.stringify(redactAudit(current.result))
          : JSON.stringify(redactAudit(patch.result)),
        patch.error === undefined ? (current.error ?? null) : patch.error,
        patch.status ?? current.status,
        Date.now(),
        patch.status ?? current.status,
        Date.now(),
        id,
      );
    return this.getRunAction(id);
  }

  transitionRunAction(
    id: string,
    expected: RunAction["status"][],
    patch: { status: RunAction["status"]; result?: unknown; error?: string | null },
  ): { action: RunAction; changed: boolean } {
    if (expected.length === 0) throw new Error("Expected Action status is required");
    const current = this.getRunAction(id);
    const placeholders = expected.map(() => "?").join(",");
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE run_actions SET status=?,result_json=?,error=?,started_at=CASE WHEN ?='running' AND started_at IS NULL THEN ? ELSE started_at END,completed_at=CASE WHEN ? IN ('completed','failed','rejected','acknowledged') THEN ? ELSE completed_at END WHERE id=? AND status IN (${placeholders})`,
      )
      .run(
        patch.status,
        patch.result === undefined
          ? current.result === undefined
            ? null
            : JSON.stringify(redactAudit(current.result))
          : JSON.stringify(redactAudit(patch.result)),
        patch.error === undefined ? (current.error ?? null) : patch.error,
        patch.status,
        now,
        patch.status,
        now,
        id,
        ...expected,
      );
    return { action: this.getRunAction(id), changed: result.changes === 1 };
  }

  getToolCallInput(id: string): unknown {
    const value = row(this.db.prepare("SELECT input_json FROM tool_calls WHERE id=?"), id);
    if (!value) throw new Error(`Tool call not found: ${id}`);
    return parseJson(value.input_json, null);
  }

  markUncertainActions(): void {
    this.db
      .prepare(
        "UPDATE run_actions SET status='prepared',started_at=NULL,error='Safe read action will be replayed after restart' WHERE status='running' AND tool_class IN ('read','attachment_read')",
      )
      .run();
    this.db
      .prepare(
        "UPDATE run_actions SET status='uncertain',error='Server restarted before action completion' WHERE status='running'",
      )
      .run();
  }

  interruptRunActions(runId: string, reason: string): RunAction[] {
    this.db
      .prepare(
        "UPDATE run_actions SET status='prepared',started_at=NULL,error=? WHERE run_id=? AND status='running' AND tool_class IN ('read','attachment_read')",
      )
      .run(`${reason}; safe read action may be replayed`, runId);
    this.db
      .prepare(
        "UPDATE run_actions SET status='uncertain',error=? WHERE run_id=? AND status='running' AND tool_class NOT IN ('read','attachment_read')",
      )
      .run(reason, runId);
    return this.listRunActions(runId).filter((action) => ["prepared", "uncertain"].includes(action.status));
  }

  hasPendingSideEffects(sessionId: string): boolean {
    return Boolean(
      row(
        this.db.prepare(
          "SELECT 1 AS pending FROM run_actions a JOIN runs r ON r.id=a.run_id WHERE r.session_id=? AND a.status IN ('prepared','running','uncertain') AND a.tool_class NOT IN ('read','attachment_read') LIMIT 1",
        ),
        sessionId,
      ),
    );
  }

  listRuns(sessionId: string): Run[] {
    return rows(this.db.prepare("SELECT id FROM runs WHERE session_id=? ORDER BY created_at"), sessionId).map(
      (value) => this.getRun(text(value.id)),
    );
  }

  listRecentRuns(sessionId: string, limit = 20): Run[] {
    const active = rows(
      this.db.prepare(
        "SELECT id,created_at FROM runs WHERE session_id=? AND status NOT IN ('completed','failed','cancelled') ORDER BY created_at",
      ),
      sessionId,
    );
    const recent = rows(
      this.db.prepare("SELECT id,created_at FROM runs WHERE session_id=? ORDER BY created_at DESC LIMIT ?"),
      sessionId,
      limit,
    );
    const unique = new Map(
      [...active, ...recent].map((value) => [text(value.id), integer(value.created_at)]),
    );
    return [...unique.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => this.getRun(id));
  }

  listQueuedRuns(sessionId: string): Run[] {
    return rows(
      this.db.prepare("SELECT id FROM runs WHERE session_id=? AND status='queued' ORDER BY created_at"),
      sessionId,
    ).map((value) => this.getRun(text(value.id)));
  }

  listPendingApprovals(sessionId: string): Approval[] {
    return rows(
      this.db.prepare("SELECT id FROM approvals WHERE session_id=? AND status='pending' ORDER BY created_at"),
      sessionId,
    ).map((value) => this.getApproval(text(value.id)));
  }

  getSnapshot(sessionId: string): SessionSnapshot {
    const session = this.getSession(sessionId);
    const sessionState = row(
      this.db.prepare("SELECT next_event_sequence FROM sessions WHERE id=?"),
      sessionId,
    );
    const tail = rows(
      this.db.prepare("SELECT id,sequence FROM messages WHERE session_id=? ORDER BY sequence DESC LIMIT 101"),
      sessionId,
    );
    const hasMoreBefore = tail.length > 100;
    const visible = tail.slice(0, 100).reverse();
    const transcript = this.listMessagesByIds(visible.map((value) => text(value.id)));
    return {
      session,
      transcript,
      recentRuns: this.listRecentRuns(sessionId),
      pendingApprovals: this.listPendingApprovals(sessionId),
      snapshotSequence: Math.max(0, integer(sessionState?.next_event_sequence) - 1),
      history: {
        oldestMessageSequence: visible.length ? integer(visible[0]?.sequence) : 0,
        hasMoreBefore,
      },
      responses: this.listResponses(sessionId),
    };
  }

  createResponse(input: {
    id?: string;
    sessionId: string;
    runId: string;
    messageId: string;
    status?: ResponseStatus;
  }): Response {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO responses(id,session_id,run_id,message_id,status,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(id, input.sessionId, input.runId, input.messageId, input.status ?? "queued", "", now, now);
    return this.getResponse(id);
  }

  getResponse(id: string): Response {
    const value = row(this.db.prepare("SELECT * FROM responses WHERE id=?"), id);
    if (!value) throw new Error(`Response not found: ${id}`);
    return this.toResponse(value);
  }

  responseOwner(id: string): string | undefined {
    const value = row(
      this.db.prepare("SELECT s.user_id FROM responses r JOIN sessions s ON s.id=r.session_id WHERE r.id=?"),
      id,
    );
    return value?.user_id ? text(value.user_id) : undefined;
  }

  listResponses(sessionId: string): Response[] {
    return rows(
      this.db.prepare("SELECT * FROM responses WHERE session_id=? ORDER BY created_at"),
      sessionId,
    ).map((value) => this.toResponse(value));
  }

  responseForRun(runId: string): Response | undefined {
    const value = row(this.db.prepare("SELECT id FROM responses WHERE run_id=?"), runId);
    return value ? this.getResponse(text(value.id)) : undefined;
  }

  responseForMessage(messageId: string): Response | undefined {
    const value = row(this.db.prepare("SELECT id FROM responses WHERE message_id=?"), messageId);
    return value ? this.getResponse(text(value.id)) : undefined;
  }

  updateResponse(id: string, patch: { status?: ResponseStatus; content?: string }): Response {
    const current = row(this.db.prepare("SELECT * FROM responses WHERE id=?"), id);
    if (!current) throw new Error(`Response not found: ${id}`);
    this.db
      .prepare("UPDATE responses SET status=?,content=?,updated_at=? WHERE id=?")
      .run(patch.status ?? text(current.status), patch.content ?? text(current.content), Date.now(), id);
    return this.getResponse(id);
  }

  updateResponseAttachmentStatus(responseId: string, status: NonNullable<Attachment["status"]>): void {
    this.db.prepare("UPDATE attachments SET status=? WHERE response_id=?").run(status, responseId);
  }

  addResponseActivity(input: {
    responseId: string;
    kind: ResponseActivity["kind"];
    status?: ResponseStatus;
    text?: string;
    toolName?: string;
    attachmentId?: string;
  }): ResponseActivity {
    const id = randomUUID();
    const createdAt = Date.now();
    this.db
      .prepare(
        "INSERT INTO response_activities(id,response_id,kind,status,text,tool_name,attachment_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.responseId,
        input.kind,
        input.status ?? null,
        input.text ?? null,
        input.toolName ?? null,
        input.attachmentId ?? null,
        createdAt,
      );
    return {
      id,
      responseId: input.responseId,
      kind: input.kind,
      ...(input.status ? { status: input.status } : {}),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}),
      createdAt,
    };
  }

  private toResponse(value: Row): Response {
    const activities = rows(
      this.db.prepare("SELECT * FROM response_activities WHERE response_id=? ORDER BY created_at"),
      text(value.id),
    ).map(
      (item): ResponseActivity => ({
        id: text(item.id),
        responseId: text(item.response_id),
        kind: text(item.kind) as ResponseActivity["kind"],
        ...(item.status ? { status: text(item.status) as ResponseStatus } : {}),
        ...(item.text !== null && item.text !== undefined ? { text: text(item.text) } : {}),
        ...(item.tool_name ? { toolName: text(item.tool_name) } : {}),
        ...(item.attachment_id ? { attachmentId: text(item.attachment_id) } : {}),
        createdAt: integer(item.created_at),
      }),
    );
    const attachments = rows(
      this.db.prepare("SELECT * FROM attachments WHERE response_id=? ORDER BY created_at"),
      text(value.id),
    ).map((item) => toAttachment(item));
    return {
      id: text(value.id),
      sessionId: text(value.session_id),
      runId: text(value.run_id),
      messageId: text(value.message_id),
      status: text(value.status) as ResponseStatus,
      content: text(value.content),
      activities,
      attachments,
      createdAt: integer(value.created_at),
      updatedAt: integer(value.updated_at),
    };
  }

  appendEvent(
    sessionId: string,
    runId: string | undefined,
    type: DurableAgentEventType,
    payload: unknown,
  ): AgentEventEnvelope {
    return this.withTransaction(() => {
      const sequence = this.allocateEventSequence(sessionId);
      const event: AgentEventEnvelope = {
        protocolVersion: PROTOCOL_VERSION,
        sessionId,
        ...(runId ? { runId } : {}),
        sequence,
        timestamp: Date.now(),
        type,
        payload: redactAudit(payload),
      };
      this.db
        .prepare(
          "INSERT INTO session_events(id,session_id,run_id,sequence,protocol_version,type,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          sessionId,
          runId ?? null,
          sequence,
          PROTOCOL_VERSION,
          type,
          JSON.stringify(event.payload),
          event.timestamp,
        );
      return event;
    });
  }

  listEvents(sessionId: string, afterSequence: number, limit = 500): SessionEventPage {
    this.getSession(sessionId);
    const sessionState = row(
      this.db.prepare("SELECT next_event_sequence FROM sessions WHERE id=?"),
      sessionId,
    );
    const bounded = Math.max(1, Math.min(1000, limit));
    const values = rows(
      this.db.prepare(
        "SELECT * FROM session_events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?",
      ),
      sessionId,
      afterSequence,
      bounded + 1,
    );
    const hasMore = values.length > bounded;
    const pageValues = values.slice(0, bounded);
    const events = pageValues.map(
      (value): AgentEventEnvelope => ({
        protocolVersion: PROTOCOL_VERSION,
        sessionId: text(value.session_id),
        ...(value.run_id ? { runId: text(value.run_id) } : {}),
        sequence: integer(value.sequence),
        timestamp: integer(value.created_at),
        type: text(value.type) as DurableAgentEventType,
        payload: parseJson(value.payload_json, null),
      }),
    );
    const snapshotSequence = Math.max(0, integer(sessionState?.next_event_sequence) - 1);
    return {
      sessionId,
      fromSequence: events[0]?.sequence ?? afterSequence,
      toSequence: events.at(-1)?.sequence ?? afterSequence,
      nextSequence: events.at(-1)?.sequence ?? afterSequence,
      hasMore,
      events,
      snapshotSequence,
    };
  }

  createToolCall(input: { id: string; runId: string; name: string; args: unknown }): void {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT OR REPLACE INTO tool_calls(id,run_id,name,input_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(input.id, input.runId, input.name, JSON.stringify(input.args), "running", now, now);
  }

  completeToolCall(id: string, result: unknown, failed: boolean): void {
    this.db
      .prepare("UPDATE tool_calls SET result_json=?, status=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(result), failed ? "error" : "complete", Date.now(), id);
  }

  createApproval(input: {
    sessionId: string;
    runId: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
  }): Approval {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO approvals(id,session_id,run_id,tool_call_id,tool_name,input_json,status,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.sessionId,
        input.runId,
        input.toolCallId,
        input.toolName,
        JSON.stringify(input.args),
        "pending",
        now,
      );
    return this.getApproval(id);
  }

  getApproval(id: string): Approval {
    const value = row(this.db.prepare("SELECT * FROM approvals WHERE id=?"), id);
    if (!value) throw new Error(`Approval not found: ${id}`);
    return {
      id: text(value.id),
      sessionId: text(value.session_id),
      runId: text(value.run_id),
      toolCallId: text(value.tool_call_id),
      toolName: text(value.tool_name),
      input: redactAudit(parseJson(value.input_json, null)),
      status: text(value.status) as Approval["status"],
      createdAt: integer(value.created_at),
      ...(value.resolved_at ? { resolvedAt: integer(value.resolved_at) } : {}),
    };
  }

  resolveApproval(id: string, approved: boolean): Approval {
    const result = this.db
      .prepare("UPDATE approvals SET status=?, resolved_at=? WHERE id=? AND status='pending'")
      .run(approved ? "approved" : "denied", Date.now(), id);
    if (result.changes === 0) return this.getApproval(id);
    return this.getApproval(id);
  }

  expireApproval(id: string): Approval {
    this.db
      .prepare("UPDATE approvals SET status='expired', resolved_at=? WHERE id=? AND status='pending'")
      .run(Date.now(), id);
    return this.getApproval(id);
  }

  addAttachment(input: {
    sessionId?: string;
    responseId?: string;
    ownerUserId?: string;
    name: string;
    mimeType: string;
    size: number;
    storagePath: string;
    sha256?: string;
    status?: Attachment["status"];
    expiresAt?: number;
  }): Attachment {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO attachments(id,session_id,response_id,owner_user_id,name,mime_type,size,sha256,status,expires_at,storage_path,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.sessionId ?? null,
        input.responseId ?? null,
        input.ownerUserId ?? (input.sessionId ? this.sessionOwner(input.sessionId) : null) ?? null,
        input.name,
        input.mimeType,
        input.size,
        input.sha256 ?? null,
        input.status ?? "ready",
        input.expiresAt ?? null,
        input.storagePath,
        now,
      );
    return this.getAttachment(id) as Attachment;
  }

  getAttachment(id: string): Attachment | undefined {
    const value = row(this.db.prepare("SELECT * FROM attachments WHERE id=?"), id);
    return value ? toAttachment(value) : undefined;
  }

  getAttachmentPath(id: string, sessionId?: string): string {
    const value = row(this.db.prepare("SELECT session_id,storage_path FROM attachments WHERE id=?"), id);
    if (!value) throw new Error(`Attachment not found: ${id}`);
    if (sessionId && (!value.session_id || text(value.session_id) !== sessionId))
      throw new Error(`Attachment belongs to another session: ${id}`);
    return text(value.storage_path);
  }

  validateAttachmentForSession(id: string, sessionId: string): void {
    const value = row(this.db.prepare("SELECT session_id,status,expires_at FROM attachments WHERE id=?"), id);
    if (!value) throw new Error(`Attachment not found: ${id}`);
    if (!value.session_id || text(value.session_id) !== sessionId)
      throw new Error(`Attachment belongs to another session: ${id}`);
    if (text(value.status) === "revoked" || (value.expires_at && integer(value.expires_at) <= Date.now()))
      throw new Error(`Attachment is no longer available: ${id}`);
  }

  searchMemory(sessionId: string, query: string, limit = 5): string[] {
    const match = ftsQuery(query);
    if (!match) return [];
    return rows(
      this.db.prepare(
        "SELECT m.value FROM memory_fts f JOIN memory_facts m ON m.id=f.id WHERE memory_fts MATCH ? AND m.status='active' AND ((m.scope='global' AND m.owner_id=(SELECT user_id FROM sessions WHERE id=?)) OR (m.scope='session' AND m.session_id=?)) ORDER BY bm25(memory_fts) LIMIT ?",
      ),
      match,
      sessionId,
      sessionId,
      limit,
    ).map((value) => text(value.value));
  }

  searchHistory(sessionId: string, query: string, limit = 20): TranscriptItem[] {
    this.getSession(sessionId);
    const match = ftsQuery(query);
    if (!match) return [];
    return rows(
      this.db.prepare(
        "SELECT message_id FROM history_fts WHERE history_fts MATCH ? AND session_id=? ORDER BY bm25(history_fts) LIMIT ?",
      ),
      match,
      sessionId,
      Math.max(1, Math.min(100, limit)),
    ).map((value) => this.getMessage(text(value.message_id)));
  }

  readHistoryRange(sessionId: string, fromSequence: number, toSequence: number): TranscriptItem[] {
    this.getSession(sessionId);
    if (toSequence < fromSequence) throw new Error("Invalid history sequence range");
    return rows(
      this.db.prepare(
        "SELECT id FROM messages WHERE session_id=? AND sequence BETWEEN ? AND ? ORDER BY sequence LIMIT 200",
      ),
      sessionId,
      Math.max(1, fromSequence),
      toSequence,
    ).map((value) => this.getMessage(text(value.id)));
  }

  replaceKnowledgeSource(input: {
    ownerId?: string;
    name: string;
    path: string;
    chunks: Array<{
      filePath: string;
      content: string;
      embedding?: { model: string; vector: number[]; contentHash: string };
    }>;
  }): KnowledgeSource {
    const existing = row(
      this.db.prepare("SELECT id FROM knowledge_sources WHERE path=? AND owner_id=?"),
      input.path,
      input.ownerId ?? "system",
    );
    const id = existing ? text(existing.id) : randomUUID();
    const now = Date.now();
    if (existing) {
      const oldIds = rows(this.db.prepare("SELECT id FROM knowledge_chunks WHERE source_id=?"), id).map(
        (value) => text(value.id),
      );
      for (const chunkId of oldIds) this.db.prepare("DELETE FROM knowledge_fts WHERE id=?").run(chunkId);
      this.db.prepare("DELETE FROM knowledge_chunks WHERE source_id=?").run(id);
      this.db
        .prepare(
          "UPDATE knowledge_sources SET name=?,document_count=?,status='indexed',error=NULL,updated_at=? WHERE id=?",
        )
        .run(input.name, new Set(input.chunks.map((chunk) => chunk.filePath)).size, now, id);
    } else {
      this.db
        .prepare(
          "INSERT INTO knowledge_sources(id,owner_id,name,path,document_count,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          input.ownerId ?? "system",
          input.name,
          input.path,
          new Set(input.chunks.map((chunk) => chunk.filePath)).size,
          "indexed",
          now,
          now,
        );
    }
    const insertChunk = this.db.prepare(
      "INSERT INTO knowledge_chunks(id,source_id,file_path,position,content) VALUES(?,?,?,?,?)",
    );
    const insertFts = this.db.prepare(
      "INSERT INTO knowledge_fts(id,source_id,file_path,content) VALUES(?,?,?,?)",
    );
    const embeddings: Array<{ chunkId: string; model: string; vector: number[]; contentHash: string }> = [];
    input.chunks.forEach((chunk, position) => {
      const chunkId = randomUUID();
      insertChunk.run(chunkId, id, chunk.filePath, position, chunk.content);
      insertFts.run(chunkId, id, chunk.filePath, chunk.content);
      if (chunk.embedding) embeddings.push({ chunkId, ...chunk.embedding });
    });
    this.db.prepare("DELETE FROM knowledge_embeddings WHERE source_id=?").run(id);
    const insertEmbedding = this.db.prepare(
      "INSERT INTO knowledge_embeddings(chunk_id,source_id,model,vector_json,content_hash,created_at) VALUES(?,?,?,?,?,?)",
    );
    for (const embedding of embeddings)
      insertEmbedding.run(
        embedding.chunkId,
        id,
        embedding.model,
        JSON.stringify(embedding.vector),
        embedding.contentHash,
        now,
      );
    return this.getKnowledgeSource(id);
  }

  createKnowledgeSource(input: { name: string; path: string; ownerId?: string }): KnowledgeSource {
    const existing = row(
      this.db.prepare("SELECT id FROM knowledge_sources WHERE path=? AND owner_id=?"),
      input.path,
      input.ownerId ?? "system",
    );
    const now = Date.now();
    const id = existing ? text(existing.id) : randomUUID();
    if (existing) {
      for (const value of rows(this.db.prepare("SELECT id FROM knowledge_chunks WHERE source_id=?"), id))
        this.db.prepare("DELETE FROM knowledge_fts WHERE id=?").run(text(value.id));
      this.db.prepare("DELETE FROM knowledge_chunks WHERE source_id=?").run(id);
      this.db
        .prepare(
          "UPDATE knowledge_sources SET name=?,status='queued',error=NULL,document_count=0,updated_at=? WHERE id=?",
        )
        .run(input.name, now, id);
    } else
      this.db
        .prepare(
          "INSERT INTO knowledge_sources(id,owner_id,name,path,document_count,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(id, input.ownerId ?? "system", input.name, input.path, 0, "queued", now, now);
    return this.getKnowledgeSource(id);
  }

  updateKnowledgeSourceStatus(
    id: string,
    status: KnowledgeSource["status"],
    error?: string,
  ): KnowledgeSource {
    const result = this.db
      .prepare("UPDATE knowledge_sources SET status=?,error=?,updated_at=? WHERE id=?")
      .run(status, error ?? null, Date.now(), id);
    if (result.changes === 0) throw new Error(`Knowledge source not found: ${id}`);
    return this.getKnowledgeSource(id);
  }

  deleteKnowledgeSource(id: string): void {
    this.withTransaction(() => {
      for (const value of rows(this.db.prepare("SELECT id FROM knowledge_chunks WHERE source_id=?"), id))
        this.db.prepare("DELETE FROM knowledge_fts WHERE id=?").run(text(value.id));
      const result = this.db.prepare("DELETE FROM knowledge_sources WHERE id=?").run(id);
      if (result.changes === 0) throw new Error(`Knowledge source not found: ${id}`);
    });
  }

  getKnowledgeSource(id: string): KnowledgeSource {
    const value = row(this.db.prepare("SELECT * FROM knowledge_sources WHERE id=?"), id);
    if (!value) throw new Error(`Knowledge source not found: ${id}`);
    return {
      id: text(value.id),
      name: text(value.name),
      path: text(value.path),
      documentCount: integer(value.document_count),
      status: text(value.status) as KnowledgeSource["status"],
      ...(value.error ? { error: text(value.error) } : {}),
      createdAt: integer(value.created_at),
      updatedAt: integer(value.updated_at),
    };
  }

  listKnowledgeSources(ownerId?: string): KnowledgeSource[] {
    return rows(
      ownerId
        ? this.db.prepare("SELECT id FROM knowledge_sources WHERE owner_id=? ORDER BY created_at DESC")
        : this.db.prepare("SELECT id FROM knowledge_sources ORDER BY created_at DESC"),
      ...(ownerId ? [ownerId] : []),
    ).map((value) => this.getKnowledgeSource(text(value.id)));
  }

  knowledgeOwner(id: string): string | undefined {
    const value = row(this.db.prepare("SELECT owner_id FROM knowledge_sources WHERE id=?"), id);
    return value ? text(value.owner_id) : undefined;
  }

  searchKnowledge(
    query: string,
    limit = 5,
    sourceId?: string,
    ownerId?: string,
  ): Array<{ sourceId: string; sourceName: string; filePath: string; content: string }> {
    const match = ftsQuery(query);
    if (!match) return [];
    const statement = sourceId
      ? this.db.prepare(
          "SELECT f.source_id,s.name AS source_name,f.file_path,f.content FROM knowledge_fts f JOIN knowledge_sources s ON s.id=f.source_id WHERE knowledge_fts MATCH ? AND f.source_id=? AND (? IS NULL OR s.owner_id=?) ORDER BY bm25(knowledge_fts) LIMIT ?",
        )
      : this.db.prepare(
          "SELECT f.source_id,s.name AS source_name,f.file_path,f.content FROM knowledge_fts f JOIN knowledge_sources s ON s.id=f.source_id WHERE knowledge_fts MATCH ? AND (? IS NULL OR s.owner_id=?) ORDER BY bm25(knowledge_fts) LIMIT ?",
        );
    const values = sourceId
      ? rows(statement, match, sourceId, ownerId ?? null, ownerId ?? null, Math.max(1, Math.min(100, limit)))
      : rows(statement, match, ownerId ?? null, ownerId ?? null, Math.max(1, Math.min(100, limit)));
    return values.map((value) => ({
      sourceId: text(value.source_id),
      sourceName: text(value.source_name),
      filePath: text(value.file_path),
      content: text(value.content),
    }));
  }

  replaceKnowledgeEmbeddings(
    sourceId: string,
    entries: Array<{ chunkId: string; model: string; vector: number[]; contentHash: string }>,
  ): void {
    this.withTransaction(() => {
      this.db.prepare("DELETE FROM knowledge_embeddings WHERE source_id=?").run(sourceId);
      const insert = this.db.prepare(
        "INSERT INTO knowledge_embeddings(chunk_id,source_id,model,vector_json,content_hash,created_at) VALUES(?,?,?,?,?,?)",
      );
      for (const entry of entries)
        insert.run(
          entry.chunkId,
          sourceId,
          entry.model,
          JSON.stringify(entry.vector),
          entry.contentHash,
          Date.now(),
        );
    });
  }

  searchKnowledgeSemantic(
    queryVector: number[],
    limit = 5,
    ownerId?: string,
    model?: string,
  ): Array<{ sourceId: string; sourceName: string; filePath: string; content: string; score: number }> {
    const values = rows(
      this.db.prepare(
        "SELECT e.source_id,e.model,e.vector_json,c.file_path,c.content,s.name AS source_name FROM knowledge_embeddings e JOIN knowledge_chunks c ON c.id=e.chunk_id JOIN knowledge_sources s ON s.id=e.source_id WHERE (? IS NULL OR s.owner_id=?) AND (? IS NULL OR e.model=?)",
      ),
      ownerId ?? null,
      ownerId ?? null,
      model ?? null,
      model ?? null,
    );
    const norm = Math.sqrt(queryVector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return values
      .map((value) => {
        const vector = JSON.parse(text(value.vector_json)) as number[];
        const denominator = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) * norm || 1;
        const score =
          vector.reduce((sum, item, index) => sum + item * (queryVector[index] ?? 0), 0) / denominator;
        return {
          sourceId: text(value.source_id),
          sourceName: text(value.source_name),
          filePath: text(value.file_path),
          content: text(value.content),
          score,
        };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, Math.min(100, limit)));
  }

  putWebSession(hash: string, expiresAt: number, userId?: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO web_sessions(id_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)")
      .run(hash, userId ?? null, expiresAt, Date.now());
  }

  hasWebSession(hash: string): boolean {
    this.db.prepare("DELETE FROM web_sessions WHERE expires_at<?").run(Date.now());
    return Boolean(
      row(
        this.db.prepare("SELECT 1 AS ok FROM web_sessions WHERE id_hash=? AND expires_at>=?"),
        hash,
        Date.now(),
      ),
    );
  }

  webSessionUser(hash: string): { userId: string; role: "admin" | "user" } | undefined {
    const value = row(
      this.db.prepare(
        "SELECT s.user_id,u.role,u.status,s.expires_at FROM web_sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=?",
      ),
      hash,
    );
    if (
      !value ||
      !value.user_id ||
      text(value.status) !== "active" ||
      integer(value.expires_at) <= Date.now()
    )
      return undefined;
    return { userId: text(value.user_id), role: text(value.role) as "admin" | "user" };
  }

  deleteWebSession(hash: string): void {
    this.db.prepare("DELETE FROM web_sessions WHERE id_hash=?").run(hash);
  }

  findAwaitingRun(sessionId: string): Run | undefined {
    const value = row(
      this.db.prepare(
        "SELECT id FROM runs WHERE session_id=? AND status='awaiting_input' ORDER BY updated_at DESC LIMIT 1",
      ),
      sessionId,
    );
    return value ? this.getRun(text(value.id)) : undefined;
  }

  createBackgroundTask(input: {
    id: string;
    parentSessionId?: string;
    sessionId: string;
    source?: BackgroundTask["source"];
    prompt: string;
  }): BackgroundTask {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO background_tasks(id,parent_session_id,session_id,source_type,source_schedule_id,source_schedule_run_id,prompt,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        input.id,
        input.parentSessionId ?? null,
        input.sessionId,
        input.source?.type ?? null,
        input.source?.scheduleId ?? null,
        input.source?.scheduleRunId ?? null,
        input.prompt,
        "pending",
        now,
        now,
      );
    return this.getBackgroundTask(input.id);
  }

  getBackgroundTask(id: string): BackgroundTask {
    const value = row(this.db.prepare("SELECT * FROM background_tasks WHERE id=?"), id);
    if (!value) throw new Error(`Background task not found: ${id}`);
    return {
      id: text(value.id),
      ...(value.parent_session_id ? { parentSessionId: text(value.parent_session_id) } : {}),
      sessionId: text(value.session_id),
      ...(value.run_id ? { runId: text(value.run_id) } : {}),
      ...(value.source_type
        ? {
            source: {
              type: "schedule" as const,
              scheduleId: text(value.source_schedule_id),
              scheduleRunId: text(value.source_schedule_run_id),
            },
          }
        : {}),
      prompt: text(value.prompt),
      status: text(value.status) as BackgroundTask["status"],
      ...(value.result ? { result: text(value.result) } : {}),
      ...(value.error ? { error: text(value.error) } : {}),
      createdAt: integer(value.created_at),
      updatedAt: integer(value.updated_at),
    };
  }

  findBackgroundTaskByRunId(runId: string): BackgroundTask | undefined {
    const value = row(this.db.prepare("SELECT id FROM background_tasks WHERE run_id=?"), runId);
    return value ? this.getBackgroundTask(text(value.id)) : undefined;
  }

  listBackgroundTasks(userId?: string): BackgroundTask[] {
    const statement = userId
      ? this.db.prepare(
          "SELECT t.id FROM background_tasks t JOIN sessions s ON s.id=t.session_id WHERE s.user_id=? ORDER BY t.updated_at DESC",
        )
      : this.db.prepare("SELECT id FROM background_tasks ORDER BY updated_at DESC");
    return rows(statement, ...(userId ? [userId] : [])).map((value) =>
      this.getBackgroundTask(text(value.id)),
    );
  }

  deleteBackgroundTask(id: string): void {
    const task = this.getBackgroundTask(id);
    if (["pending", "running"].includes(task.status))
      throw new Error("Only terminal background tasks can be deleted");
    const result = this.db.prepare("DELETE FROM background_tasks WHERE id=?").run(id);
    if (result.changes === 0) throw new Error(`Background task not found: ${id}`);
  }

  updateBackgroundTask(
    id: string,
    patch: {
      status?: BackgroundTask["status"];
      runId?: string;
      result?: string;
      error?: string | null;
    },
  ): BackgroundTask {
    const current = this.getBackgroundTask(id);
    this.db
      .prepare("UPDATE background_tasks SET status=?,run_id=?,result=?,error=?,updated_at=? WHERE id=?")
      .run(
        patch.status ?? current.status,
        patch.runId ?? current.runId ?? null,
        patch.result ?? current.result ?? null,
        patch.error === undefined ? (current.error ?? null) : patch.error,
        Date.now(),
        id,
      );
    return this.getBackgroundTask(id);
  }

  addMemoryFact(input: {
    ownerId?: string;
    sessionId?: string;
    scope: MemoryFact["scope"];
    key: string;
    value: string;
    category: string;
    confidence: number;
    evidence?: string;
    sourceRunId?: string;
    status: MemoryFact["status"];
  }): MemoryFact {
    const id = randomUUID();
    const now = Date.now();
    const storedId = this.withTransaction(() => {
      const duplicate = row(
        this.db.prepare(
          "SELECT id FROM memory_facts WHERE owner_id=? AND scope=? AND COALESCE(session_id,'')=COALESCE(?,'') AND key=? AND value=? AND status IN ('active','candidate') ORDER BY updated_at DESC LIMIT 1",
        ),
        input.ownerId ?? "system",
        input.scope,
        input.sessionId ?? null,
        input.key,
        input.value,
      );
      if (duplicate) return text(duplicate.id);
      const previous =
        input.status === "active"
          ? row(
              this.db.prepare(
                "SELECT id,value FROM memory_facts WHERE owner_id=? AND scope=? AND COALESCE(session_id,'')=COALESCE(?,'') AND key=? AND status='active' ORDER BY updated_at DESC LIMIT 1",
              ),
              input.ownerId ?? "system",
              input.scope,
              input.sessionId ?? null,
              input.key,
            )
          : undefined;
      if (previous && text(previous.value) !== input.value)
        this.db
          .prepare("UPDATE memory_facts SET status='superseded',updated_at=? WHERE id=?")
          .run(now, text(previous.id));
      this.db
        .prepare(
          "INSERT INTO memory_facts(id,owner_id,session_id,scope,key,value,category,confidence,evidence,source_run_id,status,supersedes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          input.ownerId ?? "system",
          input.sessionId ?? null,
          input.scope,
          input.key,
          input.value,
          input.category,
          input.confidence,
          input.evidence ?? null,
          input.sourceRunId ?? null,
          input.status,
          previous && text(previous.value) !== input.value ? text(previous.id) : null,
          now,
          now,
        );
      this.db
        .prepare("INSERT INTO memory_fts(id,content) VALUES(?,?)")
        .run(id, `${input.key} ${input.value}`);
      return id;
    });
    return this.getMemoryFact(storedId);
  }

  getMemoryFact(id: string): MemoryFact {
    const value = row(this.db.prepare("SELECT * FROM memory_facts WHERE id=?"), id);
    if (!value) throw new Error(`Memory fact not found: ${id}`);
    return {
      id: text(value.id),
      ...(value.session_id ? { sessionId: text(value.session_id) } : {}),
      scope: text(value.scope) as MemoryFact["scope"],
      key: text(value.key),
      value: text(value.value),
      category: text(value.category),
      confidence: Number(value.confidence),
      ...(value.evidence ? { evidence: text(value.evidence) } : {}),
      ...(value.source_run_id ? { sourceRunId: text(value.source_run_id) } : {}),
      status: text(value.status) as MemoryFact["status"],
      ...(value.supersedes ? { supersedes: text(value.supersedes) } : {}),
      createdAt: integer(value.created_at),
      updatedAt: integer(value.updated_at),
    };
  }

  memoryOwner(id: string): string | undefined {
    const value = row(this.db.prepare("SELECT owner_id FROM memory_facts WHERE id=?"), id);
    return value ? text(value.owner_id) : undefined;
  }

  listMemoryFacts(status?: MemoryFact["status"], ownerId?: string): MemoryFact[] {
    const values = status
      ? rows(
          ownerId
            ? this.db.prepare(
                "SELECT id FROM memory_facts WHERE status=? AND owner_id=? ORDER BY updated_at DESC,rowid DESC",
              )
            : this.db.prepare(
                "SELECT id FROM memory_facts WHERE status=? ORDER BY updated_at DESC,rowid DESC",
              ),
          ...(ownerId ? [status, ownerId] : [status]),
        )
      : rows(
          ownerId
            ? this.db.prepare(
                "SELECT id FROM memory_facts WHERE owner_id=? ORDER BY updated_at DESC,rowid DESC",
              )
            : this.db.prepare("SELECT id FROM memory_facts ORDER BY updated_at DESC,rowid DESC"),
          ...(ownerId ? [ownerId] : []),
        );
    return values.map((value) => this.getMemoryFact(text(value.id)));
  }

  updateMemoryFact(id: string, status: MemoryFact["status"]): MemoryFact {
    const result = this.db
      .prepare("UPDATE memory_facts SET status=?,updated_at=? WHERE id=?")
      .run(status, Date.now(), id);
    if (result.changes === 0) throw new Error(`Memory fact not found: ${id}`);
    return this.getMemoryFact(id);
  }

  deleteMemoryFact(id: string): void {
    this.withTransaction(() => {
      const result = this.db.prepare("DELETE FROM memory_facts WHERE id=?").run(id);
      if (result.changes === 0) throw new Error(`Memory fact not found: ${id}`);
      this.db.prepare("DELETE FROM memory_fts WHERE id=?").run(id);
    });
  }

  addMemoryRollup(input: Omit<MemoryRollup, "id" | "createdAt">): MemoryRollup {
    const id = randomUUID();
    const createdAt = Date.now();
    this.db
      .prepare(
        "INSERT INTO memory_rollups(id,session_id,kind,from_sequence,to_sequence,summary,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_id,kind,from_sequence,to_sequence) DO UPDATE SET summary=excluded.summary,created_at=excluded.created_at",
      )
      .run(id, input.sessionId, input.kind, input.fromSequence, input.toSequence, input.summary, createdAt);
    const value = row(
      this.db.prepare(
        "SELECT * FROM memory_rollups WHERE session_id=? AND kind=? AND from_sequence=? AND to_sequence=?",
      ),
      input.sessionId,
      input.kind,
      input.fromSequence,
      input.toSequence,
    ) as Row;
    return {
      id: text(value.id),
      sessionId: text(value.session_id),
      kind: text(value.kind) as MemoryRollup["kind"],
      fromSequence: integer(value.from_sequence),
      toSequence: integer(value.to_sequence),
      summary: text(value.summary),
      createdAt: integer(value.created_at),
    };
  }

  listMemoryRollups(sessionId: string, limit = 20): MemoryRollup[] {
    return rows(
      this.db.prepare("SELECT * FROM memory_rollups WHERE session_id=? ORDER BY to_sequence DESC LIMIT ?"),
      sessionId,
      Math.max(1, Math.min(100, limit)),
    ).map((value) => ({
      id: text(value.id),
      sessionId: text(value.session_id),
      kind: text(value.kind) as MemoryRollup["kind"],
      fromSequence: integer(value.from_sequence),
      toSequence: integer(value.to_sequence),
      summary: text(value.summary),
      createdAt: integer(value.created_at),
    }));
  }

  replaceAggregateRollup(input: Omit<MemoryRollup, "id" | "createdAt">): MemoryRollup {
    if (input.kind === "turn") return this.addMemoryRollup(input);
    this.db
      .prepare("DELETE FROM memory_rollups WHERE session_id=? AND kind=?")
      .run(input.sessionId, input.kind);
    return this.addMemoryRollup(input);
  }

  maintainMemoryRollups(sessionId: string): void {
    this.db
      .prepare(
        "DELETE FROM memory_rollups WHERE id IN (SELECT id FROM memory_rollups WHERE session_id=? AND kind='turn' ORDER BY to_sequence DESC LIMIT -1 OFFSET 500)",
      )
      .run(sessionId);
    this.db
      .prepare(
        "DELETE FROM memory_rollups WHERE id IN (SELECT id FROM memory_rollups WHERE session_id=? AND kind='day' ORDER BY to_sequence DESC LIMIT -1 OFFSET 90)",
      )
      .run(sessionId);
  }

  getAgentProfile(userId = "system"): AgentProfile {
    this.db
      .prepare("INSERT OR IGNORE INTO agent_profiles(user_id,content,updated_at) VALUES(?,?,?)")
      .run(userId, "", 0);
    const value = row(
      this.db.prepare("SELECT content,updated_at FROM agent_profiles WHERE user_id=?"),
      userId,
    );
    return { content: text(value?.content), updatedAt: integer(value?.updated_at) };
  }

  putAgentProfile(content: string, userId = "system"): AgentProfile {
    this.db
      .prepare(
        "INSERT INTO agent_profiles(user_id,content,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at",
      )
      .run(userId, content, Date.now());
    return this.getAgentProfile(userId);
  }

  addQualityAssessment(input: Omit<QualityAssessment, "id" | "createdAt">): QualityAssessment {
    const id = randomUUID();
    const createdAt = Date.now();
    this.db
      .prepare(
        "INSERT INTO quality_assessments(id,run_id,target_message_id,passed,issues_json,suggestions_json,iteration,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.runId,
        input.targetMessageId,
        input.passed ? 1 : 0,
        JSON.stringify(input.issues),
        JSON.stringify(input.suggestions),
        input.iteration,
        createdAt,
      );
    return { id, createdAt, ...input };
  }

  listQualityAssessments(runId: string): QualityAssessment[] {
    return rows(
      this.db.prepare("SELECT * FROM quality_assessments WHERE run_id=? ORDER BY iteration,created_at"),
      runId,
    ).map((value) => ({
      id: text(value.id),
      runId: text(value.run_id),
      targetMessageId: text(value.target_message_id),
      passed: integer(value.passed) === 1,
      issues: parseJson(value.issues_json, []),
      suggestions: parseJson(value.suggestions_json, []),
      iteration: integer(value.iteration),
      createdAt: integer(value.created_at),
    }));
  }

  listQualityForMessage(messageId: string): QualityAssessment[] {
    return rows(
      this.db.prepare("SELECT run_id FROM quality_assessments WHERE target_message_id=? ORDER BY created_at"),
      messageId,
    ).flatMap((value) => this.listQualityAssessments(text(value.run_id)));
  }

  listActivity(sessionId: string, limit = 200): Array<Record<string, unknown>> {
    this.getSession(sessionId);
    return rows(
      this.db.prepare(
        "SELECT sequence,type,payload_json,created_at FROM session_events WHERE session_id=? ORDER BY sequence DESC LIMIT ?",
      ),
      sessionId,
      Math.max(1, Math.min(1000, limit)),
    )
      .reverse()
      .map((value) => ({
        sequence: integer(value.sequence),
        type: text(value.type),
        payload: parseJson(value.payload_json, {}),
        createdAt: integer(value.created_at),
      }));
  }

  upsertSkillPackage(
    input: Omit<SkillPackage, "id" | "installedAt" | "updatedAt"> & { installPath: string },
  ): SkillPackage {
    const existing = row(
      this.db.prepare("SELECT id,installed_at FROM skill_packages WHERE name=?"),
      input.name,
    );
    const id = existing ? text(existing.id) : randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO skill_packages(id,name,version,source_type,source_reference,install_path,content_hash,status,risk,diagnostics_json,installed_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET version=excluded.version,source_type=excluded.source_type,source_reference=excluded.source_reference,install_path=excluded.install_path,content_hash=excluded.content_hash,status=excluded.status,risk=excluded.risk,diagnostics_json=excluded.diagnostics_json,updated_at=excluded.updated_at",
      )
      .run(
        id,
        input.name,
        input.version,
        input.source.type,
        input.source.reference,
        input.installPath,
        input.contentHash,
        input.status,
        input.risk,
        JSON.stringify(input.diagnostics),
        existing ? integer(existing.installed_at) : now,
        now,
      );
    return this.getSkillPackage(id);
  }

  getSkillPackage(id: string): SkillPackage {
    const value = row(this.db.prepare("SELECT * FROM skill_packages WHERE id=?"), id);
    if (!value) throw new Error(`Skill package not found: ${id}`);
    return {
      id: text(value.id),
      name: text(value.name),
      version: text(value.version),
      source: {
        type: text(value.source_type) as SkillPackage["source"]["type"],
        reference: text(value.source_reference),
      },
      contentHash: text(value.content_hash),
      status: text(value.status) as SkillPackage["status"],
      risk: text(value.risk) as SkillPackage["risk"],
      diagnostics: parseJson(value.diagnostics_json, []),
      installedAt: integer(value.installed_at),
      updatedAt: integer(value.updated_at),
    };
  }

  getSkillPackagePath(id: string): string {
    const value = row(this.db.prepare("SELECT install_path FROM skill_packages WHERE id=?"), id);
    if (!value) throw new Error(`Skill package not found: ${id}`);
    return text(value.install_path);
  }

  listSkillPackages(): SkillPackage[] {
    return rows(this.db.prepare("SELECT id FROM skill_packages ORDER BY name")).map((value) =>
      this.getSkillPackage(text(value.id)),
    );
  }

  updateSkillPackageStatus(id: string, status: SkillPackage["status"]): SkillPackage {
    const result = this.db
      .prepare("UPDATE skill_packages SET status=?,updated_at=? WHERE id=?")
      .run(status, Date.now(), id);
    if (!result.changes) throw new Error(`Skill package not found: ${id}`);
    return this.getSkillPackage(id);
  }

  addOptimizationProposal(
    input: Omit<OptimizationProposal, "id" | "createdAt" | "updatedAt">,
  ): OptimizationProposal {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO optimization_proposals(id,title,evidence_json,risk,recommendation,validation_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.title,
        JSON.stringify(input.evidence),
        input.risk,
        input.recommendation,
        JSON.stringify(input.validation),
        input.status,
        now,
        now,
      );
    return this.getOptimizationProposal(id);
  }

  getOptimizationProposal(id: string): OptimizationProposal {
    const value = row(this.db.prepare("SELECT * FROM optimization_proposals WHERE id=?"), id);
    if (!value) throw new Error(`Optimization proposal not found: ${id}`);
    return {
      id: text(value.id),
      title: text(value.title),
      evidence: parseJson(value.evidence_json, []),
      risk: text(value.risk) as OptimizationProposal["risk"],
      recommendation: text(value.recommendation),
      validation: parseJson(value.validation_json, []),
      status: text(value.status) as OptimizationProposal["status"],
      createdAt: integer(value.created_at),
      updatedAt: integer(value.updated_at),
    };
  }

  listOptimizationProposals(): OptimizationProposal[] {
    return rows(this.db.prepare("SELECT id FROM optimization_proposals ORDER BY created_at DESC")).map(
      (value) => this.getOptimizationProposal(text(value.id)),
    );
  }

  addOptimizationApplication(
    input: Omit<OptimizationApplication, "id" | "createdAt">,
  ): OptimizationApplication {
    const id = randomUUID();
    const createdAt = Date.now();
    this.db
      .prepare(
        "INSERT INTO optimization_applications(id,proposal_id,workspace,changes_json,backups_json,validation_command,validation_status,validation_output,status,rollback_status,error,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.proposalId,
        input.workspace,
        JSON.stringify(input.changes),
        JSON.stringify(input.backups),
        input.validationCommand,
        input.validationStatus,
        input.validationOutput ?? null,
        input.status,
        input.rollbackStatus,
        input.error ?? null,
        createdAt,
        input.completedAt ?? null,
      );
    return this.getOptimizationApplication(id);
  }

  getOptimizationApplication(id: string): OptimizationApplication {
    const value = row(this.db.prepare("SELECT * FROM optimization_applications WHERE id=?"), id);
    if (!value) throw new Error(`Optimization application not found: ${id}`);
    return {
      id: text(value.id),
      proposalId: text(value.proposal_id),
      workspace: text(value.workspace),
      changes: parseJson(value.changes_json, []),
      backups: parseJson(value.backups_json, []),
      validationCommand: text(value.validation_command),
      validationStatus: text(value.validation_status) as OptimizationApplication["validationStatus"],
      ...(value.validation_output ? { validationOutput: text(value.validation_output) } : {}),
      status: text(value.status) as OptimizationApplication["status"],
      rollbackStatus: text(value.rollback_status) as OptimizationApplication["rollbackStatus"],
      ...(value.error ? { error: text(value.error) } : {}),
      createdAt: integer(value.created_at),
      ...(value.completed_at ? { completedAt: integer(value.completed_at) } : {}),
    };
  }

  updateOptimizationApplication(
    id: string,
    patch: Partial<
      Pick<
        OptimizationApplication,
        "status" | "rollbackStatus" | "validationStatus" | "validationOutput" | "error" | "completedAt"
      >
    >,
  ): OptimizationApplication {
    const current = this.getOptimizationApplication(id);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        "UPDATE optimization_applications SET validation_status=?,validation_output=?,status=?,rollback_status=?,error=?,completed_at=? WHERE id=?",
      )
      .run(
        next.validationStatus,
        next.validationOutput ?? null,
        next.status,
        next.rollbackStatus,
        next.error ?? null,
        next.completedAt ?? null,
        id,
      );
    return this.getOptimizationApplication(id);
  }

  listOptimizationApplications(limit = 100): OptimizationApplication[] {
    return rows(
      this.db.prepare("SELECT id FROM optimization_applications ORDER BY created_at DESC LIMIT ?"),
      Math.max(1, Math.min(500, limit)),
    ).map((value) => this.getOptimizationApplication(text(value.id)));
  }

  updateOptimizationProposal(id: string, status: "accepted" | "rejected"): OptimizationProposal {
    const result = this.db
      .prepare("UPDATE optimization_proposals SET status=?,updated_at=? WHERE id=?")
      .run(status, Date.now(), id);
    if (!result.changes) throw new Error(`Optimization proposal not found: ${id}`);
    return this.getOptimizationProposal(id);
  }

  addAudit(input: {
    runId: string;
    kind: AuditRecord["kind"];
    name: string;
    input?: unknown;
    output?: unknown;
    status: string;
    durationMs?: number;
    usage?: unknown;
    error?: string;
  }): AuditRecord {
    return this.auditEvaluations.addAudit(input);
  }

  startModelCall(input: { runId: string; provider: string; model: string; role: string }): string {
    return this.auditEvaluations.startModelCall(input);
  }

  finishModelCall(
    id: string,
    input: {
      status: "completed" | "failed";
      durationMs?: number;
      usage?: unknown;
      error?: string;
    },
  ): void {
    this.auditEvaluations.finishModelCall(id, input);
  }

  addModelCall(input: {
    runId: string;
    provider: string;
    model: string;
    role: string;
    status: "completed" | "failed";
    durationMs?: number;
    usage?: unknown;
    error?: string;
  }): void {
    const id = this.auditEvaluations.startModelCall(input);
    this.auditEvaluations.finishModelCall(id, input);
  }

  listAudit(runId: string): AuditRecord[] {
    return this.auditEvaluations.listAudit(runId);
  }

  createScheduledTask(input: {
    ownerId?: string;
    name: string;
    prompt: string;
    messageMode: "agent";
    schedule: ScheduleDefinition;
    enabled: boolean;
    nextRunAt?: number;
  }): ScheduledTask {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO scheduled_tasks(id,owner_id,name,prompt,message_mode,schedule_json,enabled,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.ownerId ?? "system",
        input.name,
        input.prompt,
        input.messageMode,
        JSON.stringify(input.schedule),
        input.enabled ? 1 : 0,
        input.nextRunAt ?? null,
        now,
        now,
      );
    return this.getScheduledTask(id);
  }

  getScheduledTask(id: string): ScheduledTask {
    const value = row(this.db.prepare("SELECT * FROM scheduled_tasks WHERE id=?"), id);
    if (!value) throw new Error(`Scheduled task not found: ${id}`);
    return toScheduledTask(value);
  }

  listScheduledTasks(ownerId?: string): ScheduledTask[] {
    return rows(
      ownerId
        ? this.db.prepare("SELECT * FROM scheduled_tasks WHERE owner_id=? ORDER BY created_at DESC")
        : this.db.prepare("SELECT * FROM scheduled_tasks ORDER BY created_at DESC"),
      ...(ownerId ? [ownerId] : []),
    ).map(toScheduledTask);
  }

  scheduledTaskOwner(id: string): string | undefined {
    const value = row(this.db.prepare("SELECT owner_id FROM scheduled_tasks WHERE id=?"), id);
    return value ? text(value.owner_id) : undefined;
  }

  listDueScheduledTasks(now: number): ScheduledTask[] {
    return rows(
      this.db.prepare(
        "SELECT * FROM scheduled_tasks WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at",
      ),
      now,
    ).map(toScheduledTask);
  }

  updateScheduledTask(
    id: string,
    patch: Partial<{
      name: string;
      prompt: string;
      messageMode: "agent";
      schedule: ScheduleDefinition;
      enabled: boolean;
      nextRunAt: number | null;
      lastRunAt: number | null;
    }>,
  ): ScheduledTask {
    const current = this.getScheduledTask(id);
    const next = {
      name: patch.name ?? current.name,
      prompt: patch.prompt ?? current.prompt,
      messageMode: "agent",
      schedule: patch.schedule ?? current.schedule,
      enabled: patch.enabled ?? current.enabled,
      nextRunAt: patch.nextRunAt === undefined ? current.nextRunAt : (patch.nextRunAt ?? undefined),
      lastRunAt: patch.lastRunAt === undefined ? current.lastRunAt : (patch.lastRunAt ?? undefined),
    };
    this.db
      .prepare(
        "UPDATE scheduled_tasks SET name=?,prompt=?,message_mode=?,schedule_json=?,enabled=?,next_run_at=?,last_run_at=?,updated_at=? WHERE id=?",
      )
      .run(
        next.name,
        next.prompt,
        next.messageMode,
        JSON.stringify(next.schedule),
        next.enabled ? 1 : 0,
        next.nextRunAt ?? null,
        next.lastRunAt ?? null,
        Date.now(),
        id,
      );
    return this.getScheduledTask(id);
  }

  deleteScheduledTask(id: string): void {
    const result = this.db.prepare("DELETE FROM scheduled_tasks WHERE id=?").run(id);
    if (result.changes === 0) throw new Error(`Scheduled task not found: ${id}`);
  }

  createScheduledTaskRun(input: {
    scheduledTaskId: string;
    scheduledFor: number;
    occurrenceKey: string;
    trigger: ScheduledTaskRun["trigger"];
  }): ScheduledTaskRun {
    if (this.hasActiveScheduledTaskRun(input.scheduledTaskId))
      throw new Error("Scheduled task already has an active run");
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO scheduled_task_runs(id,scheduled_task_id,occurrence_key,trigger,status,scheduled_for) VALUES(?,?,?,?,?,?)",
      )
      .run(id, input.scheduledTaskId, input.occurrenceKey, input.trigger, "claimed", input.scheduledFor);
    return this.getScheduledTaskRun(id);
  }

  getScheduledTaskRun(id: string): ScheduledTaskRun {
    const value = row(this.db.prepare("SELECT * FROM scheduled_task_runs WHERE id=?"), id);
    if (!value) throw new Error(`Scheduled task run not found: ${id}`);
    return toScheduledTaskRun(value);
  }

  findScheduledTaskRunByRunId(runId: string): ScheduledTaskRun | undefined {
    const value = row(this.db.prepare("SELECT * FROM scheduled_task_runs WHERE run_id=?"), runId);
    return value ? toScheduledTaskRun(value) : undefined;
  }

  listScheduledTaskRuns(scheduledTaskId: string): ScheduledTaskRun[] {
    return rows(
      this.db.prepare(
        "SELECT * FROM scheduled_task_runs WHERE scheduled_task_id=? ORDER BY scheduled_for DESC",
      ),
      scheduledTaskId,
    ).map(toScheduledTaskRun);
  }

  hasActiveScheduledTaskRun(scheduledTaskId: string): boolean {
    return Boolean(
      row(
        this.db.prepare(
          "SELECT 1 AS ok FROM scheduled_task_runs WHERE scheduled_task_id=? AND status IN ('claimed','running','awaiting_resume') LIMIT 1",
        ),
        scheduledTaskId,
      ),
    );
  }

  updateScheduledTaskRun(
    id: string,
    patch: Partial<{
      backgroundTaskId: string;
      runId: string;
      status: ScheduledTaskRun["status"];
      resume: ScheduledTaskRun["resume"] | null;
      startedAt: number;
      completedAt: number;
      error: string | null;
    }>,
  ): ScheduledTaskRun {
    const current = this.getScheduledTaskRun(id);
    this.db
      .prepare(
        "UPDATE scheduled_task_runs SET background_task_id=?,run_id=?,status=?,resume_json=?,started_at=?,completed_at=?,error=? WHERE id=?",
      )
      .run(
        patch.backgroundTaskId ?? current.backgroundTaskId ?? null,
        patch.runId ?? current.runId ?? null,
        patch.status ?? current.status,
        patch.resume === undefined
          ? current.resume
            ? JSON.stringify(current.resume)
            : null
          : patch.resume
            ? JSON.stringify(patch.resume)
            : null,
        patch.startedAt ?? current.startedAt ?? null,
        patch.completedAt ?? current.completedAt ?? null,
        patch.error === undefined ? (current.error ?? null) : patch.error,
        id,
      );
    return this.getScheduledTaskRun(id);
  }

  createEvaluationReport(input: CreateEvaluationReport): EvaluationReport {
    return this.auditEvaluations.createEvaluationReport(input);
  }

  getEvaluationReport(id: string): EvaluationReport {
    return this.auditEvaluations.getEvaluationReport(id);
  }

  listEvaluationReports(limit = 100): EvaluationReport[] {
    return this.auditEvaluations.listEvaluationReports(limit);
  }

  evaluationTrends(from: number, to: number, groupBy: "day" | "suite" | "mode"): EvaluationTrend[] {
    return this.auditEvaluations.evaluationTrends(from, to, groupBy);
  }

  operationsReport(from: number, to: number): OperationsReport {
    return this.auditEvaluations.operationsReport(from, to);
  }

  diagnosticsReport(from: number, to: number): DiagnosticsReport {
    return this.auditEvaluations.diagnosticsReport(from, to);
  }

  insertResourceSnapshot(snapshot: ResourceSnapshot): void {
    this.db
      .prepare(
        "INSERT INTO resource_snapshots(id,captured_at,cpu_user_micros,cpu_system_micros,rss_bytes,heap_used_bytes,heap_total_bytes,external_bytes,array_buffers_bytes,event_loop_delay_ms,wal_bytes,active_runs,queued_runs) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        snapshot.id,
        snapshot.capturedAt,
        snapshot.cpuUserMicros,
        snapshot.cpuSystemMicros,
        snapshot.rssBytes,
        snapshot.heapUsedBytes,
        snapshot.heapTotalBytes,
        snapshot.externalBytes,
        snapshot.arrayBuffersBytes,
        snapshot.eventLoopDelayMs,
        snapshot.walBytes,
        snapshot.activeRuns,
        snapshot.queuedRuns,
      );
  }

  listResourceSnapshots(from = 0, to = Date.now(), limit = 500): ResourceSnapshot[] {
    return rows(
      this.db.prepare(
        "SELECT * FROM resource_snapshots WHERE captured_at BETWEEN ? AND ? ORDER BY captured_at DESC LIMIT ?",
      ),
      from,
      to,
      Math.max(1, Math.min(500, limit)),
    ).map((value) => ({
      id: text(value.id),
      capturedAt: integer(value.captured_at),
      cpuUserMicros: integer(value.cpu_user_micros),
      cpuSystemMicros: integer(value.cpu_system_micros),
      rssBytes: integer(value.rss_bytes),
      heapUsedBytes: integer(value.heap_used_bytes),
      heapTotalBytes: integer(value.heap_total_bytes),
      externalBytes: integer(value.external_bytes),
      arrayBuffersBytes: integer(value.array_buffers_bytes),
      eventLoopDelayMs: Number(value.event_loop_delay_ms ?? 0),
      walBytes: integer(value.wal_bytes),
      activeRuns: integer(value.active_runs),
      queuedRuns: integer(value.queued_runs),
    }));
  }

  recoverScheduledTaskRuns(): ScheduledTaskRun[] {
    this.db
      .prepare(
        "UPDATE background_tasks SET status='pending',error=NULL,updated_at=? WHERE status='interrupted' AND run_id IS NULL AND id IN (SELECT background_task_id FROM scheduled_task_runs WHERE status='running' AND run_id IS NULL)",
      )
      .run(Date.now());
    this.db
      .prepare(
        "UPDATE scheduled_task_runs SET status='claimed',error=NULL WHERE status='running' AND run_id IS NULL",
      )
      .run();
    this.db
      .prepare(
        "UPDATE scheduled_task_runs SET status='awaiting_resume',error='Background run requires explicit resume' WHERE status='running' AND run_id IS NOT NULL",
      )
      .run();
    return rows(
      this.db.prepare(
        "SELECT * FROM scheduled_task_runs WHERE status IN ('claimed','awaiting_resume') ORDER BY scheduled_for",
      ),
    ).map(toScheduledTaskRun);
  }

  markActiveBackgroundTasksInterrupted(): void {
    this.db
      .prepare(
        "UPDATE background_tasks SET status='interrupted',error='Server restarted during execution',updated_at=? WHERE status IN ('pending','running')",
      )
      .run(Date.now());
  }
}
