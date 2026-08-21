import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UmaDatabase } from "../src/database.js";
import { EventHub } from "../src/events.js";
import { RunApprovals } from "../src/run-approvals.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

function setup(database: UmaDatabase) {
  const session = database.createSession({
    mode: "assistant",
    title: "approval test",
    model: { provider: "test", id: "model" },
    thinkingLevel: "off",
  });
  const run = database.createRun(
    session.id,
    "approval-message",
    {
      ref: session.model,
      name: "Test",
      api: "openai-responses",
      contextWindow: 100_000,
      maxOutputTokens: 4_096,
      capabilities: { tools: true, vision: false, reasoning: false, structuredOutput: true },
    },
    "off",
  ).run;
  return { session, run };
}

describe("run approvals", () => {
  it("resolves a pending request once and returns the durable final decision on retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-approvals-"));
    temporary.push(root);
    const database = new UmaDatabase(root);
    try {
      const { session, run } = setup(database);
      const approvals = new RunApprovals(database, new EventHub(database), 10_000);
      const waiting = approvals.request({
        sessionId: session.id,
        runId: run.id,
        toolCallId: "tool-1",
        toolName: "memory_write",
        args: { content: "remember" },
        signal: new AbortController().signal,
      });
      const pending = database.getSnapshot(session.id).pendingApprovals[0];
      expect(approvals.resolve(pending?.id as string, true).status).toBe("approved");
      await expect(waiting).resolves.toBe(true);
      expect(approvals.resolve(pending?.id as string, false).status).toBe("approved");
    } finally {
      database.close();
    }
  });

  it("expires an already-aborted request and rejects all remaining requests on shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-approvals-abort-"));
    temporary.push(root);
    const database = new UmaDatabase(root);
    try {
      const { session, run } = setup(database);
      const approvals = new RunApprovals(database, new EventHub(database), 10_000);
      const aborted = new AbortController();
      aborted.abort();
      await expect(
        approvals.request({
          sessionId: session.id,
          runId: run.id,
          toolCallId: "tool-aborted",
          toolName: "shell",
          args: {},
          signal: aborted.signal,
        }),
      ).resolves.toBe(false);
      expect(database.getSnapshot(session.id).pendingApprovals).toHaveLength(0);

      const waiting = approvals.request({
        sessionId: session.id,
        runId: run.id,
        toolCallId: "tool-shutdown",
        toolName: "shell",
        args: {},
        signal: new AbortController().signal,
      });
      approvals.rejectAll();
      await expect(waiting).resolves.toBe(false);
    } finally {
      database.close();
    }
  });
});
