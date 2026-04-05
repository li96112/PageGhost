---
name: pageghost
description: Browser-side stealth environment recording — captures DOM, storage, network traffic, console logs, and device fingerprint into a JSON snapshot. Restore the full page locally with network replay.
metadata: {"openclaw":{"emoji":"👻","requires":{"bins":["python3"]},"homepage":"https://github.com/li96112/PageGhost"}}
---

# PageGhost — 页面幽灵

> 无形采集，还原现场

浏览器侧隐身录制用户环境 → 导出 JSON 或加密 .pghost → 本地一键还原页面 + 调试面板。

## Agent 调用方式

当用户提供了 `env_snapshot_*.json` 或 `env_snapshot_*.pghost` 文件，或提到"还原环境"、"查看用户现场"、"PageGhost"时，按以下步骤执行：

**重要：`.pghost` 文件是 AES-256-GCM 加密的快照，必须先向用户询问密码才能解密还原。**

```bash
# 1. 还原页面
# .json 明文快照直接还原：
python3 {baseDir}/scripts/mount_env.py --import <快照文件路径>
# .pghost 加密快照需要密码（先向用户询问密码，再通过 --password 传入）：
python3 {baseDir}/scripts/mount_env.py --import <快照文件路径> --password <用户提供的密码>

# 2. 如果页面样式缺失，先爬取静态资源再还原
python3 {baseDir}/scripts/crawler.py --snapshot <快照文件路径> --output /tmp/pageghost_assets
python3 {baseDir}/scripts/mount_env.py --import <快照文件路径> --assets /tmp/pageghost_assets

# 3. 只分析快照数据（不还原页面）— 仅支持 .json 明文快照
python3 -c "
import json
with open('<snapshot.json路径>') as f:
    data = json.load(f)
# 查看错误
for e in data.get('consoleLogs', []):
    if e['level'] in ('error', 'uncaught'):
        print(f'[{e[\"level\"]}] {e[\"message\"]}')
# 查看 API
for e in data.get('networkReplay', []):
    print(f'{e.get(\"method\",\"GET\")} {e[\"url\"]} -> {e.get(\"status\",\"FAIL\")}')
"
```

### 触发关键词
- 用户发送 `.json` 或 `.pghost` 快照文件
- "还原用户环境" / "看看用户现场" / "PageGhost"
- "用户报了个 bug，这是他的快照"
- "帮我分析这个环境快照"
- 收到 `.pghost` 文件时，**必须先问用户密码**

### 部署采集脚本
当用户需要在自己的网页上部署采集脚本时，告知：
- 将 `scripts/env_dump.js` 引入到页面 `<head>` 中
- 用户连续快速点击 15 次开始录制，再 15 次结束，弹出密码框后导出
- 设密码 → 导出加密 `.pghost`；留空 → 导出明文 `.json`
- 脚本完全隐身，不影响页面任何交互
- 也可通过控制台一行加载：`fetch('https://raw.githubusercontent.com/li96112/PageGhost/main/scripts/pg_console.min.js').then(r=>r.text()).then(eval)`

## 架构总览

```
[用户浏览器]
     |
     |-- 连续快速点击 15 次 (间隔<500ms) --> 开始录制 ⏺
     |-- 用户正常操作...（网络/Console/WS 只录制此段）
     |-- 再次连续快速点击 15 次 --> 弹出密码框 --> 导出 .pghost(加密) 或 .json(明文)
     |-- 刷新页面 = 重置录制状态，需重新点击 15 次开始
     |
     也可通过 JS：window.__ENV_DUMP__.start() / .stop()

snapshot.json / snapshot.pghost
     |
     +---> mount_env.py --启动本地 HTTP Server--> http://localhost:8080
     |     (DOM + 状态注入 + Network Replay 浏览器端拦截 + 请求/响应日志)
     |
     +---> crawler.py (可选：离线爬取静态资源)
```

## 快照 JSON Schema (V3)

| 分类 | 字段 | 说明 |
|------|------|------|
| **元数据** | `metadata.url` | 完整 URL（含 Query Params） |
| | `metadata.userAgent` | User-Agent |
| | `metadata.title` | 页面标题 |
| | `metadata.referrer` | 来源页 |
| | `metadata.timestamp` | 采集时间 |
| **录制信息** | `recording.startTime` | 录制开始时间 |
| | `recording.endTime` | 录制结束时间 |
| | `recording.durationMs` | 录制时长（毫秒） |
| **浏览器存储** | `storage.localStorage` | 全量 Key-Value |
| | `storage.sessionStorage` | 全量 Key-Value |
| | `storage.cookies` | Cookie 字符串 |
| **IndexedDB** | `indexedDB.{db}.{store}.meta` | keyPath / autoIncrement / indexes |
| | `indexedDB.{db}.{store}.records` | 全量数据记录 |
| **运行时状态** | `runtime.initialState` | `window.__INITIAL_STATE__` |
| | `runtime.appState` | `window.__APP_STATE__` |
| | `runtime.nuxtData` | `window.__NUXT__`（Nuxt.js） |
| | `runtime.nextData` | `window.__NEXT_DATA__`（Next.js） |
| | `runtime.historyState` | `history.state` |
| **环境指纹** | `fingerprint.screen` | 分辨率 / DPR / colorDepth |
| | `fingerprint.viewport` | innerWidth / innerHeight |
| | `fingerprint.touch` | 触屏支持 + maxTouchPoints |
| | `fingerprint.gpu` | WebGL 渲染器字符串 |
| | `fingerprint.timezone` | IANA 时区 |
| | `fingerprint.language` | navigator.language + languages |
| | `fingerprint.platform` | navigator.platform |
| | `fingerprint.connection` | effectiveType / downlink / rtt |
| | `fingerprint.prefersColorScheme` | dark / light |
| | `fingerprint.prefersReducedMotion` | 减弱动画偏好 |
| | `fingerprint.hardwareConcurrency` | CPU 核心数 |
| | `fingerprint.deviceMemory` | 设备内存 |
| **交互状态** | `interaction.scroll` | scrollX / scrollY |
| | `interaction.focus` | CSS 选择器 |
| | `interaction.selection` | 当前文本选区 |
| **表单状态** | `formState[]` | 每个 input/textarea/select 的值、选中状态 |
| **DOM 快照** | `domSnapshot` | `document.documentElement.outerHTML` |
| **CSS 变量** | `cssVariables` | 所有 `--*` 自定义属性 |
| **网络录制** | `networkReplay[]` | Fetch + XHR：URL / method / requestHeaders / **requestBody** / status / responseHeaders / body(Base64) / latency |
| **WebSocket** | `wsReplay[]` | 每条连接的收发消息时序 |
| **Console 日志** | `consoleLogs[]` | log / warn / error / uncaught / unhandledrejection |
| **Service Worker** | `serviceWorkers[]` | scope / scriptURL / state |
| **权限状态** | `permissions` | geolocation / notifications / camera / microphone / clipboard |

## 采集端 (`env_dump.js`)

### 录制控制
- **连续快速点击 15 次**（每两次间隔 < 500ms）：开始录制，页面右下角出现红色 REC 指示器
- **再次连续快速点击 15 次**：结束录制，弹出密码输入框
  - **输入密码** → 导出 AES-256-GCM 加密的 `.pghost` 文件（没密码打不开）
  - **留空确定** → 导出明文 `.json` 文件（和以前一样）
- **JS API**：`window.__ENV_DUMP__.start()` 开始 / `window.__ENV_DUMP__.stop()` 结束
- **刷新 = 重置**：刷新页面后录制状态清空，需重新点击 15 次开始新录制
- **隐身模式**：点击监听纯被动计数，不调用 `stopPropagation` / `preventDefault`，不影响页面任何原有点击事件
- **时间段录制**：网络流量、WebSocket、Console 日志只采集录制时间段内的数据

### 采集内容
- **Fetch 拦截**：request headers、**request body**、response status/headers、body（Base64）、latency
- **XHR 拦截**：同上，覆盖 XMLHttpRequest.open/send/setRequestHeader
- **Request Body 支持**：string / URLSearchParams / FormData（文件记录名称大小） / ArrayBuffer / Blob
- **WebSocket 拦截**：记录收发消息及方向、时间戳
- **Console 拦截**：log/warn/error/info/debug + window.onerror + unhandledrejection
- **Storage 采集**：安全遍历 Storage.key()
- **IndexedDB 导出**：含 keyPath / autoIncrement / indexes 元数据（录制期间每 3s 预缓存）
- **DOM 快照**：完整 outerHTML（导出时同步采集）
- **表单状态**：遍历所有 input/textarea/select，记录值和 CSS 选择器
- **CSS 变量**：遍历 `getComputedStyle(root)` 中的 `--*` 属性
- **Service Worker**：`getRegistrations()`（录制期间预缓存）
- **Permissions API**：查询主要权限状态（录制期间预缓存）
- **CSS.escape polyfill**：兼容不支持 CSS.escape 的浏览器 / WebView

### 导出机制
- **明文导出（留空）**：全同步导出 `.json`，从 snapshot 构建到 `a.click()` 零 await，确保在用户手势调用栈内
- **加密导出（设密码）**：异步 AES-256-GCM 加密后导出 `.pghost`，格式：`PGHOST` 魔数 + PBKDF2 盐值 + IV + 密文
- 异步数据（IndexedDB / ServiceWorker / Permissions）在录制期间每 3 秒预缓存，导出时直接读缓存
- 导出时自动排除 PageGhost 自身注入的 DOM 元素（DevPanel、指示器等）
- Response body 超过 5MB 跳过 Base64 编码，只记录大小

### 内置调试面板（DevPanel）
独立模块，和录制逻辑零耦合。通过 `window.__ENV_DUMP__` 只读接口读取数据。
- **三指长按 3 秒**：打开/关闭面板（手机）
- **Ctrl+Shift+D**：打开/关闭面板（桌面）
- **JS API**：`window.__PG_DEV__.toggle()`
- **Console Tab**：实时显示所有 log/warn/error/uncaught，支持按级别过滤和关键词搜索，底部 JS 输入框可执行代码（支持上下箭头历史），错误计数 badge
- **Elements Tab**：点击页面任意元素审查标签、盒模型、计算样式；面包屑导航显示 DOM 层级；上下左右按钮可遍历父/子/兄弟节点
- **Network Tab**：始终采集 Fetch/XHR 请求（不依赖录制），实时显示，点击展开详情；支持按 All/Errors/XHR/Fetch 过滤
- **Storage Tab**：查看 localStorage / sessionStorage / Cookies；支持 Edit/Delete 操作；长内容点击展开
- 面板高度可拖拽调整，刷新后自动恢复面板状态（开关、tab、高度）

## 还原端 (`mount_env.py`)

### 工作方式
不依赖 Playwright，不需要原站在线。直接启动本地 HTTP 服务器，浏览器打开即用。
自动识别 `.json`（明文）和 `.pghost`（加密）两种格式，加密文件会提示输入密码。

```
python3 {baseDir}/scripts/mount_env.py --import snapshot.json          # 明文快照
python3 {baseDir}/scripts/mount_env.py --import snapshot.pghost        # 加密快照（需输入密码）
python3 {baseDir}/scripts/mount_env.py --import snapshot.json --port 9090
python3 {baseDir}/scripts/mount_env.py --import snapshot.json --assets ./crawled_assets
python3 {baseDir}/scripts/mount_env.py --import snapshot.json --no-open
```

### 还原流程
```
1. 读取快照文件（.pghost 先解密为 JSON，.json 直接读取）
2. 从 domSnapshot 提取原始 HTML
3. 在 <head> 最前面注入还原脚本（在页面原始 JS 之前执行）：
   - localStorage / sessionStorage 写入
   - window.__INITIAL_STATE__ 等全局状态设置
   - CSS 自定义变量注入
   - history.state 还原
   - fetch / XHR 拦截 → 从内联的 networkReplay 数据直接返回录制响应
   - IndexedDB 创建 schema + 写入 records
   - DOMContentLoaded 后还原表单、滚动、焦点
4. 在 <body> 开头注入环境信息栏（显示原始 URL、屏幕、错误数等）
5. 在 Console 打印所有网络请求/响应日志（请求头、请求参数、响应头、响应内容）
6. 启动本地 HTTP Server（默认 8080 端口）
7. 自动打开浏览器
```

### Network Replay
- **浏览器端拦截**：fetch 和 XHR 在页面内直接被 hook，匹配录制 URL 后返回录制的 response
- 无需额外代理服务器
- 模拟原始延迟（上限 3s）
- 未录制的请求正常放行（可访问本地资源）

### 网络日志输出
还原页面打开后，在 Console (F12) 中自动打印所有录制的 API 请求/响应：
- 请求头（requestHeaders）
- 请求参数（requestBody）— JSON 自动展开，加密数据原样打印
- 响应头（responseHeaders）
- 响应内容（response body）— JSON 自动展开，加密数据原样打印
- 状态码 + 延迟

## 静态资源爬取 (`crawler.py`)

- 支持标签：link / script / img / video / audio / source / object / embed / meta(og:image)
- 支持 `srcset` 属性解析
- 支持 CSS `url()` 和 `@import` 递归提取
- 支持 inline style 中的 `url()` 提取
- 保留目录结构（domain/path），避免文件名冲突
- 输出 `_manifest.json` 资源清单
- 可从快照 JSON 读取 DOM（优先用快照中的 domSnapshot）
- 命令：`python3 {baseDir}/scripts/crawler.py --snapshot snapshot.json --output ./assets`

## 已知限制

| 限制 | 原因 | Workaround |
|------|------|------------|
| httpOnly Cookie 无法采集 | `document.cookie` 不可读 httpOnly | 需浏览器扩展或 DevTools Protocol 导出 |
| Service Worker 缓存内容无法导出 | Cache API 需在 SW 上下文中调用 | 可通过 SW 注册脚本 URL 重新注册 |
| WebSocket 二进制消息仅标记 `[binary]` | 二进制序列化复杂度高 | 后续可用 Base64 编码二进制帧 |
| Response body 过大时 JSON 膨胀 | Base64 编码有 33% 膨胀 | 可选压缩（gzip snapshot） |
| `indexedDB.databases()` 兼容性 | Firefox < 126 不支持 | 降级为手动指定 DB 名 |
| 跨域 iframe 内容无法采集 | 浏览器同源策略 | 需在 iframe 内独立注入脚本 |
| 加密 API 响应无法自动解密 | 解密逻辑在应用代码中，每个项目不同 | Console 日志打印加密原文供开发者分析 |
| Flutter Web (CanvasKit) UI 层无效 | 整个页面是 `<canvas>`，无真实 DOM | 网络层和存储层仍可用 |
| Flutter Mobile/Desktop 不支持 | 原生 App 无浏览器环境 | 需 Dart 版采集器 |

## 测试

```bash
cd {baseDir}/scripts
python3 test_cloner.py
```

覆盖：Schema 完整性、还原脚本生成、HTML 注入、信息栏生成、本地服务器、表单状态、Crawler 解析、CSS url() 提取、空 DOM 回退。
