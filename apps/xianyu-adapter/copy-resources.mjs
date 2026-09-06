import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const source = resolve(root, "src", "resources");
const target = resolve(root, "dist", "resources");
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
