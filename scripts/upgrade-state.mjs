import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { lock } from "proper-lockfile";

// 唯一一次 schema24→25 的显式离线转换；服务启动不加载此脚本。
const path = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(path))
  throw new Error("Usage: node scripts/upgrade-state.mjs <state.db>");
const directory = dirname(path);
const release = await lock(directory, {
  realpath: false,
  lockfilePath: resolve(directory, "uma.lock"),
  stale: 10_000,
  update: 2_000,
});
let db;
try {
  db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  if (Number(db.prepare("PRAGMA user_version").get().user_version) !== 24)
    throw new Error("Only schema 24 can be upgraded; no changes were made");
  if (
    db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").all().length
  )
    throw new Error("Database integrity check failed; no changes were made");
  const backupPath = `${path}.schema24-${Date.now()}.backup`;
  await backup(db, backupPath);
  const copy = new DatabaseSync(backupPath, { readOnly: true });
  try {
    if (
      copy.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
      copy.prepare("PRAGMA foreign_key_check").all().length
    )
      throw new Error("Backup integrity check failed; source was not modified");
  } finally {
    copy.close();
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`ALTER TABLE users ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 1 CHECK(auto_approve IN (0,1));
      CREATE TABLE account_execution_audit (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        auto_approve INTEGER NOT NULL CHECK(auto_approve IN (0,1)), created_at INTEGER NOT NULL);
      PRAGMA user_version=25;`);
    if (
      db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    )
      throw new Error("Post-upgrade integrity check failed");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  console.log(JSON.stringify({ upgraded: true, schema: 25, backup: backupPath }));
} finally {
  db?.close();
  await release();
}
