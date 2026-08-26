import { readFile } from "node:fs/promises";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error("usage: compare-protected-user.mjs BEFORE_JSON AFTER_JSON");
const before = JSON.parse(await readFile(beforePath, "utf8"));
const after = JSON.parse(await readFile(afterPath, "utf8"));
const fields = ["userId", "fingerprint", "token", "counts", "ids", "integrity", "foreignKeyViolations"];
for (const field of fields) {
  if (JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    throw new Error(`protected user changed: ${field}`);
}
if (after.integrity !== "ok" || after.foreignKeyViolations !== 0)
  throw new Error("post-release database integrity check failed");
console.log(
  JSON.stringify({ protectedUserUnchanged: true, userId: after.userId, fingerprint: after.fingerprint }),
);
