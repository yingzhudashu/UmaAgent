import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { lock } from "proper-lockfile";
import { afterEach, expect, it } from "vitest";
import { MessageRepository } from "../src/message-repository.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "uma-upgrade-"));
  roots.push(root);
  const path = join(root, "state.db");
  const db = new DatabaseSync(path);
  const schema = (await readFile(resolve("packages/core/src/schema.sql"), "utf8"))
    .replace(/,\s*auto_approve INTEGER NOT NULL DEFAULT 1 CHECK\(auto_approve IN \(0,1\)\)/, "")
    .replace(/CREATE TABLE account_execution_audit \([\s\S]*?\);/, "");
  db.exec(`${schema}; PRAGMA user_version=24`);
  db.prepare(
    "INSERT INTO users(id,role,status,created_at,updated_at) VALUES('owner','user','active',1,2)",
  ).run();
  db.close();
  return { root, path };
}
const upgrade = (path: string) => exec(process.execPath, [resolve("scripts/upgrade-state.mjs"), path]);
const upgrade2627 = (path: string) =>
  exec(process.execPath, [resolve("scripts/migrate-state-26-27.mjs"), path]);

async function schema26Fixture() {
  const root = await mkdtemp(join(tmpdir(), "uma-schema26-"));
  roots.push(root);
  const path = join(root, "state.db");
  const schema = (await readFile(resolve("packages/core/src/schema.sql"), "utf8"))
    .replace(
      /\s*branch_revision INTEGER NOT NULL DEFAULT 1,\r?\n\s*queue_revision INTEGER NOT NULL DEFAULT 1,/,
      "",
    )
    .replace(
      /\s*branch_revision INTEGER NOT NULL DEFAULT 1,\r?\n\s*superseded_by_run_id TEXT REFERENCES runs\(id\) ON DELETE SET NULL,\r?\n\s*terminal_reason TEXT,/,
      "",
    )
    .replace("PRAGMA user_version = 27;", "PRAGMA user_version = 26;");
  const db = new DatabaseSync(path);
  db.exec(schema);
  db.close();
  return { root, path };
}

it("upgrades once, preserves accounts and verifies a restorable schema24 backup", async () => {
  const { root, path } = await fixture();
  const result = JSON.parse((await upgrade(path)).stdout);
  const db = new DatabaseSync(path);
  try {
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(25);
    expect(db.prepare("SELECT auto_approve,created_at,updated_at FROM users WHERE id='owner'").get()).toEqual(
      { auto_approve: 1, created_at: 1, updated_at: 2 },
    );
    expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
  } finally {
    db.close();
  }
  const backup = new DatabaseSync(result.backup, { readOnly: true });
  try {
    expect(backup.prepare("PRAGMA user_version").get()?.user_version).toBe(24);
    expect(backup.prepare("SELECT id FROM users WHERE id='owner'").get()?.id).toBe("owner");
  } finally {
    backup.close();
  }
  await expect(upgrade(path)).rejects.toThrow("Only schema 24");
  expect((await readdir(root)).filter((name) => name.endsWith(".backup"))).toHaveLength(1);
});

it("refuses a live service lock and rolls back all DDL when the conversion fails", async () => {
  const { root, path } = await fixture();
  const release = await lock(root, { realpath: false, lockfilePath: join(root, "uma.lock") });
  try {
    await expect(upgrade(path)).rejects.toThrow();
  } finally {
    await release();
  }
  const invalid = new DatabaseSync(path);
  invalid.exec("CREATE TABLE account_execution_audit(id INTEGER)");
  invalid.close();
  await expect(upgrade(path)).rejects.toThrow("already exists");
  const db = new DatabaseSync(path);
  try {
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(24);
    expect(
      db
        .prepare("PRAGMA table_info(users)")
        .all()
        .some((row) => row.name === "auto_approve"),
    ).toBe(false);
    expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
  } finally {
    db.close();
  }
});

it("migrates schema26 queue and branch revisions with a verified backup", async () => {
  const { root, path } = await schema26Fixture();
  const result = JSON.parse((await upgrade2627(path)).stdout);
  const db = new DatabaseSync(path);
  try {
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(27);
    expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    expect(db.prepare("SELECT branch_revision,queue_revision FROM sessions").all()).toEqual([]);
    expect(db.prepare("SELECT branch_revision,terminal_reason FROM runs").all()).toEqual([]);
  } finally {
    db.close();
  }
  const backup = new DatabaseSync(result.backup, { readOnly: true });
  expect(backup.prepare("PRAGMA user_version").get()?.user_version).toBe(26);
  backup.close();
  await expect(upgrade2627(path)).rejects.toThrow("Only schema 26");
  expect((await readdir(root)).filter((name) => name.endsWith(".backup"))).toHaveLength(1);
});

it("migrates explicit legacy replacement edges while preserving the common prefix and old branch", async () => {
  const { path } = await schema26Fixture();
  const source = new DatabaseSync(path);
  source.exec(`INSERT INTO sessions(id,user_id,title,model_provider,model_id,thinking_level,created_at,updated_at)
    VALUES('s','system','test','test','test','off',1,1);
    INSERT INTO messages(id,session_id,sequence,role,status,content,parent_message_id,created_at,updated_at) VALUES
      ('prefix','s',1,'user','complete','prefix',NULL,1,1),
      ('old','s',2,'user','complete','old','prefix',2,2),
      ('replacement','s',3,'user','complete','replacement','old',3,3),
      ('followup','s',4,'user','complete','followup','replacement',4,4);
    INSERT INTO conversation_branches(id,session_id,name,head_message_id,created_at,updated_at)
      VALUES('edit','s','edit','followup',3,4);
    INSERT INTO conversation_branch_forks VALUES('edit','old');
    UPDATE sessions SET active_branch_id='edit';`);
  source.close();
  const result = JSON.parse((await upgrade2627(path)).stdout);
  expect(result.repairedEdges).toBe(1);
  const db = new DatabaseSync(path);
  try {
    expect(new MessageRepository(db).listMessages("s").map((item) => item.id)).toEqual([
      "prefix",
      "replacement",
      "followup",
    ]);
    expect(db.prepare("SELECT parent_message_id FROM messages WHERE id='old'").get()?.parent_message_id).toBe(
      "prefix",
    );
    expect(db.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(4);
  } finally {
    db.close();
  }
  const copy = new DatabaseSync(result.backup, { readOnly: true });
  expect(
    copy.prepare("SELECT parent_message_id FROM messages WHERE id='replacement'").get()?.parent_message_id,
  ).toBe("old");
  copy.close();
});
