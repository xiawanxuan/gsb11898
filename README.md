# Permissions Policy 策略演示台

在页面与 iframe 中配置摄像头、麦克风、地理位置、全屏、自动播放等特性开关，
检测当前生效策略，模拟允许/拒绝场景，并可视化策略的继承与覆盖关系。

## 运行

需要通过 HTTP 访问（`file://` 下 iframe / Worker / IndexedDB 行为受限）：

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

如需真实测试页面级 `Permissions-Policy` 响应头，可用任意支持自定义头的服务器，
例如：`npx serve -h "Permissions-Policy: camera=(self)"`，或在页面内直接编辑策略文本（本地计算 + 运行时接口双通道检测）。

## 功能

- **环境支持检测**：`document.permissionsPolicy` / 旧名 `featurePolicy` / Permissions API / iframe `allow` / Worker / IndexedDB / Canvas
- **策略配置**：开关（默认/允许/拒绝）与策略文本双向同步，语法错误实时提示（非法特性名、缺括号、非法源等）
- **iframe 继承**：`allow` 属性与页面策略求交，子页面（`child.html`）自检并 `postMessage` 回传
- **生效检测**：本地计算 + `permissionsPolicy.allowsFeature()` 运行时检测；接口不可用时降级到 `navigator.permissions.query()`
- **允许/拒绝模拟**：按有效策略预测 SecurityError/放行；并提供真实请求测试（getUserMedia / geolocation / fullscreen / autoplay）
- **可视化**：Canvas 绘制 页面策略 → iframe allow → 子上下文 的继承/覆盖链路
- **Worker 检测**：在 Web Worker 上下文中探测 Permissions API 可用性差异
- **持久化**：配置与检测日志存入 IndexedDB，可保存/恢复/查看/清空
- **异常提示**：所有异常以 toast 形式提示，未捕获异常统一兜底

## 文件结构

- `index.html` / `css/styles.css` — 主页面
- `js/policy.js` — 策略语法解析、校验、继承/覆盖计算（可在 Node 中单测）
- `js/app.js` — 主逻辑
- `js/diagram.js` — Canvas 可视化
- `js/db.js` — IndexedDB 封装
- `js/worker.js` — Worker 上下文检测
- `child.html` — iframe 子页面（自检并回传）
