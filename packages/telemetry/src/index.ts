import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  SpanAttributes,
  SpanOptions,
  SpanStatus,
  TelemetryContext,
  TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { context, trace as otelTrace, type Span, TraceFlags, type Tracer } from "@opentelemetry/api";

export type TelemetryStatus = "active" | "ok" | "error" | "cancelled";
export type TraceParent = {
  traceId: string;
  spanId: string;
  traceFlags: number;
};
export type TelemetryEvent = {
  name: string;
  occurredAt: number;
  attributes: Record<string, string | number | boolean>;
};
export type TelemetrySpanRecord = {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  service: string;
  runId?: string;
  sessionId?: string;
  name: string;
  kind: string;
  status: TelemetryStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  attributes: Record<string, string | number | boolean>;
  errorType?: string;
  errorMessage?: string;
  events: TelemetryEvent[];
};
export type TelemetrySpanQuery = {
  runId?: string;
  traceId?: string;
  from?: number;
  to?: number;
  status?: Exclude<TelemetryStatus, "active">;
  name?: string;
  offset?: number;
  limit?: number;
};
export type TelemetrySpanPage = {
  spans: TelemetrySpanRecord[];
  hasMore: boolean;
  nextOffset: number;
};
export type TelemetrySummary = {
  spans: number;
  incomplete: number;
  active: number;
  errorRate: number;
  writeFailures: number;
  otlpExportFailures: number;
  services: Array<{ service: string; spans: number; errors: number }>;
  stageLatencyMs: Record<string, { p50: number; p95: number; p99: number }>;
  latencyMs: { p50: number; p95: number; p99: number };
};
export type ResourceSample = {
  id: string;
  capturedAt: number;
  cpuUserMicros: number;
  cpuSystemMicros: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  eventLoopDelayMs: number;
  activeRuns: number;
  queuedRuns: number;
};

const REDACTED = "[REDACTED]";
const sensitive = /(authorization|cookie|api[_-]?key|password|secret|token|prompt|completion|body)/i;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const errorSecretPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(\bcookie\s*:\s*)[^;\r\n]+/gi,
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token|prompt|completion|request[_-]?body|body)\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\{[\s\S]*?\}|\[[\s\S]*?\}|[^\s,;&}]+)/gi,
  /(["']?(?:authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token|prompt|completion|body)["']?\s*:\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\{[\s\S]*?\}|\[[\s\S]*?\}|[^\s,;&}]+)/gi,
  /([?&](?:api[_-]?key|access[_-]?token|password|secret|token)=)[^&#\s]*/gi,
  /\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{9,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
];

export function redactErrorMessage(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let redacted = value;
  for (const pattern of errorSecretPatterns)
    redacted = redacted.replace(pattern, (...matches: unknown[]) => {
      const prefix = typeof matches[1] === "string" ? matches[1] : "";
      return `${prefix}${REDACTED}`;
    });
  return redacted.slice(0, 2_000);
}

export function parseTraceparent(value: string | undefined): TraceParent | undefined {
  if (!value) return undefined;
  const match = TRACEPARENT.exec(value.trim());
  if (!match || /^0+$/.test(match[1] as string) || /^0+$/.test(match[2] as string)) return undefined;
  return {
    traceId: (match[1] as string).toLowerCase(),
    spanId: (match[2] as string).toLowerCase(),
    traceFlags: Number.parseInt(match[3] as string, 16),
  };
}

export function formatTraceparent(parent: TraceParent): string {
  const normalized = parseTraceparent(
    `00-${parent.traceId}-${parent.spanId}-${parent.traceFlags.toString(16).padStart(2, "0")}`,
  );
  if (!normalized) throw new Error("Invalid W3C trace context");
  return `00-${normalized.traceId}-${normalized.spanId}-${normalized.traceFlags.toString(16).padStart(2, "0")}`;
}

function traceId(): string {
  return randomBytes(16).toString("hex");
}

function spanId(): string {
  return randomBytes(8).toString("hex");
}

export function telemetryDirectory(defaultDirectory: string): string {
  return process.env.UMA_TELEMETRY_DIR?.trim() || defaultDirectory;
}
function safeAttributes(attributes: SpanAttributes | undefined): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes ?? {}).slice(0, 32)) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || value === undefined) continue;
    if (sensitive.test(key)) result[key] = REDACTED;
    else if (typeof value === "string") result[key] = value.slice(0, 200);
    else if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (typeof value === "boolean") result[key] = value;
  }
  return result;
}

export class TelemetryStore {
  readonly db: DatabaseSync;
  private otelProvider?: { shutdown: () => Promise<void> };
  private otelTracer?: Tracer;
  private otelInitialization?: Promise<void>;
  private closePromise?: Promise<void>;
  private closed = false;
  private otlpExportFailures = 0;
  private telemetryWriteFailures = 0;
  private readonly otelSpans = new Map<string, Span>();
  private readonly insertSpanStatement;
  private readonly updateSpanStatement;
  private readonly insertEventStatement;
  private readonly linkRunStatement;
  private readonly insertResourceStatement;
  constructor(
    readonly stateDir: string,
    readonly service: string,
    private readonly onFinished?: (record: TelemetrySpanRecord) => void,
  ) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new DatabaseSync(join(stateDir, "telemetry.db"));
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    this.insertSpanStatement = this.db.prepare(
      "INSERT INTO spans(span_id,trace_id,parent_span_id,service,run_id,session_id,name,kind,status,started_at,attributes_json,error_type,error_message) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    this.updateSpanStatement = this.db.prepare(
      "UPDATE spans SET status=?,ended_at=?,duration_ms=?,attributes_json=?,error_type=?,error_message=? WHERE span_id=? AND status='active'",
    );
    this.insertEventStatement = this.db.prepare(
      "INSERT OR REPLACE INTO span_events(span_id,event_no,name,occurred_at,attributes_json) VALUES(?,?,?,?,?)",
    );
    this.linkRunStatement = this.db.prepare(
      "INSERT OR IGNORE INTO run_trace_links(run_id,trace_id,linked_at) VALUES(?,?,?)",
    );
    this.insertResourceStatement = this.db.prepare(
      "INSERT INTO resource_samples(id,service,captured_at,cpu_user_micros,cpu_system_micros,rss_bytes,heap_used_bytes,heap_total_bytes,external_bytes,array_buffers_bytes,event_loop_delay_ms,active_runs,queued_runs) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    this.db
      .prepare(
        "UPDATE spans SET status='error',ended_at=?,duration_ms=MAX(0,? - started_at),error_type='IncompleteSpan',error_message='Service restarted before span completed' WHERE service=? AND status='active'",
      )
      .run(Date.now(), Date.now(), service);
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
    if (endpoint)
      this.otelInitialization = this.initializeOtel(endpoint, service).catch(() => {
        this.otlpExportFailures += 1;
      });
  }
  private async initializeOtel(endpoint: string, service: string): Promise<void> {
    const [{ OTLPTraceExporter }, { BatchSpanProcessor, NodeTracerProvider }] = await Promise.all([
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/sdk-trace-node"),
    ]);
    const exporter = new OTLPTraceExporter({ url: endpoint });
    const provider = new NodeTracerProvider({
      spanProcessors: [
        new BatchSpanProcessor({
          export: (spans, callback) =>
            exporter.export(spans, (result) => {
              if (result.code !== 0) this.otlpExportFailures += 1;
              callback(result);
            }),
          shutdown: () => exporter.shutdown(),
        }),
      ],
    });
    if (this.closed) {
      await provider.shutdown().catch(() => undefined);
    } else {
      this.otelProvider = provider;
      this.otelTracer = provider.getTracer(`uma-agent/${service}`);
    }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      await this.otelInitialization;
      await this.otelProvider?.shutdown().catch(() => undefined);
      this.db.close();
    })();
    return this.closePromise;
  }
  otlpStatus(): { configured: boolean; initialized: boolean; exportFailures: number } {
    return {
      configured: Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()),
      initialized: Boolean(this.otelTracer),
      exportFailures: this.otlpExportFailures,
    };
  }
  start(record: Omit<TelemetrySpanRecord, "status" | "events">): void {
    if (this.otelTracer) {
      let parentContext = context.active();
      const localParent = record.parentSpanId ? this.otelSpans.get(record.parentSpanId) : undefined;
      if (localParent) parentContext = otelTrace.setSpan(parentContext, localParent);
      else if (
        record.parentSpanId &&
        /^[0-9a-f]{32}$/.test(record.traceId) &&
        /^[0-9a-f]{16}$/.test(record.parentSpanId)
      ) {
        parentContext = otelTrace.setSpanContext(parentContext, {
          traceId: record.traceId,
          spanId: record.parentSpanId,
          traceFlags:
            Number(record.attributes["trace.flags"] ?? 1) & 1 ? TraceFlags.SAMPLED : TraceFlags.NONE,
          isRemote: true,
        });
      }
      const span = this.otelTracer.startSpan(
        record.name,
        {
          attributes: {
            ...safeAttributes(record.attributes),
            "uma.trace_id": record.traceId,
            "uma.span_id": record.spanId,
          },
        },
        parentContext,
      );
      this.otelSpans.set(record.spanId, span);
    }
    try {
      this.insertSpanStatement.run(
        record.spanId,
        record.traceId,
        record.parentSpanId ?? null,
        record.service,
        record.runId ?? null,
        record.sessionId ?? null,
        record.name,
        record.kind,
        "active",
        record.startedAt,
        JSON.stringify(safeAttributes(record.attributes)),
        null,
        null,
      );
    } catch {
      this.telemetryWriteFailures += 1;
      /* diagnostics must never change business behavior */
    }
  }
  finish(record: TelemetrySpanRecord): void {
    const otelSpan = this.otelSpans.get(record.spanId);
    if (otelSpan) {
      for (const event of record.events.slice(0, 64))
        otelSpan.addEvent(event.name, safeAttributes(event.attributes));
      if (record.status === "error")
        otelSpan.recordException({
          name: record.errorType ?? "Error",
          message: redactErrorMessage(record.errorMessage) ?? "Telemetry span failed",
        });
      otelSpan.setStatus({ code: record.status === "error" ? 2 : 1 });
      otelSpan.end(record.endedAt);
      this.otelSpans.delete(record.spanId);
    }
    // 诊断写入与业务事务解耦：即使 SQLite 或 OTLP 暂时失败，也不能
    // 让已经完成的用户请求回滚或抛出新的业务异常。
    let persisted = false;
    try {
      const update = () =>
        this.updateSpanStatement.run(
          record.status,
          record.endedAt ?? null,
          record.durationMs ?? null,
          JSON.stringify(safeAttributes(record.attributes)),
          record.errorType ?? null,
          redactErrorMessage(record.errorMessage) ?? null,
          record.spanId,
        );
      // 没有事件时直接更新行，避免为每个普通 Span 额外开启事务；
      // 有事件时用同一事务保证 Span 和事件不会出现半写入状态。
      if (record.events.length === 0) {
        persisted = Number(update().changes ?? 0) > 0;
      } else {
        this.db.exec("BEGIN IMMEDIATE");
        persisted = Number(update().changes ?? 0) > 0;
        if (persisted)
          record.events.slice(0, 64).forEach((event, index) => {
            this.insertEventStatement.run(
              record.spanId,
              index,
              event.name.slice(0, 120),
              event.occurredAt,
              JSON.stringify(safeAttributes(event.attributes)),
            );
          });
        this.db.exec("COMMIT");
      }
    } catch {
      this.telemetryWriteFailures += 1;
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore telemetry failure */
      }
    }
    if (persisted) {
      try {
        this.onFinished?.(record);
      } catch {
        /* diagnostics must never change business behavior */
      }
    }
  }
  linkRun(runId: string, traceId: string): void {
    try {
      this.linkRunStatement.run(runId, traceId, Date.now());
    } catch {
      this.telemetryWriteFailures += 1;
      /* ignore telemetry failure */
    }
  }
  recordResource(sample: ResourceSample): void {
    try {
      this.insertResourceStatement.run(
        sample.id,
        this.service,
        sample.capturedAt,
        sample.cpuUserMicros,
        sample.cpuSystemMicros,
        sample.rssBytes,
        sample.heapUsedBytes,
        sample.heapTotalBytes,
        sample.externalBytes,
        sample.arrayBuffersBytes,
        sample.eventLoopDelayMs,
        sample.activeRuns,
        sample.queuedRuns,
      );
    } catch {
      this.telemetryWriteFailures += 1;
      /* ignore telemetry failure */
    }
  }
  listSpans(query: TelemetrySpanQuery): TelemetrySpanPage {
    if (
      !query.runId &&
      !query.traceId &&
      query.from === undefined &&
      query.to === undefined &&
      !query.name &&
      !query.status
    )
      throw new Error("Trace query requires a filter");
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 500)));
    const clauses = ["status <> 'active'"];
    const params: Array<string | number> = [];
    if (query.runId) {
      clauses.push("(run_id=? OR trace_id IN (SELECT trace_id FROM run_trace_links WHERE run_id=?))");
      params.push(query.runId, query.runId);
    }
    if (query.traceId) {
      clauses.push("trace_id=?");
      params.push(query.traceId);
    }
    if (query.from !== undefined) {
      clauses.push("started_at>=?");
      params.push(query.from);
    }
    if (query.to !== undefined) {
      clauses.push("started_at<=?");
      params.push(query.to);
    }
    if (query.status) {
      clauses.push("status=?");
      params.push(query.status);
    }
    if (query.name) {
      clauses.push("instr(name,?) > 0");
      params.push(query.name);
    }
    const values = this.db
      .prepare(
        `SELECT * FROM spans WHERE ${clauses.join(" AND ")} ORDER BY started_at,span_id LIMIT ? OFFSET ?`,
      )
      .all(...params, limit + 1, offset) as Array<Record<string, unknown>>;
    const selected = values.slice(0, limit);
    const eventsBySpan = new Map<string, TelemetryEvent[]>();
    if (selected.length) {
      const spanIds = selected.map((value) => String(value.span_id));
      const eventRows = this.db
        .prepare(
          `SELECT span_id,name,occurred_at,attributes_json FROM span_events
           WHERE span_id IN (${spanIds.map(() => "?").join(",")}) ORDER BY span_id,event_no`,
        )
        .all(...spanIds) as Array<Record<string, unknown>>;
      for (const event of eventRows) {
        const id = String(event.span_id);
        const current = eventsBySpan.get(id) ?? [];
        let attributes: Record<string, string | number | boolean> = {};
        try {
          attributes = JSON.parse(String(event.attributes_json ?? "{}"));
        } catch {
          // Corrupt diagnostic attributes do not make the business trace unreadable.
        }
        current.push({ name: String(event.name), occurredAt: Number(event.occurred_at), attributes });
        eventsBySpan.set(id, current);
      }
    }
    return {
      spans: selected.map((value) => ({
        traceId: String(value.trace_id),
        spanId: String(value.span_id),
        ...(value.parent_span_id ? { parentSpanId: String(value.parent_span_id) } : {}),
        service: String(value.service),
        ...(value.run_id ? { runId: String(value.run_id) } : {}),
        ...(value.session_id ? { sessionId: String(value.session_id) } : {}),
        name: String(value.name),
        kind: String(value.kind),
        status: String(value.status) as TelemetryStatus,
        startedAt: Number(value.started_at),
        ...(value.ended_at == null ? {} : { endedAt: Number(value.ended_at) }),
        ...(value.duration_ms == null ? {} : { durationMs: Number(value.duration_ms) }),
        attributes: (() => {
          try {
            return JSON.parse(String(value.attributes_json ?? "{}"));
          } catch {
            return {};
          }
        })(),
        ...(value.error_type ? { errorType: String(value.error_type) } : {}),
        ...(value.error_message
          ? { errorMessage: redactErrorMessage(String(value.error_message)) as string }
          : {}),
        events: eventsBySpan.get(String(value.span_id)) ?? [],
      })),
      hasMore: values.length > limit,
      nextOffset: offset + selected.length,
    };
  }
  summarize(from: number, to: number): TelemetrySummary {
    const summary = this.db
      .prepare(
        "SELECT COUNT(*) AS spans,SUM(CASE WHEN error_type='IncompleteSpan' THEN 1 ELSE 0 END) AS incomplete FROM spans WHERE status <> 'active' AND started_at BETWEEN ? AND ?",
      )
      .get(from, to) as Record<string, unknown>;
    const spans = Number(summary.spans ?? 0);
    const active = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS count FROM spans WHERE status='active' AND started_at <= ?")
          .get(to) as Record<string, unknown>
      )?.count ?? 0,
    );
    const errors = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS count FROM spans WHERE status='error' AND started_at BETWEEN ? AND ?")
          .get(from, to) as Record<string, unknown>
      )?.count ?? 0,
    );
    const services = (
      this.db
        .prepare(
          "SELECT service,COUNT(*) AS spans,SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors FROM spans WHERE status <> 'active' AND started_at BETWEEN ? AND ? GROUP BY service ORDER BY service",
        )
        .all(from, to) as Array<Record<string, unknown>>
    ).map((row) => ({
      service: String(row.service),
      spans: Number(row.spans ?? 0),
      errors: Number(row.errors ?? 0),
    }));
    const stageLatencyMs: Record<string, { p50: number; p95: number; p99: number }> = {};
    const latencyRows = this.db
      .prepare(
        `WITH base AS (
           SELECT kind,span_id,COALESCE(duration_ms,0) AS duration
           FROM spans
           WHERE status <> 'active' AND started_at BETWEEN ? AND ?
         ), ranked AS (
           SELECT kind,duration,
                  ROW_NUMBER() OVER (PARTITION BY kind ORDER BY duration,span_id) AS kind_rank,
                  COUNT(*) OVER (PARTITION BY kind) AS kind_count,
                  ROW_NUMBER() OVER (ORDER BY duration,span_id) AS all_rank,
                  COUNT(*) OVER () AS all_count
           FROM base
         ), kind_metrics AS (
           SELECT kind,
             MAX(CASE WHEN kind_rank=MAX(1,CAST(kind_count*0.50+0.999999 AS INTEGER)) THEN duration ELSE 0 END) AS p50,
             MAX(CASE WHEN kind_rank=MAX(1,CAST(kind_count*0.95+0.999999 AS INTEGER)) THEN duration ELSE 0 END) AS p95,
             MAX(CASE WHEN kind_rank=MAX(1,CAST(kind_count*0.99+0.999999 AS INTEGER)) THEN duration ELSE 0 END) AS p99
           FROM ranked GROUP BY kind
         ), overall_metrics AS (
           SELECT
             MAX(CASE WHEN all_rank=MAX(1,CAST(all_count*0.50+0.999999 AS INTEGER)) THEN duration ELSE 0 END) AS p50,
             MAX(CASE WHEN all_rank=MAX(1,CAST(all_count*0.95+0.999999 AS INTEGER)) THEN duration ELSE 0 END) AS p95,
             MAX(CASE WHEN all_rank=MAX(1,CAST(all_count*0.99+0.999999 AS INTEGER)) THEN duration ELSE 0 END) AS p99
           FROM ranked
         )
         SELECT kind,p50,p95,p99 FROM kind_metrics
         UNION ALL
         SELECT NULL AS kind,p50,p95,p99 FROM overall_metrics`,
      )
      .all(from, to) as Array<Record<string, unknown>>;
    for (const row of latencyRows) {
      if (row.kind === null) continue;
      stageLatencyMs[String(row.kind)] = {
        p50: Number(row.p50 ?? 0),
        p95: Number(row.p95 ?? 0),
        p99: Number(row.p99 ?? 0),
      };
    }
    const overallLatency = latencyRows.find((row) => row.kind === null);
    return {
      spans,
      incomplete: Number(summary.incomplete ?? 0),
      active,
      errorRate: spans ? errors / spans : 0,
      writeFailures: this.telemetryWriteFailures,
      otlpExportFailures: this.otlpExportFailures,
      services,
      stageLatencyMs,
      latencyMs: {
        p50: Number(overallLatency?.p50 ?? 0),
        p95: Number(overallLatency?.p95 ?? 0),
        p99: Number(overallLatency?.p99 ?? 0),
      },
    };
  }
  maintain(now = Date.now()): void {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const cutoff = now - 90 * 86_400_000;
      // 让 SQLite 在库内完成分组，避免维护任务把数月 Span 全量加载进 Node 堆。
      this.db
        .prepare(
          `INSERT INTO span_aggregates(bucket_start,bucket_ms,service,name,status,count,total_duration_ms,min_duration_ms,max_duration_ms)
           SELECT CAST(started_at / 3600000 AS INTEGER) * 3600000,3600000,service,name,status,
                  COUNT(*),SUM(MAX(0,duration_ms)),MIN(MAX(0,duration_ms)),MAX(MAX(0,duration_ms))
           FROM spans WHERE ended_at IS NOT NULL AND ended_at < ?
           GROUP BY CAST(started_at / 3600000 AS INTEGER),service,name,status
           ON CONFLICT(bucket_start,bucket_ms,service,name,status) DO UPDATE SET
             count=count+excluded.count,
             total_duration_ms=total_duration_ms+excluded.total_duration_ms,
             min_duration_ms=MIN(min_duration_ms,excluded.min_duration_ms),
             max_duration_ms=MAX(max_duration_ms,excluded.max_duration_ms)`,
        )
        .run(cutoff);
      this.db
        .prepare(
          "DELETE FROM span_events WHERE span_id IN (SELECT span_id FROM spans WHERE ended_at IS NOT NULL AND ended_at < ?)",
        )
        .run(cutoff);
      this.db.prepare("DELETE FROM spans WHERE ended_at IS NOT NULL AND ended_at < ?").run(cutoff);
      this.db.prepare("DELETE FROM resource_samples WHERE captured_at < ?").run(now - 30 * 86_400_000);
      this.db.prepare("DELETE FROM span_aggregates WHERE bucket_start < ?").run(now - 365 * 86_400_000);
      this.db.exec("COMMIT");
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore telemetry maintenance failure */
      }
    }
  }
}

export class TraceSpanContext implements TelemetryContext {
  private readonly startedAt = process.hrtime.bigint();
  private attributes: Record<string, string | number | boolean>;
  private readonly events: TelemetryEvent[] = [];
  private status: TelemetryStatus = "ok";
  private errorType: string | undefined;
  private errorMessage: string | undefined;
  private ended = false;
  private readonly children = new Set<TraceSpanContext>();
  constructor(
    private readonly store: TelemetryStore,
    readonly traceId: string,
    readonly spanId: string,
    private readonly parentSpanId: string | undefined,
    private readonly runId: string | undefined,
    private readonly sessionId: string | undefined,
    private readonly name: string,
    private readonly kind: string,
    private readonly service: string,
    attributes?: SpanAttributes,
    private readonly parentContext?: TraceSpanContext,
  ) {
    this.attributes = safeAttributes(attributes);
    this.store.start({
      spanId,
      traceId,
      ...(parentSpanId ? { parentSpanId } : {}),
      service,
      ...(runId ? { runId } : {}),
      ...(sessionId ? { sessionId } : {}),
      name,
      kind,
      startedAt: Date.now(),
      attributes: this.attributes,
    });
  }
  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    const child = this.child(options.name, "internal", options.attributes);
    let result: T | Promise<T>;
    try {
      result = callback(child);
    } catch (error) {
      child.finish({
        status: "error",
        error: { name: error instanceof Error ? error.name : "Error", message: String(error) },
      });
      return Promise.reject(error);
    }
    return Promise.resolve(result).then(
      (value) => {
        child.finish({ status: "ok" });
        return value;
      },
      (error: unknown) => {
        child.finish({
          status: "error",
          error: { name: error instanceof Error ? error.name : "Error", message: String(error) },
        });
        throw error;
      },
    );
  }
  child(name: string, kind: string, attributes?: SpanAttributes): TraceSpanContext {
    if (this.ended) throw new Error(`Trace span is already ended: ${this.spanId}`);
    const child = new TraceSpanContext(
      this.store,
      this.traceId,
      spanId(),
      this.spanId,
      this.runId,
      this.sessionId,
      name,
      kind,
      this.service,
      attributes,
      this,
    );
    this.children.add(child);
    return child;
  }
  addEvent(name: string, attributes?: SpanAttributes): void {
    if (!this.ended && this.events.length < 64)
      this.events.push({ name, occurredAt: Date.now(), attributes: safeAttributes(attributes) });
  }
  setAttributes(attributes: SpanAttributes): void {
    if (!this.ended) this.attributes = { ...this.attributes, ...safeAttributes(attributes) };
  }
  setStatus(status: SpanStatus | { status: "cancelled" }): void {
    if (this.ended) return;
    this.status = status.status === "cancelled" ? "cancelled" : status.status === "error" ? "error" : "ok";
    this.errorType = status.status === "error" ? status.error?.name : undefined;
    this.errorMessage = status.status === "error" ? status.error?.message : undefined;
  }
  finish(status?: SpanStatus | { status: "cancelled" }): void {
    if (this.ended) return;
    // 父 Span 提前结束时，未结束的子 Span 必须显式标记为不完整，
    // 否则 Trace 会永久保留 active 节点，误导延迟和错误率统计。
    for (const child of this.children)
      if (!child.ended)
        child.finish({
          status: "error",
          error: { name: "IncompleteSpan", message: "Parent span ended before child span" },
        });
    if (status) this.setStatus(status);
    this.ended = true;
    const endedAt = Date.now();
    const durationMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - this.startedAt) / 1_000_000));
    this.store.finish({
      spanId: this.spanId,
      traceId: this.traceId,
      ...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
      service: this.service,
      ...(this.runId ? { runId: this.runId } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      name: this.name,
      kind: this.kind,
      status: this.status,
      startedAt: endedAt - durationMs,
      endedAt,
      durationMs,
      attributes: this.attributes,
      events: this.events,
      ...(this.errorType ? { errorType: this.errorType } : {}),
      ...(this.errorMessage ? { errorMessage: this.errorMessage } : {}),
    });
    this.parentContext?.children.delete(this);
  }
}

export class TraceService {
  constructor(
    protected readonly store: TelemetryStore,
    protected readonly service: string,
  ) {}
  startRoot(
    runId?: string,
    sessionId?: string,
    name = "run",
    attributes?: SpanAttributes,
    parent?: TraceParent,
    kind = "run",
  ): TraceSpanContext {
    const rootTraceId = parent?.traceId ?? traceId();
    const span = new TraceSpanContext(
      this.store,
      rootTraceId,
      spanId(),
      parent?.spanId,
      runId,
      sessionId,
      name,
      kind,
      this.service,
      { ...attributes, "trace.flags": parent?.traceFlags ?? 1 },
    );
    if (runId) this.store.linkRun(runId, rootTraceId);
    return span;
  }
}
