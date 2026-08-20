import type { SessionSnapshot } from "@uma-agent/protocol";

const DB_NAME = "uma-agent-v4";
const STORE = "session-snapshots";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function cacheSnapshot(snapshot: SessionSnapshot): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(snapshot, snapshot.session.id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function cachedSnapshot(sessionId: string): Promise<SessionSnapshot | undefined> {
  const database = await openDatabase();
  const value = await new Promise<SessionSnapshot | undefined>((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).get(sessionId);
    request.onsuccess = () => resolve(request.result as SessionSnapshot | undefined);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return value;
}
