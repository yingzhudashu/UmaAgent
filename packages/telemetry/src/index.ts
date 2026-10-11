import { mkdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { context, trace as otelTrace, type Span, TraceFlags, type Tracer } from "@opentelemetry/api";
import { SqlWriter } from "./sql-writer.js";
import {
  percentile,
  type ResourceSample,
  spanTree,
  type TelemetryEvent,
  type TelemetrySpanPage,
  type TelemetrySpanQuery,
  type TelemetrySpanRecord,
  type TelemetryStatus,
  type TelemetrySummary,
} from "./telemetry-contract.js";
import { redactErrorMessage, safeAttributes } from "./telemetry-utils.js";

export * from "./telemetry-contract.js";
export * from "./telemetry-utils.js";

export class TelemetryStore {
  readonly db: DatabaseSync;
  private readonly queries = new Map<string, StatementSync>();
  private readonly writer: SqlWriter;
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
  ) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new DatabaseSync(join(stateDir, "telemetry.db"));
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA wal_autocheckpoint=256;");
    this.db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    const resourceColumns = new Set(
      (this.prepareQuery("PRAGMA table_info(resource_samples)").all() as Array<{ name?: unknown }>).map(
        (row) => String(row.name ?? ""),
      ),
    );
    if (!["wal_bytes", "sample_duration_ms", "cpu_percent"].every((column) => resourceColumns.has(column))) {
      this.db.close();
      throw new Error("Unsupported telemetry schema; delete telemetry.db and start with the current schema.");
    }
    this.writer = SqlWriter.acquire(join(stateDir, "telemetry.db"));
    this.insertSpanStatement = this.prepareWrite(
      "INSERT INTO spans(span_id,trace_id,parent_span_id,service,run_id,session_id,name,kind,status,started_at,attributes_json,error_type,error_message) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    this.updateSpanStatement = this.prepareWrite(
      "UPDATE spans SET status=?,ended_at=?,duration_ms=?,attributes_json=?,error_type=?,error_message=? WHERE span_id=? AND status='active'",
    );
    this.insertEventStatement = this.prepareWrite(
      "INSERT OR REPLACE INTO span_events(span_id,event_no,name,occurred_at,attributes_json) VALUES(?,?,?,?,?)",
    );
    this.linkRunStatement = this.prepareWrite(
      "INSERT OR IGNORE INTO run_trace_links(run_id,trace_id,linked_at) VALUES(?,?,?)",
    );
    this.insertResourceStatement = this.prepareWrite(
      "INSERT INTO resource_samples(id,service,captured_at,cpu_user_micros,cpu_system_micros,sample_duration_ms,cpu_percent,rss_bytes,heap_used_bytes,heap_total_bytes,external_bytes,array_buffers_bytes,event_loop_delay_ms,wal_bytes,active_runs,queued_runs) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    this.prepareQuery(
      "UPDATE spans SET status='error',ended_at=?,duration_ms=MAX(0,? - started_at),error_type='IncompleteSpan',error_message='Service restarted before span completed' WHERE service=? AND status='active'",
    ).run(Date.now(), Date.now(), service);
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
    if (endpoint)
      this.otelInitialization = this.initializeOtel(endpoint, service).catch(() => {
        this.otlpExportFailures += 1;
      });
  }
  /** 查询参数不改变 SQL；复用原生句柄，动态过滤组合仍有明确上限。 */
  private prepareQuery(sql: string): StatementSync {
    const existing = this.queries.get(sql);
    if (existing) return existing;
    const statement = this.db.prepare(sql);
    if (this.queries.size >= 64) this.queries.delete(this.queries.keys().next().value as string);
    this.queries.set(sql, statement);
    return statement;
  }
  private prepareWrite(sql: string) {
    return {
      run: (...args: Array<string | number | null>) => {
        this.writer.enqueue(sql, args);
      },
    };
  }
  /** 读取前的持久化屏障，以及优雅关闭时的排空入口。 */
  flush(): Promise<void> {
    return this.writer.flush();
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
      await this.writer.release();
      this.queries.clear();
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
    // 一个 Span 的属性可能同时写入 OTLP 与 SQLite；先脱敏一次，避免每个后端重复遍历正则。
    const attributes = safeAttributes(record.attributes);
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
            ...attributes,
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
        JSON.stringify(attributes),
        null,
        null,
      );
    } catch {
      this.telemetryWriteFailures += 1;
      /* diagnostics must never change business behavior */
    }
  }
  finish(record: TelemetrySpanRecord): void {
    const attributes = safeAttributes(record.attributes);
    const events = record.events.slice(0, 64).map((event) => ({
      ...event,
      name: event.name.slice(0, 120),
      attributes: safeAttributes(event.attributes),
    }));
    const errorMessage = redactErrorMessage(record.errorMessage) ?? null;
    const otelSpan = this.otelSpans.get(record.spanId);
    if (otelSpan) {
      for (const event of events) otelSpan.addEvent(event.name, event.attributes);
      if (record.status === "error")
        otelSpan.recordException({
          name: record.errorType ?? "Error",
          message: errorMessage ?? "Telemetry span failed",
        });
      otelSpan.setStatus({ code: record.status === "error" ? 2 : 1 });
      otelSpan.end(record.endedAt);
      this.otelSpans.delete(record.spanId);
    }
    // 诊断写入与业务事务解耦：即使 SQLite 或 OTLP 暂时失败，也不能
    // 让已经完成的用户请求回滚或抛出新的业务异常。
    this.writer.batch(() => {
      this.updateSpanStatement.run(
        record.status,
        record.endedAt ?? null,
        record.durationMs ?? null,
        JSON.stringify(attributes),
        record.errorType ?? null,
        errorMessage,
        record.spanId,
      );
      events.forEach((event, index) => {
        this.insertEventStatement.run(
          record.spanId,
          index,
          event.name,
          event.occurredAt,
          JSON.stringify(event.attributes),
        );
      });
    });
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
        sample.sampleDurationMs,
        sample.cpuPercent,
        sample.rssBytes,
        sample.heapUsedBytes,
        sample.heapTotalBytes,
        sample.externalBytes,
        sample.arrayBuffersBytes,
        sample.eventLoopDelayMs,
        sample.walBytes,
        sample.activeRuns,
        sample.queuedRuns,
      );
    } catch {
      this.telemetryWriteFailures += 1;
      /* ignore telemetry failure */
    }
  }
  listResources(from = 0, to = Date.now(), limit = 500): ResourceSample[] {
    const values = this.prepareQuery(
      "SELECT * FROM resource_samples WHERE captured_at BETWEEN ? AND ? ORDER BY captured_at DESC LIMIT ?",
    ).all(from, to, Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>;
    return values.map((value) => ({
      id: String(value.id),
      service: String(value.service),
      capturedAt: Number(value.captured_at),
      cpuUserMicros: Number(value.cpu_user_micros),
      cpuSystemMicros: Number(value.cpu_system_micros),
      sampleDurationMs: Number(value.sample_duration_ms),
      cpuPercent: Number(value.cpu_percent),
      rssBytes: Number(value.rss_bytes),
      heapUsedBytes: Number(value.heap_used_bytes),
      heapTotalBytes: Number(value.heap_total_bytes),
      externalBytes: Number(value.external_bytes),
      arrayBuffersBytes: Number(value.array_buffers_bytes),
      eventLoopDelayMs: Number(value.event_loop_delay_ms),
      walBytes: Number(value.wal_bytes),
      activeRuns: Number(value.active_runs),
      queuedRuns: Number(value.queued_runs),
    }));
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
      if (query.scopeToRun) {
        clauses.push(`span_id IN (
          WITH RECURSIVE owned(span_id, trace_id) AS (
            SELECT span_id, trace_id FROM spans WHERE run_id=?
            UNION
            SELECT child.span_id, child.trace_id FROM spans child
            JOIN owned parent ON child.parent_span_id=parent.span_id AND child.trace_id=parent.trace_id
            WHERE child.run_id IS NULL OR child.run_id=?
          ) SELECT span_id FROM owned
        )`);
        params.push(query.runId, query.runId);
      } else {
        clauses.push("(run_id=? OR trace_id IN (SELECT trace_id FROM run_trace_links WHERE run_id=?))");
        params.push(query.runId, query.runId);
      }
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
    const values = this.prepareQuery(
      `SELECT * FROM spans WHERE ${clauses.join(" AND ")} ORDER BY started_at,span_id LIMIT ? OFFSET ?`,
    ).all(...params, limit + 1, offset) as Array<Record<string, unknown>>;
    const selected = values.slice(0, limit);
    const selectedIds = selected.map((span) => String(span.span_id));
    const treeRows = selected.length
      ? (this.prepareQuery(
          `WITH RECURSIVE ancestors(origin_span_id,trace_id,span_id,parent_span_id,depth,path) AS (
             SELECT span_id,trace_id,span_id,parent_span_id,0,'|' || span_id || '|'
             FROM spans WHERE span_id IN (${selectedIds.map(() => "?").join(",")})
             UNION ALL
             SELECT child.origin_span_id,child.trace_id,parent.span_id,parent.parent_span_id,
                    child.depth+1,child.path || parent.span_id || '|'
             FROM ancestors child JOIN spans parent
               ON parent.span_id=child.parent_span_id AND parent.trace_id=child.trace_id
             WHERE child.parent_span_id IS NOT NULL
               AND instr(child.path,'|' || parent.span_id || '|')=0
           ) SELECT origin_span_id,span_id,parent_span_id,depth FROM ancestors`,
        ).all(...selectedIds) as Array<Record<string, unknown>>)
      : [];
    const tree = spanTree(treeRows, selected[0] ? String(selected[0].span_id) : undefined);
    const eventsBySpan = new Map<string, TelemetryEvent[]>();
    if (selected.length) {
      const spanIds = selected.map((value) => String(value.span_id));
      const eventRows = this.prepareQuery(
        `SELECT span_id,name,occurred_at,attributes_json FROM span_events
           WHERE span_id IN (${spanIds.map(() => "?").join(",")}) ORDER BY span_id,event_no`,
      ).all(...spanIds) as Array<Record<string, unknown>>;
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
      ...tree,
    };
  }
  summarize(from: number, to: number): TelemetrySummary {
    const summary = this.prepareQuery(
      "SELECT COUNT(*) AS spans,SUM(CASE WHEN error_type='IncompleteSpan' THEN 1 ELSE 0 END) AS incomplete FROM spans WHERE status <> 'active' AND started_at BETWEEN ? AND ?",
    ).get(from, to) as Record<string, unknown>;
    const spans = Number(summary.spans ?? 0);
    const active = Number(
      (
        this.prepareQuery(
          "SELECT COUNT(*) AS count FROM spans WHERE status='active' AND started_at <= ?",
        ).get(to) as Record<string, unknown>
      )?.count ?? 0,
    );
    const errors = Number(
      (
        this.prepareQuery(
          "SELECT COUNT(*) AS count FROM spans WHERE status='error' AND started_at BETWEEN ? AND ?",
        ).get(from, to) as Record<string, unknown>
      )?.count ?? 0,
    );
    const services = (
      this.prepareQuery(
        "SELECT service,COUNT(*) AS spans,SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors FROM spans WHERE status <> 'active' AND started_at BETWEEN ? AND ? GROUP BY service ORDER BY service",
      ).all(from, to) as Array<Record<string, unknown>>
    ).map((row) => ({
      service: String(row.service),
      spans: Number(row.spans ?? 0),
      errors: Number(row.errors ?? 0),
    }));
    const stageLatencyMs: Record<string, { p50: number; p95: number; p99: number }> = {};
    const latencyRows = this.prepareQuery(
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
    ).all(from, to) as Array<Record<string, unknown>>;
    for (const row of latencyRows) {
      if (row.kind === null) continue;
      stageLatencyMs[String(row.kind)] = {
        p50: Number(row.p50 ?? 0),
        p95: Number(row.p95 ?? 0),
        p99: Number(row.p99 ?? 0),
      };
    }
    const overallLatency = latencyRows.find((row) => row.kind === null);
    const queueWaitCount = Number(
      (
        this.prepareQuery(
          "SELECT COUNT(*) AS count FROM spans WHERE kind='queue' AND status <> 'active' AND started_at BETWEEN ? AND ?",
        ).get(from, to) as Record<string, unknown>
      )?.count ?? 0,
    );
    const retryCount = Number(
      (
        this.prepareQuery(
          "SELECT COUNT(*) AS count FROM span_events e JOIN spans s ON s.span_id=e.span_id WHERE s.started_at BETWEEN ? AND ? AND instr(lower(e.name),'retry') > 0",
        ).get(from, to) as Record<string, unknown>
      )?.count ?? 0,
    );
    const orphanParentChains = Number(
      (
        this.prepareQuery(
          "SELECT COUNT(*) AS count FROM spans child WHERE child.parent_span_id IS NOT NULL AND child.started_at BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM spans parent WHERE parent.span_id=child.parent_span_id AND parent.trace_id=child.trace_id)",
        ).get(from, to) as Record<string, unknown>
      )?.count ?? 0,
    );
    const errorTypes = (
      this.prepareQuery(
        "SELECT error_type,COUNT(*) AS count FROM spans WHERE status='error' AND started_at BETWEEN ? AND ? GROUP BY error_type ORDER BY count DESC,error_type LIMIT 50",
      ).all(from, to) as Array<Record<string, unknown>>
    ).map((row) => ({
      type: String(row.error_type ?? "Error").slice(0, 200),
      count: Number(row.count ?? 0),
    }));
    const resourceRows = this.prepareQuery(
      "SELECT cpu_percent,sample_duration_ms,rss_bytes,wal_bytes,event_loop_delay_ms FROM resource_samples WHERE captured_at BETWEEN ? AND ? ORDER BY captured_at",
    ).all(from, to) as Array<Record<string, unknown>>;
    const resourceDuration = resourceRows.reduce((sum, row) => sum + Number(row.sample_duration_ms ?? 0), 0);
    const cpuAverage = resourceDuration
      ? resourceRows.reduce(
          (sum, row) => sum + Number(row.cpu_percent ?? 0) * Number(row.sample_duration_ms ?? 0),
          0,
        ) / resourceDuration
      : 0;
    const coreCount = availableParallelism();
    const queueLatency = stageLatencyMs.queue ?? { p50: 0, p95: 0, p99: 0 };
    return {
      spans,
      incomplete: Number(summary.incomplete ?? 0),
      active,
      errorRate: spans ? errors / spans : 0,
      writeFailures: this.telemetryWriteFailures + this.writer.failures,
      otlpExportFailures: this.otlpExportFailures,
      orphanParentChains,
      retries: retryCount,
      errorTypes,
      queueWait: { count: queueWaitCount, ...queueLatency },
      resources: {
        samples: resourceRows.length,
        cpuAverageCorePercent: cpuAverage * coreCount,
        cpuPeakCorePercent:
          Math.max(0, ...resourceRows.map((row) => Number(row.cpu_percent ?? 0))) * coreCount,
        rssPeakBytes: Math.max(0, ...resourceRows.map((row) => Number(row.rss_bytes ?? 0))),
        walPeakBytes: Math.max(0, ...resourceRows.map((row) => Number(row.wal_bytes ?? 0))),
        eventLoopDelayP95Ms: percentile(
          resourceRows.map((row) => Number(row.event_loop_delay_ms ?? 0)),
          95,
        ),
      },
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
      const cutoff = now - 90 * 86_400_000;
      this.writer.batch(() => {
        // 让 SQLite 在库内完成分组，避免维护任务把数月 Span 全量加载进 Node 堆。
        this.prepareWrite(
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
        ).run(cutoff);
        this.prepareWrite(
          "DELETE FROM span_events WHERE span_id IN (SELECT span_id FROM spans WHERE ended_at IS NOT NULL AND ended_at < ?)",
        ).run(cutoff);
        this.prepareWrite("DELETE FROM spans WHERE ended_at IS NOT NULL AND ended_at < ?").run(cutoff);
        this.prepareWrite(
          "DELETE FROM run_trace_links WHERE linked_at < ? AND NOT EXISTS (SELECT 1 FROM spans WHERE spans.trace_id=run_trace_links.trace_id)",
        ).run(cutoff);
        this.prepareWrite("DELETE FROM resource_samples WHERE captured_at < ?").run(now - 30 * 86_400_000);
        this.prepareWrite("DELETE FROM span_aggregates WHERE bucket_start < ?").run(now - 365 * 86_400_000);
      });
    } catch {
      try {
        this.telemetryWriteFailures++;
      } catch {
        /* ignore telemetry maintenance failure */
      }
    }
  }
}

export { TraceService, TraceSpanContext } from "./trace-context.js";
