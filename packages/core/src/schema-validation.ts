import type { DatabaseSync } from "node:sqlite";

const REQUIRED_TABLES = [
  "users",
  "auth_tokens",
  "sessions",
  "runs",
  "messages",
  "approvals",
  "attachments",
  "memory_facts",
  "knowledge_sources",
  "scheduled_tasks",
  "background_tasks",
  "session_events",
  "knowledge_embeddings",
] as const;

export function validateSchema(db: DatabaseSync): void {
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name?: unknown }>).map(
      (value) => String(value.name ?? ""),
    ),
  );
  for (const table of REQUIRED_TABLES)
    if (!tables.has(table)) throw new Error(`schema_mismatch: missing table ${table}`);
  const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
    name?: unknown;
    notnull?: unknown;
    dflt_value?: unknown;
  }>;
  const byName = new Map(columns.map((column) => [String(column.name ?? ""), column]));
  if (byName.has("mode")) throw new Error("schema_mismatch: sessions.mode is obsolete");
  const userId = byName.get("user_id");
  if (!userId || Number(userId.notnull) !== 1 || userId.dflt_value !== null)
    throw new Error("schema_mismatch: sessions.user_id must be NOT NULL without a default");
  for (const name of [
    "id",
    "user_id",
    "title",
    "model_provider",
    "model_id",
    "thinking_level",
    "queue_mode",
    "next_sequence",
    "next_event_sequence",
    "created_at",
    "updated_at",
  ])
    if (!byName.has(name)) throw new Error(`schema_mismatch: sessions.${name} is missing`);
  const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown };
  if (String(integrity?.integrity_check ?? "") !== "ok")
    throw new Error("schema_mismatch: integrity_check failed");
  if (db.prepare("PRAGMA foreign_key_check").all().length > 0)
    throw new Error("schema_mismatch: foreign_key_check failed");
}
