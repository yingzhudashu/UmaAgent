import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { UmaDatabase } from "../src/database.js";
import { safeFetch } from "../src/tools.js";
import { WorkspacePolicy } from "../src/workspace.js";
import { testDatabase } from "./test-database.js";

const modelSnapshot = {
  ref: { provider: "test", id: "model" },
  name: "Test Model",
  api: "openai-responses",
  contextWindow: 100_000,
  maxOutputTokens: 4_096,
  capabilities: { tools: true, vision: false, reasoning: false, structuredOutput: true },
};

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("UmaDatabase", () => {
  it("persists sessions and enforces message idempotency", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-db-"));
    temporary.push(root);
    const db = testDatabase(root);
    const session = db.createSession({
      title: "test",
      workspace: root,
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    const first = db.createRun(session.id, "message-1", modelSnapshot, "off", "agent", "agent");
    const second = db.createRun(session.id, "message-1", modelSnapshot, "off", "agent", "agent");
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    const other = db.createSession({
      title: "other",
      workspace: root,
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    expect(() => db.createRun(other.id, "message-1", modelSnapshot, "off", "agent", "agent")).toThrow(
      "another session",
    );
    db.addMemoryFact({
      sessionId: session.id,
      scope: "session",
      key: "preference.language",
      value: "用户偏好使用 TypeScript 编写工具",
      category: "preference",
      confidence: 1,
      status: "active",
    });
    expect(db.searchMemory(session.id, "TypeScript 编写")).toContain("用户偏好使用 TypeScript 编写工具");
    db.close();
    const reopened = testDatabase(root);
    expect(reopened.getSession(session.id).title).toBe("test");
    reopened.close();
  });

  it.each([18, 19, 21, 99])("rejects unsupported schema version %s without rewriting it", async (version) => {
    const root = await mkdtemp(join(tmpdir(), "uma-schema-"));
    temporary.push(root);
    const db = testDatabase(root);
    db.db.exec(`PRAGMA user_version = ${version}`);
    db.close();
    expect(() => new UmaDatabase(root)).toThrow(`Unsupported database schema ${version}`);
    const reopened = new DatabaseSync(join(root, "state.db"));
    expect(Number(reopened.prepare("PRAGMA user_version").get().user_version)).toBe(version);
    reopened.close();
  });

  it("initializes the current schema directly at version 20", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-schema-18-"));
    temporary.push(root);
    const db = testDatabase(root);
    expect(Number(db.db.prepare("PRAGMA user_version").get().user_version)).toBe(20);
    db.close();
  });

  it("never lets an older compaction replace a newer context boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-summary-"));
    temporary.push(root);
    const db = testDatabase(root);
    const session = db.createSession({
      title: "summary",
      workspace: root,
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    db.putContextSummary(session.id, 12, "newer summary");
    db.putContextSummary(session.id, 8, "stale summary");
    expect(db.getContextSummary(session.id)).toMatchObject({
      throughSequence: 12,
      content: "newer summary",
    });
    db.close();
  });

  it("marks active runs interrupted after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-restart-"));
    temporary.push(root);
    const db = testDatabase(root);
    const session = db.createSession({
      title: "restart",
      workspace: root,
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    const run = db.createRun(session.id, "active-message", modelSnapshot, "off", "agent", "agent").run;
    db.updateRun(run.id, { status: "running" });
    db.createCheckpoint({
      runId: run.id,
      phase: "tool",
      turnCount: 1,
      lastMessageSequence: 0,
      safeToResume: true,
    });
    const runningAction = db.createRunAction({
      runId: run.id,
      toolCallId: "shell-1",
      toolName: "shell",
      toolClass: "shell",
      idempotencyKey: "action-1",
      input: { command: "echo hi" },
    });
    db.updateRunAction(runningAction.id, { status: "running" });
    const runningRead = db.createRunAction({
      runId: run.id,
      toolCallId: "read-1",
      toolName: "read",
      toolClass: "read",
      idempotencyKey: "action-read",
      input: { path: "README.md" },
    });
    db.updateRunAction(runningRead.id, { status: "running" });
    const modelCallId = db.startModelCall({
      runId: run.id,
      provider: "test",
      model: "model",
      role: "default",
    });
    const preparedAction = db.createRunAction({
      runId: run.id,
      toolCallId: "shell-2",
      toolName: "shell",
      toolClass: "shell",
      idempotencyKey: "action-2",
      input: { command: "echo later" },
    });
    db.close();
    const reopened = testDatabase(root);
    expect(reopened.getRun(run.id).status).toBe("interrupted");
    expect(reopened.getRunAction(runningAction.id).status).toBe("uncertain");
    expect(reopened.getRunAction(runningRead.id).status).toBe("prepared");
    expect(reopened.getRunAction(preparedAction.id).status).toBe("prepared");
    expect(reopened.getRun(run.id).resume?.state).toBe("needs_confirmation");
    expect(reopened.listEvents(session.id, 0).events.at(-1)?.type).toBe("run.updated");
    expect(
      (
        reopened.db.prepare("SELECT status FROM model_calls WHERE id=?").get(modelCallId) as {
          status: string;
        }
      ).status,
    ).toBe("abandoned");
    reopened.close();
  });

  it("bounds snapshots while retaining every non-terminal run", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-snapshot-"));
    temporary.push(root);
    const db = testDatabase(root);
    const session = db.createSession({
      title: "bounded",
      workspace: root,
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    for (let index = 0; index < 105; index++)
      db.insertMessage({ sessionId: session.id, role: "user", status: "complete", content: String(index) });
    for (let index = 0; index < 25; index++) {
      const run = db.createRun(session.id, `completed-${index}`, modelSnapshot, "off", "agent", "agent").run;
      db.updateRun(run.id, { status: "completed" });
    }
    const activeIds = Array.from(
      { length: 3 },
      (_, index) =>
        db.createRun(session.id, `active-${index}`, modelSnapshot, "off", "agent", "agent").run.id,
    );
    const snapshot = db.getSnapshot(session.id);
    expect(snapshot.transcript).toHaveLength(100);
    expect(snapshot.history).toEqual({ oldestMessageSequence: 6, hasMoreBefore: true });
    expect(snapshot.recentRuns.length).toBeLessThanOrEqual(23);
    expect(activeIds.every((id) => snapshot.recentRuns.some((run) => run.id === id))).toBe(true);
    db.close();
  });

  it("loads message attachments in one projection without dropping metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-message-repository-"));
    temporary.push(root);
    const db = testDatabase(root);
    const session = db.createSession({
      title: "attachments",
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    const attachment = db.addAttachment({
      sessionId: session.id,
      name: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      storagePath: join(root, "notes.txt"),
    });
    const message = db.insertMessage({
      sessionId: session.id,
      role: "user",
      status: "complete",
      content: "attached",
      attachmentIds: [attachment.id],
    });
    expect(db.getMessage(message.id).attachments).toEqual([attachment]);
    expect(db.listHistory(session.id).items[0]?.attachments).toEqual([attachment]);
    expect(db.getSnapshot(session.id).transcript[0]?.attachments).toEqual([attachment]);
    db.close();
  });

  it("paginates durable events beyond one thousand entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-events-"));
    temporary.push(root);
    const db = testDatabase(root);
    const session = db.createSession({
      title: "events",
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    for (let index = 0; index < 1_005; index++)
      db.appendEvent(session.id, undefined, "session.snapshot", { index });
    const first = db.listEvents(session.id, 0, 1_000);
    const second = db.listEvents(session.id, first.nextSequence, 1_000);
    expect(first.events).toHaveLength(1_000);
    expect(first.hasMore).toBe(true);
    expect(second.events).toHaveLength(5);
    expect(second.hasMore).toBe(false);
    expect(second.toSequence).toBe(1_005);
    db.close();
  });

  it("retrieves only active global and current-session memory facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-memory-"));
    temporary.push(root);
    const db = testDatabase(root);
    const session = db.createSession({
      title: "memory",
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    const other = db.createSession({
      title: "other",
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    db.addMemoryFact({
      scope: "global",
      key: "global.zebrafish",
      value: "global zebrafish preference",
      category: "preference",
      confidence: 1,
      status: "active",
    });
    db.addMemoryFact({
      sessionId: session.id,
      scope: "session",
      key: "session.zebrafish",
      value: "session zebrafish preference",
      category: "preference",
      confidence: 1,
      status: "active",
    });
    db.addMemoryFact({
      sessionId: other.id,
      scope: "session",
      key: "other.zebrafish",
      value: "other zebrafish preference",
      category: "preference",
      confidence: 1,
      status: "active",
    });
    db.addMemoryFact({
      sessionId: session.id,
      scope: "session",
      key: "candidate.zebrafish",
      value: "candidate zebrafish preference",
      category: "preference",
      confidence: 0.7,
      status: "candidate",
    });
    const results = db.searchMemory(session.id, "zebrafish preference", 10);
    expect(results).toContain("global zebrafish preference");
    expect(results).toContain("session zebrafish preference");
    expect(results).not.toContain("other zebrafish preference");
    expect(results).not.toContain("candidate zebrafish preference");
    db.close();
  });

  it("keeps fixed Chinese and English memory Recall@8 above the 85% embedding gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-memory-recall-"));
    temporary.push(root);
    const db = testDatabase(root);
    const session = db.createSession({
      title: "recall",
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    const samples = [
      ["language.typescript", "用户主要使用 TypeScript 开发 Agent", "TypeScript Agent"],
      ["editor.vscode", "用户偏好使用 VS Code 编辑代码", "VS Code 编辑"],
      ["deploy.sqlite", "项目采用 SQLite WAL 单副本部署", "SQLite WAL"],
      ["security.reasoning", "系统永不保存隐藏思维链", "隐藏思维链"],
      ["channel.feishu", "飞书消息通过独立 Adapter 接入", "飞书 Adapter"],
      ["runtime.pi", "Runtime reuses the stable Pi agent loop", "stable Pi agent"],
      ["testing.playwright", "Web end-to-end tests use Playwright", "Playwright end-to-end"],
      ["memory.active", "Only active facts are injected into prompts", "active facts prompts"],
      ["skills.staged", "Executable skills remain staged until owner approval", "skills staged approval"],
      [
        "recovery.actions",
        "Uncertain side effects are never replayed automatically",
        "uncertain side effects",
      ],
    ] as const;
    for (const [key, value] of samples)
      db.addMemoryFact({
        scope: "global",
        key,
        value,
        category: "recall-eval",
        confidence: 1,
        status: "active",
      });
    const recalled = samples.filter(([, value, query]) =>
      db.searchMemory(session.id, query, 8).includes(value),
    );
    expect(recalled.length / samples.length).toBeGreaterThanOrEqual(0.85);
    db.close();
  });

  it("rejects attachments that are not owned by the current session", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-attachment-"));
    temporary.push(root);
    const db = testDatabase(root);
    const first = db.createSession({
      title: "first",
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    const second = db.createSession({
      title: "second",
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    const attachment = db.addAttachment({
      sessionId: first.id,
      name: "private.txt",
      mimeType: "text/plain",
      size: 1,
      storagePath: join(root, "private.txt"),
    });
    expect(() => db.validateAttachmentForSession(attachment.id, first.id)).not.toThrow();
    expect(() => db.validateAttachmentForSession(attachment.id, second.id)).toThrow(
      "belongs to another session",
    );
    const unbound = db.addAttachment({
      name: "unbound.txt",
      mimeType: "text/plain",
      size: 1,
      storagePath: join(root, "unbound.txt"),
    });
    expect(() => db.validateAttachmentForSession(unbound.id, first.id)).toThrow("belongs to another session");
    db.close();
  });

  it("redacts credentials from durable audit input and output", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-audit-"));
    temporary.push(root);
    const db = testDatabase(root);
    const session = db.createSession({
      title: "audit",
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    const run = db.createRun(session.id, "audit-message", modelSnapshot, "off", "agent", "agent").run;
    const audit = db.addAudit({
      runId: run.id,
      kind: "tool",
      name: "external",
      input: { authorization: "Bearer private-token", nested: { apiKey: "model-secret" } },
      output: { cookie: "session-secret", result: "ok" },
      status: "completed",
    });
    expect(JSON.stringify(audit)).not.toContain("private-token");
    expect(JSON.stringify(audit)).not.toContain("model-secret");
    expect(JSON.stringify(audit)).not.toContain("session-secret");
    expect(audit.output).toMatchObject({ cookie: "[REDACTED]", result: "ok" });
    db.close();
  });

  it("rolls back state and durable events together", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-atomic-"));
    temporary.push(root);
    const db = testDatabase(root);
    const session = db.createSession({
      title: "before",
      workspace: root,
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    expect(() =>
      db.withTransaction(() => {
        db.updateSession(session.id, { title: "after" });
        db.appendEvent(session.id, undefined, "session.snapshot", { title: "after" });
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(db.getSession(session.id).title).toBe("before");
    expect(db.listEvents(session.id, 0).events).toHaveLength(0);
    db.close();
  });

  it("paginates transcript history before a stable message sequence", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-history-"));
    temporary.push(root);
    const db = testDatabase(root);
    const session = db.createSession({
      title: "history",
      workspace: root,
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    for (let index = 0; index < 3; index++)
      db.insertMessage({ sessionId: session.id, role: "user", status: "complete", content: String(index) });
    const latest = db.listHistory(session.id, undefined, 2);
    expect(latest.items.map((item) => item.sequence)).toEqual([2, 3]);
    expect(latest.hasMore).toBe(true);
    expect(db.listHistory(session.id, latest.oldestSequence, 2).items[0]?.sequence).toBe(1);
    db.close();
  });

  it("claims an Action transition only once", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-action-"));
    temporary.push(root);
    const db = testDatabase(root);
    const session = db.createSession({
      title: "action",
      workspace: root,
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    const run = db.createRun(session.id, "action-message", modelSnapshot, "off", "agent", "agent").run;
    db.createToolCall({ id: "tool-1", runId: run.id, name: "read", args: { path: "README.md" } });
    const action = db.createRunAction({
      runId: run.id,
      toolCallId: "tool-1",
      toolName: "read",
      toolClass: "read",
      idempotencyKey: "action-once",
      input: { path: "README.md" },
    });
    expect(db.transitionRunAction(action.id, ["prepared"], { status: "running" }).changed).toBe(true);
    expect(db.transitionRunAction(action.id, ["prepared"], { status: "rejected" }).changed).toBe(false);
    expect(db.getRunAction(action.id).status).toBe("running");
    expect(db.getToolCallInput("tool-1")).toEqual({ path: "README.md" });
    const approval = db.createApproval({
      sessionId: session.id,
      runId: run.id,
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    expect(db.resolveApproval(approval.id, true).status).toBe("approved");
    expect(db.resolveApproval(approval.id, false).status).toBe("approved");
    db.close();
  });
});

describe("evaluation reports", () => {
  it("persists immutable report summaries and cases", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-evaluation-"));
    temporary.push(root);
    const db = testDatabase(root);
    const report = db.createEvaluationReport({
      mode: "faux",
      suiteVersion: "builtin-1",
      status: "failed",
      totals: { total: 2, passed: 1, failed: 1, skipped: 0 },
      durationMs: 123,
      cases: [
        { name: "pass", category: "regression", passed: true, durationMs: 10 },
        { name: "fail", category: "security", passed: false, durationMs: 20, error: "mismatch" },
      ],
    });
    expect(db.getEvaluationReport(report.id)).toEqual(report);
    expect(db.listEvaluationReports()).toEqual([report]);
    db.close();
  });
});

describe("network policy", () => {
  it.each(["http://127.0.0.1", "http://[::1]", "http://169.254.169.254"])(
    "blocks private target %s",
    async (url) => {
      await expect(safeFetch(url)).rejects.toThrow("blocked");
    },
  );
});

describe("WorkspacePolicy", () => {
  it("blocks traversal and allows missing descendants", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-workspace-"));
    temporary.push(root);
    await mkdir(join(root, "project"));
    const policy = new WorkspacePolicy([root]);
    await policy.initialize();
    const workspace = await policy.validateWorkspace(join(root, "project"));
    await expect(policy.resolvePath(workspace, "nested/file.txt", true)).resolves.toBe(
      join(workspace, "nested", "file.txt"),
    );
    await expect(policy.resolvePath(workspace, "../outside.txt", true)).rejects.toThrow("escapes");
  });

  it("blocks paths that escape through a symbolic-link directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-workspace-link-"));
    const outside = await mkdtemp(join(tmpdir(), "uma-workspace-outside-"));
    temporary.push(root, outside);
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    const policy = new WorkspacePolicy([root]);
    await policy.initialize();
    await expect(policy.resolvePath(root, "escape/secret.txt")).rejects.toThrow("outside");
    await expect(policy.resolvePath(root, "escape/new.txt", true)).rejects.toThrow("outside");
  });
});
