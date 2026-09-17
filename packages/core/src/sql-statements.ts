import type { DatabaseSync, StatementSync } from "node:sqlite";

const caches = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

/** 复用热点 SQL 的原生语句，避免每次请求都分配等待 GC 回收的 SQLite 句柄。
 * 动态 IN 查询也必须有界；缓存按连接隔离，不跨事务或数据库分享句柄。
 */
export function prepareStatement(db: DatabaseSync, sql: string): StatementSync {
  let cache = caches.get(db);
  if (!cache) {
    cache = new Map();
    caches.set(db, cache);
  }
  const existing = cache.get(sql);
  if (existing) {
    cache.delete(sql);
    cache.set(sql, existing);
    return existing;
  }
  const statement = db.prepare(sql);
  cache.set(sql, statement);
  if (cache.size > 128) cache.delete(cache.keys().next().value as string);
  return statement;
}
