import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  Approval,
  Attachment,
  AuditRecord,
  BackgroundTask,
  KnowledgeSource,
  MemoryFact,
  MessageSource,
  ModelRef,
  ModelSnapshot,
  OperationsReport,
  PlanStep,
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
  SessionMode,
  SessionSnapshot,
  TranscriptItem,
} from "@uma-agent/protocol";
import { type AgentEventEnvelope, type AgentEventType, PROTOCOL_VERSION } from "@uma-agent/protocol";
import type { ContextSummary, StoredAgentMessage } from "./types.js";

const SCHEMA_VERSION = 7;
type Row = Record<string, unknown>;

function rows(statement: StatementSync, ...params: SQLInputValue[]): Row[] {
  return statement.all(...params) as Row[];
}

function row(statement: StatementSync, ...params: SQLInputValue[]): Row | undefined {
  return statement.get(...params) as Row | undefined;
}

function text(value: unknown): string {
  return String(value ?? "");
}

function integer(value: unknown): number {
  return Number(value ?? 0);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function ftsQuery(value: string): string | undefined {
  const terms =
    value
      .normalize("NFKC")
      .match(/[\p{L}\p{N}_]{3,}/gu)
      ?.slice(0, 12) ?? [];
  if (terms.length === 0) return undefined;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function redactAudit(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
      .replace(/(api[_-]?key|password|secret|token)(\s*[:=]\s*)[^\s,}]+/gi, "$1$2[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redactAudit);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) =>
        /(authorization|cookie|api[_-]?key|password|secret|token)/i.test(key)
          ? [key, "[REDACTED]"]
          : [key, redactAudit(item)],
      ),
    );
  }
  return value;
}

function toSession(value: Row): Session {
  return {
    id: text(value.id),
    mode: text(value.mode) as SessionMode,
    title: text(value.title),
    ...(value.workspace ? { workspace: text(value.workspace) } : {}),
    model: { provider: text(value.model_provider), id: text(value.model_id) },
    thinkingLevel: text(value.thinking_level) as ThinkingLevel,
    createdAt: integer(value.created_at),
    updatedAt: integer(value.updated_at),
  };
}

function toAttachment(value: Row): Attachment {
  return {
    id: text(value.id),
    name: text(value.name),
    mimeType: text(value.mime_type),
    size: integer(value.size),
    createdAt: integer(value.created_at),
  };
}

function toScheduledTask(value: Row): ScheduledTask {
  return {
    id: text(value.id),
    name: text(value.name),
    prompt: text(value.prompt),
    sessionMode: text(value.session_mode) as SessionMode,
    schedule: parseJson(value.schedule_json, { kind: "once", at: 0 }) as ScheduleDefinition,
    enabled: integer(value.enabled) === 1,
    ...(value.next_run_at !== null && value.next_run_at !== undefined
      ? { nextRunAt: integer(value.next_run_at) }
      : {}),
    ...(value.last_run_at !== null && value.last_run_at !== undefined
      ? { lastRunAt: integer(value.last_run_at) }
      : {}),
    createdAt: integer(value.created_at),
    updatedAt: integer(value.updated_at),
  };
}

function toScheduledTaskRun(value: Row): ScheduledTaskRun {
  return {
    id: text(value.id),
    scheduledTaskId: text(value.scheduled_task_id),
    ...(value.background_task_id ? { backgroundTaskId: text(value.background_task_id) } : {}),
    status: text(value.status) as ScheduledTaskRun["status"],
    scheduledFor: integer(value.scheduled_for),
    ...(value.started_at ? { startedAt: integer(value.started_at) } : {}),
    ...(value.completed_at ? { completedAt: integer(value.completed_at) } : {}),
    ...(value.error ? { error: text(value.error) } : {}),
  };
}

function toPlanStep(value: Row): PlanStep {
  return {
    id: text(value.id),
    position: integer(value.position),
    title: text(value.title),
    status: text(value.status) as PlanStep["status"],
    ...(value.started_at ? { startedAt: integer(value.started_at) } : {}),
    ...(value.completed_at ? { completedAt: integer(value.completed_at) } : {}),
    ...(value.error ? { error: text(value.error) } : {}),
  };
}

function toRunAction(value: Row): RunAction {
  return {
    id: text(value.id),
    runId: text(value.run_id),
    ...(value.checkpoint_id ? { checkpointId: text(value.checkpoint_id) } : {}),
    toolCallId: text(value.tool_call_id),
    toolName: text(value.tool_name),
    toolClass: text(value.tool_class),
    idempotencyKey: text(value.idempotency_key),
    ...(value.input_json ? { input: redactAudit(parseJson(value.input_json, null)) } : {}),
    ...(value.result_json ? { result: redactAudit(parseJson(value.result_json, null)) } : {}),
    status: text(value.status) as RunAction["status"],
    ...(value.started_at ? { startedAt: integer(value.started_at) } : {}),
    ...(value.completed_at ? { completedAt: integer(value.completed_at) } : {}),
    ...(value.error ? { error: text(value.error) } : {}),
  };
}

function toRunCheckpoint(value: Row): RunCheckpoint {
  return {
    id: text(value.id),
    runId: text(value.run_id),
    checkpointNo: integer(value.checkpoint_no),
    phase: text(value.phase) as RunCheckpoint["phase"],
    ...(value.plan_step_id ? { planStepId: text(value.plan_step_id) } : {}),
    turnCount: integer(value.turn_count),
    lastMessageSequence: integer(value.last_message_sequence),
    ...(value.context_summary_sequence
      ? { contextSummarySequence: integer(value.context_summary_sequence) }
      : {}),
    safeToResume: integer(value.safe_to_resume) === 1,
    createdAt: integer(value.created_at),
  };
}

export class UmaDatabase {
  readonly db: DatabaseSync;
  private transactionDepth = 0;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new DatabaseSync(join(stateDir, "state.db"));
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const version = integer(row(this.db.prepare("PRAGMA user_version"))?.user_version);
    if (version === 0) {
      this.db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    } else if (version !== SCHEMA_VERSION) {
      this.db.close();
      throw new Error(
        `Unsupported database schema ${version}; expected ${SCHEMA_VERSION}. Reset state explicitly.`,
      );
    }
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
    return rows(this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC")).map(toSession);
  }

  createSession(input: {
    mode: SessionMode;
    title: string;
    workspace?: string;
    model: ModelRef;
    thinkingLevel: ThinkingLevel;
  }): Session {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO sessions(id,mode,title,workspace,model_provider,model_id,thinking_level,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.mode,
        input.title,
        input.workspace ?? null,
        input.model.provider,
        input.model.id,
        input.thinkingLevel,
        now,
        now,
      );
    return this.getSession(id);
  }

  getSession(id: string): Session {
    const result = row(this.db.prepare("SELECT * FROM sessions WHERE id = ?"), id);
    if (!result) throw new Error(`Session not found: ${id}`);
    return toSession(result);
  }

  updateSession(
    id: string,
    patch: { title?: string; mode?: SessionMode; model?: ModelRef; thinkingLevel?: ThinkingLevel },
  ): Session {
    const current = this.getSession(id);
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE sessions SET title=?, mode=?, model_provider=?, model_id=?, thinking_level=?, updated_at=? WHERE id=?",
      )
      .run(
        patch.title ?? current.title,
        patch.mode ?? current.mode,
        patch.model?.provider ?? current.model.provider,
        patch.model?.id ?? current.model.id,
        patch.thinkingLevel ?? current.thinkingLevel,
        now,
        id,
      );
    return this.getSession(id);
  }

  deleteSession(id: string): void {
    const result = this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    if (result.changes === 0) throw new Error(`Session not found: ${id}`);
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
  }): TranscriptItem {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    const sequence = this.allocateMessageSequence(input.sessionId);
    this.db
      .prepare(
        "INSERT INTO messages(id,session_id,run_id,sequence,role,status,name,content,payload_json,source_json,attachment_ids_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
        JSON.stringify(input.attachmentIds ?? []),
        now,
        now,
      );
    return this.getMessage(id);
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
    return this.getMessage(id);
  }

  getMessage(id: string): TranscriptItem {
    const value = row(this.db.prepare("SELECT * FROM messages WHERE id=?"), id);
    if (!value) throw new Error(`Message not found: ${id}`);
    const attachmentIds = parseJson<string[]>(value.attachment_ids_json, []);
    const source = value.source_json
      ? parseJson<MessageSource | undefined>(value.source_json, undefined)
      : undefined;
    return {
      id: text(value.id),
      sequence: integer(value.sequence),
      role: text(value.role) as TranscriptItem["role"],
      status: text(value.status) as TranscriptItem["status"],
      content: text(value.content),
      ...(value.name ? { name: text(value.name) } : {}),
      ...(value.run_id ? { runId: text(value.run_id) } : {}),
      attachments: attachmentIds
        .map((attachmentId) => this.getAttachment(attachmentId))
        .filter((item): item is Attachment => item !== undefined),
      ...(source ? { source } : {}),
      createdAt: integer(value.created_at),
      updatedAt: integer(value.updated_at),
    };
  }

  findMessageOwner(id: string): { sessionId: string; runId?: string } | undefined {
    const value = row(this.db.prepare("SELECT session_id,run_id FROM messages WHERE id=?"), id);
    if (!value) return undefined;
    return {
      sessionId: text(value.session_id),
      ...(value.run_id ? { runId: text(value.run_id) } : {}),
    };
  }

  listMessages(sessionId: string): TranscriptItem[] {
    return rows(
      this.db.prepare("SELECT id FROM messages WHERE session_id=? ORDER BY sequence"),
      sessionId,
    ).map((value) => this.getMessage(text(value.id)));
  }

  listHistory(sessionId: string, beforeSequence?: number, limit = 100): SessionHistoryPage {
    this.getSession(sessionId);
    const bounded = Math.max(1, Math.min(500, limit));
    const values = rows(
      beforeSequence === undefined
        ? this.db.prepare(
            "SELECT id,sequence FROM messages WHERE session_id=? ORDER BY sequence DESC LIMIT ?",
          )
        : this.db.prepare(
            "SELECT id,sequence FROM messages WHERE session_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?",
          ),
      ...(beforeSequence === undefined ? [sessionId, bounded + 1] : [sessionId, beforeSequence, bounded + 1]),
    );
    const hasMore = values.length > bounded;
    const page = values.slice(0, bounded).reverse();
    return {
      sessionId,
      items: page.map((value) => this.getMessage(text(value.id))),
      oldestSequence: page.length ? integer(page[0]?.sequence) : 0,
      hasMore,
    };
  }

  listAgentMessages(sessionId: string, beforeSequence?: number): StoredAgentMessage[] {
    const statement =
      beforeSequence === undefined
        ? this.db.prepare(
            "SELECT id,sequence,payload_json FROM messages WHERE session_id=? AND payload_json IS NOT NULL AND status='complete' ORDER BY sequence",
          )
        : this.db.prepare(
            "SELECT id,sequence,payload_json FROM messages WHERE session_id=? AND sequence<? AND payload_json IS NOT NULL AND status='complete' ORDER BY sequence",
          );
    return rows(
      statement,
      ...(beforeSequence === undefined ? [sessionId] : [sessionId, beforeSequence]),
    ).flatMap((value) => {
      const message = parseJson<AgentMessage | null>(value.payload_json, null);
      return message ? [{ id: text(value.id), sequence: integer(value.sequence), message }] : [];
    });
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
        "INSERT INTO context_summaries(session_id,through_sequence,content,updated_at) VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET through_sequence=excluded.through_sequence,content=excluded.content,updated_at=excluded.updated_at",
      )
      .run(sessionId, throughSequence, content, Date.now());
    return this.getContextSummary(sessionId) as ContextSummary;
  }

  createRun(
    sessionId: string,
    messageId: string,
    model: ModelSnapshot,
    thinkingLevel: Run["thinkingLevel"],
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
        "INSERT INTO runs(id,session_id,message_id,status,phase,model_snapshot_json,thinking_level,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(id, sessionId, messageId, "queued", "queued", JSON.stringify(model), thinkingLevel, now, now);
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
        "UPDATE runs SET status=?,phase=?,task_class=?,goal=?,success_criteria_json=?,turn_count=?,correction_count=?,route=?,reasoning_summary=?,error=?,clarification_count=?,updated_at=? WHERE id=?",
      )
      .run(
        patch.status ?? current.status,
        patch.phase ?? current.phase,
        patch.taskClass ?? current.taskClass ?? null,
        patch.goal ?? current.goal ?? null,
        JSON.stringify(patch.successCriteria ?? current.successCriteria),
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
      status: text(value.status) as RunStatus,
      phase: text(value.phase) as Run["phase"],
      ...(value.task_class ? { taskClass: text(value.task_class) as NonNullable<Run["taskClass"]> } : {}),
      ...(value.goal ? { goal: text(value.goal) } : {}),
      successCriteria: parseJson<string[]>(value.success_criteria_json, []),
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

  listPendingApprovals(sessionId: string): Approval[] {
    return rows(
      this.db.prepare("SELECT id FROM approvals WHERE session_id=? AND status='pending' ORDER BY created_at"),
      sessionId,
    ).map((value) => this.getApproval(text(value.id)));
  }

  getSnapshot(sessionId: string): SessionSnapshot {
    const sessionState = row(
      this.db.prepare("SELECT next_event_sequence FROM sessions WHERE id=?"),
      sessionId,
    );
    this.getSession(sessionId);
    const tail = rows(
      this.db.prepare("SELECT id,sequence FROM messages WHERE session_id=? ORDER BY sequence DESC LIMIT 101"),
      sessionId,
    );
    const hasMoreBefore = tail.length > 100;
    const visible = tail.slice(0, 100).reverse();
    return {
      session: this.getSession(sessionId),
      transcript: visible.map((value) => this.getMessage(text(value.id))),
      recentRuns: this.listRecentRuns(sessionId),
      pendingApprovals: this.listPendingApprovals(sessionId),
      snapshotSequence: Math.max(0, integer(sessionState?.next_event_sequence) - 1),
      history: {
        oldestMessageSequence: visible.length ? integer(visible[0]?.sequence) : 0,
        hasMoreBefore,
      },
    };
  }

  appendEvent(
    sessionId: string,
    runId: string | undefined,
    type: AgentEventType,
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
        type: text(value.type) as AgentEventType,
        payload: parseJson(value.payload_json, null),
      }),
    );
    const snapshotSequence = this.getSnapshot(sessionId).snapshotSequence;
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
    name: string;
    mimeType: string;
    size: number;
    storagePath: string;
  }): Attachment {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO attachments(id,session_id,name,mime_type,size,storage_path,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(id, input.sessionId ?? null, input.name, input.mimeType, input.size, input.storagePath, now);
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
    const value = row(this.db.prepare("SELECT session_id FROM attachments WHERE id=?"), id);
    if (!value) throw new Error(`Attachment not found: ${id}`);
    if (!value.session_id || text(value.session_id) !== sessionId)
      throw new Error(`Attachment belongs to another session: ${id}`);
  }

  searchMemory(sessionId: string, query: string, limit = 5): string[] {
    const match = ftsQuery(query);
    if (!match) return [];
    return rows(
      this.db.prepare(
        "SELECT m.content FROM memory_fts f JOIN memory_facts m ON m.id=f.id WHERE memory_fts MATCH ? AND m.status='active' AND (m.scope='global' OR m.session_id=?) ORDER BY bm25(memory_fts) LIMIT ?",
      ),
      match,
      sessionId,
      limit,
    ).map((value) => text(value.content));
  }

  replaceKnowledgeSource(input: {
    name: string;
    path: string;
    chunks: Array<{ filePath: string; content: string }>;
  }): KnowledgeSource {
    const existing = row(this.db.prepare("SELECT id FROM knowledge_sources WHERE path=?"), input.path);
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
          "INSERT INTO knowledge_sources(id,name,path,document_count,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
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
    input.chunks.forEach((chunk, position) => {
      const chunkId = randomUUID();
      insertChunk.run(chunkId, id, chunk.filePath, position, chunk.content);
      insertFts.run(chunkId, id, chunk.filePath, chunk.content);
    });
    return this.getKnowledgeSource(id);
  }

  createKnowledgeSource(input: { name: string; path: string }): KnowledgeSource {
    const existing = row(this.db.prepare("SELECT id FROM knowledge_sources WHERE path=?"), input.path);
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
          "INSERT INTO knowledge_sources(id,name,path,document_count,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(id, input.name, input.path, 0, "queued", now, now);
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

  listKnowledgeSources(): KnowledgeSource[] {
    return rows(this.db.prepare("SELECT id FROM knowledge_sources ORDER BY created_at DESC")).map((value) =>
      this.getKnowledgeSource(text(value.id)),
    );
  }

  searchKnowledge(query: string, limit = 5): Array<{ filePath: string; content: string }> {
    const match = ftsQuery(query);
    if (!match) return [];
    return rows(
      this.db.prepare(
        "SELECT file_path,content FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY bm25(knowledge_fts) LIMIT ?",
      ),
      match,
      limit,
    ).map((value) => ({ filePath: text(value.file_path), content: text(value.content) }));
  }

  putWebSession(hash: string, expiresAt: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO web_sessions(id_hash,expires_at,created_at) VALUES(?,?,?)")
      .run(hash, expiresAt, Date.now());
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
    prompt: string;
  }): BackgroundTask {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO background_tasks(id,parent_session_id,session_id,prompt,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(input.id, input.parentSessionId ?? null, input.sessionId, input.prompt, "pending", now, now);
    return this.getBackgroundTask(input.id);
  }

  getBackgroundTask(id: string): BackgroundTask {
    const value = row(this.db.prepare("SELECT * FROM background_tasks WHERE id=?"), id);
    if (!value) throw new Error(`Background task not found: ${id}`);
    return {
      id: text(value.id),
      ...(value.parent_session_id ? { parentSessionId: text(value.parent_session_id) } : {}),
      sessionId: text(value.session_id),
      prompt: text(value.prompt),
      status: text(value.status) as BackgroundTask["status"],
      ...(value.result ? { result: text(value.result) } : {}),
      ...(value.error ? { error: text(value.error) } : {}),
      createdAt: integer(value.created_at),
      updatedAt: integer(value.updated_at),
    };
  }

  listBackgroundTasks(): BackgroundTask[] {
    return rows(this.db.prepare("SELECT id FROM background_tasks ORDER BY updated_at DESC")).map((value) =>
      this.getBackgroundTask(text(value.id)),
    );
  }

  updateBackgroundTask(
    id: string,
    patch: { status?: BackgroundTask["status"]; result?: string; error?: string },
  ): BackgroundTask {
    const current = this.getBackgroundTask(id);
    this.db
      .prepare("UPDATE background_tasks SET status=?,result=?,error=?,updated_at=? WHERE id=?")
      .run(
        patch.status ?? current.status,
        patch.result ?? current.result ?? null,
        patch.error ?? current.error ?? null,
        Date.now(),
        id,
      );
    return this.getBackgroundTask(id);
  }

  addMemoryFact(input: {
    sessionId?: string;
    scope: MemoryFact["scope"];
    content: string;
    confidence: number;
    sourceRunId?: string;
    status: MemoryFact["status"];
  }): MemoryFact {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO memory_facts(id,session_id,scope,content,confidence,source_run_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.sessionId ?? null,
        input.scope,
        input.content,
        input.confidence,
        input.sourceRunId ?? null,
        input.status,
        now,
        now,
      );
    this.db.prepare("INSERT INTO memory_fts(id,content) VALUES(?,?)").run(id, input.content);
    return this.getMemoryFact(id);
  }

  getMemoryFact(id: string): MemoryFact {
    const value = row(this.db.prepare("SELECT * FROM memory_facts WHERE id=?"), id);
    if (!value) throw new Error(`Memory fact not found: ${id}`);
    return {
      id: text(value.id),
      ...(value.session_id ? { sessionId: text(value.session_id) } : {}),
      scope: text(value.scope) as MemoryFact["scope"],
      content: text(value.content),
      confidence: Number(value.confidence),
      ...(value.source_run_id ? { sourceRunId: text(value.source_run_id) } : {}),
      status: text(value.status) as MemoryFact["status"],
      createdAt: integer(value.created_at),
      updatedAt: integer(value.updated_at),
    };
  }

  listMemoryFacts(status?: MemoryFact["status"]): MemoryFact[] {
    const values = status
      ? rows(this.db.prepare("SELECT id FROM memory_facts WHERE status=? ORDER BY updated_at DESC"), status)
      : rows(this.db.prepare("SELECT id FROM memory_facts ORDER BY updated_at DESC"));
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
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO audit_events(id,run_id,kind,name,input_json,output_json,status,duration_ms,usage_json,error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.runId,
        input.kind,
        input.name,
        input.input === undefined ? null : JSON.stringify(redactAudit(input.input)),
        input.output === undefined ? null : JSON.stringify(redactAudit(input.output)),
        input.status,
        input.durationMs ?? null,
        input.usage === undefined ? null : JSON.stringify(input.usage),
        input.error ?? null,
        Date.now(),
      );
    return this.getAudit(id);
  }

  startModelCall(input: { runId: string; provider: string; model: string; role: string }): string {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO model_calls(id,run_id,provider,model,role,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(id, input.runId, input.provider, input.model, input.role, "started", now, now);
    return id;
  }

  finishModelCall(
    id: string,
    input: {
      status: string;
      durationMs?: number;
      usage?: unknown;
      error?: string;
    },
  ): void {
    const result = this.db
      .prepare(
        "UPDATE model_calls SET status=?,duration_ms=?,usage_json=?,error=?,updated_at=? WHERE id=? AND status='started'",
      )
      .run(
        input.status,
        input.durationMs ?? null,
        input.usage === undefined ? null : JSON.stringify(redactAudit(input.usage)),
        input.error ?? null,
        Date.now(),
        id,
      );
    if (result.changes === 0) throw new Error(`Model call is not active: ${id}`);
  }

  addModelCall(input: {
    runId: string;
    provider: string;
    model: string;
    role: string;
    status: string;
    durationMs?: number;
    usage?: unknown;
    error?: string;
  }): void {
    const id = this.startModelCall(input);
    this.finishModelCall(id, input);
  }

  listAudit(runId: string): AuditRecord[] {
    return rows(this.db.prepare("SELECT * FROM audit_events WHERE run_id=? ORDER BY created_at"), runId).map(
      (value) => ({
        id: text(value.id),
        runId: text(value.run_id),
        kind: text(value.kind) as AuditRecord["kind"],
        name: text(value.name),
        ...(value.input_json ? { input: parseJson(value.input_json, null) } : {}),
        ...(value.output_json ? { output: parseJson(value.output_json, null) } : {}),
        status: text(value.status),
        ...(value.duration_ms !== null && value.duration_ms !== undefined
          ? { durationMs: integer(value.duration_ms) }
          : {}),
        ...(value.usage_json ? { usage: parseJson(value.usage_json, null) } : {}),
        ...(value.error ? { error: text(value.error) } : {}),
        createdAt: integer(value.created_at),
      }),
    );
  }

  private getAudit(id: string): AuditRecord {
    const value = row(this.db.prepare("SELECT * FROM audit_events WHERE id=?"), id);
    if (!value) throw new Error(`Audit record not found: ${id}`);
    return {
      id: text(value.id),
      runId: text(value.run_id),
      kind: text(value.kind) as AuditRecord["kind"],
      name: text(value.name),
      ...(value.input_json ? { input: parseJson(value.input_json, null) } : {}),
      ...(value.output_json ? { output: parseJson(value.output_json, null) } : {}),
      status: text(value.status),
      ...(value.duration_ms !== null && value.duration_ms !== undefined
        ? { durationMs: integer(value.duration_ms) }
        : {}),
      ...(value.usage_json ? { usage: parseJson(value.usage_json, null) } : {}),
      ...(value.error ? { error: text(value.error) } : {}),
      createdAt: integer(value.created_at),
    };
  }

  createScheduledTask(input: {
    name: string;
    prompt: string;
    sessionMode: SessionMode;
    schedule: ScheduleDefinition;
    enabled: boolean;
    nextRunAt?: number;
  }): ScheduledTask {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO scheduled_tasks(id,name,prompt,session_mode,schedule_json,enabled,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.name,
        input.prompt,
        input.sessionMode,
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

  listScheduledTasks(): ScheduledTask[] {
    return rows(this.db.prepare("SELECT * FROM scheduled_tasks ORDER BY created_at DESC")).map(
      toScheduledTask,
    );
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
      sessionMode: SessionMode;
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
      sessionMode: patch.sessionMode ?? current.sessionMode,
      schedule: patch.schedule ?? current.schedule,
      enabled: patch.enabled ?? current.enabled,
      nextRunAt: patch.nextRunAt === undefined ? current.nextRunAt : (patch.nextRunAt ?? undefined),
      lastRunAt: patch.lastRunAt === undefined ? current.lastRunAt : (patch.lastRunAt ?? undefined),
    };
    this.db
      .prepare(
        "UPDATE scheduled_tasks SET name=?,prompt=?,session_mode=?,schedule_json=?,enabled=?,next_run_at=?,last_run_at=?,updated_at=? WHERE id=?",
      )
      .run(
        next.name,
        next.prompt,
        next.sessionMode,
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

  createScheduledTaskRun(scheduledTaskId: string, scheduledFor: number): ScheduledTaskRun {
    if (this.hasActiveScheduledTaskRun(scheduledTaskId))
      throw new Error("Scheduled task already has an active run");
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO scheduled_task_runs(id,scheduled_task_id,status,scheduled_for) VALUES(?,?,?,?)")
      .run(id, scheduledTaskId, "pending", scheduledFor);
    return this.getScheduledTaskRun(id);
  }

  getScheduledTaskRun(id: string): ScheduledTaskRun {
    const value = row(this.db.prepare("SELECT * FROM scheduled_task_runs WHERE id=?"), id);
    if (!value) throw new Error(`Scheduled task run not found: ${id}`);
    return toScheduledTaskRun(value);
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
          "SELECT 1 AS ok FROM scheduled_task_runs WHERE scheduled_task_id=? AND status IN ('pending','running') LIMIT 1",
        ),
        scheduledTaskId,
      ),
    );
  }

  updateScheduledTaskRun(
    id: string,
    patch: Partial<{
      backgroundTaskId: string;
      status: ScheduledTaskRun["status"];
      startedAt: number;
      completedAt: number;
      error: string | null;
    }>,
  ): ScheduledTaskRun {
    const current = this.getScheduledTaskRun(id);
    this.db
      .prepare(
        "UPDATE scheduled_task_runs SET background_task_id=?,status=?,started_at=?,completed_at=?,error=? WHERE id=?",
      )
      .run(
        patch.backgroundTaskId ?? current.backgroundTaskId ?? null,
        patch.status ?? current.status,
        patch.startedAt ?? current.startedAt ?? null,
        patch.completedAt ?? current.completedAt ?? null,
        patch.error === undefined ? (current.error ?? null) : patch.error,
        id,
      );
    return this.getScheduledTaskRun(id);
  }

  operationsReport(from: number, to: number): OperationsReport {
    const runRows = rows(
      this.db.prepare(
        "SELECT status,COUNT(*) AS count FROM runs WHERE created_at BETWEEN ? AND ? GROUP BY status",
      ),
      from,
      to,
    );
    const runCount = (status: string) =>
      integer(runRows.find((value) => text(value.status) === status)?.count);
    const modelRows = rows(
      this.db.prepare(
        "SELECT status,duration_ms,usage_json FROM model_calls WHERE created_at BETWEEN ? AND ?",
      ),
      from,
      to,
    );
    const durations = modelRows.map((value) => integer(value.duration_ms)).filter((value) => value > 0);
    const totalTokens = modelRows.reduce((sum, value) => {
      const usage = parseJson<Record<string, unknown>>(value.usage_json, {});
      return sum + integer(usage.totalTokens ?? usage.total);
    }, 0);
    const tools = row(
      this.db.prepare(
        "SELECT COUNT(*) AS calls,SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS failed FROM audit_events WHERE kind='tool' AND created_at BETWEEN ? AND ?",
      ),
      from,
      to,
    );
    const approvals = row(
      this.db.prepare(
        "SELECT COUNT(*) AS requested,SUM(CASE WHEN status IN ('denied','expired') THEN 1 ELSE 0 END) AS denied FROM approvals WHERE created_at BETWEEN ? AND ?",
      ),
      from,
      to,
    );
    return {
      from,
      to,
      runs: {
        total: runRows.reduce((sum, value) => sum + integer(value.count), 0),
        completed: runCount("completed"),
        failed: runCount("failed"),
        cancelled: runCount("cancelled"),
        interrupted: runCount("interrupted"),
      },
      model: {
        calls: modelRows.length,
        failed: modelRows.filter((value) => ["error", "failed", "abandoned"].includes(text(value.status)))
          .length,
        totalTokens,
        averageDurationMs: durations.length
          ? durations.reduce((sum, value) => sum + value, 0) / durations.length
          : 0,
      },
      tools: { calls: integer(tools?.calls), failed: integer(tools?.failed) },
      approvals: { requested: integer(approvals?.requested), denied: integer(approvals?.denied) },
      recoveries: integer(
        row(
          this.db.prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE kind='run' AND name='resume' AND created_at BETWEEN ? AND ?",
          ),
          from,
          to,
        )?.count,
      ),
    };
  }

  markActiveScheduledTaskRunsInterrupted(): void {
    this.db
      .prepare(
        "UPDATE scheduled_task_runs SET status='interrupted',error='Server restarted during execution',completed_at=? WHERE status IN ('pending','running')",
      )
      .run(Date.now());
  }

  markActiveBackgroundTasksInterrupted(): void {
    this.db
      .prepare(
        "UPDATE background_tasks SET status='interrupted',error='Server restarted during execution',updated_at=? WHERE status IN ('pending','running')",
      )
      .run(Date.now());
  }
}
