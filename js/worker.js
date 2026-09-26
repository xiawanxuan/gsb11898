// Web Worker：策略语法后台校验、IndexedDB 日志落库、
// 以及“Worker 环境运行时检测”（navigator.permissions 在部分浏览器的 Worker 中可用，
// getUserMedia/geolocation 等在 DedicatedWorker 中通常不可用——这也是运行时差异的一部分）。

import { parseHeader, FEATURE_IDS } from './policy.js';
import { idbGet, idbSet, idbAddLog, idbListLogs, idbClearLogs, idbAvailable } from './storage.js';

const workerEnv = {
  secureContext: typeof self !== 'undefined' && !!self.isSecureContext,
  permissionsInWorker: typeof navigator !== 'undefined' && !!navigator.permissions,
  hasIndexedDB: idbAvailable(),
  userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
};

async function queryPermissionInWorker(name) {
  if (!navigator.permissions || !navigator.permissions.query) {
    return { available: false, state: 'unsupported', error: 'Worker 中没有 navigator.permissions' };
  }
  try {
    const status = await navigator.permissions.query({ name });
    return { available: true, state: status.state, onchange: typeof status.onchange === 'object' };
  } catch (err) {
    return { available: false, state: 'error', error: `${err.name}: ${err.message}` };
  }
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  const reply = (type, payload) => self.postMessage({ type, id: msg.id, ...payload });

  try {
    switch (msg.type) {
      case 'env':
        reply('env', { env: workerEnv });
        break;

      case 'validate': {
        const result = parseHeader(msg.header || '');
        reply('validate', {
          errors: result.errors,
          warnings: result.warnings,
          directives: Array.from(result.directives.entries()).map(([name, d]) => ({ name, ...d })),
        });
        break;
      }

      case 'saveState':
        await idbSet(msg.key, msg.value);
        reply('saved', { key: msg.key });
        break;

      case 'loadState':
        reply('state', { key: msg.key, value: await idbGet(msg.key) });
        break;

      case 'log':
        await idbAddLog({
          ts: new Date().toISOString(),
          context: msg.context || 'top',
          feature: msg.feature || '-',
          result: msg.result || {},
        });
        reply('logged', { ok: true });
        break;

      case 'listLogs':
        reply('logs', { logs: await idbListLogs(msg.limit || 100) });
        break;

      case 'clearLogs':
        await idbClearLogs();
        reply('logs', { logs: [] });
        break;

      case 'workerPermissions': {
        const out = {};
        for (const name of ['camera', 'microphone', 'geolocation', 'fullscreen', 'autoplay']) {
          out[name] = await queryPermissionInWorker(name);
        }
        reply('workerPermissions', { results: out, featureIds: FEATURE_IDS });
        break;
      }

      default:
        reply('error', { error: `未知消息类型：${msg.type}` });
    }
  } catch (err) {
    reply('error', { error: `${err.name}: ${err.message}` });
  }
};
