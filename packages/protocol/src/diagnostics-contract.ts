import Type, { type Static } from "typebox";
import { Id, Strict, Timestamp } from "./schema-helpers.js";

export const OperationsReportSchema = Strict({
  from: Timestamp,
  to: Timestamp,
  runs: Strict({
    total: Type.Integer({ minimum: 0 }),
    completed: Type.Integer({ minimum: 0 }),
    failed: Type.Integer({ minimum: 0 }),
    cancelled: Type.Integer({ minimum: 0 }),
    interrupted: Type.Integer({ minimum: 0 }),
  }),
  model: Strict({
    calls: Type.Integer({ minimum: 0 }),
    failed: Type.Integer({ minimum: 0 }),
    totalTokens: Type.Integer({ minimum: 0 }),
    averageDurationMs: Type.Number({ minimum: 0 }),
  }),
  tools: Strict({
    calls: Type.Integer({ minimum: 0 }),
    failed: Type.Integer({ minimum: 0 }),
  }),
  approvals: Strict({ requested: Type.Integer({ minimum: 0 }), denied: Type.Integer({ minimum: 0 }) }),
  recoveries: Type.Integer({ minimum: 0 }),
});
export type OperationsReport = Static<typeof OperationsReportSchema>;

export const DiagnosticsReportSchema = Strict({
  from: Timestamp,
  to: Timestamp,
  summary: OperationsReportSchema,
  slowModels: Type.Array(
    Strict({
      provider: Id,
      model: Id,
      calls: Type.Integer({ minimum: 0 }),
      averageDurationMs: Type.Number({ minimum: 0 }),
    }),
  ),
  toolFailures: Type.Array(
    Strict({ tool: Id, failures: Type.Integer({ minimum: 0 }), latestError: Type.Optional(Type.String()) }),
  ),
  recoveryFrequency: Type.Number({ minimum: 0 }),
  approvalBottlenecks: Type.Array(
    Strict({ tool: Id, requested: Type.Integer({ minimum: 0 }), denied: Type.Integer({ minimum: 0 }) }),
  ),
  trace: Strict({
    spans: Type.Integer({ minimum: 0 }),
    incomplete: Type.Integer({ minimum: 0 }),
    active: Type.Integer({ minimum: 0 }),
    errorRate: Type.Number({ minimum: 0, maximum: 1 }),
    writeFailures: Type.Integer({ minimum: 0 }),
    otlpExportFailures: Type.Integer({ minimum: 0 }),
    orphanParentChains: Type.Integer({ minimum: 0 }),
    retries: Type.Integer({ minimum: 0 }),
    errorTypes: Type.Array(
      Strict({ type: Type.String({ minLength: 1, maxLength: 200 }), count: Type.Integer({ minimum: 0 }) }),
    ),
    queueWait: Strict({
      count: Type.Integer({ minimum: 0 }),
      p50: Type.Number({ minimum: 0 }),
      p95: Type.Number({ minimum: 0 }),
      p99: Type.Number({ minimum: 0 }),
    }),
    resources: Strict({
      samples: Type.Integer({ minimum: 0 }),
      cpuAverageCorePercent: Type.Number({ minimum: 0 }),
      cpuPeakCorePercent: Type.Number({ minimum: 0 }),
      rssPeakBytes: Type.Integer({ minimum: 0 }),
      walPeakBytes: Type.Integer({ minimum: 0 }),
      eventLoopDelayP95Ms: Type.Number({ minimum: 0 }),
    }),
    services: Type.Array(
      Strict({
        service: Type.String({ minLength: 1, maxLength: 100 }),
        spans: Type.Integer({ minimum: 0 }),
        errors: Type.Integer({ minimum: 0 }),
      }),
    ),
    stageLatencyMs: Type.Record(
      Type.String({ minLength: 1 }),
      Strict({
        p50: Type.Number({ minimum: 0 }),
        p95: Type.Number({ minimum: 0 }),
        p99: Type.Number({ minimum: 0 }),
      }),
    ),
    latencyMs: Strict({
      p50: Type.Number({ minimum: 0 }),
      p95: Type.Number({ minimum: 0 }),
      p99: Type.Number({ minimum: 0 }),
    }),
  }),
});
export type DiagnosticsReport = Static<typeof DiagnosticsReportSchema>;
