import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UmaDatabase } from "../src/database.js";
import { EventHub } from "../src/events.js";
import { RunApprovals } from "../src/run-approvals.js";
import { testDatabase } from "./test-database.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

function setup(database: UmaDatabase) {
  const session = database.createSession({
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
    "agent",
    "agent",
  ).run;
  return { session, run };
}

describe("run approvals", () => {
  it("defaults new accounts to automatic execution and audits a shell without pending approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-automatic-"));
    temporary.push(root);
    const database = testDatabase(root);
    try {
      const user = database.createUser();
      expect(database.getExecutionSettings(user.id)).toEqual({ autoApprove: true });
      const { session, run } = setup(database);
      database.setExecutionSettings("test-user", true);
      const approvals = new RunApprovals(database, new EventHub(database), 1000);
      await expect(
        approvals.request({
          sessionId: session.id,
          runId: run.id,
          toolCallId: "automatic-shell",
          toolName: "shell",
          args: { command: "echo ok" },
          signal: new AbortController().signal,
        }),
      ).resolves.toBe(true);
      expect(database.getSnapshot(session.id).pendingApprovals).toEqual([]);
      expect(
        database.db.prepare("SELECT status FROM audit_events WHERE run_id=? AND kind='approval'").get(run.id),
      ).toMatchObject({ status: "approved" });
      database.setExecutionSettings("test-user", false);
      expect(database.getExecutionSettings(user.id).autoApprove).toBe(true);
      expect(() => database.getExecutionSettings("absent")).toThrow();
    } finally {
      database.close();
    }
  });

  it("resolves a pending request once and returns the durable final decision on retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-approvals-"));
    temporary.push(root);
    const database = testDatabase(root);
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
    const database = testDatabase(root);
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
