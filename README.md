# PageGhost — 页面幽灵

> 无形采集，还原现场

一款浏览器侧**全量生产环境克隆工具**。在用户浏览器中隐身录制完整的运行环境数据，导出为加密快照，开发者本地一键还原页面现场——无需用户安装任何浏览器扩展，无需远程连接 DevTools。

## 解决什么问题

- **"帮我截个图"** → 截图丢失动态状态 → PageGhost 一键导出完整环境快照（DOM + 存储 + 网络 + 状态）
- **"你用的什么浏览器？"** → 来回沟通效率低 → 自动采集设备指纹、屏幕、GPU、网络等
- **无法复现用户的 API 响应** → 录制全部 Fetch / XHR 请求和响应体（Base64）
- **Console 报错用户看不懂** → 自动捕获所有 log / warn / error / 未捕获异常
- **让用户导出 localStorage 太难** → 一键采集 localStorage、sessionStorage、Cookie、IndexedDB
- **问题在手机上才出现** → 内置移动端调试面板，无需连接电脑

## 工作流程

```
[用户浏览器]
     │
     ├── 注入 env_dump.js（或控制台粘贴一行加载器）
     ├── 连续快速点击 15 次 → 开始录制 ⏺
     ├── 用户正常操作（网络/Console/WS 只录制此时段）
     ├── 再次连续快速点击 15 次 → 弹出密码框
     │   ├── 输入密码 → 导出加密 .pghost 文件
     │   └── 留空确定 → 导出明文 .json 文件
     │
     └── 也可通过 JS 控制：
         window.__ENV_DUMP__.start() / .stop()

snapshot.json / snapshot.pghost
     │
     ├──→ mount_env.py → 本地 HTTP Server → 浏览器还原完整现场
     │    （DOM + 状态注入 + Network Replay + 静态资源代理）
     │
     └──→ crawler.py（可选：离线爬取静态资源）
```

## 核心功能

### 环境采集 (env_dump.js)

**录制控制：**
- 连续快速点击 15 次（间隔 < 500ms）开始录制，右下角出现红色 REC 指示器
- 再次连续点击 15 次结束录制，弹出密码输入框
- JS API：`window.__ENV_DUMP__.start()` / `.stop()`
- 纯被动监听，不影响页面原有交互

**采集内容：**
- **网络流量** — Fetch / XHR 请求和响应（URL、method、请求头、请求体、响应头、响应体 Base64、耗时）
- **WebSocket** — 收发消息内容、方向、时间戳
- **Console 日志** — log / warn / error / info / debug + window.onerror + unhandledrejection
- **浏览器存储** — localStorage、sessionStorage、Cookie（全量 Key-Value）
- **IndexedDB** — 完整数据 + 元数据（keyPath、autoIncrement、索引信息），Web Worker 异步导出不阻塞主线程
- **运行时状态** — `__INITIAL_STATE__` / `__APP_STATE__` / `__NUXT__` / `__NEXT_DATA__` / `history.state`
- **环境指纹** — 屏幕分辨率、DPR、GPU、时区、语言、平台、暗色模式、减弱动画、CPU 核心数、设备内存、网络状况
- **页面状态** — 完整 DOM outerHTML、所有表单控件值、CSS 自定义变量、滚动位置、焦点元素、文本选区
- **样式表** — 同源 cssRules 直读，跨域 fetch 获取
- **其他** — Service Worker（scope/scriptURL/state）、Permissions API

**导出机制：**
- **明文导出（留空）** — 全同步导出 `.json`，零 await，确保在用户手势调用栈内（兼容 Safari）
- **加密导出（设密码）** — AES-256-GCM 加密后导出 `.pghost`，格式：PGHOST 魔数 + PBKDF2 盐值 + IV + 密文
- 异步数据（IndexedDB / ServiceWorker / Permissions）在录制期间每 3 秒预缓存，导出时直接读取
- Response body 超过 5MB 跳过 Base64 编码，只记录大小

### 快照加密

导出时弹出密码输入框：
- **输入密码** → AES-256-GCM 加密，PBKDF2 派生密钥（100000 次迭代），导出 `.pghost` 二进制文件
- **留空确定** → 导出明文 `.json`（和传统方式一样）
- 没有密码无法打开 `.pghost` 文件，保护用户的 Cookie、Token、API 响应等敏感数据

### 内置调试面板 (DevPanel)

独立模块，与录制逻辑零耦合，通过 `window.__ENV_DUMP__` 只读接口读取数据。

**打开方式：**
- 移动端：三指长按 3 秒
- 桌面端：Ctrl + Shift + D
- JS API：`window.__PG_DEV__.toggle()`

**功能 Tab：**
- **Console** — 实时显示所有日志，按级别过滤 + 关键词搜索，底部 JS 输入框可执行代码，错误计数 Badge
- **Elements** — 点击页面任意元素审查标签、盒模型、计算样式，面包屑导航，方向键遍历 DOM
- **DOM** — DOM 树可视化浏览
- **Network** — 实时显示 Fetch/XHR 请求（始终采集，不依赖录制），点击展开详情，类型过滤
- **Storage** — 查看 localStorage / sessionStorage / Cookies / IndexedDB，支持编辑删除

### 环境还原 (mount_env.py)

不依赖 Playwright，不需要原站在线。直接启动本地 HTTP 服务器，浏览器打开即还原。

**还原流程：**
1. 读取快照文件（`.pghost` 自动检测并解密，`.json` 直接读取）
2. 清理 DOM（移除录制脚本和指示器）
3. 内联外部 CSS / JS 资源（自动转义 HTML 标签防止结构破坏）
4. 注入还原脚本到 `<head>` 最前面（先于页面原始 JS 执行）：
   - 写入 localStorage / sessionStorage
   - 设置全局状态变量
   - 注入 CSS 自定义变量、还原 history.state
   - 拦截 fetch / XHR → 匹配 URL 后返回录制的响应（Network Replay）
   - 创建 IndexedDB schema + 写入数据
   - DOMContentLoaded 后还原表单、滚动位置、焦点
5. 注入调试面板到 `<body>` 开头
6. 静态资源（图片、字体等）自动代理到原始服务器
7. Console 打印所有网络请求/响应详细日志
8. 启动本地 HTTP Server，自动打开浏览器

**Network Replay：**
- 浏览器端拦截 fetch 和 XHR，匹配录制 URL 后直接返回录制的 response
- 无需额外代理服务器
- 模拟原始延迟（上限 3s）
- 未录制的请求正常放行

### 静态资源爬取 (crawler.py)

可选工具，用于离线补全还原页面的静态资源（还原时已自动代理到原站，通常不需要手动跑）。

- 支持标签：link / script / img / video / audio / source / object / embed / meta(og:image)
- 支持 srcset 属性解析、CSS url() 和 @import 递归提取
- 保留目录结构，输出 _manifest.json 资源清单

## 快速使用

### 部署采集脚本

**方式一：页面引入**

```html
<script src="env_dump.min.js"></script>
```

**方式二：控制台一行加载（运营/测试人员推荐）**

```js
fetch('https://raw.githubusercontent.com/li96112/PageGhost/main/scripts/pg_console.min.js').then(r=>r.text()).then(eval)
```

打开 F12 控制台 → 粘贴上面一行 → 回车 → 开始点击录制。

### 录制与导出

1. 在页面上连续快速点击 15 次 → 右下角出现红色 REC 指示器
2. 正常操作复现 bug
3. 再次连续快速点击 15 次 → 弹出密码输入框
4. 输入密码导出加密 `.pghost` / 留空导出明文 `.json`

### 还原快照

```bash
# 明文快照
python3 mount_env.py --import snapshot.json

# 加密快照（交互输入密码）
python3 mount_env.py --import snapshot.pghost

# 加密快照（命令行传密码，适合 CI/Agent）
python3 mount_env.py --import snapshot.pghost --password <密码>

# 指定端口
python3 mount_env.py --import snapshot.json --port 9090

# 附带离线静态资源
python3 mount_env.py --import snapshot.json --assets ./crawled_assets

# 不自动打开浏览器
python3 mount_env.py --import snapshot.json --no-open
```

## 通过 OpenClaw 对话使用

PageGhost 是一个 [OpenClaw](https://github.com/anthropics/openclaw) 技能，安装后可以直接用自然语言和 AI Agent 对话完成所有操作，无需记命令。

### 安装

将 PageGhost 目录放入 OpenClaw 的技能目录，Agent 会自动识别 `SKILL.md` 并加载。

### 对话示例

**还原快照：**
```
用户：帮我还原这个用户快照
     [拖入 env_snapshot_20260405.json]

Agent：→ 自动执行 mount_env.py，打开浏览器还原页面
```

**加密快照：**
```
用户：还原这个快照
     [拖入 snapshot.pghost]

Agent：这是加密的 .pghost 文件，请提供密码。

用户：密码是 abc123

Agent：→ 解密并还原，打开浏览器
```

**分析快照：**
```
用户：这个快照里有什么报错？
     [拖入 snapshot.json]

Agent：→ 解析 consoleLogs，列出所有 error/uncaught 错误及上下文

用户：看看有哪些 API 请求失败了

Agent：→ 分析 networkReplay，列出 status >= 400 和 error 的请求
```

**部署采集脚本：**
```
用户：我想在我的网站上部署 PageGhost

Agent：→ 提供引入方式和控制台加载代码，说明录制操作流程
```

**页面样式缺失时：**
```
用户：还原出来样式不对

Agent：→ 自动运行 crawler.py 爬取静态资源，再用 --assets 重新还原
```

### 触发关键词

Agent 在以下场景自动调用 PageGhost：

- 发送 `.json` 或 `.pghost` 快照文件
- 提到"还原环境"、"查看用户现场"、"PageGhost"
- "用户报了个 bug，这是他的快照"
- "帮我分析这个环境快照"

## 快照 JSON Schema (V3)

- **metadata** — url, userAgent, title, referrer, timestamp
- **recording** — startTime, endTime, durationMs
- **storage** — localStorage, sessionStorage, cookies
- **indexedDB** — {db}.{store}.meta (keyPath/autoIncrement/indexes), {db}.{store}.records
- **runtime** — initialState, appState, nuxtData, nextData, historyState
- **fingerprint** — screen, viewport, touch, gpu, timezone, language, platform, connection, prefersColorScheme, prefersReducedMotion, hardwareConcurrency, deviceMemory
- **interaction** — scroll, focus, selection
- **formState[]** — tagName, type, name, value, checked, selector
- **domSnapshot** — 完整 outerHTML
- **inlinedStyles[]** — href, css
- **cssVariables** — --var-name: value
- **networkReplay[]** — type, url, method, requestHeaders, requestBody, status, responseHeaders, body (Base64), latency
- **wsReplay[]** — url, messages (direction, data, ts)
- **consoleLogs[]** — level, message, ts
- **serviceWorkers[]** — scope, scriptURL, state
- **permissions** — geolocation, notifications, camera, microphone, clipboard

## 文件说明

```
PageGhost/
├── SKILL.md                      # OpenClaw 技能描述（Agent 调用指南）
├── README.md                     # 本文件
├── scripts/
│   ├── env_dump.js               # 采集脚本源码（含 DevPanel 调试面板）
│   ├── env_dump.min.js           # 采集脚本压缩版（含 DevPanel）
│   ├── pg_console.min.js         # 控制台粘贴版（纯录制+导出，无 DevPanel，16KB）
│   ├── mount_env.py              # 快照还原服务器（支持 .json 和 .pghost）
│   ├── crawler.py                # 静态资源离线爬取
│   └── test_cloner.py            # 测试脚本
└── knowledge/                    # Agent 知识库
```

## 已知限制

- **httpOnly Cookie 无法采集** — document.cookie 不可读 httpOnly → 需浏览器扩展或 DevTools Protocol
- **Service Worker 缓存内容无法导出** — Cache API 需在 SW 上下文中调用
- **WebSocket 二进制消息仅标记 [binary]** — 二进制序列化复杂度高
- **Response body 过大时 JSON 膨胀** — Base64 编码 33% 膨胀 → 可选 gzip 压缩快照
- **indexedDB.databases() 兼容性** — Firefox < 126 不支持
- **跨域 iframe 内容无法采集** — 浏览器同源策略限制
- **加密 API 响应无法自动解密** — 解密逻辑在应用代码中
- **Flutter Web (CanvasKit) UI 层无效** — 整个页面是 canvas → 网络层和存储层仍可用

## 测试

```bash
cd scripts
python3 test_cloner.py
```

覆盖：Schema 完整性、还原脚本生成、HTML 注入、信息栏生成、本地服务器、表单状态、Crawler 解析、CSS url() 提取、空 DOM 回退。
