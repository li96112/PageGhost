# PageGhost 更新日志

## v1.0.0 — 2026-04-04

### 首次发布

PageGhost（页面幽灵）—— 浏览器侧隐身环境采集 + 本地一键还原调试工具。

---

### 核心功能

**采集端 `env_dump.js`**
- 连续快速点击 15 次开始/结束录制，完全隐身不影响页面交互
- JS API：`window.__ENV_DUMP__.start()` / `.stop()`
- 采集内容覆盖：DOM 快照、Fetch/XHR 拦截（含 request body）、WebSocket 消息、Console 日志、localStorage/sessionStorage/Cookies、IndexedDB（含 schema 元数据）、表单状态、CSS 变量、设备指纹、权限状态、Service Worker
- 全同步导出机制，零 await 确保在用户手势调用栈内完成下载
- 异步数据（IndexedDB / SW / Permissions）录制期间每 3 秒预缓存
- Response body 超 5MB 自动跳过 Base64，只记录大小
- CSS.escape polyfill 兼容低版本浏览器/WebView

**内置调试面板 DevPanel**
- 三指长按 3 秒（手机）/ Ctrl+Shift+D（桌面）唤起
- **Console Tab**：实时日志流，按级别过滤 + 关键词搜索，底部 JS 执行输入框（支持上下箭头历史），错误计数 badge
- **Elements Tab**：点击审查任意元素，盒模型 + 计算样式，面包屑 DOM 层级导航，方向键遍历父/子/兄弟节点
- **Network Tab**：实时 Fetch/XHR 请求列表（不依赖录制），点击展开详情，All/Errors/XHR/Fetch 过滤
- **Storage Tab**：查看/编辑/删除 localStorage / sessionStorage / Cookies
- 面板高度可拖拽调整，刷新后自动恢复面板状态

**还原端 `mount_env.py`**
- 零依赖，纯 Python 启动本地 HTTP Server
- 不需要原站在线，不需要 Playwright
- 浏览器端 fetch/XHR hook 实现 Network Replay，匹配录制 URL 返回录制响应
- 自动注入还原脚本：Storage 写入、全局状态设置、CSS 变量、history.state、IndexedDB schema + records
- DOMContentLoaded 后还原表单、滚动位置、焦点
- Console 自动打印所有录制的 API 请求/响应详情
- 页面顶部环境信息栏（原始 URL、屏幕、错误数等）

**静态资源爬取 `crawler.py`**
- 支持 link/script/img/video/audio/source/object/embed/meta(og:image)
- 支持 srcset、CSS url()、@import 递归提取、inline style url()
- 保留域名+路径目录结构，输出 `_manifest.json` 资源清单

**测试 `test_cloner.py`**
- 覆盖 Schema 完整性、还原脚本生成、HTML 注入、信息栏生成、本地服务器、表单状态、Crawler 解析、CSS url() 提取、空 DOM 回退

---

### v1.0.1 — 2026-04-05

**UC/夸克/QQ 浏览器兼容性修复**
- Console 拦截重写为 ES5 闭包语法（`for` + IIFE 替代 `forEach` + 箭头函数），修复 UC 等低版本引擎报错
- 增加 `try/catch` 保护：采集失败不影响原始 console 调用
- 原始方法调用前增加 `typeof` 检查，防止被覆盖为非函数时崩溃
- 定时重绑逻辑同步改为 `for` 循环

**DevPanel 搜索简化**
- Console Tab 和 Network Tab 的搜索输入去掉 debounce + 手动 DOM 操作，统一走 `_renderTab()` 重绘，消除搜索结果不一致的问题
