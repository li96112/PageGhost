/**
 * env_dump.js - 全量生产环境克隆脚本 (V3)
 *
 * 采集范围：浏览器存储、运行时状态、环境指纹、交互状态、
 *           网络流量（Fetch + XHR + WebSocket）、DOM 快照、
 *           表单状态、Console 日志、CSS 变量等。
 *
 * 录制控制：
 *   - 页面内连续点击 15 次 → 开始录制（出现录制指示器）
 *   - 再次连续点击 15 次 → 结束录制并导出 JSON
 *   - 也可通过 JS 控制：window.__ENV_DUMP__.start() / stop()
 *   - 采集的网络流量只包含录制时间段内的请求
 */
(function () {
  'use strict';

  // 保存原始 API（在拦截之前）
  const _fetch = window.fetch;
  const _XHROpen = XMLHttpRequest.prototype.open;
  const _XHRSend = XMLHttpRequest.prototype.send;
  const _XHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const _WS = window.WebSocket;

  // ============================================================
  // 0. 录制状态控制
  // ============================================================
  let isRecording = false;
  let recordingStartTime = 0;
  let recordingEndTime = 0;

  // 录制期间的网络/WS/Console 缓存（导出快照用）
  const networkLog = [];
  const wsLog = [];
  const consoleLogs = [];

  // 始终采集的网络日志（供 DevPanel 显示，不依赖录制）
  const _devNetLog = [];
  const _devNetLogMax = 200;
  let _onDevNet = null; // 回调：新请求到达时通知面板

  function _pushDevNet(entry) {
    _devNetLog.push(entry);
    if (_devNetLog.length > _devNetLogMax) _devNetLog.shift();
    if (_onDevNet) _onDevNet(entry);
  }

  // 异步数据预缓存（录制期间持续更新，导出时直接用）
  let _cachedIDB = {};
  let _cachedSW = [];
  let _cachedPerms = {};
  let _cachedStyles = []; // 内联 CSS
  let _cacheTimer = null;

  function _startAsyncCache() {
    // 立即采一次，之后每 3 秒更新
    _refreshAsyncCache();
    _cacheTimer = setInterval(_refreshAsyncCache, 3000);
  }

  function _stopAsyncCache() {
    if (_cacheTimer) { clearInterval(_cacheTimer); _cacheTimer = null; }
    _terminateIDBWorker();
  }

  function _refreshAsyncCache() {
    dumpIndexedDB().then(d => { _cachedIDB = d; }).catch(() => {});
    dumpServiceWorkers().then(d => { _cachedSW = d; }).catch(() => {});
    dumpPermissions().then(d => { _cachedPerms = d; }).catch(() => {});
    _cacheStylesheets();
  }

  // 采集所有样式表内容（同源用 cssRules，跨域用 fetch）
  function _cacheStylesheets() {
    const results = [];
    const fetches = [];

    for (const sheet of document.styleSheets) {
      const href = sheet.href;
      // 内联 <style> 标签 — 已在 DOM 中，不需要额外采集
      if (!href) continue;

      // 同源样式表：直接读 cssRules
      try {
        if (sheet.cssRules) {
          const css = Array.from(sheet.cssRules).map(r => r.cssText).join('\n');
          results.push({ href, css });
          continue;
        }
      } catch (_) { /* 跨域，cssRules 不可读 */ }

      // 跨域样式表：用 fetch 获取
      const p = _fetch(href, { mode: 'cors', credentials: 'omit' })
        .then(r => r.ok ? r.text() : '')
        .then(css => { if (css) results.push({ href, css }); })
        .catch(() => {
          // cors 也失败，尝试 no-cors（拿不到内容但至少不报错）
          // no-cors 返回 opaque response，无法读取，跳过
        });
      fetches.push(p);
    }

    if (fetches.length > 0) {
      Promise.all(fetches).then(() => { _cachedStyles = results; });
    } else {
      _cachedStyles = results;
    }
  }

  function startRecording() {
    if (isRecording) return;
    isRecording = true;
    recordingStartTime = Date.now();

    // 清空之前的数据
    networkLog.length = 0;
    wsLog.length = 0;
    consoleLogs.length = 0;

    _startAsyncCache();
    _showIndicator('REC', '正在录制...');
    console.log('[env_dump] 录制开始 ⏺');
  }

  function stopRecordingAndExport() {
    if (!isRecording) return;
    isRecording = false;
    recordingEndTime = Date.now();
    _stopAsyncCache();

    console.log('[env_dump] 录制结束 ⏹ 时长: ' + ((recordingEndTime - recordingStartTime) / 1000).toFixed(1) + 's');

    // 弹出密码输入框（prompt 是同步的，不打断调用栈）
    var pwd = prompt('[PageGhost] 设置快照密码（留空则不加密）：');

    if (pwd) {
      // 有密码 → 异步加密后下载
      _showIndicator('⏳', '正在加密...');
      _buildAndEncryptSnapshot(pwd);
    } else {
      // 无密码 → 同步明文下载（兼容 Safari 用户手势）
      _dumpPlain();
    }
  }


  // 录制指示器 UI
  let _indicatorEl = null;
  function _showIndicator(label, text) {
    if (!_indicatorEl) {
      _indicatorEl = document.createElement('div');
      _indicatorEl.id = '__env_dump_indicator__';
      _indicatorEl.setAttribute('data-el-ignore', '1');
      Object.assign(_indicatorEl.style, {
        position: 'fixed', bottom: '16px', right: '16px', zIndex: '2147483647',
        background: 'rgba(0,0,0,0.85)', color: '#fff', padding: '8px 16px',
        borderRadius: '8px', fontFamily: '-apple-system,system-ui,sans-serif',
        fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)', transition: 'opacity 0.3s'
      });
      document.body.appendChild(_indicatorEl);
    }
    const dotColor = label === 'REC' ? '#ef4444' : '#22c55e';
    const pulse = label === 'REC' ? 'animation:_envPulse 1s infinite;' : '';
    _indicatorEl.innerHTML = `
      <span style="width:10px;height:10px;border-radius:50%;background:${dotColor};display:inline-block;${pulse}"></span>
      <span><b>${label}</b> ${text}</span>
    `;
    _indicatorEl.style.opacity = '1';

    // 注入动画
    if (!document.getElementById('__env_dump_style__')) {
      const style = document.createElement('style');
      style.id = '__env_dump_style__';
      style.textContent = '@keyframes _envPulse{0%,100%{opacity:1}50%{opacity:0.3}}';
      document.head.appendChild(style);
    }
  }

  function _hideIndicator() {
    if (_indicatorEl) {
      _indicatorEl.style.opacity = '0';
      setTimeout(() => { if (_indicatorEl) { _indicatorEl.remove(); _indicatorEl = null; } }, 500);
    }
  }

  // 暴露全局控制接口（供 dev_panel.js 读取数据）
  window.__ENV_DUMP__ = {
    start: startRecording,
    stop: stopRecordingAndExport,
    isRecording: () => isRecording,
    // 数据接口 — DevPanel 通过这些读取，不直接操作录制内部状态
    getLogs: () => _devLogs,
    getNetworkLog: () => _devNetLog,      // 始终采集的网络日志
    getRecordingNetLog: () => networkLog,  // 录制期间的网络日志（含完整 body）
    onLog: (fn) => { _onDevLog = fn; },
    offLog: () => { _onDevLog = null; },
    onNet: (fn) => { _onDevNet = fn; },
    offNet: () => { _onDevNet = null; }
  };

  // ============================================================
  // 1. 网络流量录制
  // ============================================================

  // --- 请求体序列化工具 ---
  async function _serializeRequestBody(body) {
    if (body === null || body === undefined) return null;
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) {
      // FormData 转为可序列化对象（文件只记录名称和大小）
      const obj = {};
      body.forEach((v, k) => {
        if (v instanceof File) {
          obj[k] = { _file: true, name: v.name, size: v.size, type: v.type };
        } else {
          obj[k] = v;
        }
      });
      return JSON.stringify(obj);
    }
    if (body instanceof ArrayBuffer) return _arrayBufferToBase64(body);
    if (body instanceof Blob) {
      try {
        const buf = await body.arrayBuffer();
        return _arrayBufferToBase64(buf);
      } catch (_) { return '[Blob]'; }
    }
    if (ArrayBuffer.isView(body)) return _arrayBufferToBase64(body.buffer);
    try { return JSON.stringify(body); } catch (_) { return String(body); }
  }

  // --- Fetch 拦截 ---
  const _inflightFetch = []; // 未完成的 fetch 请求

  window.fetch = async function (...args) {
    const reqInput = args[0];
    const reqInit = args[1] || {};
    const url = typeof reqInput === 'string' ? reqInput : (reqInput instanceof Request ? reqInput.url : String(reqInput));
    const method = reqInit.method || (reqInput instanceof Request ? reqInput.method : 'GET');
    const reqHeaders = {};
    try {
      const h = new Headers(reqInit.headers || (reqInput instanceof Request ? reqInput.headers : {}));
      h.forEach((v, k) => { reqHeaders[k] = v; });
    } catch (_) { /* ignore */ }

    // 提取请求体
    let reqBody = null;
    try {
      const rawBody = reqInit.body || (reqInput instanceof Request ? await reqInput.clone().text() : null);
      reqBody = await _serializeRequestBody(rawBody);
    } catch (_) { /* ignore */ }

    const _MAX_BODY = 5 * 1024 * 1024; // 5MB 上限，超过不录制 body
    const start = Date.now();
    _capturedFetchXhrUrls.add(url); // 标记，防止 Resource Timing 重复采集

    // 立即记录为 in-flight
    const inflightEntry = {
      type: 'fetch', url, method,
      requestHeaders: reqHeaders, requestBody: reqBody,
      status: 0, statusText: 'pending', latency: 0, body: null,
      ts: start, _inflight: true
    };
    _inflightFetch.push(inflightEntry);
    _pushDevNet(inflightEntry);

    try {
      const response = await _fetch.apply(this, args);
      // 完成，从 in-flight 移除
      const idx = _inflightFetch.indexOf(inflightEntry);
      if (idx !== -1) _inflightFetch.splice(idx, 1);
      try {
        const clone = response.clone();
        const buf = await clone.arrayBuffer();
        const resHeaders = {};
        response.headers.forEach((v, k) => { resHeaders[k] = v; });
        const bodyB64 = buf.byteLength <= _MAX_BODY
          ? _arrayBufferToBase64(buf)
          : '[body too large: ' + (buf.byteLength / 1024 / 1024).toFixed(1) + 'MB]';
        const entry = {
          type: 'fetch', url, method,
          requestHeaders: reqHeaders, requestBody: reqBody,
          status: response.status, statusText: response.statusText,
          redirected: response.redirected, finalUrl: response.url !== url ? response.url : undefined,
          responseHeaders: resHeaders, latency: Date.now() - start,
          body: bodyB64, ts: start
        };
        _pushDevNet(entry); // 始终采集
        if (isRecording) networkLog.push(entry);
      } catch (_rec) {
        const entry = {
          type: 'fetch', url, method,
          requestHeaders: reqHeaders, requestBody: reqBody,
          status: response.status, statusText: response.statusText,
          latency: Date.now() - start, body: null, ts: start
        };
        _pushDevNet(entry);
        if (isRecording) networkLog.push(entry);
      }
      return response;
    } catch (e) {
      const idx2 = _inflightFetch.indexOf(inflightEntry);
      if (idx2 !== -1) _inflightFetch.splice(idx2, 1);
      const entry = { type: 'fetch', url, method, requestBody: reqBody, error: e.toString(), latency: Date.now() - start, ts: start };
      _pushDevNet(entry);
      if (isRecording) networkLog.push(entry);
      throw e;
    }
  };

  // --- XMLHttpRequest 拦截 ---
  const _inflightXhr = []; // 未完成的 XHR 请求（导出时一并写入快照）

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._dump = { method, url, requestHeaders: {}, start: 0 };
    return _XHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this._dump) this._dump.requestHeaders[k] = v;
    return _XHRSetHeader.call(this, k, v);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this._dump) {
      this._dump.start = Date.now();
      _capturedFetchXhrUrls.add(new URL(this._dump.url, location.href).href); // 标记去重
      // 同步记录请求体（send 的参数）
      var reqBody = null;
      if (body !== null && body !== undefined) {
        if (typeof body === 'string') {
          reqBody = body;
        } else if (body instanceof FormData) {
          const obj = {};
          body.forEach((v, k) => {
            obj[k] = v instanceof File ? { _file: true, name: v.name, size: v.size, type: v.type } : v;
          });
          reqBody = JSON.stringify(obj);
        } else if (body instanceof ArrayBuffer) {
          reqBody = _arrayBufferToBase64(body);
        } else if (ArrayBuffer.isView(body)) {
          reqBody = _arrayBufferToBase64(body.buffer);
        } else if (body instanceof Blob) {
          reqBody = '[Blob:' + body.size + ']';
        } else {
          try { reqBody = String(body); } catch(_) {}
        }
      }
      this._dump.requestBody = reqBody;

      // 立即记录为 in-flight（导出时如果还没完成也会包含在快照中）
      var inflightEntry = {
        type: 'xhr', url: this._dump.url, method: this._dump.method,
        requestHeaders: this._dump.requestHeaders, requestBody: reqBody,
        status: 0, statusText: 'pending', latency: 0, body: null,
        ts: this._dump.start, _inflight: true
      };
      _inflightXhr.push(inflightEntry);
      this._dump._inflightRef = inflightEntry;
      _pushDevNet(inflightEntry);

      this.addEventListener('loadend', function () {
        // 从 in-flight 列表移除
        var idx = _inflightXhr.indexOf(this._dump._inflightRef);
        if (idx !== -1) _inflightXhr.splice(idx, 1);

        var _bodyB64 = null;
        try {
          if (this.response instanceof ArrayBuffer) {
            _bodyB64 = this.response.byteLength <= 5*1024*1024
              ? _arrayBufferToBase64(this.response)
              : '[body too large: ' + (this.response.byteLength/1024/1024).toFixed(1) + 'MB]';
          } else if (typeof this.responseText === 'string') {
            _bodyB64 = this.responseText.length <= 5*1024*1024
              ? btoa(encodeURIComponent(this.responseText).replace(/%([0-9A-F]{2})/g, function(_,p){ return String.fromCharCode(parseInt(p,16)); }))
              : '[body too large: ' + (this.responseText.length/1024/1024).toFixed(1) + 'MB]';
          }
        } catch(_) {}
        var entry = {
          type: 'xhr',
          url: this._dump.url,
          method: this._dump.method,
          requestHeaders: this._dump.requestHeaders,
          requestBody: this._dump.requestBody || null,
          status: this.status,
          statusText: this.statusText,
          responseHeaders: _parseXHRHeaders(this.getAllResponseHeaders()),
          latency: Date.now() - this._dump.start,
          body: _bodyB64,
          ts: this._dump.start
        };
        _pushDevNet(entry); // 始终采集
        if (isRecording) networkLog.push(entry);
      });

      // 监听上传进度（记录上传总大小，用于还原端模拟进度）
      if (this.upload) {
        var _xhrRef = this;
        this.upload.addEventListener('progress', function (e) {
          if (_xhrRef._dump._inflightRef) {
            _xhrRef._dump._inflightRef._uploadTotal = e.total;
            _xhrRef._dump._inflightRef._uploadLoaded = e.loaded;
          }
        });
      }
    }
    return _XHRSend.call(this, body);
  };

  function _parseXHRHeaders(raw) {
    const headers = {};
    if (!raw) return headers;
    raw.trim().split(/[\r\n]+/).forEach(line => {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    });
    return headers;
  }

  // --- 资源加载错误监听（捕获 img/script/link/video 的 404/403 等）---
  window.addEventListener('error', function (e) {
    var el = e.target || e.srcElement;
    if (!el || !el.tagName) return; // 非元素错误跳过
    var tag = el.tagName.toLowerCase();
    if (tag === 'img' || tag === 'script' || tag === 'link' || tag === 'video' || tag === 'audio' || tag === 'source' || tag === 'iframe') {
      var src = el.src || el.href || '';
      if (!src || src === 'about:blank') return;
      // 从 Resource Timing 中查找真实状态码（避免 HEAD 探测产生额外请求噪音）
      var status = 0;
      var statusText = 'load failed';
      try {
        var perfEntries = performance.getEntriesByName(src, 'resource');
        if (perfEntries.length > 0) {
          var last = perfEntries[perfEntries.length - 1];
          if (last.responseStatus) { status = last.responseStatus; statusText = status + ''; }
        }
      } catch (_pe) {}
      var entry = {
        type: 'resource-error', url: src, method: 'GET',
        initiatorType: tag, status: status, statusText: statusText,
        error: tag + ' load error (' + (status || 'blocked/failed') + ')',
        latency: 0, body: null, ts: Date.now()
      };
      _pushDevNet(entry);
      if (isRecording) networkLog.push(entry);
    }
  }, true); // capture phase，必须用 true 才能捕获资源错误

  // --- WebSocket 拦截 ---
  window.WebSocket = function (url, protocols) {
    const ws = protocols ? new _WS(url, protocols) : new _WS(url);
    const entry = { url, messages: [] };

    ws.addEventListener('message', (e) => {
      if (isRecording) {
        entry.messages.push({ direction: 'in', data: typeof e.data === 'string' ? e.data : '[binary]', ts: Date.now() });
      }
    });
    const _send = ws.send.bind(ws);
    ws.send = function (data) {
      if (isRecording) {
        entry.messages.push({ direction: 'out', data: typeof data === 'string' ? data : '[binary]', ts: Date.now() });
      }
      return _send(data);
    };

    // 连接关闭时：有消息则写入 wsLog，并从活跃列表移除
    ws.addEventListener('close', () => {
      if (entry.messages.length > 0) wsLog.push(entry);
      const idx = _activeWsEntries.indexOf(entry);
      if (idx !== -1) _activeWsEntries.splice(idx, 1);
    });
    _activeWsEntries.push(entry);

    return ws;
  };
  window.WebSocket.prototype = _WS.prototype;
  window.WebSocket.CONNECTING = _WS.CONNECTING;
  window.WebSocket.OPEN = _WS.OPEN;
  window.WebSocket.CLOSING = _WS.CLOSING;
  window.WebSocket.CLOSED = _WS.CLOSED;
  const _activeWsEntries = [];

  // --- sendBeacon 拦截 ---
  const _sendBeacon = navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null;
  if (_sendBeacon) {
    navigator.sendBeacon = function (url, data) {
      const entry = {
        type: 'beacon', url: new URL(url, location.href).href, method: 'POST',
        requestBody: data ? String(data).substring(0, 8192) : null,
        status: 0, statusText: 'beacon', latency: 0, body: null, ts: Date.now()
      };
      _pushDevNet(entry);
      if (isRecording) networkLog.push(entry);
      return _sendBeacon(url, data);
    };
  }

  // --- Resource Timing 采集（img/script/link/video 等 HTML 标签发起的请求）---
  const _capturedFetchXhrUrls = new Set(); // 用于去重，避免和 fetch/XHR 重复
  const _seenResourceUrls = new Set();    // resource 类型 URL 去重
  const _origPushDevNet = _pushDevNet;

  // 包装 _pushDevNet，记录 fetch/xhr 的 URL 用于去重
  // (不能直接覆盖 _pushDevNet 因为是 function，改为在 entry 层面标记)
  const _resourceLog = [];

  function _processResourceEntry(entry) {
    var url = entry.name;
    // 跳过 data: / blob: / about: / 心跳等
    if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.indexOf('__heartbeat__') !== -1) return;
    // 跳过已被 fetch/XHR 捕获的（通过 URL 匹配）
    if (_capturedFetchXhrUrls.has(url)) return;
    // 同一 URL 只记录一次（去重，避免 Google Translate/Fonts 等轮询请求刷屏）
    if (_seenResourceUrls.has(url)) return;
    _seenResourceUrls.add(url);

    var resEntry = {
      type: 'resource',
      url: url,
      method: 'GET',
      initiatorType: entry.initiatorType || 'other',
      status: entry.responseStatus || 0,  // Chrome 109+
      transferSize: entry.transferSize || 0,
      encodedBodySize: entry.encodedBodySize || 0,
      decodedBodySize: entry.decodedBodySize || 0,
      duration: Math.round(entry.duration),
      latency: Math.round(entry.responseEnd - entry.requestStart) || Math.round(entry.duration),
      body: null,
      ts: Math.round(entry.startTime + performance.timeOrigin)
    };
    _resourceLog.push(resEntry);
    _pushDevNet(resEntry);
    if (isRecording) networkLog.push(resEntry);
  }

  // 监听新增资源
  try {
    var _resObserver = new PerformanceObserver(function (list) {
      list.getEntries().forEach(_processResourceEntry);
    });
    _resObserver.observe({ type: 'resource', buffered: true });
  } catch (_poErr) {
    // fallback: 在 _buildSnapshot 时一次性采集
  }

  // 在原始 _pushDevNet 调用时标记 URL（用于去重）
  var _origPushDevNet2 = _pushDevNet;
  // 我们不能覆盖 const，改为在 fetch/xhr entry 创建时标记
  // → 在 fetch 拦截和 XHR 拦截中加标记

  // ============================================================
  // 2. Console 日志采集（始终采集供 DevPanel 使用，录制期间同时写入 consoleLogs）
  // ============================================================
  const _devLogs = []; // 始终采集，供内置控制台显示
  const _devLogsMax = 500; // 最多保留条数
  let _onDevLog = null; // 回调：新日志到达时通知面板刷新

  function _pushDevLog(entry) {
    _devLogs.push(entry);
    if (_devLogs.length > _devLogsMax) _devLogs.shift();
    if (_onDevLog) _onDevLog(entry);
  }

  function _safeStringify(obj) {
    const seen = new WeakSet();
    return JSON.stringify(obj, function (_key, val) {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
  }

  const _origConsole = {};
  const _wrappedConsole = {};
  const _levels = ['log', 'warn', 'error', 'info', 'debug'];
  for (let li = 0; li < _levels.length; li++) {
    (function(level) {
      _origConsole[level] = console[level];
      _wrappedConsole[level] = function () {
        try {
          var args = [];
          for (var ai = 0; ai < arguments.length; ai++) args.push(arguments[ai]);
          var msg = args.map(function(a) {
            try { return typeof a === 'object' && a !== null ? _safeStringify(a) : String(a); }
            catch (_e) { return String(a); }
          }).join(' ');
          var entry = { level: level, message: msg, ts: Date.now() };
          _pushDevLog(entry);
          if (isRecording) consoleLogs.push(entry);
        } catch (_e2) { /* 采集失败不影响原始调用 */ }
        if (typeof _origConsole[level] === 'function') {
          return _origConsole[level].apply(console, arguments);
        }
      };
      console[level] = _wrappedConsole[level];
    })(_levels[li]);
  }

  // UC/夸克/QQ浏览器可能在脚本加载后覆盖 console 方法，定时检查并重新绑定
  setInterval(function () {
    for (var ri = 0; ri < _levels.length; ri++) {
      var lv = _levels[ri];
      if (console[lv] !== _wrappedConsole[lv]) {
        _origConsole[lv] = console[lv];
        console[lv] = _wrappedConsole[lv];
      }
    }
  }, 2000);

  // --- 未捕获异常（双保险：onerror 兼容性更好，addEventListener 能拿到 ErrorEvent） ---
  let _lastErrKey = '';
  function _pushError(level, msg, ts) {
    // 去重：同一毫秒的相同消息只记一次（onerror 和 addEventListener 可能同时触发）
    var key = ts + '|' + msg.slice(0, 80);
    if (key === _lastErrKey) return;
    _lastErrKey = key;
    var entry = { level: level, message: msg, ts: ts };
    _pushDevLog(entry);
    if (isRecording) consoleLogs.push(entry);
  }

  window.onerror = function (msg, src, line, col, err) {
    var m = String(msg || 'Unknown error');
    if (src) m += '\n  at ' + src + (line ? ':' + line : '') + (col ? ':' + col : '');
    if (err && err.stack) m += '\n' + err.stack;
    _pushError('uncaught', m, Date.now());
  };

  window.addEventListener('error', (e) => {
    var m = e.message || (e.error ? String(e.error) : 'Error');
    if (e.filename) m += '\n  at ' + e.filename + (e.lineno ? ':' + e.lineno : '') + (e.colno ? ':' + e.colno : '');
    if (e.error && e.error.stack) m += '\n' + e.error.stack;
    _pushError('uncaught', m, Date.now());
  });

  window.addEventListener('unhandledrejection', (e) => {
    var reason = e.reason;
    var m;
    if (reason instanceof Error) {
      m = reason.message + (reason.stack ? '\n' + reason.stack : '');
    } else if (typeof reason === 'object' && reason !== null) {
      try { m = _safeStringify(reason); } catch(_) { m = String(reason); }
    } else {
      m = String(reason);
    }
    _pushError('unhandledrejection', m, Date.now());
  });

  // ============================================================
  // 3. 工具函数
  // ============================================================
  function _arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  // 导出 DOM 时临时移除 PageGhost 注入的元素
  function _captureCleanDOM() {
    const pgIds = ['__pg_panel__', '__pg_panel_style__', '__pg_inspect_overlay__',
      '__pg_inspect_hint__', '__env_dump_indicator__', '__env_dump_style__', '__pg_fab__'];
    const removed = [];
    for (const id of pgIds) {
      const el = document.getElementById(id);
      if (el && el.parentNode) {
        removed.push({ el, parent: el.parentNode, next: el.nextSibling });
        el.remove();
      }
    }
    const html = document.documentElement.outerHTML;
    // 恢复
    for (const r of removed) {
      if (r.next) r.parent.insertBefore(r.el, r.next);
      else r.parent.appendChild(r.el);
    }
    return html;
  }

  function _getStorage(storage) {
    const result = {};
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      result[key] = storage.getItem(key);
    }
    return result;
  }

  // ============================================================
  // 4. DOM 快照 & 表单状态采集
  // ============================================================
  function _captureFormState() {
    const forms = [];
    document.querySelectorAll('input, textarea, select').forEach((el, idx) => {
      const entry = {
        index: idx, tagName: el.tagName, type: el.type || '',
        name: el.name || '', id: el.id || '', selector: _cssSelector(el)
      };
      if (el.tagName === 'SELECT') {
        entry.selectedIndex = el.selectedIndex;
        entry.value = el.value;
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        entry.checked = el.checked;
      } else {
        entry.value = el.value;
      }
      forms.push(entry);
    });
    return forms;
  }

  // CSS.escape polyfill（部分 WebView / 老浏览器不支持）
  const _esc = typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape
    : function(s) { return s.replace(/([^\w-])/g, '\\$1'); };

  function _cssSelector(el) {
    if (el.id) return '#' + _esc(el.id);
    const parts = [];
    while (el && el !== document.body && el !== document.documentElement) {
      let selector = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        selector += '.' + el.className.trim().split(/\s+/).map(c => _esc(c)).join('.');
      }
      const parent = el.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
        if (siblings.length > 1) {
          selector += ':nth-child(' + (Array.from(parent.children).indexOf(el) + 1) + ')';
        }
      }
      parts.unshift(selector);
      el = parent;
    }
    return parts.join(' > ');
  }

  function _captureCSSVariables() {
    const vars = {};
    const styles = getComputedStyle(document.documentElement);
    for (let i = 0; i < styles.length; i++) {
      const prop = styles[i];
      if (prop.startsWith('--')) {
        vars[prop] = styles.getPropertyValue(prop).trim();
      }
    }
    return vars;
  }

  // ============================================================
  // 5. IndexedDB 完整导出（Web Worker，避免阻塞主线程）
  // ============================================================
  // Worker 源码用字符串字面量，避免混淆器破坏 toString()
  const _IDB_WORKER_SRC = 'self.onmessage=async function(){try{var d={};if(typeof indexedDB==="undefined"){self.postMessage(d);return}if(typeof indexedDB.databases!=="function"){self.postMessage(d);return}var a=await indexedDB.databases();for(var i=0;i<a.length;i++){var n=a[i].name;d[n]=await new Promise(function(resolve){var r=indexedDB.open(n);r.onsuccess=function(e){var db=e.target.result,st={},sn=Array.from(db.objectStoreNames);if(sn.length===0){resolve(st);db.close();return}var done=0,tx=db.transaction(sn,"readonly");for(var s=0;s<sn.length;s++){var nm=sn[s],os=tx.objectStore(nm),m={keyPath:os.keyPath,autoIncrement:os.autoIncrement,indexes:[]};for(var j=0;j<os.indexNames.length;j++){var ix=os.index(os.indexNames[j]);m.indexes.push({name:ix.name,keyPath:ix.keyPath,unique:ix.unique,multiEntry:ix.multiEntry})}(function(k,mt){os.getAll().onsuccess=function(ev){st[k]={meta:mt,records:ev.target.result};if(++done===sn.length){resolve(st);db.close()}}})(nm,m)}};r.onerror=function(){resolve({})}})}self.postMessage(d)}catch(e){self.postMessage({})}}';

  let _idbWorker = null;
  let _idbWorkerBusy = false;

  function _initIDBWorker() {
    if (_idbWorker) return true;
    try {
      const blob = new Blob([_IDB_WORKER_SRC], { type: 'application/javascript' });
      _idbWorker = new Worker(URL.createObjectURL(blob));
      return true;
    } catch (_) {
      return false;
    }
  }

  function _terminateIDBWorker() {
    if (_idbWorker) { _idbWorker.terminate(); _idbWorker = null; _idbWorkerBusy = false; }
  }

  function dumpIndexedDB() {
    // 优先走 Worker，失败则回退主线程
    if (_initIDBWorker() && !_idbWorkerBusy) {
      _idbWorkerBusy = true;
      return new Promise(function (resolve) {
        const timer = setTimeout(function () {
          _idbWorkerBusy = false;
          resolve(_cachedIDB); // 超时返回上次缓存
        }, 5000);
        _idbWorker.onmessage = function (e) {
          clearTimeout(timer);
          _idbWorkerBusy = false;
          resolve(e.data || {});
        };
        _idbWorker.onerror = function () {
          clearTimeout(timer);
          _idbWorkerBusy = false;
          resolve(_cachedIDB);
        };
        _idbWorker.postMessage('dump');
      });
    }
    return _dumpIndexedDBMain();
  }

  // 主线程回退（Worker 不可用时）
  async function _dumpIndexedDBMain() {
    const dbData = {};
    if (!window.indexedDB) return dbData;
    if (typeof indexedDB.databases !== 'function') return dbData;

    const dbs = await indexedDB.databases();
    for (const dbInfo of dbs) {
      const dbName = dbInfo.name;
      dbData[dbName] = await new Promise((resolve) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = (e) => {
          const db = e.target.result;
          const stores = {};
          const storeNames = Array.from(db.objectStoreNames);
          if (storeNames.length === 0) { resolve(stores); db.close(); return; }

          let done = 0;
          const tx = db.transaction(storeNames, 'readonly');
          for (const sName of storeNames) {
            const store = tx.objectStore(sName);
            const meta = {
              keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: []
            };
            for (let j = 0; j < store.indexNames.length; j++) {
              const idx = store.index(store.indexNames[j]);
              meta.indexes.push({ name: idx.name, keyPath: idx.keyPath, unique: idx.unique, multiEntry: idx.multiEntry });
            }
            store.getAll().onsuccess = (ev) => {
              stores[sName] = { meta, records: ev.target.result };
              if (++done === storeNames.length) { resolve(stores); db.close(); }
            };
          }
        };
        req.onerror = () => resolve({});
      });
    }
    return dbData;
  }

  // ============================================================
  // 6. Service Worker 信息
  // ============================================================
  async function dumpServiceWorkers() {
    if (!('serviceWorker' in navigator)) return [];
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.map(r => ({
      scope: r.scope,
      scriptURL: r.active ? r.active.scriptURL : (r.installing ? r.installing.scriptURL : null),
      state: r.active ? r.active.state : 'none'
    }));
  }

  // ============================================================
  // 7. Permissions
  // ============================================================
  async function dumpPermissions() {
    const permNames = ['geolocation', 'notifications', 'camera', 'microphone', 'clipboard-read', 'clipboard-write'];
    const result = {};
    for (const name of permNames) {
      try {
        const status = await navigator.permissions.query({ name });
        result[name] = status.state;
      } catch (_) { result[name] = 'unsupported'; }
    }
    return result;
  }

  // ============================================================
  // 8. 快照构建 + 导出（明文 / 加密）
  // ============================================================

  function _buildSnapshot() {
    // 收集还在活跃的 WebSocket 连接
    for (const entry of _activeWsEntries) {
      if (entry.messages.length > 0 && !wsLog.includes(entry)) {
        wsLog.push(entry);
      }
    }

    return {
      version: 3,

      metadata: {
        timestamp: new Date().toISOString(),
        url: window.location.href,
        userAgent: navigator.userAgent,
        title: document.title,
        referrer: document.referrer
      },

      recording: {
        startTime: new Date(recordingStartTime).toISOString(),
        endTime: new Date(recordingEndTime || Date.now()).toISOString(),
        durationMs: (recordingEndTime || Date.now()) - recordingStartTime
      },

      storage: {
        localStorage: _getStorage(localStorage),
        sessionStorage: _getStorage(sessionStorage),
        cookies: document.cookie
      },

      indexedDB: _cachedIDB,

      runtime: {
        initialState: window.__INITIAL_STATE__ || null,
        appState: window.__APP_STATE__ || null,
        nuxtData: window.__NUXT__ || null,
        nextData: window.__NEXT_DATA__ || null,
        historyState: history.state
      },

      fingerprint: {
        screen: {
          width: screen.width, height: screen.height,
          availWidth: screen.availWidth, availHeight: screen.availHeight,
          dpr: window.devicePixelRatio, colorDepth: screen.colorDepth
        },
        viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
        touch: 'ontouchstart' in window,
        maxTouchPoints: navigator.maxTouchPoints || 0,
        gpu: (() => {
          try {
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl');
            const ext = gl ? gl.getExtension('WEBGL_debug_renderer_info') : null;
            return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
          } catch (_) { return 'unknown'; }
        })(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timezoneOffset: new Date().getTimezoneOffset(),
        language: navigator.language,
        languages: Array.from(navigator.languages || []),
        platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '',
        hardwareConcurrency: navigator.hardwareConcurrency || 0,
        deviceMemory: navigator.deviceMemory || 0,
        connection: navigator.connection ? {
          effectiveType: navigator.connection.effectiveType,
          downlink: navigator.connection.downlink,
          rtt: navigator.connection.rtt
        } : null,
        prefersColorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches
      },

      interaction: {
        scroll: { x: window.scrollX, y: window.scrollY },
        focus: document.activeElement ? _cssSelector(document.activeElement) : null,
        selection: (() => {
          const sel = window.getSelection();
          return sel && sel.toString() ? sel.toString() : null;
        })()
      },

      formState: _captureFormState(),
      domSnapshot: _captureCleanDOM(),
      inlinedStyles: _cachedStyles,
      cssVariables: _captureCSSVariables(),
      networkReplay: networkLog.concat(
        _inflightFetch.map(function(e) { e.statusText = 'in-flight'; e.latency = Date.now() - e.ts; delete e._inflight; return e; }),
        _inflightXhr.map(function(e) { e.statusText = 'in-flight'; e.latency = Date.now() - e.ts; delete e._inflight; return e; })
      ),
      wsReplay: wsLog,
      consoleLogs: consoleLogs,
      serviceWorkers: _cachedSW,
      permissions: _cachedPerms
    };
  }

  // 下载文件
  function _downloadFile(data, filename, mimeType) {
    const blob = new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
  }

  // 明文导出（同步，兼容 Safari 手势）
  function _dumpPlain() {
    try {
      const json = JSON.stringify(_buildSnapshot());
      const filename = 'env_snapshot_' + Date.now() + '.json';
      _downloadFile(json, filename, 'application/json');

      const sizeMB = (json.length / 1024 / 1024).toFixed(2);
      _showIndicator('✓', `已导出 ${filename} (${sizeMB} MB, ${networkLog.length} API)`);
      setTimeout(_hideIndicator, 5000);
      console.log(`[env_dump] 导出成功: ${filename} (${sizeMB} MB, ${networkLog.length} network, ${consoleLogs.length} console)`);
    } catch (e) {
      console.error('[env_dump] 导出失败:', e);
      _showIndicator('✗', '导出失败: ' + e.message);
      setTimeout(_hideIndicator, 8000);
    }
  }

  // 加密导出（异步，AES-256-GCM）
  // 文件格式: "PGHOST" (6B) + version (1B) + salt (16B) + iv (12B) + ciphertext
  async function _buildAndEncryptSnapshot(password) {
    try {
      const json = JSON.stringify(_buildSnapshot());
      const enc = new TextEncoder();

      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));

      // PBKDF2 派生密钥
      const keyMaterial = await crypto.subtle.importKey(
        'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
      );
      const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt']
      );

      // AES-GCM 加密
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv }, key, enc.encode(json)
      );

      // 拼接: PGHOST + 0x01 + salt(16) + iv(12) + ciphertext
      const magic = enc.encode('PGHOST');
      const version = new Uint8Array([1]);
      const result = new Uint8Array(6 + 1 + 16 + 12 + encrypted.byteLength);
      let off = 0;
      result.set(magic, off); off += 6;
      result.set(version, off); off += 1;
      result.set(salt, off); off += 16;
      result.set(iv, off); off += 12;
      result.set(new Uint8Array(encrypted), off);

      const filename = 'env_snapshot_' + Date.now() + '.pghost';
      _downloadFile(result, filename, 'application/octet-stream');

      const sizeMB = (result.byteLength / 1024 / 1024).toFixed(2);
      _showIndicator('🔒', `已加密导出 ${filename} (${sizeMB} MB)`);
      setTimeout(_hideIndicator, 5000);
      console.log(`[env_dump] 加密导出成功: ${filename} (${sizeMB} MB, ${networkLog.length} network, ${consoleLogs.length} console)`);
    } catch (e) {
      console.error('[env_dump] 加密导出失败:', e);
      _showIndicator('✗', '加密失败: ' + e.message);
      setTimeout(_hideIndicator, 8000);
    }
  }

  // ============================================================
  // 9. 触发器：连续快速点击 15 次（每两次间隔 < 300ms 才算连续）
  //    - 纯被动监听，不调用 stopPropagation / preventDefault
  //    - 不影响页面任何原有点击行为
  // ============================================================
  let clickCount = 0;
  let lastClickTime = 0;
  const MAX_INTERVAL = 500;
  const TRIGGER_COUNT = 15;

  document.addEventListener('click', (e) => {
    // 忽略面板内部的点击，避免操作面板时误触发录制
    const pg = document.getElementById('__pg_panel__');
    if (pg && pg.contains(e.target)) return;
    const now = Date.now();
    if (now - lastClickTime > MAX_INTERVAL) {
      clickCount = 1;
    } else {
      clickCount++;
    }
    lastClickTime = now;

    if (clickCount >= TRIGGER_COUNT) {
      clickCount = 0;
      lastClickTime = 0;
      if (!isRecording) {
        startRecording();
      } else {
        stopRecordingAndExport();
      }
    }
  }, true);

  // 提示用户
  console.log('[env_dump] 环境克隆脚本已加载。连续点击 15 次开始录制，再 15 次结束并导出。');
  console.log('[env_dump] 也可用 JS: window.__ENV_DUMP__.start() / .stop()');

})();


// ##################################################################
// DevPanel — 内置调试面板（独立模块，和录制逻辑零耦合）
// 通过 window.__ENV_DUMP__ 接口读取数据，不修改录制状态。
//
// 触发：三指长按 3 秒 / 桌面 Ctrl+Shift+D / window.__PG_DEV__.toggle()
// Tab：Console | Elements | DOM | Network | Storage
// ##################################################################
(function () {
  'use strict';

  // ---- 数据桥接：只读访问录制数据 ----
  function _api() { return window.__ENV_DUMP__ || {}; }
  function _getLogs() { return (_api().getLogs && _api().getLogs()) || []; }
  function _getNetworkLog() { return (_api().getNetworkLog && _api().getNetworkLog()) || []; }

  var _PG_STATE_KEY = '__pg_dev_state__';
  function _loadPanelState() {
    try { return JSON.parse(sessionStorage.getItem(_PG_STATE_KEY)) || {}; } catch(_) { return {}; }
  }
  function _savePanelState() {
    try {
      sessionStorage.setItem(_PG_STATE_KEY, JSON.stringify({
        visible: _visible, tab: _activeTab, height: _panel ? _panel.style.height : null
      }));
    } catch(_) {}
  }

  var _saved = _loadPanelState();
  var _visible = false;
  var _panel = null;
  var _activeTab = _saved.tab || 'console';
  var _savedHeight = _saved.height || null;
  var _inspectMode = false;
  var _inspectOverlay = null;
  var _inspectHint = null;
  var _cFilter = 'all';
  var _cSearch = '';
  var _errorCount = 0;
  var _miniFab = null; // 最小化时的浮动按钮

  function toggle() {
    if (_visible) {
      // 打开 → 最小化
      _visible = false;
      _destroy();
      _showMiniFab();
    } else if (_miniFab) {
      // 最小化 → 打开
      _hideMiniFab();
      _visible = true;
      _create();
    } else {
      // 完全关闭 → 打开
      _visible = true;
      _create();
    }
    _savePanelState();
  }

  function _showMiniFab() {
    if (_miniFab) return;
    _miniFab = document.createElement('div');
    _miniFab.id = '__pg_fab__';
    _miniFab.setAttribute('data-el-ignore', '1');
    Object.assign(_miniFab.style, {
      position: 'fixed', bottom: '16px', right: '16px', zIndex: '2147483646',
      width: '40px', height: '40px', borderRadius: '50%', background: '#007acc',
      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '18px', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,.4)',
      fontFamily: 'monospace', userSelect: 'none', webkitUserSelect: 'none'
    });
    _miniFab.textContent = '{ }';
    _miniFab.addEventListener('click', function() { toggle(); });
    document.body.appendChild(_miniFab);
  }

  function _hideMiniFab() {
    if (_miniFab) { _miniFab.remove(); _miniFab = null; }
  }

  // 三指长按完全关闭（包括浮动按钮）
  function fullClose() {
    _visible = false;
    _destroy();
    _hideMiniFab();
    _savePanelState();
  }

  // 自动恢复面板（刷新后保持打开）
  if (_saved.visible) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() { _visible = true; _create(); });
    } else { _visible = true; _create(); }
  }

  window.__PG_DEV__ = { toggle: toggle, close: fullClose };

  // ================================================================
  // 样式
  // ================================================================
  var CSS =
'#__pg_panel__{all:initial;position:fixed;left:0;right:0;bottom:0;height:55vh;z-index:2147483646;' +
'background:#1e1e1e !important;color:#d4d4d4 !important;font-family:"SF Mono",Monaco,Consolas,monospace;' +
'font-size:12px;display:flex;flex-direction:column;border-top:2px solid #007acc;line-height:1.4}' +
'#__pg_panel__ *{box-sizing:border-box;font-family:inherit;line-height:inherit}' +
'#__pg_panel__ div,#__pg_panel__ span,#__pg_panel__ pre,#__pg_panel__ p,#__pg_panel__ td,#__pg_panel__ th,#__pg_panel__ li{color:inherit}' +
'#__pg_tabs__{display:flex;background:#252526;border-bottom:1px solid #3c3c3c;flex-shrink:0}' +
'#__pg_tabs__ button{background:none;border:none;color:#888 !important;padding:8px 14px;font-size:12px;' +
'font-family:inherit;cursor:pointer;border-bottom:2px solid transparent}' +
'#__pg_tabs__ button.active{color:#fff !important;border-bottom-color:#007acc}' +
'#__pg_tabs__ button:last-child{margin-left:auto;color:#888 !important;font-size:16px;padding:8px 12px}' +
'#__pg_body__{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0}' +
'.__pg_row__{padding:4px 8px;border-bottom:1px solid #2d2d2d;word-break:break-all;white-space:pre-wrap}' +
'.__pg_row__.log{color:#d4d4d4 !important}.__pg_row__.info{color:#3dc9b0 !important}' +
'.__pg_row__.warn{color:#cca700 !important;background:rgba(204,167,0,.08) !important}' +
'.__pg_row__.error,.__pg_row__.uncaught,.__pg_row__.unhandledrejection{color:#f44747 !important;background:rgba(244,71,71,.08) !important}' +
'.__pg_row__.debug{color:#888 !important}.__pg_row__:active{background:#2a2d2e !important}' +
'.__pg_net_row__{padding:6px 8px;border-bottom:1px solid #2d2d2d}' +
'.__pg_net_row__ .url{color:#569cd6 !important;word-break:break-all}' +
'.__pg_net_row__ .method{color:#dcdcaa !important;margin-right:6px}' +
'.__pg_net_row__ .status{margin-left:6px}' +
'.__pg_net_row__ .status.ok{color:#4ec9b0 !important}.__pg_net_row__ .status.err{color:#f44747 !important}' +
'.__pg_net_row__ .latency{color:#888 !important;margin-left:6px}' +
'.__pg_net_detail__{padding:6px 12px;background:#252526 !important;color:#ccc !important;font-size:11px;' +
'display:none;word-break:break-all;white-space:pre-wrap;max-height:200px;overflow-y:auto}' +
'.__pg_store_section__{padding:6px 8px}' +
'.__pg_store_section__ h4{color:#569cd6 !important;margin:8px 0 4px;font-size:12px}' +
'.__pg_store_kv__{padding:2px 0;border-bottom:1px solid #2d2d2d}' +
'.__pg_store_kv__ .k{color:#9cdcfe !important}.__pg_store_kv__ .v{color:#ce9178 !important;margin-left:4px;word-break:break-all}' +
'.__pg_el_info__{padding:8px}' +
'.__pg_el_info__ .tag{color:#569cd6 !important;font-size:14px;font-weight:bold}' +
'.__pg_el_info__ .attr{color:#9cdcfe !important}.__pg_el_info__ .val{color:#ce9178 !important}' +
'.__pg_el_info__ .sec{color:#dcdcaa !important;margin-top:8px;display:block;font-weight:bold}' +
'.__pg_el_info__ .prop{padding:1px 0}.__pg_el_info__ .prop .n{color:#9cdcfe !important}.__pg_el_info__ .prop .v{color:#d4d4d4 !important}' +
'#__pg_inspect_overlay__{position:fixed;z-index:2147483645;pointer-events:none;' +
'border:2px solid #007acc;background:rgba(0,122,204,.15);transition:all .1s}' +
'#__pg_inspect_hint__{position:fixed;z-index:2147483645;background:rgba(0,0,0,.85);' +
'color:#fff;padding:4px 8px;font-size:11px;font-family:monospace;border-radius:4px;' +
'pointer-events:none;white-space:nowrap}' +
'.__pg_filter__{display:flex;background:#252526;padding:4px 8px;gap:4px;flex-shrink:0}' +
'.__pg_filter__ button{background:#3c3c3c;border:1px solid #555;color:#ccc !important;padding:3px 8px;' +
'border-radius:3px;font-size:11px;font-family:inherit;cursor:pointer}' +
'.__pg_filter__ button.on{background:#007acc;border-color:#007acc;color:#fff !important}' +
'.__pg_filter__ input{flex:1;background:#3c3c3c;border:1px solid #555;color:#d4d4d4;' +
'padding:3px 8px;border-radius:3px;font-size:11px;font-family:inherit;outline:none}' +
'#__pg_resize__{height:12px;cursor:ns-resize;display:flex;align-items:center;' +
'justify-content:center;background:#252526;flex-shrink:0;touch-action:none}' +
'#__pg_resize__ span{width:32px;height:3px;background:#555;border-radius:2px}' +
'#__pg_console_input__{display:flex;background:#1e1e1e;border-top:1px solid #3c3c3c;flex-shrink:0;padding:4px 8px;gap:4px}' +
'#__pg_console_input__ input{flex:1;background:#2d2d2d;border:1px solid #555;color:#d4d4d4;' +
'padding:6px 8px;border-radius:3px;font-size:12px;font-family:inherit;outline:none}' +
'#__pg_console_input__ input:focus{border-color:#007acc}' +
'#__pg_console_input__ button{background:#007acc;border:none;color:#fff;padding:6px 12px;' +
'border-radius:3px;font-size:12px;font-family:inherit;cursor:pointer}' +
'.__pg_row__.result{color:#4ec9b0;padding-left:16px}' +
'.__pg_row__.result-err{color:#f44747;padding-left:16px}' +
'.__pg_row__.input-echo{color:#569cd6;padding-left:8px}' +
'.__pg_breadcrumb__{display:flex;flex-wrap:wrap;gap:2px;padding:6px 8px;background:#252526;' +
'border-bottom:1px solid #3c3c3c;flex-shrink:0;align-items:center}' +
'.__pg_breadcrumb__ span{color:#569cd6;cursor:pointer;padding:2px 4px;border-radius:2px;font-size:11px}' +
'.__pg_breadcrumb__ span:hover{background:#3c3c3c}' +
'.__pg_breadcrumb__ span.sep{color:#555;cursor:default}' +
'.__pg_breadcrumb__ span.sep:hover{background:none}' +
'.__pg_el_nav__{display:flex;gap:4px;padding:6px 8px;flex-shrink:0}' +
'.__pg_el_nav__ button{background:#3c3c3c;border:1px solid #555;color:#ccc;padding:4px 10px;' +
'border-radius:3px;font-size:11px;cursor:pointer;font-family:inherit}' +
'.__pg_el_nav__ button:disabled{opacity:.3;cursor:default}' +
'.__pg_store_actions__{display:inline-flex;gap:4px;margin-left:8px}' +
'.__pg_store_actions__ button{background:none;border:none;color:#888;font-size:11px;cursor:pointer;padding:0 4px}' +
'.__pg_store_actions__ button:hover{color:#fff}' +
'.__pg_badge__{background:#f44747;color:#fff;font-size:9px;padding:1px 5px;border-radius:8px;margin-left:4px;' +
'vertical-align:middle;display:inline-block;min-width:14px;text-align:center}' +
'.__pg_net_filter__{display:flex;background:#252526;padding:4px 8px;gap:4px;flex-shrink:0}' +
'.__pg_net_filter__ button{background:#3c3c3c;border:1px solid #555;color:#ccc;padding:3px 8px;' +
'border-radius:3px;font-size:11px;cursor:pointer;font-family:inherit}' +
'.__pg_net_filter__ button.on{background:#007acc;border-color:#007acc;color:#fff}' +
'.__pg_store_tabs__{display:flex;background:#252526;padding:4px 8px;gap:4px;flex-shrink:0;border-bottom:1px solid #3c3c3c}' +
'.__pg_store_tabs__ button{background:#3c3c3c;border:1px solid #555;color:#ccc;padding:4px 12px;' +
'border-radius:3px;font-size:11px;cursor:pointer;font-family:inherit;position:relative}' +
'.__pg_store_tabs__ button.on{background:#007acc;border-color:#007acc;color:#fff}' +
'.__pg_store_tabs__ .cnt{font-size:9px;color:#888;margin-left:3px}' +
'.__pg_tree_node__{padding:2px 0;white-space:nowrap;line-height:20px}' +
'.__pg_tree_node__ .tgl{display:inline-block;width:16px;text-align:center;color:#888;cursor:pointer;-webkit-user-select:none;user-select:none}' +
'.__pg_tree_node__ .tn{color:#569cd6;cursor:pointer}.__pg_tree_node__ .tn:active{text-decoration:underline}' +
'.__pg_tree_node__ .an{color:#9cdcfe}.__pg_tree_node__ .av{color:#ce9178}' +
'.__pg_tree_node__ .tp{color:#666;font-style:italic;margin-left:4px}' +
'.__pg_el_back__{background:#3c3c3c;border:1px solid #555;color:#ccc;padding:4px 10px;margin:6px 8px;' +
'border-radius:3px;font-size:11px;cursor:pointer;font-family:inherit}' +
'.__pg_attr_full__{color:#ce9178;word-break:break-all;cursor:pointer;padding:0 2px;border-radius:2px}' +
'.__pg_attr_full__:active{background:#3c3c3c}';

  // ================================================================
  // 面板创建 / 销毁
  // ================================================================
  function _create() {
    if (_panel) return;
    if (!document.getElementById('__pg_panel_style__')) {
      var s = document.createElement('style');
      s.id = '__pg_panel_style__';
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    _panel = document.createElement('div');
    _panel.id = '__pg_panel__';
    _panel.setAttribute('data-el-ignore', '1');
    _panel.innerHTML =
      '<div id="__pg_resize__" data-el-ignore="1"><span></span></div>' +
      '<div id="__pg_tabs__" data-el-ignore="1">' +
        '<button data-tab="console" class="active">Console</button>' +
        '<button data-tab="elements">Elements</button>' +
        '<button data-tab="dom">DOM</button>' +
        '<button data-tab="network">Network</button>' +
        '<button data-tab="storage">Storage</button>' +
        '<button data-tab="__close__">\u00d7</button>' +
      '</div>' +
      '<div id="__pg_body__" data-el-ignore="1"></div>';
    if (_savedHeight) _panel.style.height = _savedHeight;
    document.body.appendChild(_panel);

    _panel.querySelector('#__pg_tabs__').addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      var tab = btn.dataset.tab;
      if (tab === '__close__') { toggle(); return; }
      _activeTab = tab;
      _panel.querySelectorAll('#__pg_tabs__ button[data-tab]').forEach(function (b) {
        if (b.dataset.tab === '__close__') return;
        b.classList.toggle('active', b.dataset.tab === tab);
      });
      if (tab === 'elements') { _inspectMode = true; _ensureOverlay(); }
      else { _inspectMode = false; _hideOverlay(); }
      _savePanelState();
      _renderTab();
    });

    // 设置初始 active tab
    _panel.querySelectorAll('#__pg_tabs__ button[data-tab]').forEach(function (b) {
      if (b.dataset.tab === '__close__') return;
      b.classList.toggle('active', b.dataset.tab === _activeTab);
    });

    _initResize();
    if (_api().onLog) {
      _api().onLog(function (entry) {
        if (entry.level === 'error' || entry.level === 'uncaught' || entry.level === 'unhandledrejection') {
          _errorCount++;
          _updateBadge();
        }
        if (_activeTab === 'console' && _panel) _appendLogRow(entry);
      });
    }
    if (_api().onNet) {
      _api().onNet(function (entry) {
        if (_activeTab === 'network' && _panel) _appendNetRow(entry);
      });
    }
    // 统计已有错误
    var logs = _getLogs();
    _errorCount = 0;
    for (var i = 0; i < logs.length; i++) {
      if (logs[i].level === 'error' || logs[i].level === 'uncaught' || logs[i].level === 'unhandledrejection') _errorCount++;
    }
    _updateBadge();

    _renderTab();
  }

  function _destroy() {
    if (_panel) { _panel.remove(); _panel = null; }
    if (_api().offLog) _api().offLog();
    if (_api().offNet) _api().offNet();
    _inspectMode = false;
    _hideOverlay();
    var f = document.querySelector('.__pg_filter__');
    if (f) f.remove();
  }

  // ================================================================
  // 拖拽调高度
  // ================================================================
  function _initResize() {
    var handle = _panel.querySelector('#__pg_resize__');
    var startY = 0, startH = 0;
    function onMove(e) {
      var cy = e.touches ? e.touches[0].clientY : e.clientY;
      _panel.style.height = Math.min(Math.max(startH + (startY - cy), 120), window.innerHeight - 40) + 'px';
    }
    function onEnd() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      _savedHeight = _panel.style.height;
      _savePanelState();
    }
    handle.addEventListener('mousedown', function (e) {
      startY = e.clientY; startH = _panel.offsetHeight;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
    });
    handle.addEventListener('touchstart', function (e) {
      startY = e.touches[0].clientY; startH = _panel.offsetHeight;
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
    });
  }

  // ================================================================
  // Tab 渲染
  // ================================================================
  function _renderTab() {
    var body = _panel.querySelector('#__pg_body__');
    body.innerHTML = '';
    // 统一清除所有 tab 附属的浮动元素（tabs 和 body 之间的）
    var removes = ['.__pg_filter__', '#__pg_console_input__', '.__pg_breadcrumb__',
      '.__pg_el_nav__', '.__pg_el_back__', '.__pg_net_filter__', '.__pg_store_tabs__'];
    for (var ri = 0; ri < removes.length; ri++) {
      var el = _panel.querySelector(removes[ri]);
      if (el) el.remove();
    }
    switch (_activeTab) {
      case 'console': _renderConsole(body); break;
      case 'elements': _renderElements(body); break;
      case 'dom': _renderDomTab(body); break;
      case 'network': _renderNetwork(body); break;
      case 'storage': _renderStorage(body); break;
    }
    // 给所有动态创建的子 div 加排除标记，防止 element.js 的 convertAll 替换
    _panel.querySelectorAll('div:not([data-el-ignore])').forEach(function(el) {
      el.setAttribute('data-el-ignore', '1');
    });
  }

  function _updateBadge() {
    if (!_panel) return;
    var btn = _panel.querySelector('button[data-tab="console"]');
    if (!btn) return;
    var badge = btn.querySelector('.__pg_badge__');
    if (_errorCount > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = '__pg_badge__';
        btn.appendChild(badge);
      }
      badge.textContent = _errorCount > 99 ? '99+' : _errorCount;
    } else if (badge) {
      badge.remove();
    }
  }

  function _esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ================================================================
  // Console Tab
  // ================================================================
  function _matchFilter(entry) {
    // JS 执行的输入/输出始终显示
    if (entry.level === 'input-echo' || entry.level === 'result' || entry.level === 'result-err') return true;
    if (_cFilter !== 'all') {
      if (_cFilter === 'error' && entry.level !== 'error' && entry.level !== 'uncaught' && entry.level !== 'unhandledrejection') return false;
      if (_cFilter === 'warn' && entry.level !== 'warn') return false;
      if (_cFilter === 'log' && entry.level !== 'log' && entry.level !== 'info' && entry.level !== 'debug') return false;
    }
    if (_cSearch && entry.message.toLowerCase().indexOf(_cSearch.toLowerCase()) === -1) return false;
    return true;
  }

  function _makeLogRow(entry) {
    var div = document.createElement('div');
    div.className = '__pg_row__ ' + entry.level;
    div.textContent = '[' + new Date(entry.ts).toLocaleTimeString() + '] ' + entry.message;
    return div;
  }

  var _cmdHistory = [];
  var _cmdHistoryIdx = -1;

  function _execJS(code) {
    if (!code.trim()) return;
    _cmdHistory.push(code);
    _cmdHistoryIdx = _cmdHistory.length;
    // 显示输入
    var inputEntry = { level: 'input-echo', message: '\u25b6 ' + code, ts: Date.now() };
    _getLogs().push(inputEntry);
    if (_panel) _appendLogRow(inputEntry);
    // 执行
    var resultEntry;
    try {
      var result = (0, eval)(code); // indirect eval = 全局作用域
      var display;
      try {
        if (typeof result === 'object' && result !== null) {
          var seen = new WeakSet();
          display = JSON.stringify(result, function(_k, v) {
            if (typeof v === 'object' && v !== null) { if (seen.has(v)) return '[Circular]'; seen.add(v); }
            return v;
          }, 2);
        } else { display = String(result); }
      } catch(_) { display = String(result); }
      resultEntry = { level: 'result', message: '\u25c0 ' + display, ts: Date.now() };
    } catch(err) {
      resultEntry = { level: 'result-err', message: '\u25c0 ' + err.toString(), ts: Date.now() };
    }
    _getLogs().push(resultEntry);
    if (_panel) _appendLogRow(resultEntry);
  }

  function _renderConsole(body) {
    var filter = document.createElement('div');
    filter.className = '__pg_filter__';
    filter.innerHTML =
      '<button data-f="all" class="' + (_cFilter === 'all' ? 'on' : '') + '">All</button>' +
      '<button data-f="error" class="' + (_cFilter === 'error' ? 'on' : '') + '">Errors</button>' +
      '<button data-f="warn" class="' + (_cFilter === 'warn' ? 'on' : '') + '">Warn</button>' +
      '<button data-f="log" class="' + (_cFilter === 'log' ? 'on' : '') + '">Log</button>' +
      '<input type="text" placeholder="Filter..." value="' + _esc(_cSearch) + '">' +
      '<button data-f="__clear__">Clear</button>';
    filter.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      var f = btn.dataset.f;
      if (f === '__clear__') { _getLogs().length = 0; _renderTab(); return; }
      _cFilter = f;
      _renderTab();
    });
    filter.querySelector('input').addEventListener('input', function (e) {
      _cSearch = e.target.value;
      _renderTab();
    });
    _panel.querySelector('#__pg_tabs__').after(filter);

    var list = document.createElement('div');
    var logs = _getLogs();
    for (var i = 0; i < logs.length; i++) {
      if (_matchFilter(logs[i])) list.appendChild(_makeLogRow(logs[i]));
    }
    body.appendChild(list);
    body.scrollTop = body.scrollHeight;

    // JS 输入框（插到 body 下方，panel 内底部）
    var inputBar = document.createElement('div');
    inputBar.id = '__pg_console_input__';
    inputBar.innerHTML = '<input type="text" placeholder="输入 JS 表达式...">' +
      '<button>Run</button>';
    // 插到 #__pg_body__ 后面（panel 的最后一个子元素）
    _panel.appendChild(inputBar);
    var inp = inputBar.querySelector('input');
    var runBtn = inputBar.querySelector('button');
    function doRun() { _execJS(inp.value); inp.value = ''; }
    runBtn.addEventListener('click', doRun);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doRun(); }
      else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (_cmdHistoryIdx > 0) { _cmdHistoryIdx--; inp.value = _cmdHistory[_cmdHistoryIdx]; }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (_cmdHistoryIdx < _cmdHistory.length - 1) { _cmdHistoryIdx++; inp.value = _cmdHistory[_cmdHistoryIdx]; }
        else { _cmdHistoryIdx = _cmdHistory.length; inp.value = ''; }
      }
    });
  }

  function _appendLogRow(entry) {
    if (!_panel) return;
    var body = _panel.querySelector('#__pg_body__');
    if (!body || !_matchFilter(entry)) return;
    var list = body.firstElementChild;
    if (list) list.appendChild(_makeLogRow(entry));
    if (body.scrollHeight - body.scrollTop - body.clientHeight < 60) body.scrollTop = body.scrollHeight;
  }

  // ================================================================
  // Elements Tab — 纯审查模式（点击页面元素查看详情）
  // ================================================================
  var _inspectedEl = null;

  // --- 判断是否为 PageGhost 自身注入的元素 ---
  var _pgIds = {'__pg_panel__':1,'__pg_panel_style__':1,'__pg_inspect_overlay__':1,
    '__pg_inspect_hint__':1,'__env_dump_indicator__':1,'__env_dump_style__':1,'__pg_fab__':1};
  function _isPGNode(el) {
    return el.id && _pgIds[el.id];
  }

  function _renderElements(body) {
    if (_inspectedEl) {
      _showBreadcrumb(_inspectedEl);
      _showNavButtons();
      _showDetail(_inspectedEl);
    } else {
      body.innerHTML = '<div class="__pg_el_info__" style="color:#888;padding:16px;text-align:center;">' +
        '点击页面上任意元素进行审查<br><br>面板外区域 = 选取元素</div>';
    }
  }

  function _selectElement(el) {
    _inspectedEl = el;
    _ensureOverlay();
    _highlight(el);
    if (_activeTab === 'elements') _renderTab();
  }

  // ================================================================
  // DOM Tab — 独立的 DOM 树浏览
  // ================================================================
  function _renderDomTab(body) {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'padding:4px 0;overflow-x:auto';
    _buildTreeNode(wrap, document.documentElement, 0, true);
    body.appendChild(wrap);
  }

  function _treeLabel(el) {
    var tag = el.tagName.toLowerCase();
    var s = '<span class="tn">&lt;' + tag;
    for (var i = 0; i < el.attributes.length && i < 3; i++) {
      var a = el.attributes[i];
      if (a.name === 'data-el-ignore') continue;
      var v = a.value.length > 30 ? a.value.slice(0, 30) + '...' : a.value;
      s += ' <span class="an">' + _esc(a.name) + '</span>=<span class="av">"' + _esc(v) + '"</span>';
    }
    if (el.attributes.length > 3) s += ' <span class="an">...</span>';
    s += '&gt;</span>';
    return s;
  }

  function _buildTreeNode(container, el, depth, expanded) {
    if (_isPGNode(el)) return;
    var hasKids = false;
    for (var ci = 0; ci < el.children.length; ci++) {
      if (!_isPGNode(el.children[ci])) { hasKids = true; break; }
    }
    var row = document.createElement('div');
    row.className = '__pg_tree_node__';
    row.style.paddingLeft = (depth * 14 + 4) + 'px';

    var tgl = document.createElement('span');
    tgl.className = 'tgl';
    tgl.textContent = hasKids ? (expanded ? '\u25BC' : '\u25B6') : '\u00a0';
    row.appendChild(tgl);

    var tagSpan = document.createElement('span');
    tagSpan.innerHTML = _treeLabel(el);
    row.appendChild(tagSpan);

    if (!hasKids) {
      var txt = (el.textContent || '').trim();
      if (txt) {
        var tp = document.createElement('span');
        tp.className = 'tp';
        tp.textContent = txt.length > 40 ? txt.slice(0, 40) + '...' : txt;
        row.appendChild(tp);
      }
    }

    container.appendChild(row);

    var kidBox = document.createElement('div');
    kidBox.style.display = expanded ? 'block' : 'none';
    container.appendChild(kidBox);

    var loaded = false;
    function loadKids() {
      if (loaded) return;
      loaded = true;
      for (var i = 0; i < el.children.length; i++) {
        _buildTreeNode(kidBox, el.children[i], depth + 1, depth < 1);
      }
    }
    if (expanded && hasKids) loadKids();

    if (hasKids) {
      (function(t, kb, lk) {
        var open = expanded;
        t.addEventListener('click', function(e) {
          e.stopPropagation();
          open = !open;
          t.textContent = open ? '\u25BC' : '\u25B6';
          kb.style.display = open ? 'block' : 'none';
          if (open) lk();
        });
      })(tgl, kidBox, loadKids);
    }

    // 点击标签名 → 切到 Elements tab 查看详情
    (function(target) {
      tagSpan.addEventListener('click', function(e) {
        e.stopPropagation();
        _inspectedEl = target;
        _activeTab = 'elements';
        _inspectMode = true;
        _ensureOverlay();
        _highlight(target);
        // 更新 tab 高亮
        if (_panel) {
          _panel.querySelectorAll('#__pg_tabs__ button[data-tab]').forEach(function(b) {
            if (b.dataset.tab === '__close__') return;
            b.classList.toggle('active', b.dataset.tab === 'elements');
          });
        }
        _renderTab();
      });
    })(el);
  }

  function _showBreadcrumb(el) {
    var chain = [];
    var cur = el;
    while (cur && cur !== document) {
      chain.unshift(cur);
      cur = cur.parentElement;
    }
    var bc = document.createElement('div');
    bc.className = '__pg_breadcrumb__';
    for (var i = 0; i < chain.length; i++) {
      if (i > 0) {
        var sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '\u203a';
        bc.appendChild(sep);
      }
      var sp = document.createElement('span');
      var c = chain[i];
      var label = c.tagName.toLowerCase();
      if (c.id) label += '#' + c.id;
      else if (c.className && typeof c.className === 'string') {
        var cls = c.className.trim().split(/\s+/);
        if (cls[0]) label += '.' + cls[0];
      }
      sp.textContent = label;
      (function(target) {
        sp.addEventListener('click', function() { _selectElement(target); });
      })(c);
      bc.appendChild(sp);
    }
    _panel.querySelector('#__pg_tabs__').after(bc);
  }

  function _showNavButtons() {
    if (!_inspectedEl) return;
    var nav = document.createElement('div');
    nav.className = '__pg_el_nav__';
    var parent = _inspectedEl.parentElement;
    var prevSib = _inspectedEl.previousElementSibling;
    var nextSib = _inspectedEl.nextElementSibling;
    var firstChild = _inspectedEl.firstElementChild;

    nav.innerHTML =
      '<button data-dir="parent"' + (!parent ? ' disabled' : '') + '>\u2191 Parent</button>' +
      '<button data-dir="child"' + (!firstChild ? ' disabled' : '') + '>\u2193 Child</button>' +
      '<button data-dir="prev"' + (!prevSib ? ' disabled' : '') + '>\u2190 Prev</button>' +
      '<button data-dir="next"' + (!nextSib ? ' disabled' : '') + '>\u2192 Next</button>';
    nav.addEventListener('click', function(e) {
      var btn = e.target.closest('button');
      if (!btn || btn.disabled) return;
      var dir = btn.dataset.dir;
      var target = null;
      if (dir === 'parent') target = _inspectedEl.parentElement;
      else if (dir === 'child') target = _inspectedEl.firstElementChild;
      else if (dir === 'prev') target = _inspectedEl.previousElementSibling;
      else if (dir === 'next') target = _inspectedEl.nextElementSibling;
      if (target) _selectElement(target);
    });
    var bc = _panel.querySelector('.__pg_breadcrumb__');
    if (bc) bc.after(nav);
    else _panel.querySelector('#__pg_tabs__').after(nav);
  }

  function _ensureOverlay() {
    if (!_inspectOverlay) {
      _inspectOverlay = document.createElement('div');
      _inspectOverlay.id = '__pg_inspect_overlay__';
      document.body.appendChild(_inspectOverlay);
    }
    if (!_inspectHint) {
      _inspectHint = document.createElement('div');
      _inspectHint.id = '__pg_inspect_hint__';
      _inspectHint.style.display = 'none';
      document.body.appendChild(_inspectHint);
    }
  }

  function _hideOverlay() {
    if (_inspectOverlay) { _inspectOverlay.remove(); _inspectOverlay = null; }
    if (_inspectHint) { _inspectHint.remove(); _inspectHint = null; }
  }

  function _highlight(el) {
    if (!_inspectOverlay || !el) return;
    var r = el.getBoundingClientRect();
    var s = _inspectOverlay.style;
    s.top = r.top+'px'; s.left = r.left+'px'; s.width = r.width+'px'; s.height = r.height+'px'; s.display = 'block';
    if (_inspectHint) {
      var lb = el.tagName.toLowerCase();
      if (el.id) lb += '#' + el.id;
      if (el.className && typeof el.className === 'string') lb += '.' + el.className.trim().split(/\s+/).slice(0,2).join('.');
      lb += ' ' + Math.round(r.width) + '\u00d7' + Math.round(r.height);
      _inspectHint.textContent = lb;
      _inspectHint.style.display = 'block';
      _inspectHint.style.top = (r.top > 30 ? r.top - 24 : r.bottom + 4) + 'px';
      _inspectHint.style.left = r.left + 'px';
    }
  }

  function _showDetail(el) {
    if (!_panel) return;
    var body = _panel.querySelector('#__pg_body__');
    if (!body) return;
    var r = el.getBoundingClientRect();
    var h = '<div class="__pg_el_info__">';

    // 标签 + 全部属性概览
    h += '<span class="tag">&lt;' + el.tagName.toLowerCase() + '&gt;</span>';

    // --- 全部属性（完整值，点击可复制） ---
    if (el.attributes.length > 0) {
      h += '<span class="sec">Attributes (' + el.attributes.length + ')</span>';
      for (var ai = 0; ai < el.attributes.length; ai++) {
        var a = el.attributes[ai];
        var val = a.value;
        var display = val.length > 120 ? _esc(val.slice(0, 120)) + '<span style="color:#888">... (' + val.length + ' chars)</span>' : _esc(val);
        h += '<div class="prop"><span class="n">' + _esc(a.name) + ': </span><span class="__pg_attr_full__" data-full="' + _esc(val) + '">' + display + '</span></div>';
      }
    }

    // --- children ---
    if (el.children.length > 0)
      h += '<div class="prop" style="margin-top:4px"><span class="n">children: </span><span class="v">' + el.children.length + '</span></div>';

    // --- Box ---
    h += '<span class="sec">Box</span>';
    h += '<div class="prop"><span class="n">size: </span><span class="v">' + Math.round(r.width) + ' \u00d7 ' + Math.round(r.height) + '</span></div>';
    h += '<div class="prop"><span class="n">position: </span><span class="v">(' + Math.round(r.left) + ', ' + Math.round(r.top) + ')</span></div>';

    // --- Computed Styles ---
    try {
      var cs = getComputedStyle(el);
      h += '<div class="prop"><span class="n">margin: </span><span class="v">' + cs.margin + '</span></div>';
      h += '<div class="prop"><span class="n">padding: </span><span class="v">' + cs.padding + '</span></div>';
      h += '<span class="sec">Styles</span>';
      var props = ['display','position','color','background','background-image','font-size','font-family',
        'line-height','overflow','opacity','z-index','flex','grid-template-columns','width','height',
        'max-width','max-height','border','border-radius','box-shadow','transform','transition'];
      for (var i = 0; i < props.length; i++) {
        var v = cs.getPropertyValue(props[i]);
        if (v && v !== 'normal' && v !== 'none' && v !== 'auto' && v !== 'visible' && v !== '1' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)')
          h += '<div class="prop"><span class="n">' + props[i] + ': </span><span class="v">' + _esc(v.length > 100 ? v.slice(0,100) + '...' : v) + '</span></div>';
      }
    } catch(_) {}

    // --- 直接文本内容 ---
    var txt = '';
    for (var ci = 0; ci < el.childNodes.length; ci++) {
      if (el.childNodes[ci].nodeType === 3) txt += el.childNodes[ci].textContent;
    }
    txt = txt.trim();
    if (txt) {
      h += '<span class="sec">Text</span>';
      h += '<div class="prop" style="color:#ce9178;white-space:pre-wrap">' + _esc(txt.slice(0, 500)) + (txt.length > 500 ? '...' : '') + '</div>';
    }

    // --- outerHTML 预览 ---
    h += '<span class="sec">HTML</span>';
    var oh = el.outerHTML;
    // 只取开标签 + 前 200 字符
    var closeIdx = oh.indexOf('>');
    var preview = closeIdx > 0 ? oh.slice(0, Math.min(closeIdx + 1, 300)) : oh.slice(0, 300);
    if (oh.length > preview.length) preview += '...';
    h += '<div class="prop" style="color:#888;white-space:pre-wrap;word-break:break-all;font-size:11px">' + _esc(preview) + '</div>';

    h += '</div>';
    body.innerHTML = h;

    // 属性值点击 → 展开/折叠完整内容
    body.querySelectorAll('.__pg_attr_full__').forEach(function(span) {
      var full = span.getAttribute('data-full');
      if (full && full.length > 120) {
        var collapsed = true;
        span.addEventListener('click', function() {
          collapsed = !collapsed;
          span.innerHTML = collapsed
            ? _esc(full.slice(0, 120)) + '<span style="color:#888">... (' + full.length + ' chars)</span>'
            : _esc(full);
        });
      }
    });
  }

  function _isPG(el) {
    return (_panel && _panel.contains(el)) || _isPGNode(el) || (el.closest && el.closest('[data-el-ignore]'));
  }

  // 审查模式 — 拦截点击
  document.addEventListener('touchstart', function (e) {
    if (!_inspectMode || !_panel || _panel.contains(e.target)) return;
    var el = document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY);
    if (el && !_isPG(el)) { e.preventDefault(); e.stopPropagation(); _selectElement(el); }
  }, true);
  document.addEventListener('mousemove', function (e) {
    if (!_inspectMode || !_panel || _isPG(e.target)) return;
    _highlight(e.target);
  }, true);
  document.addEventListener('click', function (e) {
    if (!_inspectMode || !_panel || _isPG(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    _selectElement(e.target);
  }, true);

  // ================================================================
  // Network Tab
  // ================================================================
  function _makeNetRow(req) {
    var row = document.createElement('div');
    row.className = '__pg_net_row__';
    var sc = req.status >= 200 && req.status < 400 ? 'ok' : 'err';
    var su = req.url.length > 80 ? req.url.slice(0, 80) + '...' : req.url;
    row.innerHTML = '<span class="method">' + (req.method||'GET') + '</span>' +
      '<span class="url">' + _esc(su) + '</span>' +
      '<span class="status ' + sc + '">' + (req.status || (req.error ? 'ERR' : '...')) + '</span>' +
      '<span class="latency" style="color:' + (req.latency > 3000 ? '#f44747' : req.latency > 1000 ? '#cca700' : '#888') + '">' + (req.latency||0) + 'ms</span>';
    var detail = document.createElement('div');
    detail.className = '__pg_net_detail__';
    var dt = 'URL: ' + req.url + '\n';
    if (req.type === 'resource' || req.type === 'beacon') {
      dt += 'Type: ' + req.type + (req.initiatorType ? ' (' + req.initiatorType + ')' : '') + '\n';
      if (req.transferSize !== undefined) dt += 'Transfer: ' + (req.transferSize / 1024).toFixed(1) + ' KB\n';
    }
    if (req.requestHeaders) dt += '\n--- Request Headers ---\n' + JSON.stringify(req.requestHeaders, null, 2);
    if (req.requestBody) dt += '\n\n--- Request Body ---\n' + req.requestBody;
    if (req.responseHeaders) dt += '\n\n--- Response Headers ---\n' + JSON.stringify(req.responseHeaders, null, 2);
    if (req.body) {
      if (req.body.indexOf('[body too large') === 0) {
        dt += '\n\n--- Response Body ---\n' + req.body;
      } else {
        // 根据 content-type 判断是否尝试文本解码
        var ct = (req.responseHeaders && (req.responseHeaders['content-type'] || '')) || '';
        var isText = !ct || /text|json|xml|javascript|html|css|svg|form-urlencoded/.test(ct);
        if (isText) {
          try {
            var dec = new TextDecoder().decode(Uint8Array.from(atob(req.body),function(c){return c.charCodeAt(0)}));
            try { dt += '\n\n--- Response Body ---\n' + JSON.stringify(JSON.parse(dec), null, 2); }
            catch(_) { dt += '\n\n--- Response Body ---\n' + dec.slice(0, 2000); }
          } catch(_) { dt += '\n\n--- Response Body ---\n[binary ' + req.body.length + ' chars base64]'; }
        } else {
          dt += '\n\n--- Response Body ---\n[' + ct.split(';')[0] + ', ' + Math.round(req.body.length * 0.75 / 1024) + ' KB]';
        }
      }
    }
    if (req.error) dt += '\n\n--- Error ---\n' + req.error;
    detail.textContent = dt;
    (function(d, r) {
      r.addEventListener('click', function() { d.style.display = d.style.display === 'none' ? 'block' : 'none'; });
    })(detail, row);
    row.appendChild(detail);
    return row;
  }

  function _appendNetRow(entry) {
    if (!_panel) return;
    var body = _panel.querySelector('#__pg_body__');
    if (!body) return;
    // 新请求插到最前面
    var list = body.firstElementChild;
    if (list) {
      var row = _makeNetRow(entry);
      list.insertBefore(row, list.firstChild);
    }
  }

  function _pgNetCat(e) {
    if (e.type === 'fetch' || e.type === 'xhr' || e.type === 'beacon') return 'Fetch/XHR';
    if (e.type === 'resource-error') {
      var eit = (e.initiatorType || '').toLowerCase();
      if (eit === 'img') return 'Img';
      if (eit === 'script') return 'JS';
      if (eit === 'link') return 'CSS';
      return 'Other';
    }
    var url = (e.url || '').split('?')[0].toLowerCase();
    var full = (e.url || '').toLowerCase();
    var it = (e.initiatorType || '').toLowerCase();
    if (/\.(woff2?|ttf|otf|eot)$/.test(url) || /fonts\.(googleapis|gstatic)\.com/.test(full)) return 'Font';
    if (it === 'img' || it === 'image' || /\.(png|jpe?g|gif|svg|webp|ico|bmp|avif)$/.test(url)) return 'Img';
    if (it === 'script' || /\.js$/.test(url)) return 'JS';
    if (it === 'link' || it === 'css' || /\.css$/.test(url)) return 'CSS';
    if (/\.(mp4|webm|m3u8|ts|mp3|ogg|wav)$/.test(url) || it === 'video' || it === 'audio') return 'Media';
    if (it === 'document' || it === 'iframe' || /\.html?$/.test(url)) return 'Doc';
    if (/\.wasm$/.test(url)) return 'Wasm';
    if (/manifest\.json$/.test(url) || /\.webmanifest$/.test(url)) return 'Manifest';
    if (/gstatic\.com/.test(full)) return 'JS';
    if (it === 'xmlhttprequest' || it === 'fetch') return 'Fetch/XHR';
    return 'Other';
  }

  var _netFilter = 'All';
  var _netSearch = '';

  function _renderNetwork(body) {
    var log = _getNetworkLog();

    // 过滤栏
    var nf = document.createElement('div');
    nf.className = '__pg_net_filter__';
    var errCount = 0;
    for (var j = 0; j < log.length; j++) {
      if (log[j].status && (log[j].status < 200 || log[j].status >= 400)) errCount++;
      if (log[j].error) errCount++;
    }
    // 按 Chrome DevTools 分类统计
    var _cats = { 'All': log.length, 'Fetch/XHR': 0, 'Doc': 0, 'CSS': 0, 'JS': 0, 'Font': 0, 'Img': 0, 'Media': 0, 'WS': 0, 'Wasm': 0, 'Manifest': 0, 'Other': 0 };
    for (var ci = 0; ci < log.length; ci++) { _cats[_pgNetCat(log[ci])]++; }
    var _catKeys = ['All','Fetch/XHR','Doc','CSS','JS','Font','Img','Media','WS','Wasm','Manifest','Other'];
    var btns = '';
    for (var ck = 0; ck < _catKeys.length; ck++) {
      var _ck = _catKeys[ck];
      btns += '<button data-nf="' + _ck + '" class="' + (_netFilter === _ck ? 'on' : '') + '">' + _ck + '</button>';
    }
    btns += '<button data-nf="err" class="' + (_netFilter === 'err' ? 'on' : '') + '" style="color:#f44747 !important">✕' + (errCount || '') + '</button>';
    nf.innerHTML = btns +
      '<input type="text" placeholder="Filter" value="' + _esc(_netSearch) + '" style="flex:1;background:#3c3c3c;border:1px solid #555;color:#d4d4d4;padding:3px 8px;border-radius:3px;font-size:11px;font-family:inherit;outline:none">' +
      '<button data-nf="__clear__">Clear</button>';
    nf.addEventListener('click', function(e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      var f = btn.dataset.nf;
      if (f === '__clear__') { _getNetworkLog().length = 0; _netSearch = ''; _renderTab(); return; }
      _netFilter = f;
      _renderTab();
    });
    nf.querySelector('input').addEventListener('input', function(e) {
      _netSearch = e.target.value;
      _renderTab();
    });
    _panel.querySelector('#__pg_tabs__').after(nf);

    if (log.length === 0) {
      body.innerHTML = '<div style="color:#888;padding:16px;text-align:center;">暂无网络请求</div>';
      return;
    }
    var list = document.createElement('div');
    for (var i = log.length - 1; i >= 0; i--) {
      var req = log[i];
      if (_netFilter === 'err') {
        if (req.status && req.status >= 200 && req.status < 400 && !req.error) continue;
      } else if (_netFilter !== 'All') {
        if (_pgNetCat(req) !== _netFilter) continue;
      }
      if (_netSearch && req.url.toLowerCase().indexOf(_netSearch.toLowerCase()) === -1) continue;
      list.appendChild(_makeNetRow(req));
    }
    body.appendChild(list);
  }

  // ================================================================
  // Storage Tab
  // ================================================================
  var _storeTab = 'local'; // local, session, cookie, idb

  function _renderStorage(body) {
    var cookieCount = document.cookie.split(';').filter(function(c){ return c.trim(); }).length;
    // 子 tab 栏
    var tabs = document.createElement('div');
    tabs.className = '__pg_store_tabs__';
    tabs.innerHTML =
      '<button data-st="local" class="' + (_storeTab === 'local' ? 'on' : '') + '">Local<span class="cnt">(' + localStorage.length + ')</span></button>' +
      '<button data-st="session" class="' + (_storeTab === 'session' ? 'on' : '') + '">Session<span class="cnt">(' + sessionStorage.length + ')</span></button>' +
      '<button data-st="cookie" class="' + (_storeTab === 'cookie' ? 'on' : '') + '">Cookies<span class="cnt">(' + cookieCount + ')</span></button>' +
      '<button data-st="idb" class="' + (_storeTab === 'idb' ? 'on' : '') + '">IndexedDB</button>';
    tabs.addEventListener('click', function(e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      _storeTab = btn.dataset.st;
      _renderTab();
    });
    _panel.querySelector('#__pg_tabs__').after(tabs);

    var container = document.createElement('div');
    container.className = '__pg_store_section__';

    if (_storeTab === 'local') {
      _renderStorageKVs(container, localStorage, 'localStorage');
    } else if (_storeTab === 'session') {
      _renderStorageKVs(container, sessionStorage, 'sessionStorage');
    } else if (_storeTab === 'idb') {
      _renderIDB(container);
    } else {
      _renderCookies(container);
    }
    body.appendChild(container);
  }

  function _renderCookies(container) {
    var cookies = document.cookie.split(';').filter(function(c){ return c.trim(); });

    // 提示 httpOnly 不可见
    var note = document.createElement('div');
    note.style.cssText = 'color:#666;padding:4px 0;font-size:11px;border-bottom:1px solid #2d2d2d;margin-bottom:4px';
    note.textContent = '\u26a0 httpOnly / Secure Cookie 无法通过 JS 读取，此处仅显示可访问的 Cookie';
    container.appendChild(note);

    if (!cookies.length) {
      var empty = document.createElement('div');
      empty.style.cssText = 'color:#888;padding:8px';
      empty.textContent = '无可访问的 Cookie';
      container.appendChild(empty);
      return;
    }
    for (var i = 0; i < cookies.length; i++) {
      var raw = cookies[i].trim();
      var eqIdx = raw.indexOf('=');
      var ck = eqIdx > 0 ? raw.slice(0, eqIdx).trim() : raw;
      var cv = eqIdx > 0 ? raw.slice(eqIdx + 1) : '';

      var row = document.createElement('div');
      row.className = '__pg_store_kv__';

      var keySpan = document.createElement('span');
      keySpan.className = 'k';
      keySpan.textContent = ck;
      var valSpan = document.createElement('span');
      valSpan.className = 'v';
      valSpan.textContent = cv.length > 120 ? cv.slice(0, 120) + '...' : cv;

      // 长值点击展开
      if (cv.length > 120) {
        (function(full, span) {
          var exp = false;
          span.style.cursor = 'pointer';
          span.addEventListener('click', function(e) {
            e.stopPropagation();
            exp = !exp;
            span.textContent = exp ? full : full.slice(0, 120) + '...';
          });
        })(cv, valSpan);
      }

      // Cookie 编辑/删除
      var actions = document.createElement('span');
      actions.className = '__pg_store_actions__';
      var editBtn = document.createElement('button');
      editBtn.textContent = 'Edit';
      var delBtn = document.createElement('button');
      delBtn.textContent = 'Del';
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      (function(name, val) {
        editBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          var newVal = prompt('Edit cookie "' + name + '":', val);
          if (newVal !== null) {
            document.cookie = name + '=' + newVal + ';path=/';
            _renderTab();
          }
        });
        delBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          if (confirm('Delete cookie "' + name + '"?')) {
            document.cookie = name + '=;expires=Thu,01 Jan 1970 00:00:00 GMT;path=/';
            _renderTab();
          }
        });
      })(ck, cv);

      row.appendChild(keySpan);
      row.appendChild(document.createTextNode(': '));
      row.appendChild(valSpan);
      row.appendChild(actions);
      container.appendChild(row);
    }

    // 新增 Cookie 按钮
    var addBtn = document.createElement('button');
    addBtn.style.cssText = 'background:#3c3c3c;border:1px solid #555;color:#ccc;padding:6px 12px;margin:8px 0;border-radius:3px;font-size:11px;cursor:pointer;font-family:inherit';
    addBtn.textContent = '+ Add Cookie';
    addBtn.addEventListener('click', function() {
      var name = prompt('Cookie name:');
      if (!name) return;
      var val = prompt('Cookie value:', '');
      if (val === null) return;
      document.cookie = name + '=' + val + ';path=/';
      _renderTab();
    });
    container.appendChild(addBtn);
  }

  function _renderIDB(container) {
    if (!window.indexedDB || typeof indexedDB.databases !== 'function') {
      container.innerHTML = '<div style="color:#888;padding:8px">此浏览器不支持 indexedDB.databases()</div>';
      return;
    }
    container.innerHTML = '<div style="color:#888;padding:8px">加载中...</div>';
    indexedDB.databases().then(function(dbs) {
      container.innerHTML = '';
      if (!dbs.length) {
        container.innerHTML = '<div style="color:#888;padding:8px">无 IndexedDB 数据库</div>';
        return;
      }
      for (var di = 0; di < dbs.length; di++) {
        (function(dbInfo) {
          var sec = document.createElement('div');
          sec.innerHTML = '<h4 style="color:#569cd6;margin:8px 0 4px;cursor:pointer">\u25B6 ' + _esc(dbInfo.name) + ' <span style="color:#888;font-weight:normal">v' + (dbInfo.version || '?') + '</span></h4>';
          var content = document.createElement('div');
          content.style.display = 'none';
          var loaded = false;
          sec.querySelector('h4').addEventListener('click', function() {
            var open = content.style.display !== 'none';
            content.style.display = open ? 'none' : 'block';
            this.innerHTML = (open ? '\u25B6 ' : '\u25BC ') + _esc(dbInfo.name) + ' <span style="color:#888;font-weight:normal">v' + (dbInfo.version || '?') + '</span>';
            if (!open && !loaded) {
              loaded = true;
              content.innerHTML = '<div style="color:#888;padding:4px 8px">读取中...</div>';
              var req = indexedDB.open(dbInfo.name);
              req.onsuccess = function(e) {
                var db = e.target.result;
                content.innerHTML = '';
                var sn = Array.from(db.objectStoreNames);
                if (!sn.length) {
                  content.innerHTML = '<div style="color:#888;padding:4px 8px">无 ObjectStore</div>';
                  db.close();
                  return;
                }
                var tx = db.transaction(sn, 'readonly');
                for (var si = 0; si < sn.length; si++) {
                  (function(storeName) {
                    var storeDiv = document.createElement('div');
                    storeDiv.style.cssText = 'padding:2px 8px';
                    storeDiv.innerHTML = '<div style="color:#dcdcaa;cursor:pointer;padding:2px 0">\u25B6 ' + _esc(storeName) + '</div>';
                    var recordsDiv = document.createElement('div');
                    recordsDiv.style.display = 'none';
                    var recordsLoaded = false;
                    storeDiv.firstChild.addEventListener('click', function() {
                      var o = recordsDiv.style.display !== 'none';
                      recordsDiv.style.display = o ? 'none' : 'block';
                      this.innerHTML = (o ? '\u25B6 ' : '\u25BC ') + _esc(storeName);
                      if (!o && !recordsLoaded) {
                        recordsLoaded = true;
                        try {
                          var store = tx.objectStore(storeName);
                          store.getAll().onsuccess = function(ev) {
                            var records = ev.target.result || [];
                            recordsDiv.innerHTML = '<div style="color:#888;padding:2px 4px">' + records.length + ' records</div>';
                            for (var ri = 0; ri < Math.min(records.length, 50); ri++) {
                              var rr = document.createElement('div');
                              rr.className = '__pg_store_kv__';
                              var json;
                              try { json = JSON.stringify(records[ri]); } catch(_) { json = String(records[ri]); }
                              var display = json.length > 120 ? json.slice(0, 120) + '...' : json;
                              rr.innerHTML = '<span class="k">[' + ri + ']</span>: <span class="v">' + _esc(display) + '</span>';
                              if (json.length > 120) {
                                (function(full, row) {
                                  var exp = false;
                                  row.querySelector('.v').style.cursor = 'pointer';
                                  row.querySelector('.v').addEventListener('click', function(e) {
                                    e.stopPropagation();
                                    exp = !exp;
                                    this.textContent = exp ? full : full.slice(0, 120) + '...';
                                  });
                                })(json, rr);
                              }
                              recordsDiv.appendChild(rr);
                            }
                            if (records.length > 50) {
                              recordsDiv.innerHTML += '<div style="color:#888;padding:4px">... 仅显示前 50 条</div>';
                            }
                          };
                        } catch(_) {
                          recordsDiv.innerHTML = '<div style="color:#f44747;padding:2px 4px">读取失败（可能事务已关闭，请重新切换到 IndexedDB tab）</div>';
                        }
                      }
                    });
                    storeDiv.appendChild(recordsDiv);
                    content.appendChild(storeDiv);
                  })(sn[si]);
                }
                // 延迟关闭 db，等事务完成
                tx.oncomplete = function() { db.close(); };
              };
              req.onerror = function() {
                content.innerHTML = '<div style="color:#f44747;padding:4px 8px">打开数据库失败</div>';
              };
            }
          });
          sec.appendChild(content);
          container.appendChild(sec);
        })(dbs[di]);
      }
    }).catch(function() {
      container.innerHTML = '<div style="color:#f44747;padding:8px">读取数据库列表失败</div>';
    });
  }

  function _renderStorageKVs(container, storage, name) {
    if (storage.length === 0) {
      var empty = document.createElement('div');
      empty.style.cssText = 'color:#888;padding:8px';
      empty.textContent = '空';
      container.appendChild(empty);
      return;
    }
    for (var i = 0; i < storage.length; i++) {
      var k = storage.key(i);
      if (name === 'sessionStorage' && (k === '__env_dump_recording__' || k === '__pg_dev_state__')) continue;
      var v = storage.getItem(k);
      var row = document.createElement('div');
      row.className = '__pg_store_kv__';

      var keySpan = document.createElement('span');
      keySpan.className = 'k';
      keySpan.textContent = k;
      var valSpan = document.createElement('span');
      valSpan.className = 'v';
      valSpan.textContent = v.length > 120 ? v.slice(0,120) + '...' : v;
      // 点击 value 展开完整内容
      if (v.length > 120) {
        (function(full, span) {
          var expanded = false;
          span.style.cursor = 'pointer';
          span.addEventListener('click', function(e) {
            e.stopPropagation();
            expanded = !expanded;
            span.textContent = expanded ? full : full.slice(0,120) + '...';
          });
        })(v, valSpan);
      }

      var actions = document.createElement('span');
      actions.className = '__pg_store_actions__';
      var editBtn = document.createElement('button');
      editBtn.textContent = 'Edit';
      var delBtn = document.createElement('button');
      delBtn.textContent = 'Del';
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      (function(key, store) {
        editBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          var cur = store.getItem(key);
          var newVal = prompt('Edit value for "' + key + '":', cur);
          if (newVal !== null) { store.setItem(key, newVal); _renderTab(); }
        });
        delBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          if (confirm('Delete "' + key + '"?')) { store.removeItem(key); _renderTab(); }
        });
      })(k, storage);

      row.appendChild(keySpan);
      row.appendChild(document.createTextNode(': '));
      row.appendChild(valSpan);
      row.appendChild(actions);
      container.appendChild(row);
    }
  }

  // ================================================================
  // 面板触发方式：
  //   1. 三指长按 3 秒（Safari/Chrome）
  //   2. URL 含 ll_debug 参数自动打开
  //   3. 桌面 Ctrl+Shift+D
  // ================================================================
  var _holdTimer = null;

  document.addEventListener('touchstart', function (e) {
    _cancelHold();
    if (e.touches.length === 3) {
      _holdTimer = setTimeout(function () {
        toggle();
        try { navigator.vibrate && navigator.vibrate(50); } catch(_) {}
      }, 3000);
    }
  }, { passive: true });

  document.addEventListener('touchend', _cancelHold, { passive: true });
  document.addEventListener('touchcancel', _cancelHold, { passive: true });
  function _cancelHold() { if (_holdTimer) { clearTimeout(_holdTimer); _holdTimer = null; } }

  // URL 参数触发：URL 含 ll_debug 参数时自动打开面板
  // 兼容普通路由（?ll_debug）和 hash 路由（#/path?ll_debug）
  if (/[?&]ll_debug([=&]|$)/.test(location.search + location.hash)) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        if (!_visible) { _visible = true; _create(); }
      });
    } else {
      if (!_visible) { _visible = true; _create(); }
    }
  }

  // 桌面快捷键：Ctrl+Shift+D
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') { e.preventDefault(); toggle(); }
  });

})();
