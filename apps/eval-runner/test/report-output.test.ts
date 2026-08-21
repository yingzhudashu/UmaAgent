import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeEvaluationOutputs } from "../src/report-output.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("evaluation report output", () => {
  it("creates missing parent directories for JUnit and history outputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uma-eval-output-"));
    directories.push(directory);
    const junitPath = join(directory, "reports", "junit", "eval.xml");
    const historyPath = join(directory, "reports", "history", "eval.jsonl");

    await writeEvaluationOutputs({
      junitPath,
      junit: "<testsuite/>",
      historyPath,
      historyEntry: '{"id":"first"}',
    });
    await writeEvaluationOutputs({
      junit: "unused",
      historyPath,
      historyEntry: '{"id":"second"}',
    });

    await expect(readFile(junitPath, "utf8")).resolves.toBe("<testsuite/>");
    await expect(readFile(historyPath, "utf8")).resolves.toBe('{"id":"first"}\n{"id":"second"}\n');
  });
});
