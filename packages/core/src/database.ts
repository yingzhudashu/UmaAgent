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
  ModelRef,
  PlanStep,
  Run,
  RunStatus,
  Session,
  SessionMode,
  SessionSnapshot,
  TranscriptItem,
} from "@uma-agent/protocol";
import type { ContextSummary, StoredAgentMessage } from "./types.js";

const SCHEMA_VERSION = 3;
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

export class UmaDatabase {
  readonly db: DatabaseSync;

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
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE runs SET status = 'interrupted', error = 'Server restarted during execution', updated_at = ? WHERE status IN ('queued','preflight','running','verifying')",
      )
      .run(now);
    this.db
      .prepare("UPDATE messages SET status = 'cancelled', updated_at = ? WHERE status = 'streaming'")
      .run(now);
    this.markActiveBackgroundTasksInterrupted();
  }

  close(): void {
    this.db.close();
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
        "UPDATE sessions SET title=?, mode=?, model_provider=?, model_id=?, thinking_level=?, revision=revision+1, updated_at=? WHERE id=?",
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
        "UPDATE sessions SET next_sequence=next_sequence+1, revision=revision+1, updated_at=? WHERE id=? RETURNING next_sequence-1 AS sequence",
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
  }): TranscriptItem {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    const sequence = this.allocateMessageSequence(input.sessionId);
    this.db
      .prepare(
        "INSERT INTO messages(id,session_id,run_id,sequence,role,status,name,content,payload_json,attachment_ids_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
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
      createdAt: integer(value.created_at),
      updatedAt: integer(value.updated_at),
    };
  }

  listMessages(sessionId: string): TranscriptItem[] {
    return rows(
      this.db.prepare("SELECT id FROM messages WHERE session_id=? ORDER BY sequence"),
      sessionId,
    ).map((value) => this.getMessage(text(value.id)));
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

  createRun(sessionId: string, messageId: string): { run: Run; created: boolean } {
    const existing = row(this.db.prepare("SELECT id,session_id FROM runs WHERE message_id=?"), messageId);
    if (existing) {
      if (text(existing.session_id) !== sessionId)
        throw new Error("messageId is already used by another session");
      return { run: this.getRun(text(existing.id)), created: false };
    }
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare("INSERT INTO runs(id,session_id,message_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(id, sessionId, messageId, "queued", now, now);
    return { run: this.getRun(id), created: true };
  }

  updateRun(
    id: string,
    patch: {
      status?: RunStatus;
      route?: Run["route"];
      reasoningSummary?: string;
      error?: string;
      clarificationCount?: number;
    },
  ): Run {
    const current = this.getRun(id);
    this.db
      .prepare(
        "UPDATE runs SET status=?, route=?, reasoning_summary=?, error=?, clarification_count=?, updated_at=? WHERE id=?",
      )
      .run(
        patch.status ?? current.status,
        patch.route ?? current.route ?? null,
        patch.reasoningSummary ?? current.reasoningSummary ?? null,
        patch.error ?? current.error ?? null,
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
    return {
      id: text(value.id),
      sessionId: text(value.session_id),
      messageId: text(value.message_id),
      status: text(value.status) as RunStatus,
      ...(value.route ? { route: text(value.route) as Exclude<Run["route"], undefined> } : {}),
      ...(value.reasoning_summary ? { reasoningSummary: text(value.reasoning_summary) } : {}),
      clarificationCount: integer(value.clarification_count),
      plan: this.listPlan(id),
      ...(value.error ? { error: text(value.error) } : {}),
      createdAt: integer(value.created_at),
      updatedAt: integer(value.updated_at),
    };
  }

  listRuns(sessionId: string): Run[] {
    return rows(this.db.prepare("SELECT id FROM runs WHERE session_id=? ORDER BY created_at"), sessionId).map(
      (value) => this.getRun(text(value.id)),
    );
  }

  getSnapshot(sessionId: string): SessionSnapshot {
    const revision = integer(
      row(this.db.prepare("SELECT revision FROM sessions WHERE id=?"), sessionId)?.revision,
    );
    return {
      session: this.getSession(sessionId),
      transcript: this.listMessages(sessionId),
      runs: this.listRuns(sessionId),
      revision,
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
    if (result.changes === 0) throw new Error("Approval is not pending");
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

  getAttachmentPath(id: string): string {
    const value = row(this.db.prepare("SELECT storage_path FROM attachments WHERE id=?"), id);
    if (!value) throw new Error(`Attachment not found: ${id}`);
    return text(value.storage_path);
  }

  validateAttachmentForSession(id: string, sessionId: string): void {
    const value = row(this.db.prepare("SELECT session_id FROM attachments WHERE id=?"), id);
    if (!value) throw new Error(`Attachment not found: ${id}`);
    if (value.session_id && text(value.session_id) !== sessionId)
      throw new Error(`Attachment belongs to another session: ${id}`);
  }

  addMemory(sessionId: string | undefined, scope: "session" | "global", content: string): string {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO memory_items(id,session_id,scope,content,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, sessionId ?? null, scope, content, now, now);
    this.db.prepare("INSERT INTO memory_fts(id,content) VALUES(?,?)").run(id, content);
    return id;
  }

  searchMemory(sessionId: string, query: string, limit = 5): string[] {
    return rows(
      this.db.prepare(
        "SELECT m.content FROM memory_fts f JOIN memory_items m ON m.id=f.id WHERE memory_fts MATCH ? AND (m.scope='global' OR m.session_id=?) ORDER BY bm25(memory_fts) LIMIT ?",
      ),
      query,
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
        .prepare("UPDATE knowledge_sources SET name=?, document_count=? WHERE id=?")
        .run(input.name, new Set(input.chunks.map((chunk) => chunk.filePath)).size, id);
    } else {
      this.db
        .prepare("INSERT INTO knowledge_sources(id,name,path,document_count,created_at) VALUES(?,?,?,?,?)")
        .run(id, input.name, input.path, new Set(input.chunks.map((chunk) => chunk.filePath)).size, now);
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

  getKnowledgeSource(id: string): KnowledgeSource {
    const value = row(this.db.prepare("SELECT * FROM knowledge_sources WHERE id=?"), id);
    if (!value) throw new Error(`Knowledge source not found: ${id}`);
    return {
      id: text(value.id),
      name: text(value.name),
      path: text(value.path),
      documentCount: integer(value.document_count),
      createdAt: integer(value.created_at),
    };
  }

  listKnowledgeSources(): KnowledgeSource[] {
    return rows(this.db.prepare("SELECT id FROM knowledge_sources ORDER BY created_at DESC")).map((value) =>
      this.getKnowledgeSource(text(value.id)),
    );
  }

  searchKnowledge(query: string, limit = 5): Array<{ filePath: string; content: string }> {
    return rows(
      this.db.prepare(
        "SELECT file_path,content FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY bm25(knowledge_fts) LIMIT ?",
      ),
      query,
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
    return this.getMemoryFact(id);
  }

  getMemoryFact(id: string): MemoryFact {
    const value = row(this.db.prepare("SELECT * FROM memory_facts WHERE id=?"), id);
    if (!value) throw new Error(`Memory fact not found: ${id}`);
    return {
      id: text(value.id),
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
    const result = this.db.prepare("DELETE FROM memory_facts WHERE id=?").run(id);
    if (result.changes === 0) throw new Error(`Memory fact not found: ${id}`);
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
    this.db
      .prepare(
        "INSERT INTO model_calls(id,run_id,provider,model,role,status,duration_ms,usage_json,error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        input.runId,
        input.provider,
        input.model,
        input.role,
        input.status,
        input.durationMs ?? null,
        input.usage === undefined ? null : JSON.stringify(redactAudit(input.usage)),
        input.error ?? null,
        Date.now(),
      );
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

  markActiveBackgroundTasksInterrupted(): void {
    this.db
      .prepare(
        "UPDATE background_tasks SET status='interrupted',error='Server restarted during execution',updated_at=? WHERE status IN ('pending','running')",
      )
      .run(Date.now());
  }
}
