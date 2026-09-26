// 顶层应用：环境检测、策略编辑与校验、iframe 树管理、Canvas 继承图、
// Permissions API 降级查询、Web Worker、Service Worker、IndexedDB 日志。

import { FEATURES, FEATURE_IDS, DEFAULT_ALLOWLIST, parseHeader, buildAllowString, simulate } from './policy.js';
import { quickSnapshot, runFeatureTest, getEnvironment } from './probe.js';

const TOKEN_OPTIONS = [
  { value: 'inherit', label: 'inherit（不写，同源继承）' },
  { value: '*', label: "*（委托任意来源）" },
  { value: "'none'", label: "'none'（显式拒绝）" },
  { value: "'self'", label: "'self'（同源）" },
  { value: "'src'", label: "'src'（框架自身来源）" },
];

const PRESETS = {
  allAllow: 'camera=*; microphone=*; geolocation=*; fullscreen=*; autoplay=*',
  allDeny: 'camera=(); microphone=(); geolocation=(); fullscreen=(); autoplay=()',
  mixed: `camera=(self); microphone=(); geolocation=("${location.origin}"); fullscreen=(self); autoplay=(self)`,
  broken: 'camera=self; microphone=(self none); geolocation=("bad origin); fullscreen=(; autoplay=???',
};

const state = {
  header: PRESETS.mixed,
  allowA: Object.fromEntries(FEATURE_IDS.map((id) => [id, 'inherit'])),
  allowB: Object.fromEntries(FEATURE_IDS.map((id) => [id, 'inherit'])),
};

const live = {
  top: null,
  frames: { A: null, B: null, S: null },
  readiness: { A: false, B: false, S: false },
  swReg: null,
  swControlled: false,
  worker: null,
  workerOk: false,
  workerEnv: null,
  workerPending: new Map(),
  storageMode: 'worker',
};

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 提示与异常 ---------------- */

function showAlert(message, level = 'warn') {
  const zone = $('alert-zone');
  const div = document.createElement('div');
  div.className = `alert alert-${level}`;
  div.innerHTML = message;
  zone.appendChild(div);
  zone.hidden = false;
  return div;
}

function feedback(node, errors, warnings) {
  node.innerHTML = '';
  if (errors.length === 0) {
    node.className = 'feedback ok';
    node.textContent = '语法正确 ✔' + (warnings.length ? `（${warnings.length} 条提醒）` : '');
  } else {
    node.className = 'feedback bad';
    node.innerHTML = errors.map((e) => `❌ ${escapeHtml(e)}`).join('<br>')
      + (warnings.length ? `<br>${warnings.map((w) => `⚠️ ${escapeHtml(w)}`).join('<br>')}` : '');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------------- 本地存储降级（Worker 不可用时） ---------------- */

import { idbGet, idbSet, idbAddLog, idbListLogs, idbClearLogs, idbAvailable } from './storage.js';

const STORE_KEY = 'demo-state-v1';

async function persistState() {
  const payload = { ...state, savedAt: new Date().toISOString() };
  if (live.workerOk) {
    workerRpc('saveState', { key: STORE_KEY, value: payload }).catch(() => idbSet(STORE_KEY, payload).catch(() => {}));
  } else {
    idbSet(STORE_KEY, payload).catch(() => {});
  }
}

async function restoreState() {
  try {
    let saved;
    if (live.workerOk) saved = (await workerRpc('loadState', { key: STORE_KEY })).value;
    if (!saved && idbAvailable()) saved = await idbGet(STORE_KEY);
    if (saved && typeof saved === 'object') {
      if (typeof saved.header === 'string') state.header = saved.header;
      if (saved.allowA) Object.assign(state.allowA, saved.allowA);
      if (saved.allowB) Object.assign(state.allowB, saved.allowB);
    }
  } catch {
    /* 恢复失败用默认状态 */
  }
}

/* ---------------- Web Worker ---------------- */

let workerSeq = 1;

function workerRpc(type, extra = {}) {
  return new Promise((resolve, reject) => {
    if (!live.worker) {
      reject(new Error('Worker 不可用'));
      return;
    }
    const id = workerSeq++;
    const timer = setTimeout(() => {
      live.workerPending.delete(id);
      reject(new Error('Worker 响应超时'));
    }, 6000);
    live.workerPending.set(id, { resolve, reject, timer });
    live.worker.postMessage({ id, type, ...extra });
  });
}

async function initWorker() {
  if (typeof Worker === 'undefined') {
    live.storageMode = 'main-idb';
    $('worker-panel').innerHTML = '<span class="tag tag-deny">Web Worker 不受支持</span> 语法校验与日志改在主线程执行（降级）。';
    return;
  }
  try {
    live.worker = new Worker('./js/worker.js', { type: 'module' });
    live.worker.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'error') {
        const pending = live.workerPending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          live.workerPending.delete(msg.id);
          pending.reject(new Error(msg.error));
        }
        return;
      }
      if (msg.id && live.workerPending.has(msg.id)) {
        const pending = live.workerPending.get(msg.id);
        clearTimeout(pending.timer);
        live.workerPending.delete(msg.id);
        pending.resolve(msg);
      }
      if (msg.type === 'env') renderWorkerPanel(msg.env);
    };
    live.worker.onerror = (err) => {
      live.workerOk = false;
      live.storageMode = 'main-idb';
      showAlert(`Web Worker 启动失败：${err.message || '未知错误'}。已降级到主线程校验 + 主线程 IndexedDB。`, 'warn');
    };
    // 探活
    const envReply = await workerRpc('env');
    live.workerOk = true;
    renderWorkerPanel(envReply.env);
  } catch (err) {
    live.workerOk = false;
    live.storageMode = 'main-idb';
    $('worker-panel').innerHTML =
      `<span class="tag tag-deny">Worker 不可用</span> 已降级到主线程：${escapeHtml(err.message)}`;
  }
}

function renderWorkerPanel(env) {
  live.workerEnv = env;
  const badges = [];
  badges.push(env.secureContext ? '<span class="tag tag-allow">Worker 安全上下文</span>' : '<span class="tag tag-deny">非安全上下文</span>');
  badges.push(env.permissionsInWorker ? '<span class="tag tag-allow">Worker 内有 Permissions API</span>' : '<span class="tag tag-warn">Worker 内无 Permissions API</span>');
  badges.push(env.hasIndexedDB ? '<span class="tag tag-allow">Worker 内 IndexedDB 可用</span>' : '<span class="tag tag-deny">Worker 内 IndexedDB 不可用</span>');
  $('worker-panel').innerHTML = `
    <div class="worker-badges">${badges.join(' ')}</div>
    <div class="tiny-note">存储路径：${live.workerOk ? 'Worker 落库' : '主线程降级落库'}；Worker 中 camera/microphone 等 DedicatedWorker 通常不可调用，差异见下方查询结果。</div>
    <div id="worker-perm-results" class="worker-perm-results">点击下方按钮查询 Worker 视角的 Permissions API：</div>
    <div class="row gap"><button id="btn-worker-query">在 Worker 中查询 Permissions API</button></div>`;
  $('btn-worker-query').addEventListener('click', queryWorkerPermissions);
}

async function queryWorkerPermissions() {
  const node = $('worker-perm-results');
  if (!live.workerOk) {
    node.textContent = 'Worker 不可用，无法查询。';
    return;
  }
  node.textContent = '查询中…';
  try {
    const reply = await workerRpc('workerPermissions');
    node.innerHTML = Object.entries(reply.results).map(([name, r]) => {
      const label = FEATURES.find((f) => f.id === name)?.label || name;
      const cls = r.available ? (r.state === 'granted' ? 'tag-allow' : r.state === 'denied' ? 'tag-deny' : 'tag-warn') : 'tag-na';
      const detail = r.available ? r.state : escapeHtml(r.error || '不支持');
      return `<div class="worker-perm-line"><code>${name}</code>（${label}）：<span class="tag ${cls}">${detail}</span></div>`;
    }).join('');
  } catch (err) {
    node.textContent = `Worker 查询失败：${err.message}（降级：改用主线程 Permissions API，见矩阵）`;
  }
}

/* ---------------- Service Worker ---------------- */

async function initServiceWorker() {
  const status = $('sw-status');
  if (!('serviceWorker' in navigator)) {
    status.innerHTML = '<span class="tag tag-deny">浏览器不支持 Service Worker</span> 顶层头只能静态模拟，沙箱将使用降级方案。';
    $('sw-fallback-note').hidden = false;
    return;
  }
  if (!window.isSecureContext) {
    status.innerHTML = '<span class="tag tag-deny">非安全上下文</span> SW 无法注册，请使用 http://localhost 或 https。';
    $('sw-fallback-note').hidden = false;
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    live.swReg = reg;
    live.swControlled = !!navigator.serviceWorker.controller;
    renderSwStatus(reg);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      live.swControlled = true;
      renderSwStatus(reg);
      showAlert('Service Worker 已接管页面。为让顶层 Permissions-Policy 头完全生效，页面将自动重新加载…', 'info');
      setTimeout(() => location.reload(), 900);
    });
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'header-stored' && event.data.ok === false) {
        showAlert(`SW 写入头缓存失败：${escapeHtml(event.data.error || '未知')}`, 'error');
      }
    });
  } catch (err) {
    status.innerHTML = `<span class="tag tag-deny">SW 注册失败</span> ${escapeHtml(err.message)}`;
    $('sw-fallback-note').hidden = false;
  }
}

function renderSwStatus(reg) {
  const active = reg && (reg.active || reg.waiting || reg.installing);
  const stateText = reg && reg.active ? 'active' : active ? 'installing/waiting' : '未激活';
  $('sw-status').innerHTML = `
    <span class="tag ${live.swControlled ? 'tag-allow' : 'tag-warn'}">${live.swControlled ? '已控制本页' : '尚未控制本页'}</span>
    <span class="tag tag-na">状态：${stateText}</span>
    <span class="tiny-note">SW 会拦截 index.html 与 sandbox.html 的响应并注入 Permissions-Policy 头。</span>`;
}

function sendHeaderToSw(header) {
  return new Promise((resolve) => {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
      resolve(false);
      return;
    }
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 1200);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(!!(event.data && event.data.ok));
    };
    navigator.serviceWorker.controller.postMessage({ type: 'set-header', header }, [channel.port2]);
  });
}

/* ---------------- 环境特性检测 ---------------- */

function renderEnvBadges() {
  const env = getEnvironment();
  const badges = [
    env.secureContext ? ['安全上下文', true] : ['非安全上下文（多 API 不可用）', false],
    env.permissionsPolicy ? ['Permissions Policy API', true] : ['无 Permissions Policy API', false],
    env.featurePolicy ? ['旧版 featurePolicy（降级读取）', true] : null,
    env.permissionsApi ? ['Permissions API', true] : ['无 Permissions API', false],
    env.mediaDevices ? ['getUserMedia', true] : ['无 getUserMedia', false],
    env.geolocation ? ['Geolocation', true] : null,
    env.fullscreen ? ['Fullscreen API', true] : null,
    typeof Worker !== 'undefined' ? ['Web Worker', true] : ['无 Web Worker', false],
    'serviceWorker' in navigator ? ['Service Worker', true] : ['无 Service Worker', false],
    idbAvailable() ? ['IndexedDB', true] : ['无 IndexedDB', false],
  ].filter(Boolean);

  $('env-badges').innerHTML = badges.map(([text, ok]) =>
    `<span class="env-badge ${ok ? 'ok' : 'bad'}">${ok ? '✔' : '✖'} ${text}</span>`).join('');

  if (!env.permissionsPolicy && env.featurePolicy) {
    showAlert('当前浏览器没有新版 <code>document.permissionsPolicy</code>，但存在旧版 <code>document.featurePolicy</code>，页面已自动使用旧 API 读取策略（降级）。', 'info');
  } else if (!env.permissionsPolicy && !env.featurePolicy) {
    showAlert('当前浏览器不提供 Permissions Policy 读取 API。页面仍可：①用各特性 API 的行为探测真实结果；②用 Permissions API 查权限状态；③用内置解析器静态模拟继承关系（结果标注为“模拟”）。', 'warn');
  }
  if (!env.secureContext) {
    showAlert('当前不是安全上下文：<code>getUserMedia</code>、Service Worker 等将不可用。请通过 <code>http://localhost</code> 或 <code>https://</code> 访问。', 'error');
  }
}

/* ---------------- 配置矩阵 ---------------- */

function renderMatrixTable() {
  const tbody = $('matrix-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const feature of FEATURES) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${feature.label}<br><code>${feature.id}</code></td>
      <td>${selectFor('allowA', feature.id)}</td>
      <td>${selectFor('allowB', feature.id)}</td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('select').forEach((sel) => {
    sel.addEventListener('change', () => {
      state[sel.dataset.group][sel.dataset.feature] = sel.value;
      updateAllowPreview();
      updateSimulated();
      persistState();
    });
  });
}

function selectFor(group, feature) {
  const current = state[group][feature];
  const opts = TOKEN_OPTIONS.map((o) =>
    `<option value="${o.value}" ${o.value === current ? 'selected' : ''}>${o.label}</option>`).join('');
  return `<select data-group="${group}" data-feature="${feature}">${opts}</select>`;
}

function updateAllowPreview() {
  const allowA = buildAllowString(state.allowA);
  const allowB = buildAllowString(state.allowB);
  $('allow-a-preview').textContent = allowA || '（空：A 不写 allow，同源继承顶层）';
  $('allow-b-preview').textContent = allowB || '（空：B 不写 allow，同源继承 A）';
  return { allowA, allowB };
}

function renderDefaultsTable() {
  $('defaults-body').innerHTML = FEATURES.map((f) => `
    <tr>
      <td>${f.label} <code>${f.id}</code></td>
      <td><code>${DEFAULT_ALLOWLIST[f.id]}</code></td>
      <td>${f.permission ? `<code>${f.permission}</code>` : '<span class="tag tag-na">无对应查询项</span>'}</td>
    </tr>`).join('');

  const featureSelect = $('view-feature');
  featureSelect.innerHTML = '<option value="ALL">全部（汇总）</option>'
    + FEATURES.map((f) => `<option value="${f.id}">${f.label}（${f.id}）</option>`).join('');

  const testBar = $('test-bar');
  testBar.innerHTML = FEATURES.map((f) =>
    `<button data-test-context="top" data-feature="${f.id}">顶层测 ${f.label}</button>
     <button data-test-context="A" data-feature="${f.id}">A 测</button>
     <button data-test-context="B" data-feature="${f.id}">B 测</button>
     <button data-test-context="S" data-feature="${f.id}">S 测</button>`).join('');
}

/* ---------------- 模拟继承 ---------------- */

function getSimulation() {
  return simulate(state.header, state.allowA, state.allowB, {
    top: location.origin,
    frame: location.origin,
  });
}

function updateSimulated() {
  const sim = getSimulation();
  renderEffectiveTable(sim);
  renderCanvas();
  return sim;
}

function boolCell(value, real, note) {
  if (value === true) return `<span class="cell-allow" title="${escapeHtml(note || '')}">允许</span>`;
  if (value === false) return `<span class="cell-deny" title="${escapeHtml(note || '')}">拒绝</span>`;
  if (real === 'unsupported') return '<span class="cell-na">无法读取</span>';
  return '<span class="cell-na">—</span>';
}

function renderEffectiveTable(sim) {
  const tbody = $('effective-table').querySelector('tbody');
  const realTop = live.top ? live.top.policy : null;
  const getReal = (context, feature) => {
    if (context === 'top') return realTop ? realTop[feature]?.allowsFeature : 'unsupported';
    const snap = live.frames[context];
    return snap ? snap.policy[feature]?.allowsFeature : 'unsupported';
  };

  tbody.innerHTML = '';
  let mismatchCount = 0;
  for (const feature of FEATURES) {
    const contexts = ['top', 'A', 'B', 'S'];
    const cells = contexts.map((ctx) => {
      const real = getReal(ctx, feature.id);
      const expected = sim.effective[ctx][feature.id];
      let mismatch = false;
      if (real === true || real === false) mismatch = real !== expected;
      if (mismatch) mismatchCount++;
      const sourceNote = sim.reason[ctx][feature.id];
      return `<td>
        <div>${boolCell(expected, real, sourceNote)} <span class="sim-tag">模拟</span></div>
        <div class="real-line">实测：${real === true ? '<span class="cell-allow">允许</span>'
          : real === false ? '<span class="cell-deny">拒绝</span>'
          : '<span class="cell-na">未测/不支持</span>'}${mismatch ? ' <span class="mismatch">⚠ 不一致</span>' : ''}</div>
      </td>`;
    }).join('');
    tbody.innerHTML += `<tr><td>${feature.label}<br><code>${feature.id}</code></td>${cells}</tr>`;
  }
  const note = $('discrepancy-note');
  if (mismatchCount === 0) {
    note.className = 'feedback ok';
    note.textContent = '实测结果与静态模拟一致。';
  } else {
    note.className = 'feedback bad';
    note.textContent = `有 ${mismatchCount} 处实测与模拟不一致：通常因为 SW 头尚未真正生效、浏览器实现差异或 allow/头缓存。请确认 SW“已控制本页”并重新加载。`;
  }
}

/* ---------------- iframe 树 ---------------- */

function buildFrameTree() {
  const stage = $('frame-stage');
  stage.innerHTML = '';
  live.frames = { A: null, B: null, S: null };
  live.readiness = { A: false, B: false, S: false };

  const { allowA, allowB } = updateAllowPreview();

  // A：顶层直接嵌套；B：由 A 内部再嵌套
  const frameA = document.createElement('iframe');
  frameA.id = 'frame-A';
  frameA.className = 'frame frame-A';
  frameA.src = 'frame.html?id=A';
  if (allowA) frameA.setAttribute('allow', allowA);
  frameA.title = 'iframe A';
  const aBox = document.createElement('div');
  aBox.className = 'frame-box';
  aBox.innerHTML = '<div class="frame-label">iframe A（父级 allow 见配置矩阵）</div>';
  aBox.appendChild(frameA);
  stage.appendChild(aBox);

  // A 加载完成后下发配置，让 A 创建 B
  frameA.addEventListener('load', () => {
    live.readiness.A = true;
    frameA.contentWindow.postMessage({
      dir: 'down',
      target: ['A'],
      payload: {
        type: 'configure',
        allow: allowA,
        config: {
          depth: 1,
          child: { id: 'B', allow: allowB },
        },
      },
    }, '*');
    setTimeout(() => requestSnapshots(), 300);
  });

  // S：沙箱框架，父级始终全量委托，真正闸门是注入的头
  const frameS = document.createElement('iframe');
  frameS.id = 'frame-S';
  frameS.className = 'frame frame-S';
  frameS.src = 'sandbox.html';
  frameS.setAttribute('allow', FEATURE_IDS.map((id) => `${id} *`).join('; '));
  frameS.title = 'sandbox S';
  const sBox = document.createElement('div');
  sBox.className = 'frame-box sandbox-box';
  sBox.innerHTML = '<div class="frame-label">iframe S · 响应头沙箱（父 allow 始终委托 *，仅看注入头）</div>';
  sBox.appendChild(frameS);
  stage.appendChild(sBox);
  frameS.addEventListener('load', () => {
    live.readiness.S = true;
    setTimeout(() => requestSnapshots(), 300);
  });
}

function sendDown(context, payload) {
  const path = context === 'A' ? ['A'] : context === 'B' ? ['A', 'B'] : ['S'];
  const win = context === 'S'
    ? document.getElementById('frame-S').contentWindow
    : document.getElementById('frame-A').contentWindow;
  if (!win) return false;
  win.postMessage({ dir: 'down', target: path, payload }, '*');
  return true;
}

function requestSnapshots() {
  live.top = null;
  quickSnapshot().then((snap) => {
    live.top = snap;
    updateSimulated();
  }).catch((err) => showAlert(`顶层快照失败：${escapeHtml(err.message)}`, 'error'));

  sendDown('A', { type: 'snapshot' });
  sendDown('S', { type: 'snapshot' });
}

function contextFromPath(path) {
  const last = path[path.length - 1];
  return ['A', 'B', 'S'].includes(last) ? last : null;
}

window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object' || msg.dir !== 'up') return;
  const path = msg.path || [];
  const ctx = contextFromPath(path);
  const payload = msg.payload || {};

  if (payload.type === 'ready') {
    if (ctx) live.readiness[ctx] = true;
    return;
  }
  if (payload.type === 'snapshot' && ctx) {
    live.frames[ctx] = payload.snapshot;
    if (ctx === 'B') live.readiness.B = true;
    updateSimulated();
    return;
  }
  if (payload.type === 'test-result') {
    const sourceCtx = contextFromPath(payload.sourcePath || path) || ctx;
    logResult(sourceCtx, payload.feature, payload.result);
    showTestToast(sourceCtx, payload.feature, payload.result);
    // 结果可能改变不了策略，但刷新一下实测矩阵
    updateSimulated();
    return;
  }
  if (payload.type === 'frame-error') {
    showAlert(`框架 ${path.join('/')} 上报错误：${escapeHtml(payload.error)}`, 'warn');
  }
});

/* ---------------- 远程测试 ---------------- */

function showTestToast(context, feature, result) {
  const featureLabel = FEATURES.find((f) => f.id === feature)?.label || feature;
  const cls = result.ok ? 'toast-ok' : result.category === 'denied-by-policy' ? 'toast-deny' : 'toast-warn';
  const zone = $('alert-zone');
  const div = document.createElement('div');
  div.className = `alert ${cls} toast`;
  div.innerHTML = `[${context}] ${featureLabel}：${escapeHtml(result.message)}`;
  zone.appendChild(div);
  zone.hidden = false;
  setTimeout(() => { div.remove(); if (!zone.children.length) zone.hidden = true; }, 6500);
}

async function logResult(context, feature, result) {
  const entry = {
    ts: new Date().toISOString(),
    context,
    feature,
    result: { ok: result.ok, category: result.category, message: result.message },
  };
  try {
    if (live.workerOk) await workerRpc('log', { context, feature, result: entry.result });
    else if (idbAvailable()) await idbAddLog(entry);
  } catch {
    /* 日志失败不影响主流程 */
  }
  refreshLogs();
}

async function triggerTest(context, feature) {
  if (context === 'top') {
    const result = await runFeatureTest(feature);
    showTestToast('top', feature, result);
    logResult('top', feature, result);
    updateSimulated();
    return;
  }
  const ok = sendDown(context, { type: 'test', feature });
  if (!ok) showAlert(`框架 ${context} 尚未加载，无法触发测试，请先重建 iframe 树。`, 'warn');
}

/* ---------------- Canvas 继承图 ---------------- */

function effectiveValueFor(context, feature) {
  const source = $('view-source').value;
  if (source === 'real') {
    if (context === 'top') return live.top ? live.top.policy[feature]?.allowsFeature : null;
    const snap = live.frames[context];
    return snap ? snap.policy[feature]?.allowsFeature : null;
  }
  const sim = getSimulation();
  return sim.effective[context][feature];
}

function renderCanvas() {
  const canvas = $('tree-canvas');
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 860;
  const height = 430;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const focus = $('view-feature').value;
  const contexts = [
    { id: 'top', label: '顶层页面', x: width / 2, y: 56 },
    { id: 'A', label: 'iframe A', x: width * 0.28, y: 190 },
    { id: 'S', label: 'iframe S（头沙箱）', x: width * 0.75, y: 190 },
    { id: 'B', label: 'iframe B（A 的子框架）', x: width * 0.28, y: 350 },
  ];

  // 边：先画，覆盖关系标注在边上
  drawEdge(ctx, contexts[0], contexts[1], edgeLabel('top', 'A', 'allowA'));
  drawEdge(ctx, contexts[0], contexts[2], '父 allow 恒为 *；闸门=注入头');
  drawEdge(ctx, contexts[1], contexts[3], edgeLabel('A', 'B', 'allowB'));

  for (const node of contexts) drawNode(ctx, node, focus);

  renderLegend(focus);
}

function edgeLabel(parent, child, groupKey) {
  const vals = new Set(Object.values(state[groupKey] || {}));
  if (vals.size === 1 && vals.has('inherit')) return 'allow 未声明（同源继承）';
  const parts = FEATURE_IDS
    .map((id) => `${id}:${state[groupKey][id] === 'inherit' ? '继承' : state[groupKey][id]}`);
  return parts.slice(0, 3).join('，') + (parts.length > 3 ? ' …' : '');
}

function drawEdge(ctx, from, to, label) {
  ctx.strokeStyle = '#7d8aa3';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y + 34);
  ctx.lineTo(to.x, to.y - 34);
  ctx.stroke();
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  ctx.fillStyle = 'rgba(17,24,39,0.85)';
  const w = Math.max(210, label.length * 6.4 + 16);
  ctx.fillRect(mx - w / 2, my - 13, w, 24);
  ctx.strokeStyle = '#4b5772';
  ctx.strokeRect(mx - w / 2, my - 13, w, 24);
  ctx.fillStyle = '#c8d3e8';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(label.slice(0, 60), mx, my + 3);
}

function drawNode(ctx, node, focus) {
  const boxW = 210;
  const features = focus === 'ALL' ? FEATURE_IDS : [focus];
  const rowH = 16;
  const boxH = 44 + features.length * rowH + 12;
  const x = node.x - boxW / 2;
  const y = node.y - boxH / 2;

  ctx.fillStyle = '#101725';
  ctx.strokeStyle = node.id === 'S' ? '#c084fc' : '#3b82f6';
  ctx.lineWidth = 2;
  roundRect(ctx, x, y, boxW, boxH, 10);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#e8eefc';
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(node.label, node.x, y + 18);

  features.forEach((id, i) => {
    const value = effectiveValueFor(node.id, id);
    const cy = y + 40 + i * rowH;
    let color, text;
    if (value === true) { color = '#34d399'; text = '允许'; }
    else if (value === false) { color = '#f87171'; text = '拒绝'; }
    else { color = '#9aa7bd'; text = $('view-source').value === 'real' ? '未测/不支持' : '—'; }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + 20, cy - 4, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#c8d3e8';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${id}`, x + 32, cy);
    ctx.fillStyle = color;
    ctx.textAlign = 'right';
    ctx.fillText(text, x + boxW - 14, cy);
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function renderLegend(focus) {
  const source = $('view-source').value === 'real' ? '运行时实测' : '静态模拟';
  $('canvas-legend').innerHTML = `
    <span class="legend-item"><i class="dot dot-allow"></i>策略允许</span>
    <span class="legend-item"><i class="dot dot-deny"></i>策略拒绝</span>
    <span class="legend-item"><i class="dot dot-na"></i>未测/不支持</span>
    <span class="legend-item">当前数据源：<b>${source}</b>${focus === 'ALL' ? '（五特性汇总）' : `（仅 ${focus}）`}</span>
    <span class="legend-item">边标签显示父级 <code>allow</code> 委托；子级允许 = 父级自身允许 ∩ 委托匹配</span>`;
}

/* ---------------- 日志 ---------------- */

async function refreshLogs() {
  let logs = [];
  try {
    if (live.workerOk) logs = (await workerRpc('listLogs', { limit: 80 })).logs;
    else if (idbAvailable()) logs = await idbListLogs(80);
  } catch (err) {
    $('log-list').innerHTML = `<span class="tag tag-deny">日志读取失败</span> ${escapeHtml(err.message)}`;
    return;
  }
  $('log-count').textContent = `共 ${logs.length} 条`;
  $('log-list').innerHTML = logs.length
    ? logs.map((entry) => {
      const r = entry.result || {};
      const cls = r.ok ? 'tag-allow' : r.category === 'denied-by-policy' ? 'tag-deny' : 'tag-warn';
      return `<div class="log-line">
        <span class="log-ts">${new Date(entry.ts).toLocaleTimeString()}</span>
        <span class="tag tag-na">[${entry.context}]</span>
        <code>${entry.feature}</code>
        <span class="tag ${cls}">${r.ok ? '允许' : r.category || '未知'}</span>
        <span class="log-msg">${escapeHtml(r.message || '')}</span>
      </div>`;
    }).join('')
    : '<span class="tiny-note">暂无日志，点击“实际调用测试”后这里会持久化到 IndexedDB。</span>';
}

async function clearLogs() {
  try {
    if (live.workerOk) await workerRpc('clearLogs');
    else if (idbAvailable()) await idbClearLogs();
  } catch { /* ignore */ }
  refreshLogs();
}

/* ---------------- 头应用 / 校验 ---------------- */

async function validateHeaderViaWorker() {
  const header = $('header-input').value;
  state.header = header;
  let result;
  if (live.workerOk) {
    result = await workerRpc('validate', { header });
  } else {
    const parsed = parseHeader(header);
    result = { errors: parsed.errors, warnings: parsed.warnings };
  }
  feedback($('header-feedback'), result.errors, result.warnings);
  return result;
}

async function applyHeader() {
  const result = await validateHeaderViaWorker();
  persistState();
  updateSimulated();

  if (result.errors.length) {
    showAlert(`策略语法错误，未下发到 Service Worker：<br>${result.errors.map(escapeHtml).join('<br>')}`, 'error');
    return;
  }

  const stored = await sendHeaderToSw(state.header);
  if (stored) {
    showAlert('头已写入 SW 缓存。正在重建 iframe 树：index.html 与 sandbox.html 的新响应将携带该 Permissions-Policy 头。', 'info');
    buildFrameTree();
    // 若 SW 刚刚注册还未控制本页，顶层自身仍无头，提示需要重载
    if (!navigator.serviceWorker.controller) {
      showAlert('SW 尚未控制顶层页面本身：A/B 的“顶层策略”可能仍缺头。请点“SW 生效后重开沙箱”或直接刷新整页。', 'warn');
    }
  } else {
    $('sw-fallback-note').hidden = false;
    showAlert('Service Worker 不可用或未受控：无法注入真实 HTTP 头。已降级——Canvas/矩阵使用静态模拟值，框架内行为探测仍会反映浏览器的实际默认策略（全部默认 *）。', 'warn');
    buildFrameTree();
  }
}

/* ---------------- 事件绑定与启动 ---------------- */

function bindEvents() {
  $('header-input').value = state.header;
  $('header-input').addEventListener('input', () => {
    state.header = $('header-input').value;
    updateSimulated();
    // 轻量即时校验（主线程），精确反馈仍走 Worker 按钮
    const parsed = parseHeader(state.header);
    feedback($('header-feedback'), parsed.errors, parsed.warnings);
    persistState();
  });

  $('btn-validate').addEventListener('click', () =>
    validateHeaderViaWorker().then(() => { /* 结果已渲染 */ }));
  $('btn-apply').addEventListener('click', applyHeader);
  $('btn-reload-frames').addEventListener('click', () => {
    persistState();
    buildFrameTree();
  });
  $('btn-reset-inherit').addEventListener('click', () => {
    for (const id of FEATURE_IDS) {
      state.allowA[id] = 'inherit';
      state.allowB[id] = 'inherit';
    }
    renderMatrixTable();
    updateAllowPreview();
    updateSimulated();
    persistState();
  });

  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.header = PRESETS[btn.dataset.preset];
      $('header-input').value = state.header;
      const parsed = parseHeader(state.header);
      feedback($('header-feedback'), parsed.errors, parsed.warnings);
      updateSimulated();
      persistState();
    });
  });

  $('btn-sw-register').addEventListener('click', async () => {
    if (!live.swReg) {
      await initServiceWorker();
      return;
    }
    try {
      await live.swReg.update();
      showAlert('已请求更新 Service Worker。', 'info');
    } catch (err) {
      showAlert(`SW 更新失败：${escapeHtml(err.message)}`, 'error');
    }
  });
  $('btn-sw-reload').addEventListener('click', async () => {
    if (await sendHeaderToSw(state.header)) {
      buildFrameTree();
    } else {
      showAlert('SW 仍未受控，请直接刷新整页（首次注册后需要一次刷新）。', 'warn');
    }
  });

  $('view-source').addEventListener('change', renderCanvas);
  $('view-feature').addEventListener('change', renderCanvas);
  $('btn-canvas-refresh').addEventListener('click', renderCanvas);
  window.addEventListener('resize', renderCanvas);

  $('test-bar').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-feature]');
    if (btn) triggerTest(btn.dataset.testContext, btn.dataset.feature);
  });

  $('btn-refresh-logs').addEventListener('click', refreshLogs);
  $('btn-clear-logs').addEventListener('click', clearLogs);
}

async function boot() {
  renderEnvBadges();
  renderMatrixTable();
  renderDefaultsTable();
  bindEvents();
  await initWorker();
  await restoreState();
  $('header-input').value = state.header;
  renderMatrixTable();
  updateAllowPreview();
  await initServiceWorker();

  const parsed = parseHeader(state.header);
  feedback($('header-feedback'), parsed.errors, parsed.warnings);
  updateSimulated();
  buildFrameTree();
  refreshLogs();
}

boot().catch((err) => {
  showAlert(`初始化失败：${escapeHtml(err.name)}: ${escapeHtml(err.message)}`, 'error');
});
