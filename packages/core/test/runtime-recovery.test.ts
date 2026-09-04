import type { Run } from "@uma-agent/protocol";
import { describe, expect, it } from "vitest";
import { recoverRestartedRuns } from "../src/runtime-recovery.js";

describe("restart recovery", () => {
  it("runs recoveries serially and records each attempt before resuming", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runs = [{ id: "first" }, { id: "second" }] as Run[];
    const recovery = recoverRestartedRuns(
      runs,
      (runId) => {
        order.push(`resume:${runId}`);
        return {} as Run;
      },
      async (runId) => {
        order.push(`wait:${runId}`);
        if (runId === "first") await firstDone;
      },
      () => true,
      (runId) => order.push(`attempt:${runId}`),
      0,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["attempt:first", "resume:first", "wait:first"]);
    releaseFirst?.();
    await recovery;
    expect(order).toEqual([
      "attempt:first",
      "resume:first",
      "wait:first",
      "attempt:second",
      "resume:second",
      "wait:second",
    ]);
  });
});
