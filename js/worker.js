/* worker.js — 在 Web Worker 上下文中检测 Permissions API / 策略可用性 */
'use strict';
self.onmessage = async function (e) {
  const { features } = e.data || {};
  const report = {
    workerType: typeof DedicatedWorkerGlobalScope !== 'undefined' ? 'dedicated' : 'unknown',
    hasPermissionsApi: typeof self.permissions !== 'undefined' && !!self.permissions.query,
    hasPermissionsPolicy: typeof self.permissionsPolicy !== 'undefined' || typeof self.featurePolicy !== 'undefined',
    results: [],
    errors: [],
  };
  if (report.hasPermissionsApi && Array.isArray(features)) {
    for (const name of features) {
      try {
        const status = await self.permissions.query({ name });
        report.results.push({ name, state: status.state });
      } catch (err) {
        report.results.push({ name, state: 'unsupported', error: String(err && err.message || err) });
      }
    }
  } else {
    report.errors.push('Worker 中无 Permissions API，无法查询权限状态');
  }
  self.postMessage(report);
};
