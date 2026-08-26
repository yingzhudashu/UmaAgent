import type { SpanAttributes, TelemetryContext } from "@earendil-works/pi-telemetry";
import {
  TraceService as SharedTraceService,
  TelemetryStore,
  type TraceSpanContext,
} from "@uma-agent/telemetry";
import type { UmaDatabase } from "./database.js";

export type TraceContext = TraceSpanContext;

export class TraceService extends SharedTraceService {
  override readonly store: TelemetryStore;
  constructor(database: UmaDatabase) {
    const store = new TelemetryStore(database.stateDir, "core", (record) => {
      if (record.status === "active") return;
      database.insertTraceSpan({
        traceId: record.traceId,
        spanId: record.spanId,
        ...(record.parentSpanId ? { parentSpanId: record.parentSpanId } : {}),
        runId: record.runId ?? "unknown",
        sessionId: record.sessionId ?? "unknown",
        name: record.name,
        kind: record.kind,
        status: record.status === "cancelled" ? "cancelled" : record.status === "error" ? "error" : "ok",
        startedAt: record.startedAt,
        durationMs: record.durationMs ?? 0,
        attributes: record.attributes,
        ...(record.errorType ? { errorType: record.errorType } : {}),
        ...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
        endedAt: record.endedAt ?? Date.now(),
      });
    });
    super(store, "core");
    this.store = store;
  }
  override startRoot(
    runId: string,
    sessionId: string,
    name = "run",
    attributes?: SpanAttributes,
  ): TraceContext {
    return super.startRoot(runId, sessionId, name, attributes);
  }
}

export type { TelemetryContext };
