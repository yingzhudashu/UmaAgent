import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const stateDir = process.argv[2];
if (!stateDir) throw new Error("usage: protected-user-fingerprint.mjs STATE_DIR");
const token = process.env.UMA_PROTECTED_PAT?.trim();
if (!token) throw new Error("UMA_PROTECTED_PAT must come from a protected secret source");
const match = /^uma_pat_([0-9a-f-]{36})_([A-Za-z0-9_-]{32,})$/.exec(token);
if (!match) throw new Error("UMA_PROTECTED_PAT has invalid format");
const tokenId = match[1];
const secretHash = createHash("sha256").update(match[2]).digest("hex");
const db = new DatabaseSync(`${stateDir}/state.db`, { readOnly: true });
const tokenRow = db
  .prepare(
    "SELECT id,user_id,token_hash,scopes_json,expires_at,revoked_at FROM auth_tokens WHERE id=? AND token_hash=?",
  )
  .get(tokenId, secretHash);
if (!tokenRow) throw new Error("protected token was not found");
const userId = String(tokenRow.user_id);
const sessionIds = db
  .prepare("SELECT id FROM sessions WHERE user_id=? ORDER BY id")
  .all(userId)
  .map((row) => String(row.id));
const sessionCount = (table) =>
  Number(
    db
      .prepare(
        `SELECT COUNT(*) AS value FROM ${table} WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?)`,
      )
      .get(userId).value,
  );
const counts = Object.fromEntries(
  ["messages", "responses", "runs", "attachments", "background_tasks"].map((table) => [
    table,
    sessionCount(table),
  ]),
);
counts.memory_facts = Number(
  db.prepare("SELECT COUNT(*) AS value FROM memory_facts WHERE owner_id=?").get(userId).value,
);
counts.memory_rollups = Number(
  db
    .prepare(
      "SELECT COUNT(*) AS value FROM memory_rollups WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?)",
    )
    .get(userId).value,
);
counts.knowledge_sources = Number(
  db.prepare("SELECT COUNT(*) AS value FROM knowledge_sources WHERE owner_id=?").get(userId).value,
);
counts.knowledge_chunks = Number(
  db
    .prepare(
      `SELECT COUNT(*) AS value FROM knowledge_chunks WHERE source_id IN (SELECT id FROM knowledge_sources WHERE owner_id=?)`,
    )
    .get(userId).value,
);
counts.knowledge_embeddings = Number(
  db
    .prepare(
      `SELECT COUNT(*) AS value FROM knowledge_embeddings WHERE source_id IN (SELECT id FROM knowledge_sources WHERE owner_id=?)`,
    )
    .get(userId).value,
);
counts.tool_calls = Number(
  db
    .prepare(
      `SELECT COUNT(*) AS value FROM tool_calls WHERE run_id IN (SELECT id FROM runs WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?))`,
    )
    .get(userId).value,
);
counts.approvals = Number(
  db
    .prepare(
      `SELECT COUNT(*) AS value FROM approvals WHERE run_id IN (SELECT id FROM runs WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?))`,
    )
    .get(userId).value,
);
counts.run_actions = Number(
  db
    .prepare(
      `SELECT COUNT(*) AS value FROM run_actions WHERE run_id IN (SELECT id FROM runs WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?))`,
    )
    .get(userId).value,
);
counts.session_events = Number(
  db
    .prepare(
      "SELECT COUNT(*) AS value FROM session_events WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?)",
    )
    .get(userId).value,
);
counts.run_checkpoints = Number(
  db
    .prepare(
      `SELECT COUNT(*) AS value FROM run_checkpoints WHERE run_id IN (SELECT id FROM runs WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?))`,
    )
    .get(userId).value,
);
counts.context_summaries = Number(
  db
    .prepare(
      "SELECT COUNT(*) AS value FROM context_summaries WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?)",
    )
    .get(userId).value,
);
counts.scheduled_tasks = Number(
  db.prepare("SELECT COUNT(*) AS value FROM scheduled_tasks WHERE owner_id=?").get(userId).value,
);
counts.scheduled_task_runs = Number(
  db
    .prepare(
      "SELECT COUNT(*) AS value FROM scheduled_task_runs WHERE scheduled_task_id IN (SELECT id FROM scheduled_tasks WHERE owner_id=?)",
    )
    .get(userId).value,
);
counts.sessions = sessionIds.length;
counts.users = Number(db.prepare("SELECT COUNT(*) AS value FROM users WHERE id=?").get(userId).value);
counts.auth_tokens = Number(
  db.prepare("SELECT COUNT(*) AS value FROM auth_tokens WHERE user_id=?").get(userId).value,
);
const ids = {
  sessions: sessionIds,
  messages: db
    .prepare(
      "SELECT id FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?) ORDER BY id",
    )
    .all(userId)
    .map((row) => String(row.id)),
  runs: db
    .prepare("SELECT id FROM runs WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?) ORDER BY id")
    .all(userId)
    .map((row) => String(row.id)),
  knowledgeSources: db
    .prepare("SELECT id FROM knowledge_sources WHERE owner_id=? ORDER BY id")
    .all(userId)
    .map((row) => String(row.id)),
  scheduledTasks: db
    .prepare("SELECT id FROM scheduled_tasks WHERE owner_id=? ORDER BY id")
    .all(userId)
    .map((row) => String(row.id)),
};
const tokenIdentity = {
  id: String(tokenRow.id),
  hash: String(tokenRow.token_hash),
  scopes: String(tokenRow.scopes_json),
  expiresAt: tokenRow.expires_at ?? null,
  revokedAt: tokenRow.revoked_at ?? null,
};
const fingerprint = createHash("sha256")
  .update(JSON.stringify({ userId, token: tokenIdentity, counts, ids }))
  .digest("hex");
const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
console.log(
  JSON.stringify({ userId, fingerprint, token: tokenIdentity, counts, integrity, foreignKeyViolations }),
);
db.close();
