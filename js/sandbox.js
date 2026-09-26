// sandbox.html：读取 Service Worker 缓存的头值，展示真实 Permissions-Policy 头的效果。
import { FEATURES, parseHeader, describeDirective } from './policy.js';
import { quickSnapshot, runFeatureTest } from './probe.js';

const ownId = 'S';
const $ = (id) => document.getElementById(id);

function postUp(payload) {
  window.parent.postMessage({ dir: 'up', path: [ownId], payload }, '*');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function headerFromQuery() {
  return decodeURIComponent(new URLSearchParams(location.search).get('hdr') || '');
}

async function fetchSwHeader() {
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 800);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data && typeof event.data.header === 'string' ? event.data.header : null);
    };
    navigator.serviceWorker.controller.postMessage({ type: 'get-header' }, [channel.port2]);
  });
}

let liveHeader = '';

function renderHeader(text, viaSw) {
  const state = $('sw-state');
  if (viaSw) {
    state.textContent = 'SW 已注入';
    state.className = 'badge tag-allow';
  } else {
    state.textContent = 'SW 未生效：模拟头';
    state.className = 'badge tag-warn';
  }
  const node = $('injected-header');
  node.textContent = text || '（空 → 全部使用默认 allowlist: *）';
  node.classList.toggle('muted', !text);
}

function policyCell(value) {
  if (value === true) return '<span class="tag tag-allow">策略允许</span>';
  if (value === false) return '<span class="tag tag-deny">策略拒绝</span>';
  if (value === 'error') return '<span class="tag tag-unknown">读取异常</span>';
  return '<span class="tag tag-unknown">API 不可用</span>';
}

function permCell(entry) {
  if (!entry) return '<span class="tag tag-unknown">—</span>';
  if (entry.state === 'n/a') return '<span class="tag tag-na">无此权限项</span>';
  if (entry.state === 'unsupported') return '<span class="tag tag-na">API 不支持</span>';
  if (entry.state === 'error') return '<span class="tag tag-unknown">查询报错</span>';
  const cls = entry.state === 'granted' ? 'tag-allow' : entry.state === 'denied' ? 'tag-deny' : 'tag-warn';
  return `<span class="tag ${cls}">${entry.state}</span>`;
}

async function renderGrid() {
  const snapshot = await quickSnapshot();
  const parsed = parseHeader(liveHeader);
  const grid = $('feature-grid');
  grid.innerHTML = '';
  for (const feature of FEATURES) {
    const p = snapshot.policy[feature.id];
    const perm = snapshot.permissions[feature.id];
    const directive = parsed.directives.get(feature.id);
    const row = document.createElement('div');
    row.className = 'feature-row';
    row.innerHTML = `
      <div class="feature-name">${feature.label}<code>${feature.id}</code></div>
      <div class="feature-cells">
        <div>头声明：<code>${escapeHtml(describeDirective(directive))}</code></div>
        <div>实际生效：${policyCell(p.allowsFeature)}</div>
        <div>Permissions API：${permCell(perm)}</div>
        <div class="feature-note">${perm && perm.note ? escapeHtml(perm.note) : '&nbsp;'}</div>
      </div>
      <div class="feature-actions">
        <button data-feature="${feature.id}">实际调用测试</button>
        <div class="test-out" id="out-${feature.id}"></div>
      </div>`;
    grid.appendChild(row);
  }
  grid.querySelectorAll('button[data-feature]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const result = await runFeatureTest(btn.dataset.feature);
      const node = $(`out-${btn.dataset.feature}`);
      const cls = result.ok ? 'ok' : result.category === 'denied-by-policy' ? 'deny' : 'warn';
      node.className = `test-out ${cls}`;
      node.textContent = `本框内点击：${result.message}`;
      postUp({ type: 'test-result', feature: btn.dataset.feature, result, sourcePath: [ownId] });
    });
  });
  postUp({ type: 'snapshot', snapshot: { ...snapshot, id: ownId } });
}

window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (msg && msg.dir === 'down' && msg.target && msg.target[0] === ownId) {
    const payload = msg.payload || {};
    if (payload.type === 'snapshot') await renderGrid();
    if (payload.type === 'test') {
      const result = await runFeatureTest(payload.feature);
      const node = $(`out-${payload.feature}`);
      if (node) {
        node.className = `test-out ${result.ok ? 'ok' : result.category === 'denied-by-policy' ? 'deny' : 'warn'}`;
        node.textContent = `父页面远程触发：${result.message}`;
      }
      postUp({ type: 'test-result', feature: payload.feature, result, sourcePath: [ownId] });
    }
  }
});

window.addEventListener('load', async () => {
  const viaSw = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  const swHeader = await fetchSwHeader();
  liveHeader = swHeader !== null ? swHeader : headerFromQuery();
  renderHeader(liveHeader, swHeader !== null);
  postUp({ type: 'ready', id: ownId, env: { injectedHeader: liveHeader, viaSw: swHeader !== null } });
  await renderGrid();
});
