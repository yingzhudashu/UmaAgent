import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const [stateDir, destination] = process.argv.slice(2);
if (!stateDir || !destination) throw new Error("usage: backup-native-online.mjs STATE_DIR DESTINATION_DB");
mkdirSync(dirname(destination), { recursive: true });
const source = new DatabaseSync(join(stateDir, "state.db"), { readOnly: true });
try {
  await backup(source, destination);
} finally {
  source.close();
}
const verified = new DatabaseSync(destination, { readOnly: true });
try {
  if (verified.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
    throw new Error("online backup integrity_check failed");
  if (verified.prepare("PRAGMA foreign_key_check").all().length)
    throw new Error("online backup foreign_key_check failed");
} finally {
  verified.close();
}
