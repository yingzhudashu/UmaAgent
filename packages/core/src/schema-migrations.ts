import type { DatabaseSync } from "node:sqlite";

export type SchemaMigration = {
  from: number;
  to: number;
  apply: (db: DatabaseSync) => void;
};

// Schema 19 is the first version managed by this forward-only migration path.
// Add one adjacent migration here whenever SCHEMA_VERSION increases.
const migrations: readonly SchemaMigration[] = [];

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
