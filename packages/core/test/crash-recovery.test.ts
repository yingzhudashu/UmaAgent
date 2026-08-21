import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { UmaDatabase } from "../src/database.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("real process crash recovery", () => {
  for (const point of ["preflight", "model", "read", "side-effect", "verify"] as const) {
    it(`recovers a forced child-process termination at ${point}`, async () => {
      const stateDir = await mkdtemp(join(tmpdir(), `uma-crash-${point}-`));
      temporary.push(stateDir);
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("./fixtures/crash-harness.ts", import.meta.url)),
          stateDir,
          point,
        ],
        { timeout: 20_000, windowsHide: true },
      );
      expect(child.status).not.toBe(0);
      const database = new UmaDatabase(stateDir);
      try {
        const session = database.listSessions()[0];
        expect(session).toBeDefined();
        const run = database.getSnapshot(session?.id as string).recentRuns[0];
        expect(run?.status).toBe("interrupted");
        if (point === "read") expect(database.listRunActions(run?.id as string)[0]?.status).toBe("prepared");
        if (point === "side-effect")
          expect(database.listRunActions(run?.id as string)[0]?.status).toBe("uncertain");
        if (point === "model") {
          const call = database.db.prepare("SELECT status FROM model_calls WHERE run_id=?").get(run?.id) as {
            status: string;
          };
          expect(call.status).toBe("abandoned");
        }
      } finally {
        database.close();
      }
    });
  }
});
