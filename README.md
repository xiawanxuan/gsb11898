# Permissions Policy 实验室

在同一页面中演示 **Permissions Policy**（旧称 Feature Policy）对五个特性的配置、继承、覆盖与运行时检测：

- 摄像头 `camera` / 麦克风 `microphone`（getUserMedia）
- 地理位置 `geolocation`
- 全屏 `fullscreen`
- 自动播放 `autoplay`

技术栈：**Permissions Policy + Permissions API + iframe + Web Worker + IndexedDB + Canvas**。

## 运行

必须在安全上下文里跑（`getUserMedia`、Service Worker 等要求）：

```bash
cd /home/iris/gsbProject/gsb11898/B
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000/
```

首次打开后点 **「注册 / 更新 SW」**，Service Worker 会拦截 `index.html` 与 `sandbox.html`，
在响应上注入编辑区的 `Permissions-Policy` 头（SW 首次接管需要一次页面刷新，页面会自动提示）。

## 页面结构（对应验收点）

1. **顶层 Permissions-Policy 头编辑器**：实时 + Worker 后台语法校验，错误逐条提示；
   「应用并下发」把头发给 SW 缓存并重建 iframe。
2. **iframe allow 委托矩阵**：分别配置 顶层→A、A→B 的 `allow` token（`* / 'none' / 'self' / 'src' / inherit`）。
3. **Service Worker 面板**：注入真实 HTTP 头；不支持/未受控时明确降级提示。
4. **默认允许列表表**：五个特性默认均为 `*`，并说明“策略允许 ≠ 用户授权”。
5. **Canvas 继承/覆盖图**：顶层 → A → B 与顶层 → S（头沙箱），
   边标签显示委托，节点显示每个特性的生效结果；可切换“运行时实测 / 静态模拟”数据源。
6. **生效策略矩阵**：每格同时展示模拟值与 `document.permissionsPolicy.allowsFeature()` 实测值，不一致给出 ⚠。
7. **实测控制台 + 页面内真实 iframe**：远程或框架内点击实际调用各 API，
   错误按 `SecurityError / NotAllowedError / PERMISSION_DENIED` 等归因（策略拒绝 / 用户拒绝 / 无设备 / 需手势）。
8. **Web Worker 面板**：Worker 环境特性检测 + Worker 内 Permissions API 查询（体现运行时差异）。
9. **IndexedDB 日志**：所有测试结果通过 Worker（或主线程降级）持久化。

## 双层门模型

子框架能用某特性，当且仅当：

1. 父框架**自身**被其容器策略（头或上层 allow）允许；并且
2. 父框架用自己的 `allow` 把特性**委托**给子框架来源。

`S` 沙箱父级始终以 `allow="*"` 委托，因此它的结果只取决于 SW 注入的顶层头，
便于直接观察“真实 HTTP 头”的效果，与 A/B 的“头 × allow 组合”对比。

## 降级策略

- 无 `document.permissionsPolicy` → 尝试旧版 `document.featurePolicy`；再不行以行为探测 + 静态模拟替代并标注。
- Permissions API 不支持某特性（如 fullscreen/autoplay 无查询项）→ 标注“无此权限项”，用 API 调用行为探测。
- Web Worker 不可用 → 语法校验与 IndexedDB 读写回退到主线程。
- Service Worker 不可用/非安全上下文 → 沙箱头无法真实注入，矩阵标注为模拟值并提示。
- 跨浏览器实现差异（错误名、Worker 内 API）在结果中原样展示 `name:message`。

## 文件

- `index.html` / `sandbox.html` / `frame.html`
- `js/policy.js`：头与 allow 属性解析器、静态继承模拟器（Worker/主线程共用）
- `js/probe.js`：特性检测、策略读取、Permissions API、五类 API 实际调用
- `js/app.js`：顶层 UI、Canvas、iframe 树编排
- `js/frame.js` / `js/sandbox.js`：框架内页面
- `js/worker.js`：后台校验 / 日志落库 / Worker 内权限查询
- `js/storage.js`：IndexedDB 封装
- `sw.js`：响应拦截与头注入
