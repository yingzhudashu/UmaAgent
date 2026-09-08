import { mkdtemp, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { TelemetryStore } from "@uma-agent/telemetry";
import { afterEach, expect, it, vi } from "vitest";
import { UmaDatabase } from "../src/database.js";
import { ResourceMonitor } from "../src/resource-monitor.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("persists normalized CPU, combined WAL and stops its periodic sampler", async () => {
  const root = await mkdtemp(join(tmpdir(), "uma-resource-monitor-"));
  const database = new UmaDatabase(root);
  const store = new TelemetryStore(root, "core");
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const monitor = new ResourceMonitor(store, database, () => 2);
  try {
    monitor.start();
    const [sample] = store.listResources();
    if (!sample) throw new Error("Missing resource sample");
    expect(sample).toMatchObject({ activeRuns: 2, queuedRuns: 0 });
    expect(sample.sampleDurationMs).toBeGreaterThan(0);
    expect(sample.walBytes).toBeGreaterThan(0);
    expect(sample.cpuPercent).toBeCloseTo(
      ((sample.cpuUserMicros + sample.cpuSystemMicros) /
        (sample.sampleDurationMs * 1_000 * availableParallelism())) *
        100,
    );
    vi.advanceTimersByTime(30_000);
    expect(store.listResources()).toHaveLength(2);
    monitor.stop();
    vi.advanceTimersByTime(60_000);
    expect(store.listResources()).toHaveLength(2);
  } finally {
    monitor.stop();
    await store.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
