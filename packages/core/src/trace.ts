import { randomUUID } from "node:crypto";
import type {
  SpanAttributes,
  SpanOptions,
  SpanStatus,
  TelemetryContext,
  TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import type { TraceSpan } from "@uma-agent/protocol";
import type { UmaDatabase } from "./database.js";

function safeAttributes(attributes: SpanAttributes | undefined): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes ?? {}).slice(0, 32)) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || value === undefined) continue;
    if (/(authorization|cookie|api[_-]?key|password|secret|token)/i.test(key)) result[key] = "[REDACTED]";
    else if (typeof value === "string") result[key] = value.slice(0, 200);
    else if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (typeof value === "boolean") result[key] = value;
  }
  return result;
}

export class TraceContext implements TelemetryContext {
  private readonly startedAt = process.hrtime.bigint();
  private attributes: Record<string, string | number | boolean>;
  private status: TraceSpan["status"] = "ok";
  private errorType: string | undefined;
  private errorMessage: string | undefined;
  private ended = false;
  private readonly children = new Set<TraceContext>();

  constructor(
    private readonly database: UmaDatabase,
    private readonly traceId: string,
    private readonly spanId: string,
    private readonly parentSpanId: string | undefined,
    private readonly runId: string,
    private readonly sessionId: string,
    private readonly name: string,
    private readonly kind: string,
    attributes?: SpanAttributes,
  ) {
    this.attributes = safeAttributes(attributes);
  }

  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    const child = this.child(options.name, "internal", options.attributes);
    return Promise.resolve()
      .then(() => callback(child))
      .then(
        (value) => {
          child.finish({ status: "ok" });
          return value;
        },
        (error: unknown) => {
          const value = error instanceof Error ? error : new Error(String(error));
          child.finish({ status: "error", error: { name: value.name, message: value.message } });
          throw error;
        },
      );
  }

  child(name: string, kind: string, attributes?: SpanAttributes): TraceContext {
    if (this.ended) throw new Error(`Trace span is already ended: ${this.spanId}`);
    const child = new TraceContext(
      this.database,
      this.traceId,
      randomUUID(),
      this.spanId,
      this.runId,
      this.sessionId,
      name,
      kind,
      attributes,
    );
    this.children.add(child);
    return child;
  }

  addEvent(name: string, attributes?: SpanAttributes): void {
    this.attributes[`event.${name}`] = JSON.stringify(safeAttributes(attributes)).slice(0, 200);
  }

  setAttributes(attributes: SpanAttributes): void {
    this.attributes = { ...this.attributes, ...safeAttributes(attributes) };
  }

  setStatus(status: SpanStatus | { status: "cancelled" }): void {
    this.status = status.status === "cancelled" ? "cancelled" : status.status === "error" ? "error" : "ok";
    this.errorType = status.status === "error" ? status.error?.name : undefined;
    this.errorMessage = status.status === "error" ? status.error?.message.slice(0, 2_000) : undefined;
  }

  finish(status?: SpanStatus | { status: "cancelled" }): void {
    if (this.ended) return;
    for (const child of this.children) {
      if (!child.ended)
        child.finish({
          status: "error",
          error: { name: "IncompleteSpan", message: "Parent span ended before child span" },
        });
    }
    if (status) this.setStatus(status);
    this.ended = true;
    const endedAt = Date.now();
    const durationMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - this.startedAt) / 1_000_000));
    this.database.insertTraceSpan({
      traceId: this.traceId,
      spanId: this.spanId,
      ...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
      runId: this.runId,
      sessionId: this.sessionId,
      name: this.name,
      kind: this.kind,
      status: this.status,
      startedAt: endedAt - durationMs,
      durationMs,
      attributes: this.attributes,
      ...(this.errorType ? { errorType: this.errorType } : {}),
      ...(this.errorMessage ? { errorMessage: this.errorMessage } : {}),
      endedAt,
    });
  }
}

export class TraceService {
  constructor(private readonly database: UmaDatabase) {}
  startRoot(runId: string, sessionId: string, name = "run", attributes?: SpanAttributes): TraceContext {
    return new TraceContext(
      this.database,
      randomUUID(),
      randomUUID(),
      undefined,
      runId,
      sessionId,
      name,
      "run",
      attributes,
    );
  }
}
