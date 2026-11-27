import { deviceKey, newDeviceKeyPair, type DeviceKey, type DeviceKeyPair } from '@leafbot/client/tunnel';

const DB = 'leafbot-extension';
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
 * This Chrome's device key, which tickets are bound to. Kept in the extension's IndexedDB as a key
 * pair whose private half cannot be exported, so it stays the same between openings of the panel.
 */
export function loadDevice(): Promise<DeviceKey> {
  loading ??= (async () => {
    const db = await openDb();
    const stored = await run<DeviceKeyPair | undefined>(db, 'readonly', (s) => s.get(ID));
    if (stored) return deviceKey(stored);
    const pair = await newDeviceKeyPair();
    await run(db, 'readwrite', (s) => s.put(pair, ID));
    return deviceKey(pair);
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
