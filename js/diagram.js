/* diagram.js — Canvas 绘制 页面策略 → iframe allow → 子上下文 的继承/覆盖关系图 */
(function (global) {
  'use strict';

  const COLORS = {
    bg: '#0b1220', node: '#1e293b', nodeBorder: '#475569',
    allow: '#22c55e', deny: '#ef4444', inherit: '#38bdf8', override: '#f59e0b',
    text: '#e2e8f0', dim: '#94a3b8', edge: '#64748b',
  };

  /**
   * data: {
   *   features: [ { feature, label, page: {allowed, list, inherited},
   *                 allow: {declared, list} | null,
   *                 child: {allowed, overriddenBy} } ]
   * }
   */
  function draw(canvas, data) {
    const dpr = global.devicePixelRatio || 1;
    const rowH = 44, headH = 56, pad = 16;
    const colX = [pad, 250, 500, 750]; // 特性列 + 三个节点列
    const nodeW = 210;
    const W = colX[3] + nodeW + pad;
    const H = headH + data.features.length * rowH + pad;

    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, W, H);
    ctx.font = '12px system-ui, sans-serif';

    const titles = ['特性', '页面策略 (Permissions-Policy)', 'iframe allow 属性', '子上下文有效策略'];
    titles.forEach((t, i) => {
      ctx.fillStyle = COLORS.text; ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.fillText(t, colX[i], 24);
    });
    ctx.font = '12px system-ui, sans-serif';

    data.features.forEach((f, idx) => {
      const y = headH + idx * rowH;
      // 特性名
      ctx.fillStyle = COLORS.text; ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.fillText(f.label + ' (' + f.feature + ')', colX[0], y + 22);
      ctx.font = '12px system-ui, sans-serif';

      // 页面策略节点
      drawNode(ctx, colX[1], y, nodeW, f.page.allowed,
        f.page.inherited ? '继承默认: ' + f.page.list.join(' ') : f.page.list.join(' ') || '(拒绝所有)',
        f.page.inherited ? COLORS.inherit : (f.page.allowed ? COLORS.allow : COLORS.deny));

      // iframe allow 节点
      if (f.allow && f.allow.declared) {
        drawNode(ctx, colX[2], y, nodeW, f.allow.allowed, f.allow.list.join(' ') || '(拒绝所有)',
          f.allow.allowed ? COLORS.allow : COLORS.deny);
      } else {
        drawNode(ctx, colX[2], y, nodeW, true, '未声明 → 继承默认', COLORS.inherit, true);
      }

      // 子上下文有效策略节点
      drawNode(ctx, colX[3], y, nodeW, f.child.allowed,
        f.child.overriddenBy ? '被覆盖: ' + f.child.overriddenBy : (f.child.allowed ? '允许' : '拒绝'),
        f.child.overriddenBy ? COLORS.override : (f.child.allowed ? COLORS.allow : COLORS.deny));

      // 连线
      drawEdge(ctx, colX[1] + nodeW, y + 15, colX[2], y + 15);
      drawEdge(ctx, colX[2] + nodeW, y + 15, colX[3], y + 15);
    });
  }

  function drawNode(ctx, x, y, w, allowed, sub, accent, dashed) {
    const h = 30;
    ctx.save();
    if (dashed) ctx.setLineDash([4, 3]);
    ctx.fillStyle = COLORS.node;
    ctx.strokeStyle = accent;
    roundRect(ctx, x, y, w, h, 6);
    ctx.fill(); ctx.stroke();
    ctx.restore();

    ctx.fillStyle = accent;
    ctx.beginPath(); ctx.arc(x + 12, y + h / 2, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = COLORS.text;
    ctx.fillText(allowed ? '允许' : '拒绝', x + 22, y + 13);
    ctx.fillStyle = COLORS.dim;
    const label = sub.length > 30 ? sub.slice(0, 29) + '…' : sub;
    ctx.fillText(label, x + 22, y + 26, w - 30);
  }

  function drawEdge(ctx, x1, y1, x2, y2) {
    ctx.strokeStyle = COLORS.edge;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2 - 6, y2); ctx.stroke();
    ctx.fillStyle = COLORS.edge;
    ctx.beginPath();
    ctx.moveTo(x2, y2); ctx.lineTo(x2 - 7, y2 - 4); ctx.lineTo(x2 - 7, y2 + 4);
    ctx.closePath(); ctx.fill();
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

  global.PolicyDiagram = { draw };
})(typeof self !== 'undefined' ? self : this);
