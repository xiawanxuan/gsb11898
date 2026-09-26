// 运行时探测库：特性检测、策略读取、Permissions API 查询、实际调用测试。
// 顶层页面与嵌套 iframe（frame.html / sandbox.html）共用。

import { FEATURES } from './policy.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function getEnvironment() {
  const nav = navigator;
  return {
    href: location.href,
    origin: location.origin,
    isTop: window.top === window,
    isIframe: window.top !== window,
    secureContext: !!window.isSecureContext,
    permissionsPolicy: 'permissionsPolicy' in document,
    featurePolicy: 'featurePolicy' in document,
    permissionsApi: !!nav.permissions && typeof nav.permissions.query === 'function',
    mediaDevices: !!(nav.mediaDevices && nav.mediaDevices.getUserMedia),
    geolocation: !!nav.geolocation,
    fullscreen: !!document.documentElement.requestFullscreen || !!document.documentElement.webkitRequestFullscreen,
    captureStream: typeof HTMLCanvasElement.prototype.captureStream === 'function',
    userAgent: nav.userAgent,
  };
}

// document.permissionsPolicy.allowsFeature(feature, src?) / 旧版 document.featurePolicy
export function readPolicy(feature) {
  const out = { modern: null, legacy: null, allowsFeature: null };
  try {
    if (document.permissionsPolicy && typeof document.permissionsPolicy.allowsFeature === 'function') {
      out.modern = document.permissionsPolicy.allowsFeature(feature);
      out.allowsFeature = out.modern;
    }
  } catch {
    out.modern = 'error';
  }
  try {
    if (document.featurePolicy && typeof document.featurePolicy.allowsFeature === 'function') {
      out.legacy = document.featurePolicy.allowsFeature(feature);
      if (out.allowsFeature === null) out.allowsFeature = out.legacy;
    }
  } catch {
    out.legacy = 'error';
  }
  return out;
}

export function getPolicySnapshot() {
  const snap = {};
  for (const { id } of FEATURES) {
    snap[id] = readPolicy(id);
  }
  // document.fullscreenEnabled 直接反映全屏特性是否被策略允许（独立键，避免覆盖特性条目）
  snap.fullscreenApiEnabled =
    document.fullscreenEnabled === true || document.fullscreenEnabled === false
      ? document.fullscreenEnabled
      : (document.webkitFullscreenEnabled ?? null);
  return snap;
}

export async function getPermissionStates() {
  const out = {};
  for (const { id, permission } of FEATURES) {
    if (!permission) {
      out[id] = { available: false, state: 'n/a', note: 'Permissions API 未定义该特性，只能用 API 行为探测' };
      continue;
    }
    if (!navigator.permissions) {
      out[id] = { available: false, state: 'unsupported', note: '当前环境没有 Permissions API' };
      continue;
    }
    try {
      const status = await navigator.permissions.query({ name: permission });
      out[id] = { available: true, state: status.state, note: '' };
    } catch (err) {
      out[id] = {
        available: false,
        state: 'error',
        note: `query({name:'${permission}'}) 抛错：${err.name} —— 浏览器不支持查询该名称`,
      };
    }
  }
  return out;
}

export function classifyMediaError(err, policyAllows) {
  if (err && (err.name === 'SecurityError' || /permission policy|disabled/i.test(err.message || ''))) {
    return policyAllows === false
      ? { category: 'denied-by-policy', message: '被 Permissions Policy 拒绝（双层门未通过）' }
      : { category: 'security', message: `SecurityError：${err.message}` };
  }
  if (err && err.name === 'NotAllowedError') {
    return policyAllows === false
      ? { category: 'denied-by-policy', message: 'NotAllowedError，且策略显示不允许 → 判定为策略拒绝' }
      : { category: 'user-denied', message: 'NotAllowedError：用户拒绝授权或自动播放/权限被浏览器拦截' };
  }
  if (err && err.name === 'NotFoundError') {
    return { category: 'no-device', message: 'NotFoundError：环境中没有对应设备（但策略层已放行）' };
  }
  if (err && err.name === 'NotReadableError') {
    return { category: 'device-busy', message: 'NotReadableError：设备被占用或硬件错误' };
  }
  if (err && err.name === 'OverconstrainedError') {
    return { category: 'constraint', message: 'OverconstrainedError：约束条件无法满足' };
  }
  return { category: 'error', message: err ? `${err.name}: ${err.message}` : '未知错误' };
}

async function testMedia(kind) {
  const constraints = kind === 'camera' ? { video: true } : { audio: true };
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return { ok: false, category: 'unsupported', message: 'navigator.mediaDevices.getUserMedia 不可用（非安全上下文或浏览器不支持）' };
  }
  const policy = readPolicy(kind);
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    const trackKinds = stream.getTracks().map((t) => t.kind);
    return { ok: true, category: 'allowed', message: `getUserMedia 成功，获得轨道：${trackKinds.join(', ')}`, policyAllows: policy.allowsFeature };
  } catch (err) {
    const c = classifyMediaError(err, policy.allowsFeature);
    return { ok: false, ...c, policyAllows: policy.allowsFeature, raw: `${err.name}: ${err.message}` };
  } finally {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  }
}

function testGeolocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({ ok: false, category: 'unsupported', message: 'navigator.geolocation 不存在' });
      return;
    }
    const policy = readPolicy('geolocation');
    const timer = setTimeout(() => {
      resolve({ ok: false, category: 'timeout', message: '定位超时（策略已放行，但未取得位置）', policyAllows: policy.allowsFeature });
    }, 8000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({
          ok: true,
          category: 'allowed',
          message: `定位成功：${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}（精度 ${Math.round(pos.coords.accuracy)}m）`,
          policyAllows: policy.allowsFeature,
        });
      },
      (err) => {
        clearTimeout(timer);
        let result;
        if (err.code === err.PERMISSION_DENIED) {
          result = policy.allowsFeature === false
            ? { category: 'denied-by-policy', message: 'PERMISSION_DENIED 且策略显示不允许 → 策略拒绝' }
            : { category: 'user-denied', message: 'PERMISSION_DENIED：用户拒绝或操作系统定位关闭' };
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          result = { category: 'unavailable', message: 'POSITION_UNAVAILABLE：位置服务不可用（策略已放行）' };
        } else {
          result = { category: 'timeout', message: 'TIMEOUT：定位超时（策略已放行）' };
        }
        resolve({ ok: false, ...result, policyAllows: policy.allowsFeature, raw: err.message });
      },
      { enableHighAccuracy: false, timeout: 7000, maximumAge: 60000 },
    );
  });
}

// 全屏必须由用户手势触发；本函数应由框架页面内的按钮直接调用。
async function testFullscreen() {
  const target = document.documentElement;
  const request = target.requestFullscreen || target.webkitRequestFullscreen;
  if (!request) {
    return { ok: false, category: 'unsupported', message: '浏览器不支持 Fullscreen API' };
  }
  if (document.fullscreenEnabled === false || document.webkitFullscreenEnabled === false) {
    return { ok: false, category: 'denied-by-policy', message: 'document.fullscreenEnabled === false：全屏被策略拒绝' };
  }
  try {
    await request.call(target);
    await sleep(300);
    const active = !!document.fullscreenElement || !!document.webkitFullscreenElement;
    if (active) {
      await sleep(900);
      try { await document.exitFullscreen(); } catch { try { document.webkitExitFullscreen(); } catch {} }
      return { ok: true, category: 'allowed', message: '已进入全屏并自动退出：全屏被策略允许' };
    }
    return { ok: false, category: 'unknown', message: '调用未抛错但未进入全屏' };
  } catch (err) {
    const gesture = /user gesture|transient activation|fullscreen/i.test(`${err.name} ${err.message}`);
    return {
      ok: false,
      category: gesture ? 'gesture-required' : 'denied',
      message: gesture
        ? '需要用户手势：请点击本 iframe 内部的“测全屏”按钮，而不是父页面按钮'
        : `${err.name}: ${err.message}`,
      raw: `${err.name}: ${err.message}`,
    };
  }
}

async function testAutoplay() {
  if (!HTMLCanvasElement.prototype.captureStream) {
    return { ok: false, category: 'unsupported', message: 'canvas.captureStream 不可用，无法构造测试媒体流' };
  }
  const policy = readPolicy('autoplay');
  const canvas = document.createElement('canvas');
  canvas.width = 48;
  canvas.height = 48;
  const ctx = canvas.getContext('2d');
  let n = 0;
  const draw = () => {
    ctx.fillStyle = `hsl(${n % 360},80%,55%)`;
    ctx.fillRect(0, 0, 48, 48);
    n += 37;
  };
  draw();
  const stream = canvas.captureStream(10);
  const timer = setInterval(draw, 100);

  const video = document.createElement('video');
  video.muted = true; // 先测“静音自动播放”（浏览器自动播放策略下最宽松的场景）
  video.playsInline = true;
  video.srcObject = stream;
  video.setAttribute('data-probe', 'autoplay');
  video.style.cssText = 'position:fixed;left:8px;bottom:8px;width:120px;height:90px;z-index:9999;background:#000';
  document.body.appendChild(video);

  let playError = null;
  try {
    await video.play();
  } catch (err) {
    playError = err;
  }
  await sleep(400);
  const playing = !video.paused;

  clearInterval(timer);
  try { video.pause(); video.srcObject = null; } catch {}
  video.remove();
  stream.getTracks().forEach((t) => t.stop());

  if (playError) {
    const byPolicy = policy.allowsFeature === false || /policy/i.test(`${playError.name} ${playError.message}`);
    return {
      ok: false,
      category: byPolicy ? 'denied-by-policy' : 'blocked',
      message: byPolicy
        ? `play() 被拒（${playError.name}）且 autoplay 策略不允许 → 策略拒绝`
        : `play() 被拒：${playError.name}: ${playError.message}`,
      policyAllows: policy.allowsFeature,
      muted: true,
    };
  }
  return {
    ok: playing,
    category: playing ? 'allowed' : 'paused',
    message: playing
      ? '静音视频自动播放成功（若此处为否但预期拒绝，请改测非静音场景对比）'
      : 'play() 未抛错但视频仍处于 paused',
    policyAllows: policy.allowsFeature,
    muted: true,
  };
}

export async function runFeatureTest(feature) {
  const startedAt = Date.now();
  let result;
  if (feature === 'camera' || feature === 'microphone') result = await testMedia(feature);
  else if (feature === 'geolocation') result = await testGeolocation();
  else if (feature === 'fullscreen') result = await testFullscreen();
  else if (feature === 'autoplay') result = await testAutoplay();
  else result = { ok: false, category: 'unknown', message: `未知特性：${feature}` };
  return { ...result, feature, elapsedMs: Date.now() - startedAt };
}

export async function quickSnapshot() {
  const [permissions] = await Promise.all([getPermissionStates()]);
  return {
    env: getEnvironment(),
    policy: getPolicySnapshot(),
    permissions,
    time: new Date().toISOString(),
  };
}
