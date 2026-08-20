import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Session } from "@uma-agent/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generateSummary: vi.fn() }));
vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
  return {
    ...original,
    estimateContextTokens: (messages: AgentMessage[]) => ({ tokens: messages.length * 100 }),
    generateSummary: mocks.generateSummary,
  };
});

import { ContextManager } from "../src/context-manager.js";

const session: Session = {
  id: "session-1",
  mode: "assistant",
  title: "context",
  model: { provider: "test", id: "model" },
  thinkingLevel: "off",
  createdAt: 1,
  updatedAt: 1,
};
const model = { provider: "test", id: "model", contextWindow: 1_000 } as Model<"openai-responses">;
const entries = Array.from({ length: 10 }, (_, index) => ({
  sequence: index + 1,
  message: { role: "user", content: `message ${index + 1}`, timestamp: index + 1 } as AgentMessage,
}));

function fixture(summary?: { throughSequence: number; content: string; updatedAt: number }) {
  const database = {
    getContextSummary: vi.fn(() => summary),
    putContextSummary: vi.fn((_sessionId: string, throughSequence: number, content: string) => ({
      sessionId: "session-1",
      throughSequence,
      content,
      updatedAt: 10,
    })),
  };
  const models = { get: vi.fn(() => model), models: {} };
  return { manager: new ContextManager(database as never, models as never), database, models };
}

describe("ContextManager", () => {
  beforeEach(() => mocks.generateSummary.mockReset());

  it("returns pending messages below threshold and carries an existing summary", async () => {
    const existing = { throughSequence: 5, content: "previous", updatedAt: 5 };
    const { manager } = fixture(existing);
    const result = await manager.compact(session, entries, new AbortController().signal);
    expect(result.summary).toBe(existing);
    expect(result.messages).toHaveLength(5);
    expect(mocks.generateSummary).not.toHaveBeenCalled();
  });

  it("does not compact fewer than six pending messages even when forced", async () => {
    const { manager } = fixture();
    const result = await manager.compact(
      session,
      entries.slice(0, 5),
      new AbortController().signal,
      true,
      model,
    );
    expect(result.messages).toHaveLength(5);
    expect(mocks.generateSummary).not.toHaveBeenCalled();
  });

  it("persists a successful summary and retains the recent token tail", async () => {
    mocks.generateSummary.mockResolvedValueOnce({ ok: true, value: "new summary" });
    const { manager, database } = fixture();
    const result = await manager.compact(session, entries, new AbortController().signal, true);
    expect(database.putContextSummary).toHaveBeenCalledWith("session-1", 8, "new summary");
    expect(result.summary).toMatchObject({ throughSequence: 8, content: "new summary" });
    expect(result.messages).toHaveLength(2);
  });

  it("keeps the original context when summary generation declines or throws", async () => {
    mocks.generateSummary.mockResolvedValueOnce({ ok: false, error: "declined" });
    const first = fixture();
    expect(
      (await first.manager.compact(session, entries, new AbortController().signal, true)).messages,
    ).toHaveLength(10);
    mocks.generateSummary.mockRejectedValueOnce(new Error("provider unavailable"));
    const second = fixture();
    expect(
      (await second.manager.compact(session, entries, new AbortController().signal, true)).messages,
    ).toHaveLength(10);
  });

  it("avoids a summary when nearly all messages must be retained", async () => {
    const large = { ...model, contextWindow: 100_000 } as Model<"openai-responses">;
    const { manager } = fixture();
    const result = await manager.compact(session, entries, new AbortController().signal, true, large);
    expect(result.messages).toHaveLength(10);
    expect(mocks.generateSummary).not.toHaveBeenCalled();
  });
});
