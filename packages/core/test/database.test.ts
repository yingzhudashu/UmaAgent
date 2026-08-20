import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UmaDatabase } from "../src/database.js";
import { safeFetch } from "../src/tools.js";
import { WorkspacePolicy } from "../src/workspace.js";

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("UmaDatabase", () => {
  it("persists sessions and enforces message idempotency", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-db-"));
    temporary.push(root);
    const db = new UmaDatabase(root);
    const session = db.createSession({
      mode: "workspace",
      title: "test",
      workspace: root,
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    const first = db.createRun(session.id, "message-1");
    const second = db.createRun(session.id, "message-1");
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    const other = db.createSession({
      mode: "workspace",
      title: "other",
      workspace: root,
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    expect(() => db.createRun(other.id, "message-1")).toThrow("another session");
    db.addMemory(session.id, "session", "用户偏好使用 TypeScript 编写工具");
    expect(db.searchMemory(session.id, "TypeScript 编写")).toContain("用户偏好使用 TypeScript 编写工具");
    db.close();
    const reopened = new UmaDatabase(root);
    expect(reopened.getSession(session.id).title).toBe("test");
    reopened.close();
  });

  it("rejects an unsupported schema version", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-schema-"));
    temporary.push(root);
    const db = new UmaDatabase(root);
    db.db.exec("PRAGMA user_version = 9");
    db.close();
    expect(() => new UmaDatabase(root)).toThrow("Unsupported database schema");
  });

  it("marks active runs interrupted after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-restart-"));
    temporary.push(root);
    const db = new UmaDatabase(root);
    const session = db.createSession({
      mode: "workspace",
      title: "restart",
      workspace: root,
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    const run = db.createRun(session.id, "active-message").run;
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
    const preparedAction = db.createRunAction({
      runId: run.id,
      toolCallId: "shell-2",
      toolName: "shell",
      toolClass: "shell",
      idempotencyKey: "action-2",
      input: { command: "echo later" },
    });
    db.close();
    const reopened = new UmaDatabase(root);
    expect(reopened.getRun(run.id).status).toBe("interrupted");
    expect(reopened.getRunAction(runningAction.id).status).toBe("uncertain");
    expect(reopened.getRunAction(preparedAction.id).status).toBe("prepared");
    expect(reopened.getRun(run.id).resume?.state).toBe("needs_confirmation");
    expect(reopened.listEvents(session.id, 0).events.at(-1)?.type).toBe("run.updated");
    reopened.close();
  });

  it("rolls back state and durable events together", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-atomic-"));
    temporary.push(root);
    const db = new UmaDatabase(root);
    const session = db.createSession({
      mode: "workspace",
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
    const db = new UmaDatabase(root);
    const session = db.createSession({
      mode: "workspace",
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
    const db = new UmaDatabase(root);
    const session = db.createSession({
      mode: "workspace",
      title: "action",
      workspace: root,
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    const run = db.createRun(session.id, "action-message").run;
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
});
