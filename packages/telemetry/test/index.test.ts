import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatTraceparent,
  parseTraceparent,
  redactErrorMessage,
  TelemetryStore,
  TraceService,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("TelemetryStore", () => {
  it("parses and formats strict W3C traceparent values", () => {
    const value = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";
    expect(parseTraceparent(value)).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
    });
    expect(
      formatTraceparent(parseTraceparent(value) as NonNullable<ReturnType<typeof parseTraceparent>>),
    ).toBe(value.toLowerCase());
    expect(parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeUndefined();
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01")).toBeUndefined();
    expect(parseTraceparent("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeUndefined();
    expect(parseTraceparent("00-not-a-trace-00f067aa0ba902b7-01")).toBeUndefined();
  });

  it("continues a parent trace with standard hexadecimal identifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-telemetry-parent-"));
    roots.push(root);
    const store = new TelemetryStore(root, "test");
    const trace = new TraceService(store, "test");
    const span = trace.startRoot("run-1", "session-1", "run", undefined, {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
    });
    expect(span.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    span.finish({ status: "ok" });
    expect(store.listSpans({ runId: "run-1" }).spans[0]).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentSpanId: "00f067aa0ba902b7",
    });
    await store.close();
  });

  it("returns cross-service spans linked to a Run through their shared trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-telemetry-linked-"));
    roots.push(root);
    const store = new TelemetryStore(root, "test");
    store.linkRun("run-1", "trace-shared");
    for (const [spanId, service, runId] of [
      ["server-span", "server", undefined],
      ["core-span", "core", "run-1"],
      ["browser-span", "browser-worker", undefined],
    ] as const) {
      store.start({
        traceId: "trace-shared",
        spanId,
        service,
        ...(runId ? { runId } : {}),
        name: service,
        kind: "test",
        startedAt: 1,
        attributes: {},
      });
      store.finish({
        traceId: "trace-shared",
        spanId,
        service,
        ...(runId ? { runId } : {}),
        name: service,
        kind: "test",
        status: "ok",
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
        attributes: {},
        events: [],
      });
    }
    expect(
      store
        .listSpans({ runId: "run-1" })
        .spans.map((span) => span.service)
        .sort(),
    ).toEqual(["browser-worker", "core", "server"]);
    await store.close();
  });

  it("persists bounded, redacted spans and supports filtered pagination", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-telemetry-"));
    roots.push(root);
    const store = new TelemetryStore(root, "test");
    store.start({
      traceId: "trace-1",
      spanId: "span-1",
      runId: "run-1",
      sessionId: "session-1",
      service: "test",
      name: "tool.call",
      kind: "tool",
      startedAt: 10,
      attributes: { authorization: "secret", safe: "value" },
    });
    store.finish({
      traceId: "trace-1",
      spanId: "span-1",
      runId: "run-1",
      sessionId: "session-1",
      service: "test",
      name: "tool.call",
      kind: "tool",
      status: "ok",
      startedAt: 10,
      endedAt: 20,
      durationMs: 10,
      attributes: { authorization: "secret", safe: "value" },
      events: [{ name: "checkpoint", occurredAt: 15, attributes: { token: "secret", safe: "event" } }],
    });
    const page = store.listSpans({ runId: "run-1", limit: 1 });
    expect(page.hasMore).toBe(false);
    expect(page.spans[0]).toMatchObject({
      status: "ok",
      attributes: { authorization: "[REDACTED]", safe: "value" },
      events: [
        {
          name: "checkpoint",
          occurredAt: 15,
          attributes: { token: "[REDACTED]", safe: "event" },
        },
      ],
    });
    expect(store.summarize(0, 100)).toEqual({
      spans: 1,
      incomplete: 0,
      active: 0,
      errorRate: 0,
      writeFailures: 0,
      otlpExportFailures: 0,
      services: [{ service: "test", spans: 1, errors: 0 }],
      stageLatencyMs: { tool: { p50: 10, p95: 10, p99: 10 } },
      latencyMs: { p50: 10, p95: 10, p99: 10 },
    });
    await store.close();
  });

  it("redacts secrets embedded in error messages without hiding ordinary diagnostics", async () => {
    expect(
      redactErrorMessage(
        'request failed: Authorization: Bearer abc.def; cookie: sid=private; api_key="secret-value" prompt="private prompt" https://example.test/?token=query-secret sk-test-secret-value',
      ),
    ).toBe(
      "request failed: Authorization: [REDACTED]; cookie: [REDACTED]; api_key=[REDACTED] prompt=[REDACTED] https://example.test/?token=[REDACTED] [REDACTED]",
    );
    expect(redactErrorMessage("ECONNRESET while calling provider")).toBe("ECONNRESET while calling provider");

    const root = await mkdtemp(join(tmpdir(), "uma-telemetry-errors-"));
    roots.push(root);
    const store = new TelemetryStore(root, "test");
    store.start({
      traceId: "trace-error",
      spanId: "span-error",
      service: "test",
      name: "request",
      kind: "http",
      startedAt: 1,
      attributes: {},
    });
    store.finish({
      traceId: "trace-error",
      spanId: "span-error",
      service: "test",
      name: "request",
      kind: "http",
      status: "error",
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
      attributes: {},
      errorType: "ProviderError",
      errorMessage: "Bearer abc.def; api_key=secret-value; ECONNRESET",
      events: [],
    });
    const span = store.listSpans({ traceId: "trace-error" }).spans[0];
    expect(span?.errorMessage).toBe("[REDACTED]; api_key=[REDACTED]; ECONNRESET");
    const stored = store.db.prepare("SELECT error_message FROM spans WHERE span_id=?").get("span-error") as {
      error_message?: unknown;
    };
    expect(String(stored.error_message ?? "")).not.toContain("abc.def");
    await store.close();
  });

  it("finishes a span at most once even when the store API is called repeatedly", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-telemetry-idempotent-"));
    roots.push(root);
    const store = new TelemetryStore(root, "test");
    const record = {
      traceId: "trace-idempotent",
      spanId: "span-idempotent",
      service: "test",
      name: "request",
      kind: "http",
      status: "ok" as const,
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
      attributes: {},
      events: [{ name: "done", occurredAt: 2, attributes: {} }],
    };
    store.start(record);
    store.finish(record);
    store.finish(record);
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM span_events").get()).toEqual({ count: 1 });
    expect(store.summarize(0, 10).spans).toBe(1);
    await store.close();
  });

  it("computes overall and per-kind percentiles in one consistent rank order", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-telemetry-percentiles-"));
    roots.push(root);
    const store = new TelemetryStore(root, "test");
    const spans = [
      ["a-1", "a", 1],
      ["a-2", "a", 5],
      ["a-3", "a", 9],
      ["b-1", "b", 2],
      ["b-2", "b", 8],
    ] as const;
    for (const [spanId, kind, duration] of spans) {
      store.start({
        traceId: "trace-percentiles",
        spanId,
        service: "test",
        name: kind,
        kind,
        startedAt: 1,
        attributes: {},
      });
      store.finish({
        traceId: "trace-percentiles",
        spanId,
        service: "test",
        name: kind,
        kind,
        status: "ok",
        startedAt: 1,
        endedAt: duration + 1,
        durationMs: duration,
        attributes: {},
        events: [],
      });
    }
    expect(store.summarize(0, 10)).toMatchObject({
      latencyMs: { p50: 5, p95: 9, p99: 9 },
      stageLatencyMs: {
        a: { p50: 5, p95: 9, p99: 9 },
        b: { p50: 2, p95: 8, p99: 8 },
      },
    });
    await store.close();
  });

  it("marks active spans incomplete when the service reopens", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-telemetry-restart-"));
    roots.push(root);
    const first = new TelemetryStore(root, "test");
    first.start({
      traceId: "trace-2",
      spanId: "span-2",
      service: "test",
      name: "request",
      kind: "http",
      startedAt: 1,
      attributes: {},
    });
    await first.close();
    const second = new TelemetryStore(root, "test");
    const page = second.listSpans({ traceId: "trace-2" });
    expect(page.spans[0]).toMatchObject({ status: "error", errorType: "IncompleteSpan" });
    await second.close();
  });

  it("aggregates and removes expired spans without loading them into application memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-telemetry-maintain-"));
    roots.push(root);
    const store = new TelemetryStore(root, "test");
    store.start({
      traceId: "trace-old",
      spanId: "span-old",
      service: "test",
      name: "old",
      kind: "run",
      startedAt: 1,
      attributes: {},
    });
    store.finish({
      traceId: "trace-old",
      spanId: "span-old",
      service: "test",
      name: "old",
      kind: "run",
      status: "ok",
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
      attributes: {},
      events: [],
    });
    store.maintain(100 * 86_400_000);
    expect(store.listSpans({ traceId: "trace-old" }).spans).toEqual([]);
    expect(
      store.db.prepare("SELECT count,total_duration_ms FROM span_aggregates WHERE name='old'").get(),
    ).toEqual({ count: 1, total_duration_ms: 1 });
    await store.close();
  });
});
