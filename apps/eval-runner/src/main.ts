import { readFile } from "node:fs/promises";
import { UmaClient } from "@uma-agent/client";
import type { CreateEvaluationReport } from "@uma-agent/protocol";
import { writeEvaluationOutputs } from "./report-output.js";
import { type EvalCase, evaluateSuite, junitReport } from "./runner.js";

const suitePath = process.argv[2];
if (!suitePath) throw new Error("Usage: uma-eval <suite.json>");
const baseUrl = process.env.UMA_SERVER_URL?.trim();
const token = process.env.UMA_TOKEN?.trim();
if (!baseUrl || !token) throw new Error("UMA_SERVER_URL and UMA_TOKEN are required");
const parsed = JSON.parse(await readFile(suitePath, "utf8")) as unknown;
if (!Array.isArray(parsed)) throw new Error("Evaluation suite must be a JSON array");
const client = new UmaClient({ baseUrl, token });
try {
  const startedAt = Date.now();
  const results = await evaluateSuite(client, parsed as EvalCase[]);
  const categories = Object.fromEntries(
    [...new Set(results.map((result) => result.category))].map((category) => {
      const values = results.filter((result) => result.category === category);
      return [category, { total: values.length, passed: values.filter((result) => result.passed).length }];
    }),
  );
  const failures = results.filter((result) => !result.passed).length;
  const input: CreateEvaluationReport = {
    mode: process.env.EVAL_MODE === "real" ? "real" : "faux",
    suiteVersion: process.env.EVAL_SUITE_VERSION?.trim() || "1",
    status: failures ? "failed" : "completed",
    totals: {
      total: results.length,
      passed: results.length - failures,
      failed: failures,
      skipped: 0,
    },
    durationMs: Date.now() - startedAt,
    cases: results,
  };
  const stored = await client.createEvaluationReport(input);
  const report = { protocolVersion: 13, timestamp: Date.now(), categories, ...stored };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  const junitPath = process.env.EVAL_JUNIT_PATH?.trim();
  const historyPath = process.env.EVAL_HISTORY_PATH?.trim();
  await writeEvaluationOutputs({
    ...(junitPath ? { junitPath } : {}),
    junit: junitReport(results),
    ...(historyPath ? { historyPath } : {}),
    historyEntry: JSON.stringify(report),
  });
  if (results.some((result) => !result.passed)) process.exitCode = 1;
} finally {
  client.close();
}
