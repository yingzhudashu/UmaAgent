import { QueryClient } from "@tanstack/react-query";
import type { AgentEventEnvelope, Response, SessionSnapshot, TranscriptItem } from "@uma-agent/protocol";
import { describe, expect, it } from "vitest";
import { applyDurableEvent, applyStreamingEvent, mergeSessionSnapshot } from "../src/streaming.js";

const transcriptItem = (content = ""): TranscriptItem => ({
  id: "assistant-1",
  sequence: 2,
  role: "assistant",
  status: "streaming",
  content,
  runId: "run-1",
  attachments: [],
  createdAt: 1,
  updatedAt: 1,
});

const response = (updatedAt = 1): Response => ({
  id: "response-1",
  sessionId: "session-1",
  runId: "run-1",
  messageId: "user-1",
  status: "thinking",
  content: "",
  activities: [],
  attachments: [],
  createdAt: 1,
  updatedAt,
});

const snapshot = (): SessionSnapshot => ({
  session: {
    id: "session-1",
    title: "test",
    model: { provider: "test", id: "model" },
    thinkingLevel: "off",
    createdAt: 1,
    updatedAt: 1,
  },
  transcript: [
    {
      ...transcriptItem(""),
      id: "user-1",
      sequence: 1,
      role: "user",
      status: "complete",
      runId: "run-1",
    },
  ],
  recentRuns: [],
  pendingApprovals: [],
  snapshotSequence: 1,
  history: { oldestMessageSequence: 1, hasMoreBefore: false },
  responses: [response()],
  branches: [],
  queue: [],
});

const durableEvent = (
  type: AgentEventEnvelope["type"],
  payload: unknown,
  sequence: number,
): AgentEventEnvelope =>
  ({
    protocolVersion: 15,
    sessionId: "session-1",
    runId: "run-1",
    sequence,
    timestamp: sequence,
    type,
    payload,
  }) as AgentEventEnvelope;

describe("streaming snapshot projection", () => {
  it("merges response and message events locally without creating a second response", () => {
    const client = new QueryClient();
    client.setQueryData(["snapshot", "session-1", undefined], snapshot());

    applyDurableEvent(client, "session-1", durableEvent("response.started", response(2), 2));
    applyDurableEvent(client, "session-1", durableEvent("message.started", transcriptItem("第一段"), 3));
    applyStreamingEvent(client, "session-1", {
      protocolVersion: 15,
      sessionId: "session-1",
      runId: "run-1",
      sequence: 0,
      timestamp: 4,
      transient: true,
      type: "message.delta",
      payload: { messageId: "assistant-1", append: "第二段", updatedAt: 4 },
    });
    applyDurableEvent(client, "session-1", durableEvent("response.updated", response(3), 5));

    const current = client.getQueryData<SessionSnapshot>(["snapshot", "session-1", undefined]);
    expect(current?.responses).toHaveLength(1);
    expect(current?.responses?.[0]?.runId).toBe("run-1");
    expect(current?.transcript.find((item) => item.id === "assistant-1")?.content).toBe("第一段第二段");
  });

  it("adds response activity without rebuilding transcript content", () => {
    const client = new QueryClient();
    const initial = snapshot();
    initial.transcript.push(transcriptItem("持续生成"));
    client.setQueryData(["snapshot", "session-1", undefined], initial);
    const activity = {
      id: "activity-1",
      responseId: "response-1",
      kind: "tool" as const,
      toolName: "read",
      status: "executing" as const,
      createdAt: 3,
    };

    applyDurableEvent(
      client,
      "session-1",
      durableEvent("response.activity", { responseId: "response-1", activity }, 3),
    );

    const current = client.getQueryData<SessionSnapshot>(["snapshot", "session-1", undefined]);
    expect(current?.responses?.[0]?.activities).toEqual([activity]);
    expect(current?.transcript.find((item) => item.id === "assistant-1")?.content).toBe("持续生成");
  });

  it("updates a completed tool inside the existing response projection", () => {
    const client = new QueryClient();
    const initial = snapshot();
    initial.transcript.push({
      ...transcriptItem('{"path":"draft.md"}'),
      id: "tool-1",
      role: "tool",
      name: "read",
    });
    client.setQueryData(["snapshot", "session-1", undefined], initial);
    const completed = {
      ...initial.transcript[1],
      status: "complete" as const,
      content: "draft contents",
      updatedAt: 4,
    };

    applyDurableEvent(client, "session-1", durableEvent("tool.completed", { item: completed }, 4));

    const current = client.getQueryData<SessionSnapshot>(["snapshot", "session-1", undefined]);
    expect(current?.transcript.find((item) => item.id === "tool-1")).toMatchObject({
      content: "draft contents",
      status: "complete",
    });
  });

  it("does not let an older snapshot roll back a newer local projection", () => {
    const current = snapshot();
    current.snapshotSequence = 8;
    current.transcript.push(transcriptItem("new streamed content"));
    const older = { ...snapshot(), snapshotSequence: 7 };

    expect(mergeSessionSnapshot(current, older)).toBe(current);
  });
});
