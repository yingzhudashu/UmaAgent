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
  const matrix = [
    { point: "preflight.completed" },
    { point: "checkpoint.created" },
    { point: "model.started", modelStatus: "abandoned" },
    { point: "model.completed", modelStatus: "completed" },
    { point: "tool.prepared:read", actionStatus: "prepared" },
    { point: "tool.started:read", actionStatus: "prepared" },
    { point: "tool.completed:read", actionStatus: "completed" },
    { point: "tool.started:side-effect", actionStatus: "uncertain" },
    { point: "tool.completed:side-effect", actionStatus: "completed" },
    { point: "verify.completed" },
  ] as const;

  for (const scenario of matrix) {
    it(`recovers a forced child-process termination at ${scenario.point}`, async () => {
      const stateDir = await mkdtemp(join(tmpdir(), `uma-crash-${scenario.point.replaceAll(/[.:]/g, "-")}-`));
      temporary.push(stateDir);
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("./fixtures/crash-harness.ts", import.meta.url)),
          stateDir,
          scenario.point,
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
        if (scenario.actionStatus)
          expect(database.listRunActions(run?.id as string)[0]?.status).toBe(scenario.actionStatus);
        if (scenario.point.startsWith("tool.completed")) {
          const toolResult = database
            .listAgentMessages(session?.id as string)
            .find((item) => item.message.role === "toolResult");
          expect(toolResult?.message).toMatchObject({ role: "toolResult" });
        }
        if (scenario.modelStatus) {
          const call = database.db.prepare("SELECT status FROM model_calls WHERE run_id=?").get(run?.id) as {
            status: string;
          };
          expect(call.status).toBe(scenario.modelStatus);
        }
      } finally {
        database.close();
      }
    });
  }
});
