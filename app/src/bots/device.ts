import { deviceKey, newDeviceKeyPair, type DeviceKey, type DeviceKeyPair } from '@leafbot/client/tunnel';

const DB = 'leafbot-web';
const STORE = 'keys';
const ID = 'device';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB'));
  });
}

function run<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  op: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = op(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB'));
  });
}

let loading: Promise<DeviceKey> | null = null;

/**
 * This browser's device key. It is kept in IndexedDB as a key pair whose private half cannot be
 * exported, so it stays the same across visits; without IndexedDB (some private windows) a new one
 * is made for this visit only.
 */
export function loadDevice(): Promise<DeviceKey> {
  loading ??= (async () => {
    let db: IDBDatabase | null = null;
    try {
      db = await openDb();
      const stored = await run<DeviceKeyPair | undefined>(db, 'readonly', (s) => s.get(ID));
      if (stored) return await deviceKey(stored);
    } catch {
      db = null;
    }
    const pair = await newDeviceKeyPair();
    if (db) await run(db, 'readwrite', (s) => s.put(pair, ID)).catch(() => {});
    return deviceKey(pair);
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
