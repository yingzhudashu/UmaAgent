import type { SpanAttributes, TelemetryContext } from "@earendil-works/pi-telemetry";
import type { TraceQuery, TraceQueryPage, TraceSpan } from "@uma-agent/protocol";
import {
  TraceService as SharedTraceService,
  type TelemetrySpanQuery,
  TelemetryStore,
  type TraceParent,
  type TraceSpanContext,
  telemetryDirectory,
} from "@uma-agent/telemetry";
import type { UmaDatabase } from "./database.js";

export type TraceContext = TraceSpanContext;
export type QueuedTrace = {
  root: TraceContext;
  run<T>(operation: (root: TraceContext) => Promise<T>): Promise<T>;
};

export class TraceService extends SharedTraceService {
  override readonly store: TelemetryStore;
  private readonly queuedWaits = new Map<string, TraceContext>();
  constructor(database: UmaDatabase) {
    const store = new TelemetryStore(telemetryDirectory(database.stateDir), "core");
    super(store, "core");
    this.store = store;
  }
  override startRoot(
    runId: string,
    sessionId: string,
    name = "run",
    attributes?: SpanAttributes,
    parent?: TraceParent,
  ): TraceContext {
    return super.startRoot(runId, sessionId, name, attributes, parent);
  }
  startQueued(
    runId: string,
    sessionId: string,
    name: string,
    attributes: SpanAttributes,
    parent?: TraceParent,
  ): QueuedTrace {
    const root = this.startRoot(runId, sessionId, name, attributes, parent);
    const wait = root.child("queue.wait", "queue");
    this.queuedWaits.set(runId, wait);
    const service = this;
    return {
      root,
      run(operation) {
        wait.finish({ status: "ok" });
        service.queuedWaits.delete(runId);
        return operation(root);
      },
    };
  }
  cancelQueued(runId: string): void {
    const wait = this.queuedWaits.get(runId);
    wait?.finish({
      status: "error",
      error: { name: "RunCancelled", message: "Cancelled before execution" },
    });
    this.queuedWaits.delete(runId);
  }
  listTrace(query: TraceQuery): TraceQueryPage {
    const page = this.store.listSpans(query as TelemetrySpanQuery);
    const spans: TraceSpan[] = page.spans
      .filter((span) => span.status !== "active")
      .map((span) => ({
        traceId: span.traceId,
        spanId: span.spanId,
        ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
        ...(span.runId ? { runId: span.runId } : {}),
        ...(span.sessionId ? { sessionId: span.sessionId } : {}),
        service: span.service,
        name: span.name,
        kind: span.kind,
        status: span.status as TraceSpan["status"],
        startedAt: span.startedAt,
        durationMs: span.durationMs ?? 0,
        attributes: span.attributes,
        ...(span.errorType ? { errorType: span.errorType } : {}),
        ...(span.errorMessage ? { errorMessage: span.errorMessage } : {}),
        events: span.events,
        endedAt: span.endedAt ?? span.startedAt + (span.durationMs ?? 0),
      }));
    const linkedSessionId = spans.find((span) => span.sessionId)?.sessionId;
    return {
      traceId: spans[0]?.traceId ?? query.traceId ?? "",
      ...(query.runId ? { runId: query.runId } : spans[0]?.runId ? { runId: spans[0].runId } : {}),
      ...(linkedSessionId ? { sessionId: linkedSessionId } : {}),
      spans,
      hasMore: page.hasMore,
      nextOffset: page.nextOffset,
    };
  }
}

export type { TelemetryContext };
