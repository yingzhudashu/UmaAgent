import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateLock } from "../src/state-lock.js";

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("StateLock", () => {
  it("allows only one server process to own a state directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-lock-"));
    temporary.push(root);
    const first = StateLock.acquire(root);
    expect(() => StateLock.acquire(root)).toThrow("already in use");
    first.release();
    expect(() => first.release()).not.toThrow();
    const next = StateLock.acquire(root);
    next.release();
  });

  it("recovers a stale lock left by a terminated process", async () => {
    const root = await mkdtemp(join(tmpdir(), "uma-stale-lock-"));
    temporary.push(root);
    const lockPath = join(root, "uma.lock");
    await mkdir(lockPath);
    const staleAt = new Date(Date.now() - 30_000);
    await utimes(lockPath, staleAt, staleAt);

    const lock = StateLock.acquire(root);
    lock.release();
  });
});
