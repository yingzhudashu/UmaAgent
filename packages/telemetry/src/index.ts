import { randomUUID } from "node:crypto";
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
import type { Span, Tracer } from "@opentelemetry/api";

export type TelemetryStatus = "active" | "ok" | "error" | "cancelled";
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
  private readonly otelSpans = new Map<string, Span>();
  constructor(
    readonly stateDir: string,
    readonly service: string,
    private readonly onFinished?: (record: TelemetrySpanRecord) => void,
  ) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new DatabaseSync(join(stateDir, "telemetry.db"));
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    this.db
      .prepare(
        "UPDATE spans SET status='error',ended_at=?,duration_ms=MAX(0,? - started_at),error_type='IncompleteSpan',error_message='Service restarted before span completed' WHERE service=? AND status='active'",
      )
      .run(Date.now(), Date.now(), service);
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
    if (endpoint) void this.initializeOtel(endpoint, service);
  }
  private async initializeOtel(endpoint: string, service: string): Promise<void> {
    const [{ OTLPTraceExporter }, { BatchSpanProcessor, NodeTracerProvider }] = await Promise.all([
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/sdk-trace-node"),
    ]);
    const provider = new NodeTracerProvider({
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint }))],
    });
    this.otelProvider = provider;
    this.otelTracer = provider.getTracer(`uma-agent/${service}`);
  }
  close(): void {
    void this.otelProvider?.shutdown();
    this.db.close();
  }
  start(record: Omit<TelemetrySpanRecord, "status" | "events">): void {
    if (this.otelTracer) {
      const span = this.otelTracer.startSpan(record.name, {
        attributes: safeAttributes(record.attributes),
      });
      this.otelSpans.set(record.spanId, span);
    }
    try {
      this.db
        .prepare(
          "INSERT INTO spans(span_id,trace_id,parent_span_id,service,run_id,session_id,name,kind,status,started_at,attributes_json,error_type,error_message) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
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
          message: record.errorMessage ?? "Telemetry span failed",
        });
      otelSpan.setStatus({ code: record.status === "error" ? 2 : 1 });
      otelSpan.end(record.endedAt);
      this.otelSpans.delete(record.spanId);
    }
    try {
      this.onFinished?.(record);
    } catch {
      /* diagnostics must never change business behavior */
    }
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db
        .prepare(
          "UPDATE spans SET status=?,ended_at=?,duration_ms=?,attributes_json=?,error_type=?,error_message=? WHERE span_id=?",
        )
        .run(
          record.status,
          record.endedAt ?? null,
          record.durationMs ?? null,
          JSON.stringify(safeAttributes(record.attributes)),
          record.errorType ?? null,
          record.errorMessage?.slice(0, 2000) ?? null,
          record.spanId,
        );
      const insert = this.db.prepare(
        "INSERT OR REPLACE INTO span_events(span_id,event_no,name,occurred_at,attributes_json) VALUES(?,?,?,?,?)",
      );
      record.events.slice(0, 64).forEach((event, index) => {
        insert.run(
          record.spanId,
          index,
          event.name.slice(0, 120),
          event.occurredAt,
          JSON.stringify(safeAttributes(event.attributes)),
        );
      });
      this.db.exec("COMMIT");
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore telemetry failure */
      }
    }
  }
  linkRun(runId: string, traceId: string): void {
    try {
      this.db
        .prepare("INSERT OR IGNORE INTO run_trace_links(run_id,trace_id,linked_at) VALUES(?,?,?)")
        .run(runId, traceId, Date.now());
    } catch {
      /* ignore telemetry failure */
    }
  }
  recordResource(sample: ResourceSample): void {
    try {
      this.db
        .prepare(
          "INSERT INTO resource_samples(id,service,captured_at,cpu_user_micros,cpu_system_micros,rss_bytes,heap_used_bytes,heap_total_bytes,external_bytes,array_buffers_bytes,event_loop_delay_ms,active_runs,queued_runs) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
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
      /* ignore telemetry failure */
    }
  }
  maintain(now = Date.now()): void {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const cutoff = now - 90 * 86_400_000;
      const raw = this.db
        .prepare(
          "SELECT service,name,status,started_at,duration_ms FROM spans WHERE ended_at IS NOT NULL AND ended_at < ?",
        )
        .all(cutoff) as Array<Record<string, unknown>>;
      const aggregate = this.db.prepare(
        "INSERT INTO span_aggregates(bucket_start,bucket_ms,service,name,status,count,total_duration_ms,min_duration_ms,max_duration_ms) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(bucket_start,bucket_ms,service,name,status) DO UPDATE SET count=count+excluded.count,total_duration_ms=total_duration_ms+excluded.total_duration_ms,min_duration_ms=MIN(min_duration_ms,excluded.min_duration_ms),max_duration_ms=MAX(max_duration_ms,excluded.max_duration_ms)",
      );
      for (const row of raw) {
        const bucketMs = 3_600_000;
        const bucket = Math.floor(Number(row.started_at) / bucketMs) * bucketMs;
        const duration = Math.max(0, Number(row.duration_ms ?? 0));
        aggregate.run(
          bucket,
          bucketMs,
          String(row.service),
          String(row.name),
          String(row.status),
          1,
          duration,
          duration,
          duration,
        );
      }
      this.db
        .prepare(
          "DELETE FROM span_events WHERE span_id IN (SELECT span_id FROM spans WHERE ended_at IS NOT NULL AND ended_at < ?)",
        )
        .run(now - 90 * 86_400_000);
      this.db
        .prepare("DELETE FROM spans WHERE ended_at IS NOT NULL AND ended_at < ?")
        .run(now - 90 * 86_400_000);
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
    private readonly traceId: string,
    private readonly spanId: string,
    private readonly parentSpanId: string | undefined,
    private readonly runId: string | undefined,
    private readonly sessionId: string | undefined,
    private readonly name: string,
    private readonly kind: string,
    private readonly service: string,
    attributes?: SpanAttributes,
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
      randomUUID(),
      this.spanId,
      this.runId,
      this.sessionId,
      name,
      kind,
      this.service,
      attributes,
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
  }
}

export class TraceService {
  constructor(
    protected readonly store: TelemetryStore,
    protected readonly service: string,
  ) {}
  startRoot(runId?: string, sessionId?: string, name = "run", attributes?: SpanAttributes): TraceSpanContext {
    const traceId = randomUUID();
    const span = new TraceSpanContext(
      this.store,
      traceId,
      randomUUID(),
      undefined,
      runId,
      sessionId,
      name,
      "run",
      this.service,
      attributes,
    );
    if (runId) this.store.linkRun(runId, traceId);
    return span;
  }
}
