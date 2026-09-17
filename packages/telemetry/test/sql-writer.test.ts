import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { SqlWriter } from "../src/sql-writer.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "uma-writer-"));
  roots.push(root);
  const path = join(root, "trace.db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE events(id INTEGER PRIMARY KEY, value TEXT)");
  return { path, db, writer: SqlWriter.acquire(path) };
}
it("persists atomic groups, isolates failures and shares a writer until the last owner closes", async () => {
  const { path, db, writer } = await fixture();
  const other = SqlWriter.acquire(path);
  try {
    expect(other).toBe(writer);
    writer.batch(() => {
      writer.enqueue("INSERT INTO events VALUES(?,?)", [1, "rolled back"]);
      writer.enqueue("INSERT INTO absent VALUES(?)", [2]);
    });
    writer.enqueue("INSERT INTO events VALUES(?,?)", [3, "kept"]);
    await writer.flush();
    expect(db.prepare("SELECT * FROM events").all()).toEqual([{ id: 3, value: "kept" }]);
    expect(writer.failures).toBe(2);
    await writer.release();
    other.enqueue("INSERT INTO events VALUES(?,?)", [4, "after first release"]);
    await other.release();
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()?.count).toBe(2);
  } finally {
    db.close();
  }
});

it("bounds outstanding writes and never admits half an oversized transaction", async () => {
  const { db, writer } = await fixture();
  try {
    writer.batch(() => {
      for (let id = 0; id < 8193; id++) writer.enqueue("INSERT INTO events VALUES(?,?)", [id, "overflow"]);
    });
    writer.enqueue("INSERT INTO events VALUES(?,?)", [9000, "healthy"]);
    await writer.flush();
    expect(writer.failures).toBe(8193);
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()?.count).toBe(1);
  } finally {
    await writer.release();
    db.close();
  }
});

it("settles flush and exposes failed writes after a worker cannot open its database", async () => {
  const root = await mkdtemp(join(tmpdir(), "uma-writer-exit-"));
  roots.push(root);
  const writer = SqlWriter.acquire(join(root, "missing", "trace.db"));
  writer.enqueue("INSERT INTO events VALUES(?,?)", [1, "failure"]);
  await writer.flush();
  expect(writer.failures).toBe(1);
  writer.enqueue("INSERT INTO events VALUES(?,?)", [2, "failure"]);
  expect(writer.failures).toBe(2);
  await writer.release();
});
