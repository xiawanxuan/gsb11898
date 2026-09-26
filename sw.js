/* Service Worker（classic worker，避免模块 SW 兼容问题）：
 * 1. 拦截同源 sandbox.html 请求，注入当前编辑的 Permissions-Policy 头；
 * 2. 头值保存在 IDB 中，由主线程 postMessage 同步；
 * 3. 同时通过 X-Injected-PP 回显实际注入值，供页面核对。 */

const DB_NAME = 'perm-policy-demo';
const STORE = 'state';

function openSwDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains('logs')) db.createObjectStore('logs', { keyPath: 'ts' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : '');
    req.onerror = () => reject(req.error);
  });
}

function dbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put({ id: key, value });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  event.waitUntil((async () => {
    try {
      const db = await openSwDb();
      if (msg.type === 'set-header') {
        await dbPut(db, 'swHeader', String(msg.header || ''));
        event.source && event.source.postMessage({ type: 'header-stored', ok: true });
      } else if (msg.type === 'get-header') {
        const header = await dbGet(db, 'swHeader');
        event.source && event.source.postMessage({ type: 'header-value', header });
      }
      db.close();
    } catch (err) {
      event.source && event.source.postMessage({ type: 'header-stored', ok: false, error: String(err) });
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const isSandbox = url.pathname.endsWith('/sandbox.html');
  const isIndex = url.pathname === '/' || url.pathname.endsWith('/index.html');
  if (!isSandbox && !isIndex) return;

  event.respondWith((async () => {
    const response = await fetch(event.request);
    let header = '';
    try {
      const db = await openSwDb();
      header = await dbGet(db, 'swHeader');
      db.close();
    } catch {
      header = '';
    }
    const headers = new Headers(response.headers);
    headers.set('X-Injected-PP', encodeURIComponent(header));
    if (header) headers.set('Permissions-Policy', header);
    headers.set('X-Injected-By', 'perm-policy-demo-sw');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  })());
});
