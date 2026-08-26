import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const stateDir = process.argv[2];
if (!stateDir) throw new Error("usage: state-fingerprint.mjs STATE_DIR");

const db = new DatabaseSync(`${stateDir}/state.db`, { readOnly: true });
const count = (table) => Number(db.prepare(`SELECT count(*) AS value FROM ${table}`).get().value);
const rows = db
  .prepare(
    "SELECT id,user_id,token_hash,label,scopes_json,expires_at,revoked_at FROM auth_tokens ORDER BY id",
  )
  .all();
const tokenFingerprint = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
const userVersion = Number(db.prepare("PRAGMA user_version").get().user_version);

console.log(
  JSON.stringify({
    userVersion,
    integrity,
    foreignKeyViolations,
    tokenFingerprint,
    counts: Object.fromEntries(
      ["users", "auth_tokens", "sessions", "messages", "attachments", "knowledge_sources"].map((table) => [
        table,
        count(table),
      ]),
    ),
  }),
);
db.close();
