import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const allowedConditionalSkips = [
  "site.robotclaw.umaagent.ShellLayoutTest#rootBackProtectsTabletSessionDraft",
];

/**
 * AndroidJUnitRunner 的进程退出码不能证明用例通过。
 * 对每个终态核对类名、方法名和发现阶段清单，拒绝截断、重复、漏跑及意外跳过。
 */
export function parseInstrumentation(output, expected, allowedSkips = []) {
  const outcomes = new Map();
  const problems = [];
  const declared = new Set();
  const allowed = new Set(allowedSkips);
  for (const match of output.matchAll(/([\s\S]*?)^INSTRUMENTATION_STATUS_CODE: (-?\d+)\s*$/gm)) {
    const block = match[1];
    const code = Number(match[2]);
    const field = (name) => new RegExp(`^INSTRUMENTATION_STATUS: ${name}=(.+)$`, "m").exec(block)?.[1].trim();
    const count = Number(field("numtests"));
    if (Number.isSafeInteger(count) && count > 0) declared.add(count);
    if (code === 1) continue;
    const className = field("class");
    const method = field("test");
    if (!className || !method) {
      problems.push("Missing test identity");
      continue;
    }
    const id = `${className}#${method}`;
    if (outcomes.has(id)) problems.push(`Duplicate result: ${id}`);
    const status = code === 0 ? "passed" : code === -3 || code === -4 ? "skipped" : "failed";
    outcomes.set(id, status);
    if (status === "failed" || (status === "skipped" && !allowed.has(id))) problems.push(`${status}: ${id}`);
  }
  const tests = [...outcomes.keys()].sort();
  if (declared.size !== 1 || !declared.has(tests.length))
    problems.push("Declared count differs from completed tests");
  if (expected && JSON.stringify(tests) !== JSON.stringify([...expected].sort()))
    problems.push("Executed test list differs from discovery");
  if (!/^OK \(\d+ tests?\)\s*$/m.test(output) || !/^INSTRUMENTATION_CODE: -1\s*$/m.test(output))
    problems.push("Missing successful runner completion");
  if (/FAILURES!!!|INSTRUMENTATION_FAILED|INSTRUMENTATION_ABORTED/.test(output))
    problems.push("Runner reported failure");
  return {
    passed: problems.length === 0,
    tests: tests.length,
    successful: [...outcomes.values()].filter((status) => status === "passed").length,
    skipped: [...outcomes.values()].filter((status) => status === "skipped").length,
    identities: tests,
    problems,
  };
}

/** 分进程执行时仍按发现清单核对总结果，不能通过拆分隐藏漏跑或失败。 */
export function mergeInstrumentation(results, expected) {
  const identities = results.flatMap((result) => result.identities).sort();
  const problems = results.flatMap((result) => result.problems);
  if (new Set(identities).size !== identities.length) problems.push("Duplicate test across processes");
  if (JSON.stringify(identities) !== JSON.stringify([...expected].sort()))
    problems.push("Executed test list differs from discovery");
  return {
    passed: results.every((result) => result.passed) && problems.length === 0,
    tests: identities.length,
    successful: results.reduce((total, result) => total + result.successful, 0),
    skipped: results.reduce((total, result) => total + result.skipped, 0),
    identities,
    problems,
  };
}

// 供 Python 设备矩阵复用同一判定，不再通过日志中的 OK 子串放行。
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const expected = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], "utf8")).identities : undefined;
  const result = parseInstrumentation(
    readFileSync(process.argv[2], "utf8"),
    expected,
    allowedConditionalSkips,
  );
  console.log(JSON.stringify(result));
  process.exitCode = result.passed ? 0 : 1;
}
