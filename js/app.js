/* app.js — 主逻辑：配置、检测、模拟、可视化、持久化 */
(function () {
  'use strict';
  const { FEATURES, KNOWN_FEATURES, parsePolicy, parseAllowAttribute, computeEffective } = window.PolicyKit;
  const $ = id => document.getElementById(id);

  const state = {
    page: {},   // feature -> 'default' | 'allow' | 'deny'
    frame: {},  // 同上（仅控制 allow 属性文本生成）
    pageParsed: { directives: {}, errors: [] },
    allowParsed: { directives: {}, errors: [] },
    childReport: null,
  };
  KNOWN_FEATURES.forEach(f => { state.page[f] = 'default'; state.frame[f] = 'default'; });

  /* ---------- 异常提示 ---------- */
  function toast(message, isInfo) {
    const el = document.createElement('div');
    el.className = 'toast' + (isInfo ? ' info' : '');
    el.textContent = message;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }
  window.addEventListener('error', e => toast('未捕获异常: ' + e.message));
  window.addEventListener('unhandledrejection', e => toast('Promise 异常: ' + (e.reason && e.reason.message || e.reason)));

  /* ---------- ① 环境支持检测 ---------- */
  function detectSupport() {
    const policy = document.permissionsPolicy || document.featurePolicy || null;
    const items = [
      ['document.permissionsPolicy', !!document.permissionsPolicy],
      ['document.featurePolicy（旧名）', !!document.featurePolicy],
      ['navigator.permissions（降级用）', !!(navigator.permissions && navigator.permissions.query)],
      ['iframe allow 属性', 'allow' in HTMLIFrameElement.prototype],
      ['Web Worker', typeof Worker !== 'undefined'],
      ['IndexedDB', 'indexedDB' in window],
      ['Canvas 2D', !!document.createElement('canvas').getContext('2d')],
    ];
    $('support-grid').innerHTML = items.map(([name, ok]) =>
      `<div class="support-item"><b>${name}</b><span class="${ok ? 'ok' : 'no'}">${ok ? '✓ 支持' : '✗ 不支持'}</span></div>`
    ).join('');
    $('fallback-hint').hidden = !!policy;
    return policy;
  }
  const runtimePolicy = detectSupport();

  /* ---------- ②③ 开关与文本同步 ---------- */
  function buildToggles(containerId, scope) {
    const box = $(containerId);
    KNOWN_FEATURES.forEach(f => {
      const row = document.createElement('div');
      row.className = 'toggle-row';
      row.innerHTML = `<span class="name">${FEATURES[f].label}</span>`;
      const seg = document.createElement('div');
      seg.className = 'seg';
      [['default', '默认'], ['allow', '允许'], ['deny', '拒绝']].forEach(([val, label]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.dataset.feature = f; btn.dataset.value = val;
        btn.addEventListener('click', () => {
          state[scope][f] = val;
          syncTextFromToggles(scope);
          refresh();
        });
        seg.appendChild(btn);
      });
      row.appendChild(seg);
      box.appendChild(row);
    });
  }

  function paintToggles(scope) {
    const containerId = scope === 'page' ? 'page-toggles' : 'frame-toggles';
    $(containerId).querySelectorAll('button[data-feature]').forEach(btn => {
      const active = state[scope][btn.dataset.feature] === btn.dataset.value;
      btn.classList.toggle('active', active);
      btn.classList.toggle('deny', active && btn.dataset.value === 'deny');
    });
  }

  function syncTextFromToggles(scope) {
    if (scope === 'page') {
      const parts = KNOWN_FEATURES.filter(f => state.page[f] !== 'default')
        .map(f => `${f}=${state.page[f] === 'allow' ? '(self)' : '()'}`);
      $('page-policy').value = parts.join(', ');
    } else {
      const parts = KNOWN_FEATURES.filter(f => state.frame[f] !== 'default')
        .map(f => state.frame[f] === 'allow' ? `${f} 'self'` : `${f} 'none'`);
      $('frame-allow').value = parts.join('; ');
    }
  }

  function syncTogglesFromText(scope) {
    const parsed = scope === 'page' ? state.pageParsed : state.allowParsed;
    KNOWN_FEATURES.forEach(f => {
      const rule = parsed.directives[f];
      if (!rule) state[scope][f] = 'default';
      else if (rule.origins.length === 0) state[scope][f] = 'deny';
      else state[scope][f] = 'allow';
    });
    paintToggles(scope);
  }

  function renderErrors(elId, errors, textarea) {
    $(elId).textContent = errors.map(e => `✗ ${e.message}`).join('\n');
    textarea.classList.toggle('invalid', errors.length > 0);
    if (errors.length) toast(`策略语法错误：${errors[0].message}`);
  }

  /* ---------- 检测计算 ---------- */
  function computeAll() {
    const origin = location.origin;
    return KNOWN_FEATURES.map(f => {
      const pageEff = computeEffective(f, state.pageParsed.directives, null, origin, origin);
      const childEff = computeEffective(f, state.pageParsed.directives, state.allowParsed.directives, origin, origin);
      const allowRule = state.allowParsed.directives[f];
      return {
        feature: f, label: FEATURES[f].label,
        page: { allowed: pageEff.allowed, list: pageEff.pageList, inherited: pageEff.inherited },
        allow: allowRule ? { declared: true, list: allowRule.origins, allowed: allowRule.origins.length > 0 } : null,
        child: { allowed: childEff.allowed, overriddenBy: childEff.overriddenBy },
      };
    });
  }

  function redrawDiagram() {
    try {
      PolicyDiagram.draw($('diagram'), { features: computeAll() });
    } catch (err) {
      toast('Canvas 可视化失败: ' + err.message);
    }
  }

  /* ---------- iframe ---------- */
  function rebuildFrame() {
    const frame = $('demo-frame');
    const allowText = $('frame-allow').value.trim();
    state.childReport = null;
    $('child-report').textContent = '等待子页面回传…';
    try {
      frame.removeAttribute('allow');
      if (allowText) frame.setAttribute('allow', allowText);
      frame.setAttribute('allowfullscreen', '');
      frame.src = 'child.html?_=' + Date.now();
    } catch (err) {
      toast('iframe 配置失败: ' + err.message);
    }
  }

  window.addEventListener('message', e => {
    if (!e.data || e.data.type !== 'child-report') return;
    state.childReport = e.data;
    const lines = [`子页面回传 (origin=${e.data.origin}, permissionsPolicy=${e.data.hasPolicy ? '✓' : '✗ 降级'}):`];
    for (const [f, r] of Object.entries(e.data.features)) {
      lines.push(`  ${f}: allowsFeature=${r.allows}  permissionsAPI=${r.permState}`);
    }
    $('child-report').textContent = lines.join('\n');
  });

  /* ---------- ④ 检测与模拟 ---------- */
  async function queryPermissionsApi(name) {
    if (!(navigator.permissions && navigator.permissions.query)) return { state: 'unsupported', note: '无 Permissions API' };
    try {
      const status = await navigator.permissions.query({ name });
      return { state: status.state };
    } catch (err) {
      return { state: 'unsupported', note: err.message };
    }
  }

  function simulateRequest(effectiveAllowed, runtimeAllows) {
    // 优先使用运行时策略接口；不支持时降级到本地计算
    const allowed = runtimeAllows !== null ? runtimeAllows : effectiveAllowed;
    const source = runtimeAllows !== null ? 'permissionsPolicy.allowsFeature' : '本地计算（降级）';
    if (!allowed) return { text: `拒绝 → SecurityError/NotAllowedError（依据: ${source}）`, cls: 'no' };
    return { text: `允许 → 将触发权限提示或直接放行（依据: ${source}）`, cls: 'ok' };
  }

  async function runDetect() {
    const rows = computeAll();
    const tbody = $('detect-rows');
    tbody.innerHTML = '';
    for (const row of rows) {
      let runtimeAllows = null;
      if (runtimePolicy && typeof runtimePolicy.allowsFeature === 'function') {
        try { runtimeAllows = runtimePolicy.allowsFeature(row.feature); }
        catch (err) { toast(`allowsFeature(${row.feature}) 异常: ${err.message}`); }
      }
      const apiName = FEATURES[row.feature].permissionsApiName;
      const perm = apiName ? await queryPermissionsApi(apiName) : { state: 'n/a', note: '无对应权限名' };
      const sim = simulateRequest(row.page.allowed, runtimeAllows);

      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${row.label}</td>` +
        `<td class="${row.page.allowed ? 'ok' : 'no'}">${row.page.allowed ? '允许' : '拒绝'}${row.page.inherited ? '（继承默认）' : ''}</td>` +
        `<td>${runtimeAllows === null ? '<span class="warn">接口不可用→降级</span>' : `<span class="${runtimeAllows ? 'ok' : 'no'}">${runtimeAllows}</span>`}</td>` +
        `<td>${perm.state}${perm.note ? ` <span class="warn">(${perm.note})</span>` : ''}</td>` +
        `<td class="${sim.cls}">${sim.text}</td>` +
        `<td><button type="button" data-real="${row.feature}">真实请求</button></td>`;
      tbody.appendChild(tr);

      PolicyDB.addLog({ feature: row.feature, allowed: row.page.allowed, runtimeAllows, permState: perm.state })
        .catch(err => toast('日志写入失败: ' + err.message));
    }
    refreshLogs();
  }

  async function realRequest(feature) {
    try {
      if (feature === 'camera' || feature === 'microphone') {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('mediaDevices 不可用');
        const stream = await navigator.mediaDevices.getUserMedia({ [feature === 'camera' ? 'video' : 'audio']: true });
        stream.getTracks().forEach(t => t.stop());
        toast(`${FEATURES[feature].label}真实请求成功`, true);
      } else if (feature === 'geolocation') {
        if (!navigator.geolocation) throw new Error('geolocation 不可用');
        await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000 }));
        toast('地理位置获取成功', true);
      } else if (feature === 'fullscreen') {
        await document.documentElement.requestFullscreen();
        await document.exitFullscreen().catch(() => {});
        toast('全屏请求成功', true);
      } else if (feature === 'autoplay') {
        const video = document.createElement('video');
        video.muted = true;
        video.src = 'data:video/mp4;base64,AAAAIGZ0eXBpc29t';
        await video.play().catch(err => { throw err; });
        toast('自动播放成功', true);
      }
    } catch (err) {
      toast(`${FEATURES[feature].label}真实请求被拒绝/失败: ${err.name || ''} ${err.message}`);
    }
    PolicyDB.addLog({ feature, realRequest: true }).catch(() => {});
  }

  /* ---------- Worker 检测 ---------- */
  function runWorker() {
    if (typeof Worker === 'undefined') { toast('当前浏览器不支持 Web Worker'); return; }
    let worker;
    try {
      worker = new Worker('js/worker.js');
    } catch (err) { toast('Worker 创建失败: ' + err.message); return; }
    const timer = setTimeout(() => { worker.terminate(); toast('Worker 检测超时'); }, 5000);
    worker.onmessage = e => {
      clearTimeout(timer);
      const r = e.data;
      const lines = [
        `Worker 类型: ${r.workerType}`,
        `Worker 中 Permissions API: ${r.hasPermissionsApi ? '✓' : '✗（无法查询，属正常差异）'}`,
        `Worker 中 Permissions Policy 接口: ${r.hasPermissionsPolicy ? '✓' : '✗'}`,
        ...r.results.map(x => `  ${x.name}: ${x.state}${x.error ? ' (' + x.error + ')' : ''}`),
        ...r.errors.map(x => '  ⚠ ' + x),
      ];
      $('worker-report').textContent = lines.join('\n');
      worker.terminate();
    };
    worker.onerror = err => { clearTimeout(timer); toast('Worker 错误: ' + err.message); worker.terminate(); };
    worker.postMessage({ features: ['camera', 'microphone', 'geolocation'] });
  }

  /* ---------- ⑥ 日志 ---------- */
  async function refreshLogs() {
    try {
      const logs = await PolicyDB.listLogs(50);
      $('log-list').innerHTML = logs.map(l =>
        `<li>[${new Date(Math.floor(l.ts)).toLocaleTimeString()}] ${l.feature} → 计算:${l.allowed ? '允许' : '拒绝'}` +
        `${l.runtimeAllows !== null && l.runtimeAllows !== undefined ? ' 运行时:' + l.runtimeAllows : ''}` +
        `${l.permState ? ' 权限:' + l.permState : ''}${l.realRequest ? ' [真实请求]' : ''}</li>`
      ).join('') || '<li>暂无日志</li>';
    } catch (err) {
      $('log-list').innerHTML = `<li class="no">日志读取失败: ${err.message}</li>`;
    }
  }

  /* ---------- 刷新 ---------- */
  function refresh() {
    state.pageParsed = parsePolicy($('page-policy').value);
    state.allowParsed = parseAllowAttribute($('frame-allow').value);
    renderErrors('page-policy-errors', state.pageParsed.errors, $('page-policy'));
    renderErrors('frame-allow-errors', state.allowParsed.errors, $('frame-allow'));
    syncTogglesFromText('page');
    syncTogglesFromText('frame');
    redrawDiagram();
  }

  /* ---------- 事件绑定 ---------- */
  buildToggles('page-toggles', 'page');
  buildToggles('frame-toggles', 'frame');
  $('page-policy').addEventListener('input', refresh);
  $('frame-allow').addEventListener('input', refresh);
  $('apply-frame').addEventListener('click', () => { refresh(); rebuildFrame(); });
  $('run-detect').addEventListener('click', () => runDetect().catch(err => toast('检测失败: ' + err.message)));
  $('run-worker').addEventListener('click', runWorker);
  $('refresh-logs').addEventListener('click', refreshLogs);
  $('clear-logs').addEventListener('click', () =>
    PolicyDB.clearLogs().then(refreshLogs).catch(err => toast('清空失败: ' + err.message)));
  $('detect-rows').addEventListener('click', e => {
    const f = e.target.dataset && e.target.dataset.real;
    if (f) realRequest(f);
  });
  $('save-config').addEventListener('click', () =>
    PolicyDB.saveConfig({ pagePolicy: $('page-policy').value, frameAllow: $('frame-allow').value })
      .then(() => toast('配置已保存到 IndexedDB', true))
      .catch(err => toast('保存失败: ' + err.message)));
  $('load-config').addEventListener('click', () =>
    PolicyDB.loadConfig().then(cfg => {
      if (!cfg) { toast('没有已保存的配置', true); return; }
      $('page-policy').value = cfg.pagePolicy || '';
      $('frame-allow').value = cfg.frameAllow || '';
      refresh(); rebuildFrame();
      toast('配置已恢复', true);
    }).catch(err => toast('读取失败: ' + err.message)));

  /* ---------- 初始化 ---------- */
  $('page-policy').value = 'camera=(self), microphone=(), geolocation=(self), fullscreen=*, autoplay=(self)';
  $('frame-allow').value = "camera 'self'; geolocation 'none'";
  refresh();
  rebuildFrame();
  refreshLogs();
})();
