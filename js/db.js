/* db.js — IndexedDB 持久化：策略配置与检测日志 */
(function (global) {
  'use strict';
  const DB_NAME = 'perm-policy-demo';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in global)) {
        reject(new Error('当前环境不支持 IndexedDB，配置将无法持久化'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('configs')) db.createObjectStore('configs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('logs')) {
          const store = db.createObjectStore('logs', { keyPath: 'ts' });
          store.createIndex('byFeature', 'feature', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
      req.onblocked = () => reject(new Error('IndexedDB 被其他标签页阻塞'));
    });
    return dbPromise;
  }

  function tx(storeName, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      const out = fn(store);
      t.oncomplete = () => resolve(out && out._result !== undefined ? out._result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('事务中止'));
    }));
  }

  const DB = {
    async saveConfig(config) {
      return tx('configs', 'readwrite', s => s.put(Object.assign({ id: 'current', savedAt: Date.now() }, config)));
    },
    async loadConfig() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const req = db.transaction('configs').objectStore('configs').get('current');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    },
    async addLog(entry) {
      return tx('logs', 'readwrite', s => s.put(Object.assign({ ts: Date.now() + Math.random() }, entry)));
    },
    async listLogs(limit) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const req = db.transaction('logs').objectStore('logs').getAll();
        req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.ts - a.ts).slice(0, limit || 50));
        req.onerror = () => reject(req.error);
      });
    },
    async clearLogs() {
      return tx('logs', 'readwrite', s => s.clear());
    },
  };
  global.PolicyDB = DB;
})(typeof self !== 'undefined' ? self : this);
