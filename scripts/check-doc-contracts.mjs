import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

const violations = [];
const releaseText = await readFile("RELEASE", "utf8");
const release = Object.fromEntries(
  [...releaseText.matchAll(/^([a-z]+)=(.+)$/gm)].map(([, key, value]) => [key, value]),
);
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const protocolSource = await readFile("packages/protocol/src/schema-helpers.ts", "utf8");
const databaseSource = await readFile("packages/core/src/database.ts", "utf8");
const schemaSource = await readFile("packages/core/src/schema.sql", "utf8");
const androidBuild = await readFile("android/app/build.gradle.kts", "utf8");
const androidProjection = await readFile(
  "android/app/src/main/java/site/robotclaw/umaagent/SnapshotProjection.kt",
  "utf8",
);
const androidStreamInterval = Number(androidProjection.match(/STREAM_PUBLISH_INTERVAL_MS\s*=\s*(\d+)L/)?.[1]);
const protocolVersion = Number(protocolSource.match(/PROTOCOL_VERSION\s*=\s*(\d+)/)?.[1]);
const schemaVersion = Number(databaseSource.match(/SCHEMA_VERSION\s*=\s*(\d+)/)?.[1]);
const sqlSchemaVersion = Number(schemaSource.match(/PRAGMA user_version\s*=\s*(\d+)/i)?.[1]);
const androidVersion = androidBuild.match(/versionName\s*=\s*"([^"]+)"/)?.[1];
const androidVersionCode = Number(androidBuild.match(/versionCode\s*=\s*(\d+)/)?.[1]);

function requireFact(name, actual, expected) {
  if (actual !== expected) violations.push(`${name}: expected ${expected}, found ${actual ?? "missing"}`);
}

requireFact("RELEASE version", packageJson.version, release.version);
requireFact("protocol source", protocolVersion, Number(release.protocol));
requireFact("database runtime schema", schemaVersion, Number(release.schema));
requireFact("database SQL schema", sqlSchemaVersion, Number(release.schema));
if (!androidVersion || !Number.isSafeInteger(androidVersionCode))
  violations.push("Android build versionName/versionCode must be defined");
if (!Number.isSafeInteger(androidStreamInterval) || androidStreamInterval <= 0)
  violations.push("Android stream publish interval must be defined");

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(path)));
    else if (extname(entry.name).toLowerCase() === ".md") files.push(path);
  }
  return files;
}

const files = ["README.md", "CODEX-CONTEXT.md", "android/RELEASE_NOTES.md", ...(await markdownFiles("docs"))];
const currentProtocol = Number(release.protocol);
const currentSchema = Number(release.schema);
const currentCore = String(release.version);
const currentAndroid = String(androidVersion);
const commandNames = new Set(Object.keys(packageJson.scripts ?? {}));
const localLink = /!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+[^)]*)?\)/g;

for (const file of files) {
  const content = await readFile(file, "utf8");
  for (const match of content.matchAll(/\/api\/v(\d+)\b/g))
    requireFact(`${file} API version`, Number(match[1]), currentProtocol);
  for (const match of content.matchAll(/\bProtocol\s+v?(\d+)\b/gi))
    requireFact(`${file} protocol version`, Number(match[1]), currentProtocol);
  for (const match of content.matchAll(/\b(?:SQLite\s+)?schema\s*(?:version)?\s*(?:=|:|：)?\s*(\d+)\b/gi))
    requireFact(`${file} schema version`, Number(match[1]), currentSchema);
  for (const match of content.matchAll(/\bCore\s+(\d+\.\d+\.\d+)\b/g))
    requireFact(`${file} Core version`, match[1], currentCore);
  for (const match of content.matchAll(/\bAndroid\s+(\d+\.\d+\.\d+)\b/g))
    requireFact(`${file} Android version`, match[1], currentAndroid);
  for (const match of content.matchAll(/\bnpm\s+run\s+([\w:.-]+)/g))
    if (!commandNames.has(match[1])) violations.push(`${file}: npm script does not exist: ${match[1]}`);
  // 设计文档须跟随实际发布节奏；不能把旧调参值继续当作当前性能事实。
  for (const match of content.matchAll(/(?:Android 流式状态按\s*|Android 按|增量按)(\d+)\s*ms\s*窗口/g))
    requireFact(`${file} Android stream interval`, Number(match[1]), androidStreamInterval);

  for (const match of content.matchAll(localLink)) {
    let target = match[1].replace(/^<|>$/g, "");
    if (/^(?:[a-z]+:|\/\/)/i.test(target) || target.startsWith("#")) continue;
    target = decodeURIComponent(target.split(/[?#]/, 1)[0] ?? "");
    if (!target) continue;
    if (!existsSync(resolve(dirname(file), target)))
      violations.push(`${file}: local Markdown link target does not exist: ${target}`);
  }
}

if (violations.length) {
  console.error("Documentation contract check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    `Documentation contracts passed (${files.length} Markdown files; Core ${currentCore}, Android ${currentAndroid}, Protocol v${currentProtocol}, schema ${currentSchema})`,
  );
}
