import type { DatabaseSync } from "node:sqlite";

export type SchemaMigration = {
  from: number;
  to: number;
  apply: (db: DatabaseSync) => void;
};

// Schema 19 is the first version managed by this forward-only migration path.
// Add one adjacent migration here whenever SCHEMA_VERSION increases.
const migrations: readonly SchemaMigration[] = [
  {
    from: 19,
    to: 20,
    apply: (db) => {
      db.exec(`
        CREATE TABLE auth_tokens_v20 (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          label TEXT NOT NULL,
          scopes_json TEXT NOT NULL DEFAULT '["user"]',
          expires_at INTEGER,
          revoked_at INTEGER,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER
        );
        INSERT INTO auth_tokens_v20(
          id,user_id,token_hash,label,scopes_json,expires_at,revoked_at,created_at,last_used_at
        )
        SELECT id,user_id,token_hash,label,scopes_json,NULL,revoked_at,created_at,last_used_at
        FROM auth_tokens;
        DROP TABLE auth_tokens;
        ALTER TABLE auth_tokens_v20 RENAME TO auth_tokens;
        CREATE INDEX auth_tokens_user_active ON auth_tokens(user_id, revoked_at, expires_at);
      `);
    },
  },
];

export function migrateSchema(db: DatabaseSync, currentVersion: number, targetVersion: number): void {
  if (currentVersion > targetVersion)
    throw new Error(`Unsupported database schema ${currentVersion}; expected at most ${targetVersion}.`);
  if (currentVersion === targetVersion) return;

  let version = currentVersion;
  db.exec("BEGIN IMMEDIATE");
  try {
    while (version < targetVersion) {
      const migration = migrations.find((item) => item.from === version && item.to === version + 1);
      if (!migration) throw new Error(`Unsupported database schema ${version}; expected ${targetVersion}.`);
      migration.apply(db);
      version = migration.to;
      db.exec(`PRAGMA user_version = ${version}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function migrateSchemaOrClose(db: DatabaseSync, currentVersion: number, targetVersion: number): void {
  try {
    migrateSchema(db, currentVersion, targetVersion);
  } catch (error) {
    db.close();
    throw error;
  }
}
