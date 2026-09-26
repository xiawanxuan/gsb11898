// frame.html 逻辑：向上汇报状态/结果、向下转发到嵌套子框架。
import { FEATURES } from './policy.js';
import { quickSnapshot, runFeatureTest, getEnvironment } from './probe.js';

const ownId = new URLSearchParams(location.search).get('id') || 'frame';
let childFrame = null;
let config = { child: null };

const $ = (id) => document.getElementById(id);
$('frame-id').textContent = ownId;
$('frame-origin').textContent = location.origin;

function postUp(payload) {
  window.parent.postMessage({ dir: 'up', path: [ownId], payload }, '*');
}

function renderAllowText(allow) {
  const node = $('frame-allow-text');
  if (!allow) {
    node.textContent = '（未设置 allow 属性 → 同源时继承父级生效策略）';
    node.classList.add('muted');
  } else {
    node.textContent = allow;
    node.classList.remove('muted');
  }
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

function renderGrid(snapshot) {
  const grid = $('feature-grid');
  grid.innerHTML = '';
  for (const feature of FEATURES) {
    const p = snapshot.policy[feature.id];
    const perm = snapshot.permissions[feature.id];
    const row = document.createElement('div');
    row.className = 'feature-row';
    row.innerHTML = `
      <div class="feature-name">${feature.label}<code>${feature.id}</code></div>
      <div class="feature-cells">
        <div>容器/继承策略：${policyCell(p.allowsFeature)}</div>
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
    btn.addEventListener('click', () => handleTest(btn.dataset.feature, true));
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderTestResult(featureId, result, local) {
  const node = $(`out-${featureId}`);
  if (!node) return;
  const cls = result.ok ? 'ok' : result.category === 'denied-by-policy' ? 'deny' : 'warn';
  node.className = `test-out ${cls}`;
  node.textContent = `${local ? '本框内点击' : '父页面远程触发'}：${result.message}`;
}

async function handleTest(feature, local, respondPath) {
  const result = await runFeatureTest(feature);
  renderTestResult(feature, result, local);
  postUp({ type: 'test-result', feature, result, sourcePath: respondPath || [ownId] });
  return result;
}

async function sendSnapshot() {
  try {
    const snapshot = await quickSnapshot();
    snapshot.id = ownId;
    postUp({ type: 'snapshot', snapshot });
    renderGrid(snapshot);
  } catch (err) {
    postUp({ type: 'frame-error', error: `${err.name}: ${err.message}` });
  }
}

function createChild(childCfg) {
  const wrap = $('child-slot-wrap');
  const slot = $('child-slot');
  slot.innerHTML = '';
  if (!childCfg) {
    wrap.hidden = true;
    childFrame = null;
    return;
  }
  wrap.hidden = false;
  const iframe = document.createElement('iframe');
  iframe.id = `child-${childCfg.id}`;
  iframe.src = `frame.html?id=${encodeURIComponent(childCfg.id)}`;
  iframe.className = 'nested-frame';
  if (childCfg.allow) iframe.setAttribute('allow', childCfg.allow);
  else iframe.removeAttribute('allow');
  slot.appendChild(iframe);
  childFrame = iframe;
  // 把自己的配置转发给子框架（子框架的 allow 已在元素上生效，配置仅用于展示标题层级）
  iframe.addEventListener('load', () => {
    iframe.contentWindow.postMessage(
      { dir: 'down', target: [childCfg.id], payload: { type: 'configure', allow: childCfg.allow, config: { depth: 2 } } },
      '*',
    );
  });
}

window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  // 子框架上行消息：加 ownId 前缀后继续向父级转发
  if (msg.dir === 'up' && Array.isArray(msg.path)) {
    window.parent.postMessage({ dir: 'up', path: [ownId, ...msg.path], payload: msg.payload }, '*');
    return;
  }

  if (msg.dir === 'down' && Array.isArray(msg.target)) {
    const [head, ...rest] = msg.target;
    if (head !== ownId) return;
    if (rest.length > 0) {
      if (childFrame && childFrame.contentWindow) {
        childFrame.contentWindow.postMessage({ dir: 'down', target: rest, payload: msg.payload }, '*');
      } else {
        postUp({ type: 'frame-error', error: `目标 ${rest.join('/')} 的子框架尚未就绪` });
      }
      return;
    }
    const payload = msg.payload || {};
    if (payload.type === 'configure') {
      config = payload.config || config;
      $('frame-depth').textContent = `嵌套深度 ${config.depth || 1}`;
      renderAllowText(payload.allow !== undefined ? payload.allow : null);
      if (config.child) createChild(config.child);
    } else if (payload.type === 'snapshot') {
      await sendSnapshot();
    } else if (payload.type === 'test') {
      await handleTest(payload.feature, false, [ownId]);
    }
  }
});

// 初始上报
$('frame-depth').textContent = `嵌套深度 1`;
window.addEventListener('load', async () => {
  const env = getEnvironment();
  postUp({ type: 'ready', id: ownId, env });
  await sendSnapshot();
});
