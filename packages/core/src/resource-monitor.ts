import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { ResourceSnapshot } from "@uma-agent/protocol";
import type { TelemetryStore } from "@uma-agent/telemetry";
import type { UmaDatabase } from "./database.js";

/** 采样生命周期独立于业务编排；不持有 Run、请求或模型正文。 */
export class ResourceMonitor {
  private timer: NodeJS.Timeout | undefined;
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private previousCpu = process.cpuUsage();
  private previousResourceTime = performance.now();

  constructor(
    private readonly store: TelemetryStore,
    private readonly database: UmaDatabase,
    private readonly activeRuns: () => number,
  ) {}

  start(): void {
    this.eventLoopDelay.enable();
    this.timer = setInterval(() => this.capture(), 30_000);
    this.capture();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.eventLoopDelay.disable();
  }

  capture(): void {
    try {
      const currentCpu = process.cpuUsage();
      const now = performance.now();
      const sampleDurationMs = now - this.previousResourceTime;
      const cpuUserMicros = Math.max(0, currentCpu.user - this.previousCpu.user);
      const cpuSystemMicros = Math.max(0, currentCpu.system - this.previousCpu.system);
      this.previousCpu = currentCpu;
      this.previousResourceTime = now;
      const memory = process.memoryUsage();
      let walBytes = 0;
      try {
        // 资源报告包含业务与遥测两份 WAL，防止将写入转移到遥测库后低估磁盘占用。
        walBytes = statSync(join(this.database.stateDir, "state.db-wal")).size;
      } catch {
        /* WAL may be checkpointed. */
      }
      try {
        walBytes += statSync(join(this.store.stateDir, "telemetry.db-wal")).size;
      } catch {
        /* telemetry WAL may be checkpointed independently. */
      }
      const queuedRuns = this.database.queuedRunCount();
      const snapshot: ResourceSnapshot = {
        id: randomUUID(),
        capturedAt: Date.now(),
        cpuUserMicros,
        cpuSystemMicros,
        sampleDurationMs,
        // CPU 时间按单调时钟采样区间和可用逻辑核数归一化，避免把微秒误当百分比。
        cpuPercent:
          ((cpuUserMicros + cpuSystemMicros) / (sampleDurationMs * 1_000 * availableParallelism())) * 100,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
        eventLoopDelayMs: Number(this.eventLoopDelay.mean / 1e6 || 0),
        walBytes,
        activeRuns: this.activeRuns(),
        queuedRuns,
      };
      this.store.recordResource(snapshot);
      this.eventLoopDelay.reset();
    } catch (error) {
      process.emitWarning(
        `Resource snapshot failed: ${error instanceof Error ? error.name : "UnknownError"}`,
        {
          code: "UMA_RESOURCE_SNAPSHOT",
        },
      );
    }
  }
}
