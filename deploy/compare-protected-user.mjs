import { readFile } from "node:fs/promises";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error("usage: compare-protected-user.mjs BEFORE_JSON AFTER_JSON");
const before = JSON.parse(await readFile(beforePath, "utf8"));
const after = JSON.parse(await readFile(afterPath, "utf8"));
const fields = ["userId", "token", "integrity", "foreignKeyViolations"];
for (const field of fields) {
  if (JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    throw new Error(`protected user changed: ${field}`);
}
if (after.integrity !== "ok" || after.foreignKeyViolations !== 0)
  throw new Error("post-release database integrity check failed");

for (const [name, beforeIds] of Object.entries(before.ids ?? {})) {
  const afterIds = after.ids?.[name];
  if (!Array.isArray(beforeIds) || !Array.isArray(afterIds))
    throw new Error(`protected user object set is invalid: ${name}`);
  const afterSet = new Set(afterIds);
  if (beforeIds.some((id) => !afterSet.has(id))) throw new Error(`protected user object removed: ${name}`);
  if (Number(after.counts?.[name]) < beforeIds.length)
    throw new Error(`protected user object count decreased: ${name}`);
}

console.log(JSON.stringify({ protectedUserPreserved: true, userId: after.userId }));
