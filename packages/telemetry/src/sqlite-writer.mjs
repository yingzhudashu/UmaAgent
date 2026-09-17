import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const db = new DatabaseSync(workerData.path);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=350");
const statements = new Map();
function write(operations) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const operation of operations) {
      let statement = statements.get(operation.sql);
      if (!statement) {
        statement = db.prepare(operation.sql);
        statements.set(operation.sql, statement);
      }
      statement.run(...operation.args);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
parentPort.on("message", ({ id, groups }) => {
  let failures = 0;
  const operations = groups.flat();
  try {
    write(operations);
  } catch {
    // 异常批次按逻辑事务隔离；一个坏事件不能回滚同批其他 Run 的有效记录。
    for (const group of groups) {
      try {
        write(group);
      } catch {
        failures += group.length;
      }
    }
  }
  parentPort.postMessage({ id, count: operations.length, failures });
});
