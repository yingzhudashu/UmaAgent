import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const output = resolve(fileURLToPath(new URL("../apps/web/dist-embed/", import.meta.url)));
const files = ["uma-embed.js", "uma-embed.css"];
const assets = {};
for (const file of files) {
  const data = await readFile(resolve(output, file));
  assets[file] = { bytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") };
}
await writeFile(
  resolve(output, "embed-manifest.json"),
  `${JSON.stringify({ version: "1.3.0", assets }, null, 2)}\n`,
  "utf8",
);
