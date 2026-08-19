import { copyFile, mkdir } from "node:fs/promises";

await mkdir(new URL("../packages/core/dist", import.meta.url), { recursive: true });
await copyFile(
  new URL("../packages/core/src/schema.sql", import.meta.url),
  new URL("../packages/core/dist/schema.sql", import.meta.url),
);
