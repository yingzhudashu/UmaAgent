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
    // Old editors linked the replacement to the replaced user message. Repair
    // only the edge proven by persisted fork metadata and that branch's path.
    const branches = db
      .prepare(`SELECT b.id,b.session_id,b.head_message_id,f.source_message_id
      FROM conversation_branches b JOIN conversation_branch_forks f ON f.branch_id=b.id
      ORDER BY b.created_at,b.id`)
      .all();
    const message = db.prepare("SELECT id,session_id,parent_message_id,role FROM messages WHERE id=?");
    let repairedEdges = 0;
    for (const branch of branches) {
      const source = message.get(branch.source_message_id);
      if (!source || source.session_id !== branch.session_id || source.role !== "user")
        throw new Error(`Invalid fork source for branch ${branch.id}`);
      const seen = new Set();
      let current = branch.head_message_id;
      while (current) {
        if (seen.has(current)) throw new Error(`Cyclic branch ${branch.id}`);
        seen.add(current);
        const entry = message.get(current);
        if (!entry || entry.session_id !== branch.session_id)
          throw new Error(`Invalid path for branch ${branch.id}`);
        if (entry.parent_message_id === source.id) {
          if (entry.role !== "user") throw new Error(`Ambiguous replacement for branch ${branch.id}`);
          db.prepare("UPDATE messages SET parent_message_id=? WHERE id=?").run(
            source.parent_message_id,
            entry.id,
          );
          repairedEdges++;
          break;
        }
        current = entry.parent_message_id;
      }
    }
    if (
      db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    )
      throw new Error("Post-migration integrity check failed");
    db.exec("COMMIT");
    console.log(JSON.stringify({ migrated: true, schema: 27, backup: backupPath, repairedEdges }));
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
} finally {
  db?.close();
  await release();
}
