import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateSchema } from "../src/schema-migrations.js";

describe("migrateSchema", () => {
  it("leaves an already-current database untouched", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE records(value TEXT); INSERT INTO records VALUES('kept'); PRAGMA user_version = 20;",
    );
    migrateSchema(db, 20, 20);
    expect(db.prepare("SELECT value FROM records").get()).toEqual({ value: "kept" });
    db.close();
  });

  it("migrates existing personal tokens to permanent records", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users(id TEXT PRIMARY KEY);
      INSERT INTO users VALUES('user-1');
      CREATE TABLE auth_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        scopes_json TEXT NOT NULL DEFAULT '["user"]',
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE INDEX auth_tokens_user_active ON auth_tokens(user_id, revoked_at, expires_at);
      INSERT INTO auth_tokens VALUES('active','user-1','hash-a','active','["user"]',1,NULL,2,3);
      INSERT INTO auth_tokens VALUES('revoked','user-1','hash-b','revoked','["user"]',4,5,6,7);
      PRAGMA user_version = 19;
    `);
    migrateSchema(db, 19, 20);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 20 });
    expect(db.prepare("SELECT id,expires_at,revoked_at FROM auth_tokens ORDER BY id").all()).toEqual([
      { id: "active", expires_at: null, revoked_at: null },
      { id: "revoked", expires_at: null, revoked_at: 5 },
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("rejects an unsupported upgrade without changing the version", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE records(value TEXT); INSERT INTO records VALUES('kept'); PRAGMA user_version = 18;",
    );
    expect(() => migrateSchema(db, 18, 20)).toThrow("Unsupported database schema 18");
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 18 });
    expect(db.prepare("SELECT value FROM records").get()).toEqual({ value: "kept" });
    db.close();
  });
});
