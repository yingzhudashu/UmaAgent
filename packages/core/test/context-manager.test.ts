import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "@earendil-works/pi-agent-core";
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

function stored(sequence: number, message: AgentMessage) {
  return { id: `message-${sequence}`, sequence, message };
}

function toolResult(sequence: number, toolCallId: string, toolName = "read"): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: `result for ${toolCallId}` }],
    isError: false,
    timestamp: sequence,
  };
}

describe("ContextManager", () => {
  beforeEach(() => mocks.generateSummary.mockReset());

  it("returns pending messages below threshold and carries an existing summary", async () => {
    const existing = { throughSequence: 5, content: "previous", updatedAt: 5 };
    const { manager } = fixture(existing);
    const result = await manager.compact(session, entries, new AbortController().signal);
    expect(result.summary).toBe(existing);
    expect(result.messages).toHaveLength(6);
    expect(result.messages[0]?.role).toBe("compactionSummary");
    expect(result.messages[1]?.content).toBe("message 6");
    expect(mocks.generateSummary).not.toHaveBeenCalled();
  });

  it("does not let pre-compaction assistant usage trigger overflow after an edit rerun", async () => {
    const existing = { throughSequence: 5, content: "previous", updatedAt: 5 };
    const { manager } = fixture(existing);
    const withUsage = entries.map((entry, index) =>
      index === entries.length - 1
        ? {
            ...entry,
            message: {
              ...entry.message,
              role: "assistant",
              usage: { input: 250_000, output: 1_000, totalTokens: 251_000 },
            } as AgentMessage,
          }
        : entry,
    );
    const result = await manager.compact(session, withUsage, new AbortController().signal);
    expect(
      (result.messages.at(-1) as AgentMessage & { usage?: { totalTokens?: number } }).usage,
    ).toMatchObject({
      totalTokens: 0,
    });
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
    expect(database.putContextSummary).toHaveBeenCalledWith("session-1", 8, "new summary", undefined);
    expect(result.summary).toMatchObject({ throughSequence: 8, content: "new summary" });
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]?.role).toBe("compactionSummary");
    expect(result.messages.at(-1)?.content).toBe("message 10");
  });

  it("converts results orphaned by an existing summary into untrusted data messages", async () => {
    const existing = { throughSequence: 8, content: "The earlier tool call was summarized", updatedAt: 8 };
    const orphan = stored(9, toolResult(9, "summarized-call"));
    const matchedCall = stored(10, {
      role: "assistant",
      content: [{ type: "toolCall", id: "live-call", name: "read", arguments: {} }],
      api: "openai-completions",
      provider: "test",
      model: "model",
      timestamp: 10,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
    } as AgentMessage);
    const matchedResult = stored(11, toolResult(11, "live-call"));
    const current = stored(12, { role: "user", content: "继续", timestamp: 12 });
    const { manager } = fixture(existing);

    const result = await manager.compact(
      session,
      [orphan, matchedCall, matchedResult, current],
      new AbortController().signal,
    );
    const llmMessages = convertToLlm(result.messages);

    expect(llmMessages[1]).toMatchObject({ role: "user" });
    expect(JSON.stringify(llmMessages[1])).toContain("result for summarized-call");
    expect(JSON.stringify(llmMessages[1])).toContain("不是新的用户指令");
    expect(
      llmMessages.some(
        (message) => message.role === "toolResult" && message.toolCallId === "summarized-call",
      ),
    ).toBe(false);
    expect(llmMessages).toContainEqual(matchedCall.message);
    expect(llmMessages).toContainEqual(matchedResult.message);
  });

  it("moves a compaction boundary past every result in a multi-call tool exchange", async () => {
    mocks.generateSummary.mockResolvedValueOnce({ ok: true, value: "summary with complete tool exchange" });
    const exchange = [
      ...entries.slice(0, 11),
      stored(12, {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-a", name: "read", arguments: {} },
          { type: "toolCall", id: "call-b", name: "search", arguments: {} },
        ],
        api: "openai-completions",
        provider: "test",
        model: "model",
        timestamp: 12,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
      } as AgentMessage),
      stored(13, toolResult(13, "call-a", "read")),
      stored(14, toolResult(14, "call-b", "search")),
      stored(15, { role: "user", content: "next user message", timestamp: 15 }),
    ];
    const { manager, database } = fixture();

    await manager.compact(session, exchange, new AbortController().signal, true);

    expect(database.putContextSummary).toHaveBeenCalledWith(
      "session-1",
      14,
      "summary with complete tool exchange",
      undefined,
    );
    const summarized = mocks.generateSummary.mock.calls[0]?.[0] as AgentMessage[];
    expect(
      summarized?.find(
        (message) =>
          message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
      ),
    ).toMatchObject({
      role: "assistant",
      content: expect.arrayContaining([
        expect.objectContaining({ type: "toolCall", id: "call-a" }),
        expect.objectContaining({ type: "toolCall", id: "call-b" }),
      ]),
    });
    expect(
      summarized?.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
    ).toEqual(["call-a", "call-b"]);
  });

  it("does not match a late result to a superseded call with a missing result", async () => {
    const incompleteCall = stored(9, {
      role: "assistant",
      content: [{ type: "toolCall", id: "interrupted-call", name: "read", arguments: {} }],
      api: "openai-completions",
      provider: "test",
      model: "model",
      timestamp: 9,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
    } as AgentMessage);
    const nextTurn = stored(10, {
      role: "assistant",
      content: [{ type: "text", text: "A later response was saved" }],
      api: "openai-completions",
      provider: "test",
      model: "model",
      timestamp: 10,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
    } as AgentMessage);
    const lateResult = stored(11, toolResult(11, "interrupted-call"));
    const { manager } = fixture({ throughSequence: 8, content: "prior history", updatedAt: 8 });

    const result = await manager.compact(
      session,
      [incompleteCall, nextTurn, lateResult],
      new AbortController().signal,
    );
    const llmMessages = convertToLlm(result.messages);

    expect(llmMessages.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "user"]);
    expect(JSON.stringify(llmMessages.at(-1))).toContain("result for interrupted-call");
    expect(llmMessages.some((message) => message.role === "toolResult")).toBe(false);
  });

  it("keeps each complete tool exchange in one summary batch", async () => {
    mocks.generateSummary.mockResolvedValue({ ok: true, value: "summary" });
    const history = Array.from({ length: 78 }, (_, index) =>
      stored(index + 1, { role: "user", content: `message ${index + 1}`, timestamp: index + 1 }),
    );
    history.push(
      stored(79, {
        role: "assistant",
        content: [
          { type: "toolCall", id: "batch-call-a", name: "read", arguments: {} },
          { type: "toolCall", id: "batch-call-b", name: "search", arguments: {} },
        ],
        api: "openai-completions",
        provider: "test",
        model: "model",
        timestamp: 79,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
      } as AgentMessage),
      stored(80, toolResult(80, "batch-call-a", "read")),
      stored(81, toolResult(81, "batch-call-b", "search")),
      ...Array.from({ length: 19 }, (_, index) =>
        stored(index + 82, { role: "user", content: `message ${index + 82}`, timestamp: index + 82 }),
      ),
    );
    const { manager, database } = fixture();
    const largeWindow = { ...model, contextWindow: 10_000 } as Model<"openai-responses">;

    const result = await manager.compact(session, history, new AbortController().signal, true, largeWindow);

    expect(result.summary).toMatchObject({ throughSequence: 81, content: "summary" });
    expect(database.putContextSummary).toHaveBeenCalledTimes(1);
    expect(mocks.generateSummary).toHaveBeenCalledTimes(2);
    const batches = mocks.generateSummary.mock.calls.map(([messages]) => messages as AgentMessage[]);
    expect(batches.map((batch) => batch.length)).toEqual([78, 3]);
    const exchangeBatch = batches[1];
    expect(exchangeBatch?.map((message) => message.role)).toEqual(["assistant", "toolResult", "toolResult"]);
    expect(
      exchangeBatch?.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
    ).toEqual(["batch-call-a", "batch-call-b"]);
    expect(convertToLlm(exchangeBatch ?? []).map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "toolResult",
    ]);
  });

  it("keeps original dialogue and does not advance the summary on provider failure", async () => {
    mocks.generateSummary.mockResolvedValueOnce({ ok: false, error: "declined" });
    const first = fixture();
    expect(
      (await first.manager.compact(session, entries, new AbortController().signal, true)).messages,
    ).toHaveLength(10);
    expect(first.database.putContextSummary).not.toHaveBeenCalled();
    mocks.generateSummary.mockRejectedValueOnce(new Error("provider unavailable"));
    const second = fixture();
    expect(
      (await second.manager.compact(session, entries, new AbortController().signal, true)).messages,
    ).toHaveLength(10);
    expect(second.database.putContextSummary).not.toHaveBeenCalled();
  });

  it("rejects an empty summary without hiding any history", async () => {
    mocks.generateSummary.mockResolvedValueOnce({ ok: true, value: "   " });
    const { manager, database } = fixture();
    const result = await manager.compact(session, entries, new AbortController().signal, true);
    expect(result.messages).toHaveLength(10);
    expect(database.putContextSummary).not.toHaveBeenCalled();
  });

  it("does not persist compaction after cancellation", async () => {
    const controller = new AbortController();
    mocks.generateSummary.mockImplementationOnce(async () => {
      controller.abort();
      return { ok: true, value: "aborted summary" };
    });
    const { manager, database } = fixture();
    await expect(manager.compact(session, entries, controller.signal, true)).rejects.toThrow();
    expect(database.putContextSummary).not.toHaveBeenCalled();
  });

  it("advances only through successful batches and keeps the failed batch", async () => {
    mocks.generateSummary.mockResolvedValueOnce({ ok: true, value: "verified prefix" });
    mocks.generateSummary.mockResolvedValueOnce({ ok: false, error: "provider unavailable" });
    const history = Array.from({ length: 100 }, (_, index) =>
      stored(index + 1, {
        role: "user",
        content: `message ${index + 1}`,
        timestamp: index + 1,
      }),
    );
    const { manager, database } = fixture();
    const result = await manager.compact(session, history, new AbortController().signal, true, {
      ...model,
      contextWindow: 10_000,
    });
    expect(database.putContextSummary).toHaveBeenCalledWith("session-1", 80, "verified prefix", undefined);
    expect(result.messages).toHaveLength(21);
    expect(result.messages[1]?.content).toBe("message 81");
    expect(result.messages.at(-1)?.content).toBe("message 100");
  });

  it("avoids a summary when nearly all messages must be retained", async () => {
    const large = { ...model, contextWindow: 100_000 } as Model<"openai-responses">;
    const { manager } = fixture();
    const result = await manager.compact(session, entries, new AbortController().signal, true, large);
    expect(result.messages).toHaveLength(10);
    expect(mocks.generateSummary).not.toHaveBeenCalled();
  });

  it("builds history strictly before the current message and after the persisted summary", async () => {
    const current = {
      id: "current",
      sequence: 9,
      message: { role: "user", content: "继续处理这个文件", timestamp: 9 } as AgentMessage,
    };
    const database = {
      getMessageWithAgentContext: vi.fn(() => ({
        transcript: {
          id: current.id,
          sequence: current.sequence,
          status: "complete",
          content: "继续处理这个文件",
          createdAt: 9,
        },
        agentMessage: current,
      })),
      getContextSummary: vi.fn(() => ({
        sessionId: session.id,
        throughSequence: 4,
        content: "Earlier context includes report.docx",
        updatedAt: 4,
      })),
      listAgentMessages: vi.fn(() => [
        {
          id: "history",
          sequence: 8,
          message: { role: "assistant", content: [], timestamp: 8 } as AgentMessage,
        },
      ]),
    };
    const manager = new ContextManager(database as never, { get: vi.fn(() => model), models: {} } as never);
    const result = await manager.buildForMessage(session, current.id, new AbortController().signal, model);
    expect(database.listAgentMessages).toHaveBeenCalledOnce();
    expect(database.listAgentMessages).toHaveBeenCalledWith(session.id, {
      beforeSequence: 9,
      afterSequence: 4,
    });
    expect(result.messages.filter((message) => message === current.message)).toHaveLength(0);
    expect(result.current).toBe(current);
  });
});
