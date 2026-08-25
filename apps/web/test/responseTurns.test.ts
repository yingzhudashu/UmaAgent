import type { Response, Run, TranscriptItem } from "@uma-agent/protocol";
import { describe, expect, it } from "vitest";
import { buildConversationEntries } from "../src/responseTurns.js";

const item = (
  value: Partial<TranscriptItem> & Pick<TranscriptItem, "id" | "sequence" | "role">,
): TranscriptItem => ({
  status: "complete",
  content: "",
  attachments: [],
  createdAt: value.sequence,
  updatedAt: value.sequence,
  ...value,
});

const response = (value: Partial<Response> & Pick<Response, "id" | "runId" | "messageId">): Response => ({
  sessionId: "session",
  status: "completed",
  content: "最终答案",
  activities: [],
  attachments: [],
  createdAt: 1,
  updatedAt: 1,
  ...value,
});

const run = (id: string): Run => ({
  id,
  sessionId: "session",
  messageId: "user-1",
  interactionMode: "agent",
  kind: "agent",
  status: "completed",
  phase: "verify",
  successCriteria: [],
  assumptions: [],
  model: {
    ref: { provider: "test", id: "model" },
    name: "Test",
    api: "test",
    contextWindow: 1_000,
    maxOutputTokens: 100,
    capabilities: { tools: true, vision: false, reasoning: false, structuredOutput: false },
  },
  thinkingLevel: "off",
  turnCount: 1,
  correctionCount: 0,
  plan: [],
  createdAt: 1,
  updatedAt: 1,
});

describe("buildConversationEntries", () => {
  it("renders one response entry for a run and keeps tool steps inside it", () => {
    const transcript = [
      item({ id: "user-1", sequence: 1, role: "user", runId: "run-1", content: "问题" }),
      item({ id: "tool-1", sequence: 2, role: "tool", runId: "run-1", name: "http_get", content: "结果" }),
      item({ id: "assistant-1", sequence: 3, role: "assistant", runId: "run-1", content: "最终答案" }),
    ];
    const entries = buildConversationEntries(
      transcript,
      [response({ id: "response-1", runId: "run-1", messageId: "user-1" })],
      [run("run-1")],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "response"]);
    const responseEntry = entries[1];
    expect(responseEntry.kind).toBe("response");
    if (responseEntry.kind === "response")
      expect(responseEntry.items.map((value) => value.id)).toEqual(["user-1", "tool-1", "assistant-1"]);
  });

  it("does not duplicate an already associated response", () => {
    const transcript = [item({ id: "user-1", sequence: 1, role: "user", runId: "run-1" })];
    const entries = buildConversationEntries(
      transcript,
      [response({ id: "response-1", runId: "run-1", messageId: "user-1" })],
      [run("run-1")],
    );
    expect(entries.filter((entry) => entry.kind === "response")).toHaveLength(1);
  });

  it("keeps multiple assistant updates in the single run response", () => {
    const transcript = [
      item({ id: "user-1", sequence: 1, role: "user", runId: "run-1" }),
      item({ id: "assistant-1", sequence: 2, role: "assistant", runId: "run-1", content: "阶段" }),
      item({
        id: "tool-1",
        sequence: 3,
        role: "tool",
        runId: "run-1",
        name: "mcp_browser_open",
        content: "工具",
      }),
      item({ id: "assistant-2", sequence: 4, role: "assistant", runId: "run-1", content: "结论" }),
    ];
    const entries = buildConversationEntries(
      transcript,
      [response({ id: "response-1", runId: "run-1", messageId: "user-1" })],
      [run("run-1")],
    );
    expect(entries.filter((entry) => entry.kind === "response")).toHaveLength(1);
    const entry = entries.find((value) => value.kind === "response");
    if (entry?.kind === "response")
      expect(entry.items.map((value) => value.id)).toEqual([
        "user-1",
        "assistant-1",
        "tool-1",
        "assistant-2",
      ]);
  });
});
