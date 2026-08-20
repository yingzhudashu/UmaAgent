import type { SessionSnapshot, TranscriptItem } from "@uma-agent/protocol";

const DB_NAME = "uma-agent-v5";
const SNAPSHOTS = "session-snapshots";
const CURSORS = "session-cursors";
const HISTORY = "session-history";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      for (const store of [SNAPSHOTS, CURSORS, HISTORY])
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function put(store: string, key: string, value: unknown): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(store, "readwrite");
    transaction.objectStore(store).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

async function get<T>(store: string, key: string): Promise<T | undefined> {
  const database = await openDatabase();
  const value = await new Promise<T | undefined>((resolve, reject) => {
    const request = database.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return value;
}

export async function cacheSnapshot(snapshot: SessionSnapshot): Promise<void> {
  await Promise.all([
    put(SNAPSHOTS, snapshot.session.id, snapshot),
    cacheCursor(snapshot.session.id, snapshot.snapshotSequence),
  ]);
}

export const cachedSnapshot = (sessionId: string) => get<SessionSnapshot>(SNAPSHOTS, sessionId);
export async function cacheCursor(sessionId: string, sequence: number): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(CURSORS, "readwrite");
    const store = transaction.objectStore(CURSORS);
    const request = store.get(sessionId);
    request.onsuccess = () => store.put(Math.max(Number(request.result ?? 0), sequence), sessionId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}
export const cachedCursor = (sessionId: string) => get<number>(CURSORS, sessionId);
export const cacheHistory = (sessionId: string, items: TranscriptItem[]) => put(HISTORY, sessionId, items);
export const cachedHistory = (sessionId: string) => get<TranscriptItem[]>(HISTORY, sessionId);
