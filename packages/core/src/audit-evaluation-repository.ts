import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type {
  AuditRecord,
  CreateEvaluationReport,
  DiagnosticsReport,
  EvaluationReport,
  OperationsReport,
} from "@uma-agent/protocol";

type Row = Record<string, unknown>;

const rows = (statement: StatementSync, ...params: SQLInputValue[]) => statement.all(...params) as Row[];
const row = (statement: StatementSync, ...params: SQLInputValue[]) =>
  statement.get(...params) as Row | undefined;
const text = (value: unknown) => String(value ?? "");
const integer = (value: unknown) => Number(value ?? 0);
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

/** Owns immutable audit/evaluation persistence while UmaDatabase retains the connection and transaction boundary. */
export class AuditEvaluationRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(operation: () => T) => T,
  ) {}

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
      status: "completed" | "failed";
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

  listAudit(runId: string): AuditRecord[] {
    return rows(this.db.prepare("SELECT * FROM audit_events WHERE run_id=? ORDER BY created_at"), runId).map(
      (value) => this.toAudit(value),
    );
  }

  private getAudit(id: string): AuditRecord {
    const value = row(this.db.prepare("SELECT * FROM audit_events WHERE id=?"), id);
    if (!value) throw new Error(`Audit record not found: ${id}`);
    return this.toAudit(value);
  }

  private toAudit(value: Row): AuditRecord {
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

  createEvaluationReport(input: CreateEvaluationReport): EvaluationReport {
    const id = randomUUID();
    const createdAt = Date.now();
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO evaluation_reports(id,mode,suite_version,status,total,passed,failed,skipped,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          input.mode,
          input.suiteVersion,
          input.status,
          input.totals.total,
          input.totals.passed,
          input.totals.failed,
          input.totals.skipped,
          input.durationMs,
          createdAt,
        );
      const insert = this.db.prepare(
        "INSERT INTO evaluation_cases(id,report_id,position,name,category,passed,duration_ms,run_id,status,error) VALUES(?,?,?,?,?,?,?,?,?,?)",
      );
      input.cases.forEach((item, position) => {
        insert.run(
          randomUUID(),
          id,
          position,
          item.name,
          item.category,
          item.passed ? 1 : 0,
          item.durationMs,
          item.runId ?? null,
          item.status ?? null,
          item.error ?? null,
        );
      });
    });
    return this.getEvaluationReport(id);
  }

  getEvaluationReport(id: string): EvaluationReport {
    const value = row(this.db.prepare("SELECT * FROM evaluation_reports WHERE id=?"), id);
    if (!value) throw new Error(`Evaluation report not found: ${id}`);
    const cases = rows(
      this.db.prepare("SELECT * FROM evaluation_cases WHERE report_id=? ORDER BY position"),
      id,
    ).map((item) => ({
      name: text(item.name),
      category: text(item.category) as EvaluationReport["cases"][number]["category"],
      passed: Boolean(item.passed),
      durationMs: integer(item.duration_ms),
      ...(item.run_id ? { runId: text(item.run_id) } : {}),
      ...(item.status
        ? { status: text(item.status) as NonNullable<EvaluationReport["cases"][number]["status"]> }
        : {}),
      ...(item.error ? { error: text(item.error) } : {}),
    }));
    return {
      id,
      mode: text(value.mode) as EvaluationReport["mode"],
      suiteVersion: text(value.suite_version),
      status: text(value.status) as EvaluationReport["status"],
      totals: {
        total: integer(value.total),
        passed: integer(value.passed),
        failed: integer(value.failed),
        skipped: integer(value.skipped),
      },
      durationMs: integer(value.duration_ms),
      cases,
      createdAt: integer(value.created_at),
    };
  }

  listEvaluationReports(limit = 100): EvaluationReport[] {
    return rows(
      this.db.prepare("SELECT id FROM evaluation_reports ORDER BY created_at DESC LIMIT ?"),
      Math.max(1, Math.min(500, limit)),
    ).map((value) => this.getEvaluationReport(text(value.id)));
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
        failed: modelRows.filter((value) => ["failed", "abandoned"].includes(text(value.status))).length,
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

  diagnosticsReport(from: number, to: number): DiagnosticsReport {
    const summary = this.operationsReport(from, to);
    const slowModels = rows(
      this.db.prepare(
        "SELECT provider,model,COUNT(*) AS calls,AVG(COALESCE(duration_ms,0)) AS average_duration FROM model_calls WHERE created_at BETWEEN ? AND ? GROUP BY provider,model ORDER BY average_duration DESC LIMIT 20",
      ),
      from,
      to,
    ).map((value) => ({
      provider: text(value.provider),
      model: text(value.model),
      calls: integer(value.calls),
      averageDurationMs: Number(value.average_duration ?? 0),
    }));
    const toolFailures = rows(
      this.db.prepare(
        "SELECT name,COUNT(*) AS failures,MAX(error) AS latest_error FROM audit_events WHERE kind='tool' AND status IN ('error','failed') AND created_at BETWEEN ? AND ? GROUP BY name ORDER BY failures DESC LIMIT 20",
      ),
      from,
      to,
    ).map((value) => ({
      tool: text(value.name),
      failures: integer(value.failures),
      ...(value.latest_error ? { latestError: text(value.latest_error) } : {}),
    }));
    const approvalBottlenecks = rows(
      this.db.prepare(
        "SELECT tool_name,COUNT(*) AS requested,SUM(CASE WHEN status IN ('denied','expired') THEN 1 ELSE 0 END) AS denied FROM approvals WHERE created_at BETWEEN ? AND ? GROUP BY tool_name ORDER BY requested DESC LIMIT 20",
      ),
      from,
      to,
    ).map((value) => ({
      tool: text(value.tool_name),
      requested: integer(value.requested),
      denied: integer(value.denied),
    }));
    return {
      from,
      to,
      summary,
      slowModels,
      toolFailures,
      recoveryFrequency: summary.runs.total ? summary.recoveries / summary.runs.total : 0,
      approvalBottlenecks,
    };
  }
}
