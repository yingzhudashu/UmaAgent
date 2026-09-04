import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("release data protection", () => {
  it("fingerprints protected user objects without exposing the PAT", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-protected-"));
    roots.push(root);
    const state = join(root, "state");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(state));
    const db = new DatabaseSync(join(state, "state.db"));
    db.exec(await readFile(resolve("packages/core/src/schema.sql"), "utf8"));
    const tokenId = "11111111-1111-4111-8111-111111111111";
    const secret = "a".repeat(32);
    const pat = `uma_pat_${tokenId}_${secret}`;
    const hash = createHash("sha256").update(secret).digest("hex");
    db.prepare("INSERT INTO users(id,role,status,created_at,updated_at) VALUES(?,?,?,?,?)").run(
      "user-1",
      "user",
      "active",
      1,
      1,
    );
    db.prepare(
      "INSERT INTO auth_tokens(id,user_id,token_hash,label,scopes_json,created_at) VALUES(?,?,?,?,?,?)",
    ).run(tokenId, "user-1", hash, "test", '["user"]', 1);
    db.prepare(
      "INSERT INTO sessions(id,user_id,title,model_provider,model_id,thinking_level,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run("session-1", "user-1", "test", "test", "model", "off", 1, 1);
    db.close();
    const secretFile = join(root, "protected-pat");
    await writeFile(secretFile, `${pat}\n`);
    await chmod(secretFile, 0o600);
    const result = spawnSync(
      process.execPath,
      [resolve("deploy/protected-user-fingerprint.mjs"), state, secretFile],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(pat);
    expect(JSON.parse(result.stdout)).toMatchObject({
      userId: "user-1",
      counts: { sessions: 1 },
      ids: { sessions: ["session-1"] },
      integrity: "ok",
      foreignKeyViolations: 0,
    });
  });

  it("creates a verified online SQLite backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-backup-"));
    roots.push(root);
    const state = join(root, "state");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(state));
    const source = new DatabaseSync(join(state, "state.db"));
    source.exec(
      "CREATE TABLE records(value TEXT); INSERT INTO records VALUES('kept'); PRAGMA user_version=21;",
    );
    source.close();
    const destination = join(root, "backup", "state.db");
    const result = spawnSync(
      process.execPath,
      [resolve("deploy/backup-native-online.mjs"), state, destination],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const backup = new DatabaseSync(destination, { readOnly: true });
    expect(backup.prepare("SELECT value FROM records").get()).toEqual({ value: "kept" });
    backup.close();
  });

  it("allows recovery writes while rejecting protected object removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-protected-compare-"));
    roots.push(root);
    const beforePath = join(root, "before.json");
    const afterPath = join(root, "after.json");
    const before = {
      userId: "user-1",
      token: { id: "token-1", hash: "hash", scopes: '["user"]', expiresAt: null, revokedAt: null },
      counts: { sessions: 1 },
      ids: { sessions: ["session-1"] },
      integrity: "ok",
      foreignKeyViolations: 0,
    };
    await writeFile(beforePath, JSON.stringify(before));
    await writeFile(
      afterPath,
      JSON.stringify({
        ...before,
        counts: { sessions: 2 },
        ids: { sessions: ["session-1", "session-2"] },
        fingerprint: "changed-by-recovery",
      }),
    );
    const preserved = spawnSync(
      process.execPath,
      [resolve("deploy/compare-protected-user.mjs"), beforePath, afterPath],
      { encoding: "utf8" },
    );
    expect(preserved.status, preserved.stderr).toBe(0);
    expect(preserved.stdout).toContain('"protectedUserPreserved":true');

    await writeFile(afterPath, JSON.stringify({ ...before, counts: { sessions: 0 }, ids: { sessions: [] } }));
    const removed = spawnSync(
      process.execPath,
      [resolve("deploy/compare-protected-user.mjs"), beforePath, afterPath],
      { encoding: "utf8" },
    );
    expect(removed.status).not.toBe(0);
    expect(`${removed.stdout}\n${removed.stderr}`).toContain("protected user object removed: sessions");
  });
});
