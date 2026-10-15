import type {
  SpanAttributes,
  SpanOptions,
  SpanStatus,
  TelemetryContext,
  TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import type { TelemetryStore } from "./index.js";
import type { TelemetryEvent, TelemetryStatus, TraceParent } from "./telemetry-contract.js";
import { spanId, traceId } from "./telemetry-utils.js";

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
    // 脱敏只在 TelemetryStore 写入 SQLite/OTLP 的边界执行一次；Span
    // 上下文只暂存原始的有限类型，避免开始和结束各重复跑一遍正则。
    this.attributes = { ...(attributes ?? {}) } as Record<string, string | number | boolean>;
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
      this.events.push({
        name,
        occurredAt: Date.now(),
        attributes: { ...(attributes ?? {}) } as Record<string, string | number | boolean>,
      });
  }

  setAttributes(attributes: SpanAttributes): void {
    if (!this.ended)
      this.attributes = { ...this.attributes, ...attributes } as Record<string, string | number | boolean>;
  }

  setStatus(status: SpanStatus | { status: "cancelled" }): void {
    if (this.ended) return;
    this.status = status.status === "cancelled" ? "cancelled" : status.status === "error" ? "error" : "ok";
    this.errorType = status.status === "error" ? status.error?.name : undefined;
    this.errorMessage = status.status === "error" ? status.error?.message : undefined;
  }

  finish(status?: SpanStatus | { status: "cancelled" }): void {
    if (this.ended) return;
    // 父 Span 提前结束时，未结束的子 Span 必须显式标记为不完整，避免 active 节点永久留存。
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
      {
        ...attributes,
        "trace.flags": parent?.traceFlags ?? 1,
        // 默认 parent 来自跨服务入口；同进程从已有 Span 派生的子 Span
        // 可显式传 false，避免把本地父级误报成远端根。
        "trace.parent_remote": attributes?.["trace.parent_remote"] ?? Boolean(parent),
      },
    );
    if (runId) this.store.linkRun(runId, rootTraceId);
    return span;
  }
}
