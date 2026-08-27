import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const stateDir = process.argv[2];
const secretPath = process.argv[3] ?? "/etc/uma-agent/protected-user-pat";
if (!stateDir) throw new Error("usage: protected-user-fingerprint.mjs STATE_DIR [SECRET_FILE]");

const secretStat = statSync(secretPath);
if (process.platform !== "win32" && (secretStat.mode & 0o777) !== 0o600)
  throw new Error("protected PAT file must use mode 0600");
if (
  process.platform !== "win32" &&
  secretPath === "/etc/uma-agent/protected-user-pat" &&
  secretStat.uid !== 0
)
  throw new Error("production protected PAT file must be owned by root");
const token = readFileSync(secretPath, "utf8").trim();
const match = /^uma_pat_([0-9a-f-]{36})_([A-Za-z0-9_-]{32,})$/.exec(token);
if (!match) throw new Error("protected PAT file has invalid content");
const tokenId = match[1];
const secretHash = createHash("sha256").update(match[2]).digest("hex");

const db = new DatabaseSync(join(stateDir, "state.db"), { readOnly: true });
try {
  const tokenRow = db
    .prepare(
      "SELECT id,user_id,token_hash,scopes_json,expires_at,revoked_at FROM auth_tokens WHERE id=? AND token_hash=?",
    )
    .get(tokenId, secretHash);
  if (!tokenRow) throw new Error("protected token was not found");
  const userId = String(tokenRow.user_id);
  const ids = {};
  const collect = (name, sql, ...params) => {
    ids[name] = db
      .prepare(sql)
      .all(...params)
      .map((row) => String(row.id))
      .sort();
  };
  const sessions = "SELECT id FROM sessions WHERE user_id=?";
  const runs = `SELECT id FROM runs WHERE session_id IN (${sessions})`;
  const responses = `SELECT id FROM responses WHERE session_id IN (${sessions})`;
  const sources = "SELECT id FROM knowledge_sources WHERE owner_id=?";
  const schedules = "SELECT id FROM scheduled_tasks WHERE owner_id=?";

  collect("users", "SELECT id FROM users WHERE id=?", userId);
  collect("auth_tokens", "SELECT id FROM auth_tokens WHERE user_id=?", userId);
  collect("sessions", sessions, userId);
  collect("runs", runs, userId);
  collect("plan_steps", `SELECT id FROM plan_steps WHERE run_id IN (${runs})`, userId);
  collect(
    "attachments",
    `SELECT id FROM attachments WHERE owner_user_id=? OR session_id IN (${sessions})`,
    userId,
    userId,
  );
  collect("responses", responses, userId);
  collect(
    "response_activities",
    `SELECT id FROM response_activities WHERE response_id IN (${responses})`,
    userId,
  );
  collect("messages", `SELECT id FROM messages WHERE session_id IN (${sessions})`, userId);
  collect("tool_calls", `SELECT id FROM tool_calls WHERE run_id IN (${runs})`, userId);
  collect("approvals", `SELECT id FROM approvals WHERE run_id IN (${runs})`, userId);
  collect("memory_facts", "SELECT id FROM memory_facts WHERE owner_id=?", userId);
  collect("memory_rollups", `SELECT id FROM memory_rollups WHERE session_id IN (${sessions})`, userId);
  collect("agent_profiles", "SELECT user_id AS id FROM agent_profiles WHERE user_id=?", userId);
  collect("quality_assessments", `SELECT id FROM quality_assessments WHERE run_id IN (${runs})`, userId);
  collect(
    "background_tasks",
    `SELECT id FROM background_tasks WHERE session_id IN (${sessions}) OR parent_session_id IN (${sessions})`,
    userId,
    userId,
  );
  collect("audit_events", `SELECT id FROM audit_events WHERE run_id IN (${runs})`, userId);
  collect("model_calls", `SELECT id FROM model_calls WHERE run_id IN (${runs})`, userId);
  collect("session_events", `SELECT id FROM session_events WHERE session_id IN (${sessions})`, userId);
  collect("run_checkpoints", `SELECT id FROM run_checkpoints WHERE run_id IN (${runs})`, userId);
  collect("run_actions", `SELECT id FROM run_actions WHERE run_id IN (${runs})`, userId);
  collect(
    "context_summaries",
    `SELECT session_id AS id FROM context_summaries WHERE session_id IN (${sessions})`,
    userId,
  );
  collect("knowledge_sources", sources, userId);
  collect("knowledge_chunks", `SELECT id FROM knowledge_chunks WHERE source_id IN (${sources})`, userId);
  collect(
    "knowledge_embeddings",
    `SELECT chunk_id AS id FROM knowledge_embeddings WHERE source_id IN (${sources})`,
    userId,
  );
  collect("scheduled_tasks", schedules, userId);
  collect(
    "scheduled_task_runs",
    `SELECT id FROM scheduled_task_runs WHERE scheduled_task_id IN (${schedules})`,
    userId,
  );
  collect(
    "team_spaces",
    "SELECT id FROM team_spaces WHERE created_by=? OR id IN (SELECT space_id FROM team_space_members WHERE user_id=?)",
    userId,
    userId,
  );
  collect(
    "team_space_members",
    "SELECT space_id || ':' || user_id AS id FROM team_space_members WHERE user_id=? OR space_id IN (SELECT id FROM team_spaces WHERE created_by=?)",
    userId,
    userId,
  );
  collect("external_identities", "SELECT id FROM external_identities WHERE user_id=?", userId);
  collect(
    "trace_spans_legacy",
    `SELECT span_id AS id FROM trace_spans WHERE session_id IN (${sessions})`,
    userId,
  );

  const counts = Object.fromEntries(Object.entries(ids).map(([name, values]) => [name, values.length]));
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
    JSON.stringify({
      userId,
      fingerprint,
      token: tokenIdentity,
      counts,
      ids,
      integrity,
      foreignKeyViolations,
    }),
  );
} finally {
  db.close();
}
