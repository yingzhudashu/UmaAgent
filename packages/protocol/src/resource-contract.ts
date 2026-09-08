import Type, { type Static } from "typebox";
import { Id, Strict, Timestamp } from "./schema-helpers.js";

/** 资源样本使用实际采样时长；cpuPercent 已按可用逻辑核数归一化。 */
export const ResourceSnapshotSchema = Strict({
  id: Id,
  capturedAt: Timestamp,
  cpuUserMicros: Type.Integer({ minimum: 0 }),
  cpuSystemMicros: Type.Integer({ minimum: 0 }),
  sampleDurationMs: Type.Number({ minimum: 0 }),
  cpuPercent: Type.Number({ minimum: 0 }),
  rssBytes: Type.Integer({ minimum: 0 }),
  heapUsedBytes: Type.Integer({ minimum: 0 }),
  heapTotalBytes: Type.Integer({ minimum: 0 }),
  externalBytes: Type.Integer({ minimum: 0 }),
  arrayBuffersBytes: Type.Integer({ minimum: 0 }),
  eventLoopDelayMs: Type.Number({ minimum: 0 }),
  walBytes: Type.Integer({ minimum: 0 }),
  activeRuns: Type.Integer({ minimum: 0 }),
  queuedRuns: Type.Integer({ minimum: 0 }),
});
export type ResourceSnapshot = Static<typeof ResourceSnapshotSchema>;
