import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const roots = ["packages", "apps"];
const ignored = new Set(["dist", "dist-types", "coverage", "node_modules", "test-results", ".vite"]);
const sourceExtensions = new Set([".ts", ".tsx", ".mjs"]);
const baseline = JSON.parse(await readFile("scripts/architecture-baseline.json", "utf8"));
const files = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (sourceExtensions.has(extname(entry.name))) files.push(path);
  }
}

for (const root of roots) await walk(root);

const violations = [];
const sizeDebt = [];
for (const file of files) {
  const content = await readFile(file, "utf8");
  const lines = content.split(/\r?\n/).length;
  const name = relative(".", file).replaceAll("\\", "/");
  const isTest = /(^|\/)test\//.test(name) || /\.test\.[cm]?[jt]sx?$/.test(name);

  if (!isTest && lines > 900) {
    sizeDebt.push({ file: name, lines });
    const allowed = baseline.maxLines[name];
    if (allowed === undefined) violations.push(`${name}: source file exceeds 900 lines`);
    else if (lines > allowed)
      violations.push(`${name}: grew beyond architecture baseline (${lines} > ${allowed})`);
  }
  if (!isTest && /@uma-agent\/(?:core|client|protocol)\/src\//.test(content))
    violations.push(`${name}: cross-package deep import`);
  if (!isTest && /\bconsole\.(?:log|warn|error|debug)\s*\(/.test(content) && !/(^|\/)main\.ts$/.test(name))
    violations.push(`${name}: use structured logger instead of console.*`);
  if (/\/api\/v(?:7|8|9)(?:\/|\b)/.test(content)) violations.push(`${name}: stale API version reference`);
}

if (violations.length > 0) {
  console.error("Architecture check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
}

if (sizeDebt.length > 0) {
  console.warn("Architecture size debt (tracked for decomposition):");
  for (const item of sizeDebt.sort((a, b) => b.lines - a.lines))
    console.warn(`- ${item.file}: ${item.lines} lines`);
}

if (violations.length === 0) console.log(`Architecture check passed (${files.length} source files scanned)`);
