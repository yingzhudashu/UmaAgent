import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { lock } from "proper-lockfile";
import { afterEach, expect, it } from "vitest";

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
