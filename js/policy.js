/* policy.js — Permissions Policy 语法解析、校验与继承/覆盖计算 */
(function (global) {
  'use strict';

  // 演示涉及的特性及其规范默认允许列表
  const FEATURES = {
    camera:      { label: '摄像头',  defaultAllowlist: 'self', permissionsApiName: 'camera' },
    microphone:  { label: '麦克风',  defaultAllowlist: 'self', permissionsApiName: 'microphone' },
    geolocation: { label: '地理位置', defaultAllowlist: 'self', permissionsApiName: 'geolocation' },
    fullscreen:  { label: '全屏',    defaultAllowlist: 'self', permissionsApiName: null }, // 无 Permissions API 对应
    autoplay:    { label: '自动播放', defaultAllowlist: 'self', permissionsApiName: null },
  };

  const KNOWN_FEATURES = Object.keys(FEATURES);

  /**
   * 解析 Permissions-Policy 头 / allow 属性语法：
   *   camera=(self "https://a.com"), geolocation=(), fullscreen=*
   * 返回 { directives: {feature: {origins: [...], raw}}, errors: [{message, index}] }
   */
  function parsePolicy(input) {
    const result = { directives: {}, errors: [] };
    if (input == null) return result;
    const text = String(input);
    if (!text.trim()) return result;

    // 按顶层逗号切分指令（引号内逗号忽略）
    const parts = splitTopLevel(text);
    let cursor = 0;
    for (const part of parts) {
      const startIndex = text.indexOf(part.text, cursor);
      cursor = startIndex + part.text.length;
      const seg = part.text.trim();
      if (!seg) continue;

      const eq = seg.indexOf('=');
      if (eq === -1) {
        result.errors.push({ message: `指令 "${seg}" 缺少 "="（应为 feature=allowlist）`, index: startIndex });
        continue;
      }
      const feature = seg.slice(0, eq).trim();
      const value = seg.slice(eq + 1).trim();

      if (!/^[a-z][a-z0-9-]*$/.test(feature)) {
        result.errors.push({ message: `特性名 "${feature}" 非法（应为小写字母/数字/连字符）`, index: startIndex });
        continue;
      }
      if (!KNOWN_FEATURES.includes(feature)) {
        result.errors.push({ message: `未知特性 "${feature}"（本演示支持：${KNOWN_FEATURES.join(', ')}）`, index: startIndex });
      }

      const origins = [];
      if (value === '*') {
        origins.push('*');
      } else if (value.startsWith('(')) {
        if (!value.endsWith(')')) {
          result.errors.push({ message: `特性 "${feature}" 的允许列表缺少右括号 ")"`, index: startIndex + eq + 1 });
          continue;
        }
        const inner = value.slice(1, -1).trim();
        if (inner) {
          for (const token of tokenizeAllowlist(inner)) {
            if (token.type === 'keyword') {
              if (token.value === 'self' || token.value === 'src') origins.push(token.value);
              else result.errors.push({ message: `非法关键字 "${token.value}"（仅支持 self / src，或加引号的源）`, index: startIndex });
            } else if (token.type === 'origin') {
              if (!/^https?:\/\/[^\s"']+$/.test(token.value) && token.value !== '*') {
                result.errors.push({ message: `源 "${token.value}" 不是合法的 http(s) URL`, index: startIndex });
              } else {
                origins.push(token.value);
              }
            }
          }
        }
        // 空列表 () 表示全部拒绝
      } else {
        result.errors.push({ message: `特性 "${feature}" 的值必须是 "*"、空列表 "()" 或 "(self ...)" 形式`, index: startIndex + eq + 1 });
        continue;
      }
      result.directives[feature] = { origins, raw: seg };
    }
    return result;
  }

  function splitTopLevel(text) {
    const parts = [];
    let depth = 0, inQuote = false, current = '';
    for (const ch of text) {
      if (ch === '"') inQuote = !inQuote;
      if (!inQuote) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { parts.push({ text: current }); current = ''; continue; }
      }
      current += ch;
    }
    if (current) parts.push({ text: current });
    return parts;
  }

  function tokenizeAllowlist(inner) {
    const tokens = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(inner)) !== null) {
      if (m[1] !== undefined) tokens.push({ type: 'origin', value: m[1] });
      else if (m[2] !== undefined) tokens.push({ type: 'origin', value: m[2] });
      else tokens.push({ type: 'keyword', value: m[3] });
    }
    return tokens;
  }

  /** 将 allow 属性语法（空格分隔，无 feature= 前缀）转为策略指令，用于 iframe allow */
  function parseAllowAttribute(attrValue) {
    // allow="camera 'self'; geolocation *" —— 浏览器 allow 属性用分号分隔
    const normalized = String(attrValue || '').split(';')
      .map(s => s.trim()).filter(Boolean)
      .map(s => {
        const sp = s.indexOf(' ');
        if (sp === -1) return `${s}=(self)`; // 仅写特性名等价于 'src'，这里近似为 self
        const feature = s.slice(0, sp).trim();
        const rest = s.slice(sp + 1).trim();
        if (rest === "'none'" || rest === '') return `${feature}=()`;
        if (rest === '*') return `${feature}=*`;
        const items = rest.split(/\s+/).map(t => {
          if (t === "'self'") return 'self';
          if (t === "'src'") return 'src';
          if (t === "'none'") return null;
          return t.replace(/^'(.*)'$/, '"$1"');
        }).filter(Boolean);
        return `${feature}=(${items.join(' ')})`;
      }).join(', ');
    return parsePolicy(normalized);
  }

  /**
   * 计算某特性的有效允许列表：
   * 页面策略 > 规范默认允许列表；iframe 场景再与 allow 属性求交。
   * origin 为当前上下文源（'self' 或具体 URL）。
   */
  function computeEffective(feature, pageDirectives, allowDirectives, contextOrigin, parentOrigin) {
    const meta = FEATURES[feature];
    const pageRule = pageDirectives[feature];
    const pageList = pageRule ? pageRule.origins : [meta.defaultAllowlist];
    const inherited = !pageRule; // 未显式配置 → 继承默认

    let allowed = matchesAllowlist(pageList, contextOrigin, parentOrigin);
    let overriddenBy = null;

    if (allowDirectives) {
      const allowRule = allowDirectives[feature];
      if (allowRule) {
        const allowOk = matchesAllowlist(allowRule.origins, contextOrigin, parentOrigin);
        if (allowed && !allowOk) overriddenBy = 'iframe allow 属性进一步收紧';
        allowed = allowed && allowOk;
      }
      // allow 未声明该特性 → 按规范回退到特性默认允许列表（多为 self）
    }
    return { feature, allowed, pageList, inherited, overriddenBy };
  }

  function matchesAllowlist(list, contextOrigin, parentOrigin) {
    if (list.includes('*')) return true;
    if (list.length === 0) return false;
    for (const item of list) {
      if (item === 'self' && contextOrigin === parentOrigin) return true;
      if (item === 'src' && contextOrigin !== parentOrigin) return true;
      if (item === contextOrigin) return true;
    }
    return false;
  }

  const api = { FEATURES, KNOWN_FEATURES, parsePolicy, parseAllowAttribute, computeEffective };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PolicyKit = api;
})(typeof self !== 'undefined' ? self : this);
