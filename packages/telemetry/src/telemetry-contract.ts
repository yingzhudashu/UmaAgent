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
  /** 服务端普通用户查询时，仅展开指定 Run 的 Span 子树。 */
  scopeToRun?: boolean;
};

export type TelemetrySpanPage = {
  spans: TelemetrySpanRecord[];
  hasMore: boolean;
  nextOffset: number;
  depthBySpanId: Record<string, number>;
  rootSpanId?: string;
};

export type TelemetrySummary = {
  spans: number;
  incomplete: number;
  active: number;
  errorRate: number;
  writeFailures: number;
  otlpExportFailures: number;
  orphanParentChains: number;
  retries: number;
  errorTypes: Array<{ type: string; count: number }>;
  queueWait: { count: number; p50: number; p95: number; p99: number };
  resources: {
    samples: number;
    cpuAverageCorePercent: number;
    cpuPeakCorePercent: number;
    rssPeakBytes: number;
    walPeakBytes: number;
    eventLoopDelayP95Ms: number;
  };
  services: Array<{ service: string; spans: number; errors: number }>;
  stageLatencyMs: Record<string, { p50: number; p95: number; p99: number }>;
  latencyMs: { p50: number; p95: number; p99: number };
};

export type ResourceSample = {
  id: string;
  service?: string;
  capturedAt: number;
  cpuUserMicros: number;
  cpuSystemMicros: number;
  sampleDurationMs: number;
  cpuPercent: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  eventLoopDelayMs: number;
  walBytes: number;
  activeRuns: number;
  queuedRuns: number;
};

export function spanTree(
  rows: Array<Record<string, unknown>>,
  firstSpanId?: string,
): { depthBySpanId: Record<string, number>; rootSpanId?: string } {
  const depths: Record<string, number> = {};
  for (const row of rows) {
    const origin = String(row.origin_span_id);
    depths[origin] = Math.max(depths[origin] ?? 0, Number(row.depth ?? 0));
  }
  const root = firstSpanId
    ? rows.find((row) => String(row.origin_span_id) === firstSpanId && row.parent_span_id == null)
    : undefined;
  return {
    depthBySpanId: depths,
    ...(root ? { rootSpanId: String(root.span_id) } : {}),
  };
}

export function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil((percentileValue / 100) * ordered.length) - 1)] ?? 0;
}
