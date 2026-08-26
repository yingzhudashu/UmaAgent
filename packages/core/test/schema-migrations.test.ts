import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateSchema } from "../src/schema-migrations.js";

describe("migrateSchema", () => {
  it("leaves an already-current database untouched", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE records(value TEXT); INSERT INTO records VALUES('kept'); PRAGMA user_version = 19;",
    );
    migrateSchema(db, 19, 19);
    expect(db.prepare("SELECT value FROM records").get()).toEqual({ value: "kept" });
    db.close();
  });

  it("rejects an unsupported upgrade without changing the version", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE records(value TEXT); INSERT INTO records VALUES('kept'); PRAGMA user_version = 18;",
    );
    expect(() => migrateSchema(db, 18, 19)).toThrow("Unsupported database schema 18");
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 18 });
    expect(db.prepare("SELECT value FROM records").get()).toEqual({ value: "kept" });
    db.close();
  });
});
