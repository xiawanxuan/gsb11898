// IndexedDB 持久化：策略配置 + 检测日志。
// 同时可在 Web Worker、Service Worker（通过 postMessage）与主线程降级路径中使用。

const DB_NAME = 'perm-policy-demo';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('state')) {
        db.createObjectStore('state', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('logs')) {
        const store = db.createObjectStore('logs', { keyPath: 'ts' });
        store.createIndex('feature', 'feature', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, name, mode) {
  return db.transaction(name, mode).objectStore(name);
}

function reqPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function idbGet(key) {
  const db = await openDb();
  try {
    const row = await reqPromise(tx(db, 'state', 'readonly').get(key));
    return row ? row.value : undefined;
  } finally {
    db.close();
  }
}

export async function idbSet(key, value) {
  const db = await openDb();
  try {
    await reqPromise(tx(db, 'state', 'readwrite').put({ id: key, value }));
  } finally {
    db.close();
  }
}

export async function idbAddLog(entry) {
  const db = await openDb();
  try {
    await reqPromise(tx(db, 'logs', 'readwrite').add(entry));
  } finally {
    db.close();
  }
}

export async function idbListLogs(limit = 100) {
  const db = await openDb();
  try {
    const rows = await reqPromise(tx(db, 'logs', 'readonly').getAll());
    return rows.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit);
  } finally {
    db.close();
  }
}

export async function idbClearLogs() {
  const db = await openDb();
  try {
    await reqPromise(tx(db, 'logs', 'readwrite').clear());
  } finally {
    db.close();
  }
}

export function idbAvailable() {
  return typeof indexedDB !== 'undefined';
}
