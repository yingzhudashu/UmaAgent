import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(".");
const files = execFileSync("git", ["ls-files", "*.ts", "*.tsx", "*.mjs", "*.js"], { encoding: "utf8" })
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
const findings = [];
for (const file of files) {
  try {
    await access(resolve(root, file));
  } catch {
    continue;
  }
  const content = await readFile(resolve(root, file), "utf8");
  const lines = content.split(/\r?\n/);
  findings.push({
    file,
    lines: lines.length,
    hotPath: /(fetch\(|DatabaseSync|setInterval|subscribe\(|while\s*\()/u.test(content),
    ioOrAllocationRisk: /(readFile|writeFile|JSON\.stringify|new\s+Map|new\s+Array|Buffer\.)/u.test(content),
    concurrencyRisk: /(Promise\.all|setInterval|AbortController|semaphore|queue)/iu.test(content),
    credentialBoundary: /(token|secret|authorization|cookie|apiKey|password)/iu.test(content),
    testCoverage: /(?:test|spec)\./u.test(file),
  });
}
// 审计结果是一次性诊断输出，不写入仓库，避免把机器生成的过程文件当成质量结论。
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), files: findings }, null, 2));
