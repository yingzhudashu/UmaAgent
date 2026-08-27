import "fake-indexeddb/auto";
import type { SessionSnapshot, TranscriptItem } from "@uma-agent/protocol";
import { describe, expect, it } from "vitest";
import {
  cacheCursor,
  cachedCursor,
  cachedHistory,
  cachedSnapshot,
  cacheHistory,
  cacheSnapshot,
} from "../src/cache.js";

const snapshot = (id: string, sequence: number): SessionSnapshot => ({
  session: {
    id,
    title: "Cached",
    model: { provider: "test", id: "model" },
    thinkingLevel: "off",
    createdAt: 1,
    updatedAt: 1,
  },
  transcript: [],
  recentRuns: [],
  pendingApprovals: [],
  snapshotSequence: sequence,
  history: { oldestMessageSequence: 0, hasMoreBefore: false },
});

describe("Web offline cache", () => {
  it("stores bounded snapshots and never moves a durable cursor backwards", async () => {
    const id = crypto.randomUUID();
    await cacheCursor(id, 12);
    await cacheSnapshot(snapshot(id, 7));
    expect(await cachedCursor(id)).toBe(12);
    expect((await cachedSnapshot(id))?.session.id).toBe(id);
  });

  it("writes a snapshot and its cursor as one cache transaction", async () => {
    const id = crypto.randomUUID();
    await cacheSnapshot(snapshot(id, 21));
    await cacheSnapshot({
      ...snapshot(id, 7),
      session: { ...snapshot(id, 7).session, title: "Stale" },
    });
    expect(await cachedSnapshot(id)).toMatchObject({ snapshotSequence: 21 });
    expect((await cachedSnapshot(id))?.session.title).toBe("Cached");
    expect(await cachedCursor(id)).toBe(21);
  });

  it("persists explicitly loaded history pages for offline reading", async () => {
    const id = crypto.randomUUID();
    const item: TranscriptItem = {
      id: "message-1",
      sequence: 1,
      role: "user",
      status: "complete",
      content: "offline history",
      attachments: [],
      createdAt: 1,
      updatedAt: 1,
    };
    await cacheHistory(id, [item]);
    expect(await cachedHistory(id)).toEqual([item]);
  });
});
