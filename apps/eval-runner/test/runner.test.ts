import type { Run, SessionSnapshot } from "@uma-agent/protocol";
import { describe, expect, it } from "vitest";
import { type EvalClient, evaluateSuite } from "../src/runner.js";

describe("evaluation runner", () => {
  it("evaluates only public terminal state and transcript output", async () => {
    const run = { id: "run", status: "completed" } as Run;
    const client: EvalClient = {
      async createSession() {
        return { id: "session" };
      },
      async sendMessage() {
        return { runId: run.id };
      },
      async waitForRun() {
        return run;
      },
      async getSession() {
        return {
          transcript: [{ runId: run.id, role: "assistant", content: "expected answer" }],
        } as SessionSnapshot;
      },
    };
    await expect(
      evaluateSuite(client, [
        {
          name: "direct",
          prompt: "answer",
          expectedStatus: "completed",
          expectedIncludes: "expected",
        },
      ]),
    ).resolves.toEqual([expect.objectContaining({ name: "direct", passed: true, status: "completed" })]);
  });
});
