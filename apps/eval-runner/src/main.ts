import { appendFile, readFile, writeFile } from "node:fs/promises";
import { UmaClient } from "@uma-agent/client";
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
  const results = await evaluateSuite(client, parsed as EvalCase[]);
  const categories = Object.fromEntries(
    [...new Set(results.map((result) => result.category))].map((category) => {
      const values = results.filter((result) => result.category === category);
      return [category, { total: values.length, passed: values.filter((result) => result.passed).length }];
    }),
  );
  const report = { protocolVersion: 9, timestamp: Date.now(), categories, results };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  const junitPath = process.env.EVAL_JUNIT_PATH?.trim();
  if (junitPath) await writeFile(junitPath, junitReport(results), "utf8");
  const historyPath = process.env.EVAL_HISTORY_PATH?.trim();
  if (historyPath) await appendFile(historyPath, `${JSON.stringify(report)}\n`, "utf8");
  if (results.some((result) => !result.passed)) process.exitCode = 1;
} finally {
  client.close();
}
