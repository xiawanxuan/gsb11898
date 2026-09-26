// 共享模块：Permissions-Policy 头解析、iframe allow 解析、继承/覆盖模拟
// 同时被主线程 (js/app.js) 与 Web Worker (js/worker.js) 引入。

export const FEATURES = [
  { id: 'camera', label: '摄像头', permission: 'camera' },
  { id: 'microphone', label: '麦克风', permission: 'microphone' },
  { id: 'geolocation', label: '地理位置', permission: 'geolocation' },
  { id: 'fullscreen', label: '全屏', permission: null },
  { id: 'autoplay', label: '自动播放', permission: null },
];

export const FEATURE_IDS = FEATURES.map((f) => f.id);

// 各特性的默认允许列表（规范 default allowlist）。
// 这五个特性默认值均为 *：任何文档默认都“被策略允许”，
// 但摄像头/麦克风/地理位置仍需用户授权，自动播放仍受浏览器自动播放策略约束。
export const DEFAULT_ALLOWLIST = Object.fromEntries(
  FEATURE_IDS.map((id) => [id, '*']),
);

const FEATURE_NAME_RE = /^[a-z][a-z0-9-]*$/;
const KNOWN = new Set(FEATURE_IDS);

function makeEmptyResult() {
  return { directives: new Map(), errors: [], warnings: [] };
}

function originFromQuoted(raw, errors) {
  if (!/^".*"$/.test(raw)) {
    errors.push(`无效 token “${raw}”：来源必须使用双引号，例如 "https://example.com"`);
    return null;
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    errors.push(`来源字符串引号不合法：${raw}`);
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`无法解析来源：${raw}`);
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) {
    errors.push(`来源协议必须是 http/https：${raw}`);
    return null;
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    errors.push(`来源不能包含路径/查询/锚点：${raw}`);
    return null;
  }
  if (url.origin === 'null') {
    errors.push(`不透明来源（如 sandbox 唯一来源）无法写入允许列表：${raw}`);
    return null;
  }
  return url.origin;
}

/**
 * 解析 Permissions-Policy 响应头。
 * 支持规范的逗号分隔，并宽容接受旧示例中的分号分隔。
 */
export function parseHeader(text) {
  const result = makeEmptyResult();
  const source = String(text || '').trim();
  if (!source) return result;

  const parts = source.split(/\s*[,;]\s*/).filter(Boolean);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      result.errors.push(`“${part.trim()}” 缺少 “=”，正确示例：camera=(self)`);
      continue;
    }
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();

    if (!FEATURE_NAME_RE.test(name)) {
      result.errors.push(
        `特性名 “${name}” 非法：只能包含小写字母、数字和连字符，例如 geolocation`,
      );
      continue;
    }
    if (!KNOWN.has(name)) {
      result.warnings.push(`特性 “${name}” 不在本演示的五个特性之内，仍会按语法保留`);
    }

    const directive = { star: false, self: false, src: false, none: false, origins: [] };

    if (value === '*') {
      directive.star = true;
    } else if (value === '') {
      result.errors.push(`特性 “${name}” 缺少允许列表值，例如 ${name}=() 或 ${name}=*`);
      continue;
    } else if (value.startsWith('(')) {
      if (!/^\(.*\)$/.test(value)) {
        result.errors.push(`特性 “${name}” 的括号未闭合：${value}`);
        continue;
      }
      const tokens = value.slice(1, -1).split(/\s+/).filter(Boolean);
      if (tokens.length === 0) {
        directive.none = true; // 空列表 () == 显式拒绝
      }
      for (const token of tokens) {
        if (token === '*') {
          result.errors.push(`特性 “${name}”：“*” 只能单独使用，不能放进括号内`);
        } else if (token === 'self') {
          if (directive.none) result.errors.push(`特性 “${name}”：'none' 必须单独使用`);
          directive.self = true;
        } else if (token === 'src') {
          if (directive.none) result.errors.push(`特性 “${name}”：'none' 必须单独使用`);
          directive.src = true;
        } else if (token === 'none') {
          if (tokens.length > 1) {
            result.errors.push(`特性 “${name}”：'none' 必须单独使用，不能与其他来源并列`);
          }
          directive.none = true;
        } else if (token.startsWith('"')) {
          if (directive.none) {
            result.errors.push(`特性 “${name}”：'none' 必须单独使用`);
          }
          const origin = originFromQuoted(token, result.errors);
          if (origin && !directive.origins.includes(origin)) directive.origins.push(origin);
        } else {
          result.errors.push(
            `特性 “${name}” 含未知 token “${token}”，合法值为 'self'、'src'、'none' 或 "https://来源"`,
          );
        }
      }
    } else if (value === 'self' || value === 'src' || value === 'none') {
      result.errors.push(`特性 “${name}=${value}” 语法错误：${value} 必须放在括号内，例如 ${name}=(${value})`);
    } else {
      result.errors.push(
        `特性 “${name}” 的值 “${value}” 非法：允许 *、()、(self)、('src' 不适用头语法) 或带引号的来源列表`,
      );
    }

    if (result.directives.has(name)) {
      result.warnings.push(`特性 “${name}” 被重复声明，以后出现的声明为准`);
    }
    result.directives.set(name, directive);
  }
  return result;
}

/**
 * 解析 iframe allow 属性，例如：
 *   camera 'self' 'src'; microphone *; geolocation 'none'
 */
export function parseAllowAttribute(text) {
  const result = makeEmptyResult();
  const source = String(text || '').trim();
  if (!source) return result;

  for (const chunk of source.split(/\s*;\s*/).filter(Boolean)) {
    const sp = chunk.search(/\s/);
    const name = sp === -1 ? chunk : chunk.slice(0, sp);
    const rest = sp === -1 ? '' : chunk.slice(sp + 1).trim();
    if (!FEATURE_NAME_RE.test(name)) {
      result.errors.push(`allow 属性中的特性名 “${name}” 非法`);
      continue;
    }
    if (!rest) {
      result.errors.push(`allow 属性中 “${name}” 后面缺少策略值（如 *、'self'、'src'、'none'）`);
      continue;
    }
    const directive = { star: false, self: false, src: false, none: false, origins: [] };
    for (const token of rest.split(/\s+/).filter(Boolean)) {
      if (token === '*') directive.star = true;
      else if (token === "'self'") directive.self = true;
      else if (token === "'src'") directive.src = true;
      else if (token === "'none'") directive.none = true;
      else if (/^https?:\/\//.test(token)) {
        try {
          const url = new URL(token);
          if (!directive.origins.includes(url.origin)) directive.origins.push(url.origin);
        } catch {
          result.errors.push(`allow 属性中 “${name}” 的来源无法解析：${token}`);
        }
      } else {
        result.errors.push(`allow 属性中 “${name}” 含无法识别的 token “${token}”`);
      }
    }
    if (directive.none && (directive.star || directive.self || directive.src || directive.origins.length)) {
      result.errors.push(`allow 属性中 “${name}”：'none' 必须单独使用`);
    }
    result.directives.set(name, directive);
  }
  return result;
}

export function buildAllowString(selections) {
  const clauses = [];
  for (const feature of FEATURE_IDS) {
    const value = selections[feature] || 'inherit';
    if (value === 'inherit') continue;
    clauses.push(`${feature} ${value}`);
  }
  return clauses.join('; ');
}

function directiveAllows(directive, targetOrigin, selfOrigin, srcOrigin) {
  if (!directive) return true; // 未声明 → 默认 allowlist (*)
  if (directive.star) return true;
  if (directive.none) return false;
  if (directive.self && selfOrigin && targetOrigin === selfOrigin) return true;
  if (directive.src && srcOrigin && targetOrigin === srcOrigin) return true;
  return directive.origins.includes(targetOrigin);
}

/**
 * 计算“预期生效策略”（纯模拟，不依赖浏览器实现）。
 *
 * @param {string} headerText 顶层 Permissions-Policy 头
 * @param {Record<string,string>} allowA  iframe A 的 allow 属性映射（矩阵生成）
 * @param {Record<string,string>} allowB  iframe B（A 的子框架）的 allow 属性映射
 * @param {{top:string, frame:string}} origins 文档来源（演示中同源）
 */
export function simulate(headerText, allowA, allowB, origins) {
  const header = parseHeader(headerText);
  const self = origins.top;
  const frameOrigin = origins.frame || origins.top;

  const effective = { top: {}, A: {}, B: {}, S: {} };
  const reason = { top: {}, A: {}, B: {}, S: {} };

  for (const feature of FEATURE_IDS) {
    const directive = header.directives.get(feature);
    effective.top[feature] = directive
      ? directiveAllows(directive, self, self, self)
      : DEFAULT_ALLOWLIST[feature] === '*';
    reason.top[feature] = directive
      ? '顶层 Permissions-Policy 头显式声明（覆盖默认 *）'
      : '未在响应头中声明，使用默认 allowlist：*';

    // iframe A：allow 属性委托；同源时未委托则继承顶层策略
    const aToken = (allowA && allowA[feature]) || 'inherit';
    const topAllowsFrame = directive
      ? directiveAllows(directive, frameOrigin, self, frameOrigin)
      : true;
    effective.A[feature] = computeFrame(feature, aToken, topAllowsFrame, effective.top[feature], self, frameOrigin, true);
    reason.A[feature] = frameReason(feature, aToken, effective.A[feature], '顶层页面', true);

    // iframe B：嵌套于 A，需要 A 的生效策略继续向下委托
    const bToken = (allowB && allowB[feature]) || 'inherit';
    const aAllowsChild = effective.A[feature];
    effective.B[feature] = computeFrame(feature, bToken, aAllowsChild, effective.A[feature], self, frameOrigin, true);
    reason.B[feature] = frameReason(feature, bToken, effective.B[feature], 'iframe A', true);

    // iframe S：由 Service Worker 注入的头作为“它自己的顶层策略”，
    // 父页面的 allow 始终委托 *，因此只看头。
    effective.S[feature] = directive
      ? directiveAllows(directive, frameOrigin, frameOrigin, frameOrigin)
      : DEFAULT_ALLOWLIST[feature] === '*';
    reason.S[feature] = directive
      ? 'Service Worker 注入的响应头（S 的顶层策略）'
      : '无注入头，使用默认 allowlist：*';
  }

  return { effective, reason, headerErrors: header.errors, headerWarnings: header.warnings };
}

function computeFrame(feature, token, parentDelegates, parentEffective, selfOrigin, frameOrigin, sameOrigin) {
  if (token === 'inherit') {
    // 同源子框架继承父级生效策略；跨来源子框架默认拿不到任何继承。
    return sameOrigin ? parentEffective : false;
  }
  if (!parentDelegates) return false; // 父级自身都不允许，委托 token 再宽也无用
  if (token === '*') return true;
  if (token === "'none'") return false;
  if (token === "'self'") return frameOrigin === selfOrigin;
  if (token === "'src'") return true; // 框架文档自身来源始终等于其 src 来源
  return false;
}

function frameReason(feature, token, allowed, parentName, sameOrigin) {
  if (token === 'inherit') {
    return sameOrigin
      ? `allow 未声明 ${feature}：同源框架继承 ${parentName} 的生效策略 → ${allowed ? '允许' : '拒绝'}`
      : `allow 未声明 ${feature}：跨源框架不继承策略 → 拒绝`;
  }
  if (!allowed && token !== "'none'") {
    return `allow="${feature} ${token}" 试图委托，但 ${parentName} 自身策略未放行该来源 → 拒绝（双层门）`;
  }
  return `allow 属性显式声明 ${feature} ${token}，且通过 ${parentName} 的双层校验 → ${allowed ? '允许' : '拒绝'}`;
}

export function describeDirective(directive) {
  if (!directive) return '*（默认）';
  if (directive.star) return '*';
  if (directive.none) return '() 空列表';
  const parts = [];
  if (directive.self) parts.push('self');
  if (directive.src) parts.push('src');
  parts.push(...directive.origins.map((o) => `"${o}"`));
  return `(${parts.join(' ')})`;
}
