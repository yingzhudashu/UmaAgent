import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const output = resolve(fileURLToPath(new URL("../apps/web/dist-embed/", import.meta.url)));
const files = ["uma-embed.js", "uma-embed.css"];
const assets = {};
for (const file of files) {
  const data = await readFile(resolve(output, file));
  // 与宿主的资源校验上限一致；构建阶段拒绝不可加载的产物。
  const limit = file.endsWith(".css") ? 1024 * 1024 : 10 * 1024 * 1024;
  if (data.byteLength > limit) throw new Error(`Embed asset exceeds host limit: ${file}`);
  if (file.endsWith(".css")) {
    const fonts = [...data.toString("utf8").matchAll(/url\(["']?([^"')]+\.(?:woff2?|ttf))["']?\)/g)];
    if (!fonts.length) throw new Error("Embed formula fonts must be external assets");
    for (const [, font] of fonts) {
      const path = resolve(output, font);
      if (dirname(path) !== output) throw new Error("Embed font must be beside its stylesheet");
      await access(path);
    }
  }
  assets[file] = { bytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") };
}
await writeFile(
  resolve(output, "embed-manifest.json"),
  `${JSON.stringify({ version: "1.3.0", assets }, null, 2)}\n`,
  "utf8",
);
