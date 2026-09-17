import { UmaDatabase } from "../src/database.js";

/** Test fixture: every synthetic session is explicitly owned by this user. */
export function testDatabase(root: string): UmaDatabase {
  const database = new UmaDatabase(root);
  const now = Date.now();
  database.db
    .prepare("INSERT OR IGNORE INTO users(id,role,status,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run("test-user", "user", "active", now, now);
  // 审批生命周期用例显式采用手动模式；生产默认值由独立用例验证。
  database.setExecutionSettings("test-user", false);
  const createSession = database.createSession.bind(database);
  database.createSession = ((
    input: Omit<Parameters<UmaDatabase["createSession"]>[0], "userId"> & {
      userId?: string;
    },
  ) => createSession({ ...input, userId: input.userId ?? "test-user" })) as UmaDatabase["createSession"];
  const addMemoryFact = database.addMemoryFact.bind(database);
  database.addMemoryFact = ((input: Parameters<UmaDatabase["addMemoryFact"]>[0]) =>
    addMemoryFact({ ...input, ownerId: input.ownerId ?? "test-user" })) as UmaDatabase["addMemoryFact"];
  return database;
}
