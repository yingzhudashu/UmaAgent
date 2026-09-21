import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { lock } from "proper-lockfile";

// One-time schema 25 -> 26 migration. Runtime code only reads the persisted
// fork source; it never infers boundaries for legacy branches.
const path = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(path))
  throw new Error("Usage: node scripts/migrate-edit-branches.mjs <state.db>");
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
  if (Number(db.prepare("PRAGMA user_version").get().user_version) !== 25)
    throw new Error("Only schema 25 can be migrated; no changes were made");
  if (
    db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").all().length
  )
    throw new Error("Database integrity check failed; no changes were made");
  const backupPath = `${path}.schema25-${Date.now()}.backup`;
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
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_branch_forks (
      branch_id TEXT PRIMARY KEY REFERENCES conversation_branches(id) ON DELETE CASCADE,
      source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE
    ); CREATE INDEX IF NOT EXISTS conversation_branch_forks_source ON conversation_branch_forks(source_message_id);`);
    const branches = db
      .prepare(`SELECT b.id,b.session_id,b.head_message_id,b.created_at
      FROM conversation_branches b LEFT JOIN conversation_branch_forks f ON f.branch_id=b.id
      WHERE b.name <> '主分支' AND b.head_message_id IS NOT NULL AND f.branch_id IS NULL`)
      .all();
    const findReplacement = db.prepare(
      "SELECT parent_message_id,sequence FROM messages WHERE id=? AND session_id=? AND role='user'",
    );
    const findDirectSource = db.prepare(
      "SELECT id FROM messages WHERE id=? AND session_id=? AND role='user'",
    );
    const findSource =
      db.prepare(`SELECT m.id FROM messages m WHERE m.session_id=? AND m.role='user' AND m.sequence<?
      AND ((m.parent_message_id IS NULL AND ? IS NULL) OR m.parent_message_id=?) ORDER BY m.sequence DESC LIMIT 1`);
    const insertFork = db.prepare(
      "INSERT INTO conversation_branch_forks(branch_id,source_message_id) VALUES(?,?)",
    );
    for (const branch of branches) {
      const replacement = findReplacement.get(branch.head_message_id, branch.session_id);
      if (!replacement) throw new Error(`Cannot determine replacement message for branch ${branch.id}`);
      const parent = replacement.parent_message_id ?? null;
      // Older edit flows linked the replacement directly to the message being
      // replaced. If that link is absent (for example, a root edit), recover
      // the source as the latest earlier user message sharing the same parent.
      const source =
        (parent && findDirectSource.get(parent, branch.session_id)) ??
        findSource.get(branch.session_id, replacement.sequence, parent, parent);
      if (!source) throw new Error(`Cannot determine source message for branch ${branch.id}`);
      insertFork.run(branch.id, source.id);
    }
    db.exec("PRAGMA user_version=26");
    if (
      db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    )
      throw new Error("Post-migration integrity check failed");
    db.exec("COMMIT");
    console.log(
      JSON.stringify({ migrated: true, schema: 26, branches: branches.length, backup: backupPath }),
    );
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
} finally {
  db?.close();
  await release();
}
