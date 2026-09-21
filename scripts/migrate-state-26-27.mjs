import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { lock } from "proper-lockfile";

const path = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(path))
  throw new Error("Usage: node scripts/migrate-state-26-27.mjs <state.db>");
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
  if (Number(db.prepare("PRAGMA user_version").get().user_version) !== 26)
    throw new Error("Only schema 26 can be migrated; no changes were made");
  if (
    db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").all().length
  )
    throw new Error("Database integrity check failed; no changes were made");
  const backupPath = `${path}.schema26-${Date.now()}.backup`;
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
    db.exec(`ALTER TABLE sessions ADD COLUMN branch_revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE sessions ADD COLUMN queue_revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE runs ADD COLUMN branch_revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE runs ADD COLUMN superseded_by_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL;
      ALTER TABLE runs ADD COLUMN terminal_reason TEXT;
      PRAGMA user_version=27;`);
    db.prepare("UPDATE sessions SET branch_revision=1,queue_revision=1").run();
    db.prepare("UPDATE runs SET branch_revision=1").run();
    if (
      db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    )
      throw new Error("Post-migration integrity check failed");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  console.log(JSON.stringify({ migrated: true, schema: 27, backup: backupPath }));
} finally {
  db?.close();
  await release();
}
