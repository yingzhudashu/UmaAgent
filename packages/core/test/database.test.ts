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
      title: "restart",
      workspace: root,
      model: { provider: "test", id: "model" },
      thinkingLevel: "off",
    });
    const run = db.createRun(session.id, "active-message").run;
    db.updateRun(run.id, { status: "running" });
    db.close();
    const reopened = new UmaDatabase(root);
    expect(reopened.getRun(run.id).status).toBe("interrupted");
    reopened.close();
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
