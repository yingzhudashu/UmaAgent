import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { testDatabase } from "./test-database.js";

const exec = promisify(execFile);
const roots: string[] = [];
const model = {
  ref: { provider: "test", id: "model" },
  name: "Test Model",
  api: "openai-responses",
  contextWindow: 100_000,
  maxOutputTokens: 4_096,
  capabilities: { tools: true, vision: false, reasoning: false, structuredOutput: true },
};
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("migrates legacy edit branches into explicit fork metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "uma-edit-migration-"));
  roots.push(root);
  const db = testDatabase(root);
  const session = db.createSession({ title: "migration", model: model.ref, thinkingLevel: "off" });
  const add = (id: string, content: string, parentMessageId?: string) => {
    const run = db.createRun(session.id, id, model, "off", "agent", "agent").run;
    db.updateRun(run.id, { status: "completed" });
    db.insertMessage({ id, sessionId: session.id, runId: run.id, role: "user", status: "complete", content, ...(parentMessageId ? { parentMessageId } : {}) });
    db.createResponse({ sessionId: session.id, runId: run.id, messageId: id });
  };
  add("old-root", "old root");
  add("old-child", "old child", "old-root");
  const oldBranch = db.listBranches(session.id).find((branch) => branch.active);
  db.db.prepare("UPDATE conversation_branches SET head_message_id=? WHERE id=?").run("old-child", oldBranch?.id);
  const branchCreatedAt = Date.now();
  db.db.prepare("INSERT INTO conversation_branches(id,session_id,name,head_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(
    "legacy-edit",
    session.id,
    "编辑分支 旧版本",
    null,
    branchCreatedAt,
    branchCreatedAt,
  );
  db.db.prepare("UPDATE sessions SET active_branch_id=? WHERE id=?").run("legacy-edit", session.id);
  add("new-root", "new root");
  db.db.prepare("UPDATE conversation_branches SET head_message_id=? WHERE id=?").run("new-root", "legacy-edit");
  db.close();

  const raw = new DatabaseSync(join(root, "state.db"));
  raw.exec("DROP TABLE conversation_branch_forks; PRAGMA user_version=25;");
  raw.close();
  const result = JSON.parse((await exec(process.execPath, [resolve("scripts/migrate-edit-branches.mjs"), join(root, "state.db")])).stdout);
  expect(result.schema).toBe(26);
  const migrated = new DatabaseSync(join(root, "state.db"), { readOnly: true });
  expect(migrated.prepare("SELECT source_message_id FROM conversation_branch_forks WHERE branch_id='legacy-edit'").get()).toEqual({
    source_message_id: "old-root",
  });
  expect(migrated.prepare("PRAGMA user_version").get()).toEqual({ user_version: 26 });
  migrated.close();
});

it("uses the replacement's direct parent as the source for legacy edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "uma-edit-migration-parent-"));
  roots.push(root);
  const db = testDatabase(root);
  const session = db.createSession({ title: "migration", model: model.ref, thinkingLevel: "off" });
  const add = (id: string, content: string, parentMessageId?: string) => {
    const run = db.createRun(session.id, id, model, "off", "agent", "agent").run;
    db.updateRun(run.id, { status: "completed" });
    db.insertMessage({ id, sessionId: session.id, runId: run.id, role: "user", status: "complete", content, ...(parentMessageId ? { parentMessageId } : {}) });
    db.createResponse({ sessionId: session.id, runId: run.id, messageId: id });
  };
  add("original", "original");
  const main = db.listBranches(session.id).find((branch) => branch.active);
  db.db.prepare("UPDATE conversation_branches SET head_message_id=? WHERE id=?").run("original", main?.id);
  db.db.prepare("INSERT INTO conversation_branches(id,session_id,name,head_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(
    "legacy-edit-parent", session.id, "编辑分支 旧版本", null, Date.now(), Date.now(),
  );
  db.db.prepare("UPDATE sessions SET active_branch_id=? WHERE id=?").run("legacy-edit-parent", session.id);
  add("replacement", "replacement", "original");
  db.db.prepare("UPDATE conversation_branches SET head_message_id=? WHERE id=?").run("replacement", "legacy-edit-parent");
  db.close();

  const raw = new DatabaseSync(join(root, "state.db"));
  raw.exec("DROP TABLE conversation_branch_forks; PRAGMA user_version=25;");
  raw.close();
  await exec(process.execPath, [resolve("scripts/migrate-edit-branches.mjs"), join(root, "state.db")]);
  const migrated = new DatabaseSync(join(root, "state.db"), { readOnly: true });
  expect(migrated.prepare("SELECT source_message_id FROM conversation_branch_forks WHERE branch_id='legacy-edit-parent'").get()).toEqual({
    source_message_id: "original",
  });
  migrated.close();
});
