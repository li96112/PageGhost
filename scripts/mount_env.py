"""
mount_env.py - 页面还原 + 调试面板 (V5)

核心思路：
  1. 读取 snapshot JSON
  2. 将 DOM 中所有外部 CSS/JS 内联（解决 ngrok 等拦截问题）
  3. 注入左侧调试面板（Tab 弹窗查看详细信息）
  4. 注入网络 replay 拦截器
  5. 启动本地 HTTP Server
  6. 自动打开浏览器

用法：
  python mount_env.py --import snapshot.json
  python mount_env.py --import snapshot.json --port 8080
  python mount_env.py --import snapshot.json --assets /tmp/site_assets
"""

import json
import os
import sys
import re
import argparse
import webbrowser
import urllib.parse
import urllib.request
import ssl
import hashlib
import getpass
from http.server import HTTPServer, BaseHTTPRequestHandler

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE


# ================================================================
# 1. 资源内联器 — 将外部 CSS/JS 内联到 HTML 中
# ================================================================
def _fetch_url(url, timeout=10):
    """获取 URL 内容，自动处理 ngrok 拦截。"""
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'ngrok-skip-browser-warning': 'true',
        'Accept': '*/*'
    }
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as resp:
            content = resp.read()
            # 检查是否是 ngrok 拦截页
            if len(content) < 300 and b'ERR_NGROK' in content:
                return None
            return content
    except Exception:
        return None


def _resolve_url(src, base_url):
    """将相对路径解析为绝对 URL。"""
    if src.startswith('http://') or src.startswith('https://') or src.startswith('//'):
        if src.startswith('//'):
            src = 'https:' + src
        return src
    # 相对路径
    return urllib.parse.urljoin(base_url, src)


def inline_resources(dom, base_url, assets_dir=None):
    """将 DOM 中的 <link stylesheet> 和 <script src> 替换为内联内容。"""
    inlined_count = 0

    def _read_from_assets(src):
        """从本地 assets 目录读取文件。"""
        if not assets_dir:
            return None
        clean = src.split('?')[0].lstrip('./')
        # 直接路径
        path = os.path.join(assets_dir, clean)
        if os.path.isfile(path):
            with open(path, 'rb') as f:
                return f.read()
        # domain 子目录
        try:
            for d in os.listdir(assets_dir):
                candidate = os.path.join(assets_dir, d, clean)
                if os.path.isfile(candidate):
                    with open(candidate, 'rb') as f:
                        return f.read()
        except OSError:
            pass
        return None

    def _get_content(src):
        """优先从 assets 读取，其次从网络获取。"""
        content = _read_from_assets(src)
        if content and len(content) > 300:
            return content
        full_url = _resolve_url(src, base_url)
        content = _fetch_url(full_url)
        if content and len(content) > 300:
            return content
        return None

    # 内联 CSS: <link rel="stylesheet" href="..."> → <style>...</style>
    def replace_css(match):
        nonlocal inlined_count
        tag = match.group(0)
        href_match = re.search(r'href=["\']([^"\']+)["\']', tag)
        rel_match = re.search(r'rel=["\']([^"\']+)["\']', tag)
        if not href_match or not rel_match:
            return tag
        if 'stylesheet' not in rel_match.group(1).lower():
            return tag
        href = href_match.group(1)
        content = _get_content(href)
        if content:
            css_text = content.decode('utf-8', errors='replace')
            css_text = re.sub(r'<(/style)', r'\\3C\1', css_text, flags=re.IGNORECASE)
            inlined_count += 1
            return f'<style data-inlined-from="{href}">\n{css_text}\n</style>'
        return tag

    dom = re.sub(r'<link[^>]+>', replace_css, dom)

    # 内联 JS: <script src="..."></script> → <script>...</script>
    def replace_js(match):
        nonlocal inlined_count
        tag_open = match.group(1)
        src_match = re.search(r'src=["\']([^"\']+)["\']', tag_open)
        if not src_match:
            return match.group(0)
        src = src_match.group(1)
        # 跳过 env_dump.js
        if 'env_dump' in src or '__ENV_DUMP__' in src:
            return ''
        content = _get_content(src)
        if content:
            js_text = content.decode('utf-8', errors='replace')
            # 内联的 JS 中可能包含 HTML 标签字符串（模板字符串、字符串拼接等）
            # HTML parser 会把 <tag、</tag、<!-- 当成真实标签，破坏页面结构
            # 用 \u003c 替换，JS 引擎能正确识别
            js_text = re.sub(r'<(/?[a-zA-Z!])', lambda m: '\\u003c' + m.group(1), js_text)
            inlined_count += 1
            return f'<script data-inlined-from="{src}">\n{js_text}\n</script>'
        return match.group(0)

    dom = re.sub(r'(<script[^>]+src=["\'][^"\']+["\'][^>]*>)\s*</script>', replace_js, dom)

    print(f"[*] 内联了 {inlined_count} 个 CSS/JS 资源")
    return dom


# ================================================================
# 2. DOM 清理
# ================================================================
def clean_dom(dom):
    """移除 env_dump 录制脚本和指示器。"""
    # 移除包含 __ENV_DUMP__ 的 script
    for marker in ['__ENV_DUMP__', 'data-env-restore']:
        while True:
            idx = dom.find(marker)
            if idx == -1:
                break
            s = dom.rfind('<script', 0, idx)
            e = dom.find('</script>', idx)
            if s != -1 and e != -1:
                dom = dom[:s] + dom[e + 9:]
            else:
                break

    # 移除 env_dump src 引用
    for src_marker in ['env_dump.js']:
        idx = dom.find(src_marker)
        if idx != -1:
            s = dom.rfind('<script', 0, idx)
            e = dom.find('</script>', idx)
            if e == -1:
                e = dom.find('>', idx)
                if s != -1 and e != -1:
                    dom = dom[:s] + dom[e + 1:]
            elif s != -1:
                dom = dom[:s] + dom[e + 9:]

    # 移除指示器
    for marker in ['__env_dump_indicator__', '__env_dump_style__', '__env_restore_bar__']:
        idx = dom.find(marker)
        if idx != -1:
            s = dom.rfind('<', 0, idx)
            te = dom.find('>', s)
            if te == -1:
                continue
            tag = dom[s + 1:te].split()[0].split('/')[0].lower()
            close = f'</{tag}>'
            e = dom.find(close, te)
            if s != -1 and e != -1:
                dom = dom[:s] + dom[e + len(close):]
    return dom


# ================================================================
# 3. 还原脚本（Storage / Globals / Network Replay / 表单 / 滚动）
# ================================================================
def _safe_json_for_html(obj):
    """JSON 序列化后转义所有 <，防止 HTML parser 解析 JSON 中的标签。"""
    return json.dumps(obj, ensure_ascii=False).replace('<', '\\u003c')


def build_restore_script(data):
    """构建注入页面的还原脚本。"""
    storage = data.get('storage', {})
    runtime = data.get('runtime', {})
    css_vars = data.get('cssVariables', {})
    interaction = data.get('interaction', {})
    form_state = data.get('formState', [])
    network_replay = data.get('networkReplay', [])
    idb_data = data.get('indexedDB', {})

    return f"""<script data-env-restore="true">
(function() {{
  // --- Storage ---
  try {{
    var ls = {_safe_json_for_html(storage.get('localStorage', {}))};
    for (var k in ls) localStorage.setItem(k, ls[k]);
  }} catch(e) {{}}
  try {{
    var ss = {_safe_json_for_html(storage.get('sessionStorage', {}))};
    for (var k in ss) sessionStorage.setItem(k, ss[k]);
  }} catch(e) {{}}

  // --- Globals ---
  try {{
    var _is = {_safe_json_for_html(runtime.get('initialState'))};
    if (_is !== null) window.__INITIAL_STATE__ = _is;
    var _as = {_safe_json_for_html(runtime.get('appState'))};
    if (_as !== null) window.__APP_STATE__ = _as;
    var _nd = {_safe_json_for_html(runtime.get('nuxtData'))};
    if (_nd !== null) window.__NUXT__ = _nd;
    var _nxd = {_safe_json_for_html(runtime.get('nextData'))};
    if (_nxd !== null) window.__NEXT_DATA__ = _nxd;
  }} catch(e) {{}}

  // --- history.state ---
  try {{
    var hs = {_safe_json_for_html(runtime.get('historyState'))};
    if (hs !== null) history.replaceState(hs, '');
  }} catch(e) {{}}

  // --- CSS Variables ---
  try {{
    var cv = {_safe_json_for_html(css_vars)};
    for (var k in cv) document.documentElement.style.setProperty(k, cv[k]);
  }} catch(e) {{}}

  // --- Network Replay ---
  var _entries = {_safe_json_for_html(network_replay)};
  var _map = {{}};
  _entries.forEach(function(e) {{
    if (!e.url || e.error) return;
    try {{
      var u = new URL(e.url);
      _map[u.pathname + u.search] = e;
      _map[u.pathname] = e;
    }} catch(ex) {{ _map[e.url] = e; }}
  }});

  function _find(url) {{
    if (_map[url]) return _map[url];
    try {{
      var u = new URL(url, location.origin);
      return _map[u.pathname + u.search] || _map[u.pathname] || null;
    }} catch(e) {{ return null; }}
  }}

  function _b64(b) {{
    var s = atob(b), a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a.buffer;
  }}

  var _origFetch = window.fetch;
  window.fetch = function() {{
    var url = typeof arguments[0] === 'string' ? arguments[0] : arguments[0] instanceof Request ? arguments[0].url : String(arguments[0]);
    var r = _find(url);
    if (r && r.body) {{
      return new Promise(function(resolve) {{
        setTimeout(function() {{
          resolve(new Response(_b64(r.body), {{
            status: r.status || 200,
            statusText: r.statusText || 'OK',
            headers: new Headers(r.responseHeaders || {{}})
          }}));
        }}, Math.min(r.latency || 0, 2000));
      }});
    }}
    return _origFetch.apply(this, arguments);
  }};

  var _xo = XMLHttpRequest.prototype.open, _xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u) {{ this._ru = u; return _xo.apply(this, arguments); }};
  XMLHttpRequest.prototype.send = function() {{
    var self = this, r = _find(self._ru || '');
    if (r && r.body) {{
      setTimeout(function() {{
        var b = _b64(r.body), t = new TextDecoder().decode(b);
        Object.defineProperty(self, 'status', {{ get: function() {{ return r.status || 200; }} }});
        Object.defineProperty(self, 'readyState', {{ get: function() {{ return 4; }}, configurable: true }});
        Object.defineProperty(self, 'responseText', {{ get: function() {{ return t; }} }});
        Object.defineProperty(self, 'response', {{ get: function() {{ return self.responseType === 'json' ? JSON.parse(t) : t; }} }});
        self.dispatchEvent(new Event('readystatechange'));
        self.dispatchEvent(new Event('load'));
        self.dispatchEvent(new Event('loadend'));
      }}, Math.min(r.latency || 0, 2000));
      return;
    }}
    return _xs.apply(this, arguments);
  }};

  // --- IndexedDB ---
  var _idb = {_safe_json_for_html(idb_data)};
  if (Object.keys(_idb).length > 0) {{
    (async function() {{
      for (var dn in _idb) {{
        var stores = _idb[dn];
        await new Promise(function(res) {{
          var dr = indexedDB.deleteDatabase(dn);
          dr.onsuccess = dr.onerror = function() {{
            var or = indexedDB.open(dn);
            or.onupgradeneeded = function(e) {{
              var db = e.target.result;
              for (var sn in stores) {{
                var m = stores[sn].meta || {{}}, o = {{}};
                if (m.keyPath != null) o.keyPath = m.keyPath;
                if (m.autoIncrement) o.autoIncrement = true;
                var s = db.createObjectStore(sn, o);
                (m.indexes || []).forEach(function(ix) {{
                  s.createIndex(ix.name, ix.keyPath, {{ unique: !!ix.unique, multiEntry: !!ix.multiEntry }});
                }});
              }}
            }};
            or.onsuccess = function(e) {{
              var db = e.target.result, sns = Array.from(db.objectStoreNames);
              if (!sns.length) {{ db.close(); res(); return; }}
              var tx = db.transaction(sns, 'readwrite');
              for (var sn in stores) {{
                if (!db.objectStoreNames.contains(sn)) continue;
                (stores[sn].records || []).forEach(function(r) {{ tx.objectStore(sn).put(r); }});
              }}
              tx.oncomplete = function() {{ db.close(); res(); }};
              tx.onerror = function() {{ db.close(); res(); }};
            }};
            or.onerror = function() {{ res(); }};
          }};
        }});
      }}
    }})();
  }}

  // --- Post-load: form, scroll, focus ---
  window.addEventListener('DOMContentLoaded', function() {{
    var fd = {_safe_json_for_html(form_state)};
    fd.forEach(function(item) {{
      var el = null;
      if (item.selector) try {{ el = document.querySelector(item.selector); }} catch(e) {{}}
      if (!el && item.id) el = document.getElementById(item.id);
      if (!el) return;
      if (item.tagName === 'SELECT') el.selectedIndex = item.selectedIndex || 0;
      else if (item.type === 'checkbox' || item.type === 'radio') el.checked = !!item.checked;
      else if (item.value !== undefined) el.value = item.value;
      el.dispatchEvent(new Event('input', {{ bubbles: true }}));
      el.dispatchEvent(new Event('change', {{ bubbles: true }}));
    }});
    var sc = {_safe_json_for_html(interaction.get('scroll', {'x': 0, 'y': 0}))};
    window.scrollTo(sc.x, sc.y);
    var fs = {_safe_json_for_html(interaction.get('focus'))};
    if (fs) try {{ var e = document.querySelector(fs); if (e) e.focus(); }} catch(e) {{}}
  }});
}})();
</script>"""


# ================================================================
# 4. 调试面板（左侧浮窗）
# ================================================================
def build_debug_panel(data):
    """构建左侧调试面板 HTML/CSS/JS — 完全自包含。"""
    # JSON 中包含完整 DOM（有 <script>、<!-- --> 等），必须转义所有 <
    _safe_json = json.dumps(data, ensure_ascii=False).replace('<', '\\u003c')
    return f"""
<style id="__dbg_style__">
#__dbg_toggle__ {{
  position:fixed; left:0; top:50%; transform:translateY(-50%); z-index:2147483646;
  width:28px; height:80px; background:#1e1e2e; border:1px solid #89b4fa;
  border-left:none; border-radius:0 8px 8px 0; cursor:pointer;
  display:flex; align-items:center; justify-content:center;
  color:#89b4fa; font-size:14px; writing-mode:vertical-lr;
  font-family:-apple-system,system-ui,sans-serif; box-shadow:2px 0 8px rgba(0,0,0,0.3);
}}
#__dbg_toggle__:hover {{ background:#2d2d44; }}
#__dbg_panel__ {{
  all:initial; position:fixed; left:0; top:0; bottom:0; width:320px; z-index:2147483645;
  background:#1e1e2e !important; color:#cdd6f4 !important; font-family:-apple-system,system-ui,sans-serif;
  font-size:12px; line-height:1.4; border-right:2px solid #89b4fa; box-shadow:4px 0 16px rgba(0,0,0,0.4);
  display:none; flex-direction:column; overflow:hidden;
}}
#__dbg_panel__ *,#__dbg_panel__ *::before,#__dbg_panel__ *::after {{ box-sizing:border-box; font-family:inherit; line-height:inherit; }}
#__dbg_panel__ div,#__dbg_panel__ span,#__dbg_panel__ p {{ color:inherit; }}
#__dbg_panel__.open {{ display:flex; }}
#__dbg_panel__ .hdr {{
  padding:10px 12px; background:#181825; border-bottom:1px solid #313244;
  font-weight:700; color:#89b4fa; font-size:13px; display:flex; align-items:center; justify-content:space-between;
}}
#__dbg_panel__ .hdr .close {{ cursor:pointer; font-size:16px; color:#6c7086; }}
#__dbg_panel__ .hdr .close:hover {{ color:#f38ba8; }}
#__dbg_panel__ .tabs {{
  display:flex; flex-wrap:wrap; gap:2px; padding:6px 8px; background:#181825; border-bottom:1px solid #313244;
}}
#__dbg_panel__ .tab {{
  padding:4px 8px; border-radius:4px; cursor:pointer; background:#313244 !important; color:#a6adc8 !important;
  font-size:11px; white-space:nowrap;
}}
#__dbg_panel__ .tab:hover {{ background:#45475a; color:#cdd6f4; }}
#__dbg_panel__ .tab .badge {{
  display:inline-block; background:#89b4fa; color:#1e1e2e; border-radius:8px;
  padding:0 5px; font-size:10px; margin-left:4px; font-weight:700;
}}
#__dbg_panel__ .tab .badge.err {{ background:#f38ba8; }}
#__dbg_panel__ .info {{ padding:8px 12px; overflow-y:auto; flex:1; }}
#__dbg_panel__ .info-row {{ padding:3px 0; border-bottom:1px solid #313244; display:flex; gap:6px; }}
#__dbg_panel__ .info-label {{ color:#6c7086 !important; min-width:60px; flex-shrink:0; }}
#__dbg_panel__ .info-val {{ color:#cdd6f4 !important; word-break:break-all; }}

/* 弹窗 */
#__dbg_modal_overlay__ {{
  position:fixed; inset:0; z-index:2147483647; background:rgba(0,0,0,0.6);
  display:none; align-items:center; justify-content:center;
}}
#__dbg_modal_overlay__.open {{ display:flex; }}
#__dbg_modal__ {{
  all:initial; background:#1e1e2e !important; color:#cdd6f4 !important; border:1px solid #89b4fa; border-radius:8px;
  width:90vw; max-width:1000px; height:80vh; display:flex; flex-direction:column;
  box-shadow:0 8px 32px rgba(0,0,0,0.5); font-family:-apple-system,system-ui,sans-serif; font-size:12px; line-height:1.4;
}}
#__dbg_modal__ *,#__dbg_modal__ *::before,#__dbg_modal__ *::after {{ box-sizing:border-box; font-family:inherit; line-height:inherit; }}
#__dbg_modal__ div,#__dbg_modal__ span,#__dbg_modal__ p,#__dbg_modal__ td,#__dbg_modal__ th {{ color:inherit; }}
#__dbg_modal__ .m-hdr {{
  padding:12px 16px; background:#181825; border-bottom:1px solid #313244;
  display:flex; align-items:center; justify-content:space-between;
  font-weight:700; color:#89b4fa; font-size:14px; border-radius:8px 8px 0 0;
}}
#__dbg_modal__ .m-hdr .m-close {{ cursor:pointer; font-size:18px; color:#6c7086; }}
#__dbg_modal__ .m-hdr .m-close:hover {{ color:#f38ba8; }}
#__dbg_modal__ .m-filter {{
  padding:8px 16px; background:#181825; border-bottom:1px solid #313244;
  display:flex; gap:8px; align-items:center; flex-wrap:wrap;
}}
#__dbg_modal__ .m-filter input {{
  background:#313244; border:1px solid #45475a; border-radius:4px; color:#cdd6f4;
  padding:4px 8px; font-size:12px; flex:1; min-width:150px; outline:none;
}}
#__dbg_modal__ .m-filter input:focus {{ border-color:#89b4fa; }}
#__dbg_modal__ .m-filter .fbtn {{
  padding:3px 8px; border-radius:4px; cursor:pointer; background:#313244; color:#a6adc8;
  font-size:11px; border:1px solid transparent;
}}
#__dbg_modal__ .m-filter .fbtn.active {{ background:#89b4fa; color:#1e1e2e; }}
#__dbg_modal__ .m-filter .fbtn:hover {{ border-color:#89b4fa; }}
#__dbg_modal__ .m-body {{ flex:1; overflow-y:auto; padding:0; }}
#__dbg_modal__ .m-body table {{ width:100%; border-collapse:collapse; font-size:12px; }}
#__dbg_modal__ .m-body th {{
  position:sticky; top:0; background:#181825 !important; color:#89b4fa !important; padding:8px 12px;
  text-align:left; border-bottom:1px solid #313244; font-weight:600;
}}
#__dbg_modal__ .m-body td {{ padding:6px 12px; border-bottom:1px solid #313244; vertical-align:top; color:#cdd6f4 !important; }}
#__dbg_modal__ .m-body tr:hover {{ background:#313244; cursor:pointer; }}
.badge-method {{ padding:2px 6px; border-radius:3px; font-size:10px; font-weight:700; color:#fff; }}
.badge-method.GET {{ background:#3b82f6; }} .badge-method.POST {{ background:#22c55e; }}
.badge-method.PUT {{ background:#f97316; }} .badge-method.DELETE {{ background:#ef4444; }}
.badge-method.PATCH {{ background:#a855f7; }}
.badge-status {{ padding:1px 5px; border-radius:3px; font-size:11px; }}
.s2xx {{ background:#166534; color:#a6e3a1; }} .s3xx {{ background:#1e3a5f; color:#89b4fa; }}
.s4xx {{ background:#78350f; color:#fbbf24; }} .s5xx {{ background:#7f1d1d; color:#f38ba8; }}
.badge-level {{ padding:1px 5px; border-radius:3px; font-size:10px; font-weight:700; }}
.lvl-log {{ background:#45475a; color:#a6adc8; }} .lvl-info {{ background:#1e3a5f; color:#89b4fa; }}
.lvl-warn {{ background:#78350f; color:#fbbf24; }} .lvl-error,.lvl-uncaught,.lvl-unhandledrejection {{ background:#7f1d1d; color:#f38ba8; }}
.lvl-debug {{ background:#313244; color:#6c7086; }}

/* 详情面板 */
#__dbg_detail_overlay__ {{
  position:fixed; inset:0; z-index:2147483647; background:rgba(0,0,0,0.6);
  display:none; align-items:center; justify-content:center;
}}
#__dbg_detail_overlay__.open {{ display:flex; }}
#__dbg_detail__ {{
  all:initial; background:#1e1e2e !important; color:#cdd6f4 !important; border:1px solid #89b4fa; border-radius:8px;
  width:85vw; max-width:900px; height:75vh; display:flex; flex-direction:column;
  box-shadow:0 8px 32px rgba(0,0,0,0.5); font-family:-apple-system,system-ui,sans-serif; font-size:12px; line-height:1.4;
}}
#__dbg_detail__ *,#__dbg_detail__ *::before,#__dbg_detail__ *::after {{ box-sizing:border-box; font-family:inherit; line-height:inherit; }}
#__dbg_detail__ div,#__dbg_detail__ span,#__dbg_detail__ p {{ color:inherit; }}
#__dbg_detail__ .d-hdr {{
  padding:10px 16px; background:#181825; border-bottom:1px solid #313244;
  font-weight:700; color:#89b4fa; font-size:13px; display:flex; align-items:center; justify-content:space-between;
  border-radius:8px 8px 0 0;
}}
#__dbg_detail__ .d-hdr .d-close {{ cursor:pointer; font-size:18px; color:#6c7086; }}
#__dbg_detail__ .d-hdr .d-close:hover {{ color:#f38ba8; }}
#__dbg_detail__ .d-body {{ flex:1; overflow-y:auto; padding:12px 16px; }}
.d-section {{ margin-bottom:12px; }}
.d-section-title {{ color:#89b4fa; font-weight:700; font-size:12px; margin-bottom:4px; border-bottom:1px solid #313244; padding-bottom:4px; }}
.d-kv {{ display:grid; grid-template-columns:180px 1fr; gap:2px 8px; font-size:11px; }}
.d-kv .dk {{ color:#6c7086 !important; padding:2px 0; }} .d-kv .dv {{ color:#cdd6f4 !important; padding:2px 0; word-break:break-all; }}
.d-pre {{ background:#181825 !important; border:1px solid #313244; border-radius:4px; padding:8px; font-size:11px;
  color:#a6e3a1 !important; white-space:pre-wrap; word-break:break-all; max-height:300px; overflow-y:auto; font-family:monospace; }}
.d-copy {{ padding:2px 8px; background:#313244; color:#89b4fa; border:1px solid #45475a;
  border-radius:3px; cursor:pointer; font-size:10px; margin-left:8px; }}
.d-copy:hover {{ background:#45475a; }}
</style>

<div id="__dbg_toggle__" onclick="document.getElementById('__dbg_panel__').classList.toggle('open'); this.style.display='none';">DEBUG</div>

<div id="__dbg_panel__">
  <div class="hdr">
    <span>🔍 调试面板</span>
    <span class="close" onclick="this.closest('#__dbg_panel__').classList.remove('open'); document.getElementById('__dbg_toggle__').style.display='flex';">✕</span>
  </div>
  <div class="tabs" id="__dbg_tabs__"></div>
  <div class="info" id="__dbg_info__"></div>
</div>

<div id="__dbg_modal_overlay__" onclick="if(event.target===this)this.classList.remove('open')">
  <div id="__dbg_modal__">
    <div class="m-hdr"><span id="__dbg_modal_title__"></span><span class="m-close" onclick="document.getElementById('__dbg_modal_overlay__').classList.remove('open')">✕</span></div>
    <div class="m-filter" id="__dbg_modal_filter__"></div>
    <div class="m-body" id="__dbg_modal_body__"></div>
  </div>
</div>

<div id="__dbg_detail_overlay__" onclick="if(event.target===this)this.classList.remove('open')">
  <div id="__dbg_detail__">
    <div class="d-hdr"><span id="__dbg_detail_title__"></span><span class="d-close" onclick="document.getElementById('__dbg_detail_overlay__').classList.remove('open')">✕</span></div>
    <div class="d-body" id="__dbg_detail_body__"></div>
  </div>
</div>

<script data-env-restore="true">
(function() {{
  var DATA = {_safe_json};
  var meta = DATA.metadata || {{}};
  var fp = DATA.fingerprint || {{}};
  var scr = fp.screen || {{}};
  var storage = DATA.storage || {{}};
  var network = DATA.networkReplay || [];
  var logs = DATA.consoleLogs || [];
  var forms = DATA.formState || [];
  var wsReplay = DATA.wsReplay || [];
  var cssVars = DATA.cssVariables || {{}};
  var idb = DATA.indexedDB || {{}};
  var runtime = DATA.runtime || {{}};
  var perms = DATA.permissions || {{}};
  var sw = DATA.serviceWorkers || [];
  var errors = logs.filter(function(l) {{ return l.level === 'error' || l.level === 'uncaught' || l.level === 'unhandledrejection'; }});

  // --- 概览 ---
  var info = document.getElementById('__dbg_info__');
  var rows = [
    ['URL', meta.url || 'N/A'],
    ['时间', meta.timestamp || 'N/A'],
    ['UA', (meta.userAgent || '').substring(0, 80)],
    ['屏幕', (scr.width||'?') + '×' + (scr.height||'?') + ' @' + (scr.dpr||'?') + 'x'],
    ['时区', fp.timezone || 'N/A'],
    ['语言', fp.language || 'N/A'],
    ['主题', fp.prefersColorScheme || 'N/A'],
    ['触屏', fp.touch ? '是 (' + (fp.maxTouchPoints||0) + '点)' : '否'],
    ['GPU', fp.gpu || 'N/A'],
    ['网络', fp.connection ? fp.connection.effectiveType + ' ↓' + fp.connection.downlink + 'Mbps' : 'N/A'],
  ];
  info.innerHTML = rows.map(function(r) {{
    return '<div class="info-row"><span class="info-label">' + r[0] + '</span><span class="info-val">' + _esc(r[1]) + '</span></div>';
  }}).join('');

  // --- Tabs ---
  var tabs = [
    {{ name: '网络', count: network.length, fn: showNetwork }},
    {{ name: '错误', count: errors.length, cls: errors.length ? 'err' : '', fn: showErrors }},
    {{ name: '日志', count: logs.length, fn: showLogs }},
    {{ name: '存储', count: Object.keys(storage.localStorage||{{}}).length + Object.keys(storage.sessionStorage||{{}}).length, fn: showStorage }},
    {{ name: '表单', count: forms.length, fn: showForms }},
    {{ name: '状态', count: Object.keys(runtime).filter(function(k){{ return runtime[k] !== null; }}).length, fn: showRuntime }},
    {{ name: 'WS', count: wsReplay.length, fn: showWS }},
    {{ name: 'CSS', count: Object.keys(cssVars).length, fn: showCSS }},
  ];
  var tabsEl = document.getElementById('__dbg_tabs__');
  tabsEl.innerHTML = tabs.map(function(t) {{
    return '<div class="tab" onclick="__dbgTabs__[' + tabs.indexOf(t) + '].fn()"><span>' + t.name + '</span><span class="badge ' + (t.cls||'') + '">' + t.count + '</span></div>';
  }}).join('');
  window.__dbgTabs__ = tabs;

  function _esc(s) {{ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }}
  function _statusCls(s) {{ s=+s; if(s<300)return 's2xx'; if(s<400)return 's3xx'; if(s<500)return 's4xx'; return 's5xx'; }}
  function _tryJson(s) {{ try {{ return JSON.stringify(JSON.parse(s), null, 2); }} catch(e) {{ return s; }} }}
  function _b64decode(b) {{ try {{ return decodeURIComponent(escape(atob(b))); }} catch(e) {{ try {{ return atob(b); }} catch(e2) {{ return '[decode error]'; }} }} }}

  function openModal(title, filterHtml, bodyHtml) {{
    document.getElementById('__dbg_modal_title__').textContent = title;
    document.getElementById('__dbg_modal_filter__').innerHTML = filterHtml;
    document.getElementById('__dbg_modal_body__').innerHTML = bodyHtml;
    document.getElementById('__dbg_modal_overlay__').classList.add('open');
  }}

  function openDetail(title, html) {{
    document.getElementById('__dbg_detail_title__').textContent = title;
    document.getElementById('__dbg_detail_body__').innerHTML = html;
    document.getElementById('__dbg_detail_overlay__').classList.add('open');
  }}

  // ---- 网络 ----
  function _netCategory(e) {{
    // 非 resource 类型直接分类
    if (e.type === 'fetch' || e.type === 'xhr' || e.type === 'beacon') return 'Fetch/XHR';
    if (e.type === 'resource-error') {{
      var eit = (e.initiatorType || '').toLowerCase();
      if (eit === 'img') return 'Img';
      if (eit === 'script') return 'JS';
      if (eit === 'link') return 'CSS';
      if (eit === 'iframe') return 'Doc';
      return 'Other';
    }}
    // resource 类型：优先按 URL 特征判断（initiatorType 不一定准确）
    var url = (e.url || '').split('?')[0].toLowerCase();
    var fullUrl = (e.url || '').toLowerCase();
    var it = (e.initiatorType || '').toLowerCase();
    // Font（优先，因为 fonts.googleapis.com 返回的是 CSS 但本质是字体请求）
    if (/\.(woff2?|ttf|otf|eot)$/.test(url) || /fonts\.(googleapis|gstatic)\.com/.test(fullUrl)) return 'Font';
    // Img
    if (it === 'img' || it === 'image' || /\.(png|jpe?g|gif|svg|webp|ico|bmp|avif)$/.test(url)) return 'Img';
    // JS
    if (it === 'script' || /\.js$/.test(url)) return 'JS';
    // CSS
    if (it === 'link' || it === 'css' || /\.css$/.test(url)) return 'CSS';
    // Media
    if (/\.(mp4|webm|m3u8|ts|mp3|ogg|wav|flac|aac)$/.test(url) || it === 'video' || it === 'audio') return 'Media';
    // Doc
    if (it === 'document' || it === 'iframe' || /\.html?$/.test(url)) return 'Doc';
    // Wasm
    if (/\.wasm$/.test(url)) return 'Wasm';
    // Manifest
    if (/manifest\.json$/.test(url) || /\.webmanifest$/.test(url)) return 'Manifest';
    // WS（websocket 条目如果有的话）
    // translate 脚本
    if (/translate/.test(fullUrl) && /\.js/.test(url)) return 'JS';
    if (/gstatic\.com/.test(fullUrl)) return 'JS';
    // fallback
    if (it === 'xmlhttprequest' || it === 'fetch') return 'Fetch/XHR';
    return 'Other';
  }}

  function showNetwork() {{
    // 统计各分类数量
    var catOrder = ['All','Fetch/XHR','Doc','CSS','JS','Font','Img','Media','WS','Wasm','Manifest','Other'];
    var cats = {{}};
    catOrder.forEach(function(c) {{ cats[c] = 0; }});
    cats['All'] = network.length;
    network.forEach(function(e) {{ cats[_netCategory(e)]++; }});

    var filter = '<input type="text" placeholder="Filter" oninput="__dbgFilterNet__(this.value)">';
    catOrder.forEach(function(f) {{
      filter += '<span class="fbtn' + (f === 'All' ? ' active' : '') + '" data-netfilter="' + f + '">' + f + '</span>';
    }});

    var rows = network.map(function(e, i) {{
      var m = e.method || 'GET';
      var url = _esc((e.url||'').substring(0, 100));
      var cat = _netCategory(e);
      var st = e.error ? '<span style="color:#f38ba8">FAIL</span>'
        : e.statusText === 'in-flight' ? '<span style="color:#fbbf24">pending</span>'
        : '<span class="badge-status ' + _statusCls(e.status) + '">' + e.status + '</span>';
      // 从 URL 中提取文件名
      var fname = (e.url||'').split('?')[0].split('/').pop() || e.url || '';
      if (fname.length > 40) fname = fname.substring(0, 37) + '...';
      return '<tr data-idx="' + i + '" data-cat="' + cat + '" onclick="__dbgNetDetail__(' + i + ')">' +
        '<td style="color:#cdd6f4 !important">' + _esc(fname) + '</td>' +
        '<td>' + st + '</td>' +
        '<td><span class="badge-method ' + m + '">' + m + '</span></td>' +
        '<td style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#89b4fa !important" title="' + _esc(e.url) + '">' + _esc((e.url||'').replace(/https?:\/\/[^/]+/,'')) + '</td>' +
        '<td style="text-align:right">' + (e.latency||0) + ' ms</td>' +
        '<td style="text-align:right;color:#a6adc8 !important">' + (e.transferSize ? (e.transferSize/1024).toFixed(1) + ' KB' : '—') + '</td></tr>';
    }}).join('');

    openModal('网络录制 (' + network.length + ')', filter,
      '<table><thead><tr><th>Name</th><th>Status</th><th>Method</th><th>Path</th><th style="text-align:right">Time</th><th style="text-align:right">Size</th></tr></thead><tbody id="__dbg_net_tbody__">' + rows + '</tbody></table>');
  }}

  window.__dbgFilterNet__ = function(q) {{
    q = q.toLowerCase();
    document.querySelectorAll('#__dbg_net_tbody__ tr').forEach(function(tr) {{
      var url = (network[+tr.dataset.idx] || {{}}).url || '';
      tr.style.display = url.toLowerCase().includes(q) ? '' : 'none';
    }});
  }};

  // Network 过滤 — 事件委托
  document.addEventListener('click', function(ev) {{
    var el = ev.target.closest('[data-netfilter]');
    if (!el) return;
    var type = el.getAttribute('data-netfilter');
    // 高亮当前选中的过滤按钮
    el.parentElement.querySelectorAll('.fbtn').forEach(function(b) {{ b.classList.remove('active'); }});
    el.classList.add('active');
    document.querySelectorAll('#__dbg_net_tbody__ tr').forEach(function(tr) {{
      var e = network[+tr.dataset.idx] || {{}};
      var cat = tr.dataset.cat || '';
      var show = true;
      if (type === 'All') show = true;
      else show = cat === type;
      tr.style.display = show ? '' : 'none';
    }});
  }});

  window.__dbgNetDetail__ = function(i) {{
    var e = network[i];
    var html = '';

    // 基本信息
    html += '<div class="d-section"><div class="d-section-title">基本信息</div><div class="d-kv">';
    html += '<div class="dk">URL</div><div class="dv">' + _esc(e.url) + '</div>';
    html += '<div class="dk">方法</div><div class="dv">' + (e.method||'GET') + '</div>';
    html += '<div class="dk">状态</div><div class="dv">' + (e.error ? 'FAIL: ' + _esc(e.error) : e.status) + '</div>';
    html += '<div class="dk">延迟</div><div class="dv">' + (e.latency||0) + 'ms</div>';
    html += '<div class="dk">类型</div><div class="dv">' + (e.type||'fetch') + '</div>';
    html += '</div></div>';

    // 请求头
    var rh = e.requestHeaders || {{}};
    if (Object.keys(rh).length) {{
      html += '<div class="d-section"><div class="d-section-title">请求头</div><div class="d-kv">';
      for (var k in rh) html += '<div class="dk">' + _esc(k) + '</div><div class="dv">' + _esc(rh[k]) + '</div>';
      html += '</div></div>';
    }}

    // 请求体
    if (e.requestBody) {{
      html += '<div class="d-section"><div class="d-section-title">请求参数 <button class="d-copy" onclick="navigator.clipboard.writeText(this.parentElement.nextElementSibling.textContent)">复制</button></div>';
      html += '<pre class="d-pre">' + _esc(_tryJson(e.requestBody)) + '</pre></div>';
    }}

    // 响应头
    var resh = e.responseHeaders || {{}};
    if (Object.keys(resh).length) {{
      html += '<div class="d-section"><div class="d-section-title">响应头</div><div class="d-kv">';
      for (var k in resh) html += '<div class="dk">' + _esc(k) + '</div><div class="dv">' + _esc(resh[k]) + '</div>';
      html += '</div></div>';
    }}

    // 响应体
    if (e.body) {{
      var decoded = _b64decode(e.body);
      var display = _tryJson(decoded);
      html += '<div class="d-section"><div class="d-section-title">响应内容 (' + decoded.length + ' 字符) <button class="d-copy" onclick="navigator.clipboard.writeText(this.parentElement.nextElementSibling.textContent)">复制</button></div>';
      html += '<pre class="d-pre">' + _esc(display) + '</pre></div>';
    }}

    openDetail((e.method||'GET') + ' ' + (e.url||'').substring(0, 60), html);
  }};

  // ---- 错误 ----
  function showErrors() {{
    var rows = errors.map(function(e, i) {{
      return '<tr><td>' + (i+1) + '</td><td><span class="badge-level lvl-' + e.level + '">' + e.level + '</span></td>' +
        '<td>' + _esc((e.message||'').substring(0, 200)) + '</td>' +
        '<td style="color:#6c7086">' + _esc(e.filename||'') + (e.lineno ? ':' + e.lineno : '') + '</td></tr>';
    }}).join('');
    openModal('错误 (' + errors.length + ')', '',
      '<table><thead><tr><th>#</th><th>级别</th><th>消息</th><th>位置</th></tr></thead><tbody>' + rows + '</tbody></table>');
  }}

  // ---- 日志 ----
  function showLogs() {{
    var filter = '<input type="text" placeholder="搜索..." oninput="__dbgFilterLogs__(this.value)">' +
      ['全部','log','warn','error','info','debug','uncaught'].map(function(f) {{
        return '<span class="fbtn" data-logfilter="' + f + '">' + f + '</span>';
      }}).join('');
    var rows = logs.map(function(e, i) {{
      var t = e.ts ? new Date(e.ts).toLocaleTimeString() : '';
      var msg = e.message || '';
      var preview = _esc(msg.substring(0, 300)) + (msg.length > 300 ? '…' : '');
      return '<tr data-idx="' + i + '" style="cursor:pointer"><td style="color:#6c7086;white-space:nowrap">' + t + '</td>' +
        '<td><span class="badge-level lvl-' + e.level + '">' + e.level + '</span></td>' +
        '<td>' + preview + '</td></tr>';
    }}).join('');
    openModal('Console 日志 (' + logs.length + ')', filter,
      '<table><thead><tr><th>时间</th><th>级别</th><th>消息</th></tr></thead><tbody id="__dbg_log_tbody__">' + rows + '</tbody></table>');
  }}

  window.__dbgFilterLogs__ = function(q) {{
    q = q.toLowerCase();
    document.querySelectorAll('#__dbg_log_tbody__ tr').forEach(function(tr) {{
      var e = logs[+tr.dataset.idx] || {{}};
      tr.style.display = (e.message||'').toLowerCase().includes(q) ? '' : 'none';
    }});
  }};
  // Console 过滤 — 事件委托
  document.addEventListener('click', function(ev) {{
    var el = ev.target.closest('[data-logfilter]');
    if (!el) return;
    var lv = el.getAttribute('data-logfilter');
    document.querySelectorAll('#__dbg_log_tbody__ tr').forEach(function(tr) {{
      var e = logs[+tr.dataset.idx] || {{}};
      tr.style.display = (lv === '全部' || e.level === lv) ? '' : 'none';
    }});
  }});

  // Console 行点击 — 展开完整日志 + JSON 格式化
  document.addEventListener('click', function(ev) {{
    var tr = ev.target.closest('#__dbg_log_tbody__ tr');
    if (!tr) return;
    var e = logs[+tr.dataset.idx];
    if (!e) return;
    var msg = e.message || '';
    var formatted = _tryJson(msg);
    var html = '<div class="d-section">';
    html += '<div class="d-kv"><div class="dk">时间</div><div class="dv">' + (e.ts ? new Date(e.ts).toLocaleString() : 'N/A') + '</div>';
    html += '<div class="dk">级别</div><div class="dv"><span class="badge-level lvl-' + e.level + '">' + e.level + '</span></div>';
    if (e.filename) html += '<div class="dk">位置</div><div class="dv">' + _esc(e.filename) + (e.lineno ? ':' + e.lineno : '') + '</div>';
    html += '</div></div>';
    html += '<div class="d-section"><div class="d-section-title">完整内容 <button class="d-copy" onclick="navigator.clipboard.writeText(this.parentElement.nextElementSibling.textContent)">复制</button></div>';
    html += '<pre class="d-pre" style="max-height:400px">' + _esc(formatted) + '</pre></div>';
    openDetail(e.level.toUpperCase() + ' 日志详情', html);
  }});

  // ---- 存储 ----
  function showStorage() {{
    var ls = storage.localStorage || {{}};
    var ss = storage.sessionStorage || {{}};
    var ck = storage.cookies || '';
    var filter = '<span class="fbtn active" data-stab="ls">localStorage (' + Object.keys(ls).length + ')</span>' +
      '<span class="fbtn" data-stab="ss">sessionStorage (' + Object.keys(ss).length + ')</span>' +
      '<span class="fbtn" data-stab="ck">cookies</span>' +
      '<span class="fbtn" data-stab="idb">IndexedDB</span>';

    function kvTable(obj) {{
      return '<table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>' +
        Object.keys(obj).map(function(k) {{
          return '<tr><td>' + _esc(k) + '</td><td style="max-width:500px;overflow:hidden"><pre class="d-pre" style="margin:0;max-height:100px">' + _esc(_tryJson(obj[k])) + '</pre></td></tr>';
        }}).join('') + '</tbody></table>';
    }}

    var body = '<div id="__dbg_st_ls__">' + kvTable(ls) + '</div>';
    body += '<div id="__dbg_st_ss__" style="display:none">' + kvTable(ss) + '</div>';
    // cookies
    var ckRows = ck ? ck.split(';').map(function(c) {{
      var p = c.trim().split('='); return '<tr><td>' + _esc(p[0]) + '</td><td>' + _esc(p.slice(1).join('=')) + '</td></tr>';
    }}).join('') : '<tr><td colspan=2>无 cookies</td></tr>';
    body += '<div id="__dbg_st_ck__" style="display:none"><table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>' + ckRows + '</tbody></table></div>';
    // indexeddb
    var idbHtml = '';
    for (var db in idb) {{
      idbHtml += '<div style="margin:8px 0"><b style="color:#89b4fa">' + _esc(db) + '</b>';
      for (var sn in idb[db]) {{
        var st = idb[db][sn];
        var m = st.meta || {{}};
        idbHtml += '<div style="margin:4px 0 4px 12px"><span style="color:#a6e3a1">' + _esc(sn) + '</span> <span style="color:#6c7086">(keyPath: ' + m.keyPath + ', ' + (st.records||[]).length + ' records)</span>';
        idbHtml += '<pre class="d-pre" style="max-height:150px">' + _esc(JSON.stringify(st.records||[], null, 2).substring(0, 5000)) + '</pre></div>';
      }}
      idbHtml += '</div>';
    }}
    if (!idbHtml) idbHtml = '<div style="color:#6c7086;padding:12px">无 IndexedDB 数据</div>';
    body += '<div id="__dbg_st_idb__" style="display:none">' + idbHtml + '</div>';

    openModal('存储', filter, body);
  }}
  // Storage tab 切换 — 用事件委托，避免 innerHTML onclick 不生效
  document.addEventListener('click', function(ev) {{
    var el = ev.target.closest('[data-stab]');
    if (!el) return;
    var tab = el.getAttribute('data-stab');
    ['ls','ss','ck','idb'].forEach(function(t) {{
      var e = document.getElementById('__dbg_st_' + t + '__');
      if (e) e.style.display = t === tab ? '' : 'none';
    }});
    el.parentElement.querySelectorAll('.fbtn').forEach(function(b) {{ b.classList.remove('active'); }});
    el.classList.add('active');
  }});

  // ---- 表单 ----
  function showForms() {{
    var rows = forms.map(function(f) {{
      var val = f.checked !== undefined ? (f.checked ? '✓' : '✗') : _esc(f.value||'');
      return '<tr><td>' + _esc(f.selector||'') + '</td><td>' + f.tagName + '</td><td>' + (f.type||'') + '</td><td>' + _esc(f.name||'') + '</td><td>' + val + '</td></tr>';
    }}).join('');
    openModal('表单状态 (' + forms.length + ')', '',
      '<table><thead><tr><th>选择器</th><th>标签</th><th>类型</th><th>名称</th><th>值</th></tr></thead><tbody>' + rows + '</tbody></table>');
  }}

  // ---- 运行时状态 ----
  function showRuntime() {{
    var html = '';
    var globals = [['__INITIAL_STATE__', runtime.initialState], ['__APP_STATE__', runtime.appState],
      ['__NUXT__', runtime.nuxtData], ['__NEXT_DATA__', runtime.nextData], ['history.state', runtime.historyState]];
    globals.forEach(function(g) {{
      if (g[1] === null || g[1] === undefined) return;
      html += '<div class="d-section"><div class="d-section-title">' + g[0] + ' <button class="d-copy" onclick="navigator.clipboard.writeText(JSON.stringify(' + _esc(JSON.stringify(g[1])) + ',null,2))">复制</button></div>';
      html += '<pre class="d-pre">' + _esc(JSON.stringify(g[1], null, 2)) + '</pre></div>';
    }});
    if (!html) html = '<div style="color:#6c7086;padding:12px">无全局状态</div>';
    openModal('运行时状态', '', html);
  }}

  // ---- WebSocket ----
  function showWS() {{
    var html = '';
    wsReplay.forEach(function(ws, i) {{
      html += '<div style="margin:8px 0;padding:8px;background:#181825;border-radius:4px">';
      html += '<div style="color:#89b4fa;font-weight:700">' + _esc(ws.url) + ' <span style="color:#6c7086">(' + ws.messages.length + ' 消息)</span></div>';
      html += '<div style="max-height:200px;overflow-y:auto;margin-top:4px">';
      ws.messages.forEach(function(m) {{
        var arrow = m.direction === 'out' ? '→' : '←';
        var color = m.direction === 'out' ? '#89b4fa' : '#a6e3a1';
        html += '<div style="font-size:11px;padding:2px 0;border-bottom:1px solid #313244"><span style="color:' + color + '">' + arrow + '</span> ' + _esc((m.data||'').substring(0, 200)) + '</div>';
      }});
      html += '</div></div>';
    }});
    if (!html) html = '<div style="color:#6c7086;padding:12px">无 WebSocket 数据</div>';
    openModal('WebSocket (' + wsReplay.length + ')', '', html);
  }}

  // ---- CSS Vars ----
  function showCSS() {{
    var keys = Object.keys(cssVars);
    var rows = keys.map(function(k) {{
      var v = cssVars[k];
      var swatch = /^#|^rgb|^hsl/.test(v) ? '<span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:' + v + ';vertical-align:middle;margin-right:6px;border:1px solid #45475a"></span>' : '';
      return '<tr><td style="color:#89b4fa">' + _esc(k) + '</td><td>' + swatch + _esc(v) + '</td></tr>';
    }}).join('');
    openModal('CSS 变量 (' + keys.length + ')', '',
      '<table><thead><tr><th>变量名</th><th>值</th></tr></thead><tbody>' + rows + '</tbody></table>');
  }}

  // --- 心跳 + 页面关闭通知 ---
  setInterval(function() {{ fetch('/__heartbeat__').catch(function(){{}}); }}, 10000);
  window.addEventListener('beforeunload', function() {{
    navigator.sendBeacon('/__shutdown__');
  }});

}})();
</script>"""


# ================================================================
# 5. 组装 HTML
# ================================================================
def build_page(data, assets_dir=None):
    """组装完整的还原页面。"""
    meta = data.get('metadata', {})
    base_url = meta.get('url', '')

    # 获取 DOM
    dom = data.get('domSnapshot', '')
    if not dom:
        dom = f"""<html><head><title>{meta.get('title', 'ENV Clone')}</title></head>
        <body style="font-family:sans-serif;padding:40px;">
        <h1>环境快照已还原</h1>
        <p>原始 URL: <code>{meta.get('url', 'N/A')}</code></p>
        <p>快照没有 DOM 内容，请查看左侧调试面板。</p>
        </body></html>"""

    # 清理 DOM
    print("[*] 清理 DOM（移除录制脚本）...")
    dom = clean_dom(dom)

    # 内联外部资源
    print("[*] 内联外部 CSS/JS 资源...")
    dom = inline_resources(dom, base_url, assets_dir)

    # 构建还原脚本
    print("[*] 构建还原脚本...")
    restore_script = build_restore_script(data)

    # 构建调试面板
    print("[*] 构建调试面板...")
    debug_panel = build_debug_panel(data)

    # 注入到 HTML
    # restore_script 注入到 <head> 最前面
    if '<head>' in dom:
        dom = dom.replace('<head>', '<head>' + restore_script, 1)
    elif '<HEAD>' in dom:
        dom = dom.replace('<HEAD>', '<HEAD>' + restore_script, 1)
    else:
        dom = '<html><head>' + restore_script + '</head>' + dom

    # debug_panel 注入到 <body> 最前面
    if '<body' in dom:
        idx = dom.find('<body')
        end = dom.find('>', idx)
        dom = dom[:end + 1] + debug_panel + dom[end + 1:]
    elif '<BODY' in dom:
        idx = dom.find('<BODY')
        end = dom.find('>', idx)
        dom = dom[:end + 1] + debug_panel + dom[end + 1:]

    return dom


# ================================================================
# 6. HTTP Server
# ================================================================
class LocalEnvServer(BaseHTTPRequestHandler):
    page_html = ''
    assets_dir = None
    origin_base = ''  # 原始站点 base URL，用于代理静态资源
    server_ref = None  # 引用 HTTPServer 实例，用于关闭

    def do_GET(self):
        # 心跳
        if self.path == '/__heartbeat__':
            self.server._last_heartbeat = __import__('time').time()
            self.send_response(204)
            self.end_headers()
            return

        # 关闭信号
        if self.path == '/__shutdown__':
            self.send_response(204)
            self.end_headers()
            print("\n[*] 网页已关闭，服务器停止")
            __import__('threading').Thread(target=self.server.shutdown, daemon=True).start()
            return

        if self.path == '/' or self.path == '/index.html':
            self._serve_html()
            return

        # 静态资源从 assets 提供
        if self.assets_dir:
            rel = self.path.split('?')[0].lstrip('/')
            path = os.path.join(self.assets_dir, rel)
            if os.path.isfile(path):
                self._serve_file(path)
                return
            try:
                for d in os.listdir(self.assets_dir):
                    c = os.path.join(self.assets_dir, d, rel)
                    if os.path.isfile(c):
                        self._serve_file(c)
                        return
            except OSError:
                pass

        # 静态资源：尝试从原始服务器代理
        ext = self.path.split('?')[0].split('.')[-1].lower()
        if ext in ('js', 'css', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico',
                    'woff', 'woff2', 'ttf', 'eot', 'mp4', 'webm', 'mp3',
                    'json', 'map', 'm3u8', 'ts', 'webp', 'avif'):
            if self.origin_base:
                proxy_url = self.origin_base.rstrip('/') + self.path
                content = _fetch_url(proxy_url, timeout=8)
                if content and len(content) > 0:
                    mime_map = {
                        'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
                        'gif': 'image/gif', 'svg': 'image/svg+xml', 'ico': 'image/x-icon',
                        'webp': 'image/webp', 'avif': 'image/avif',
                        'css': 'text/css', 'js': 'application/javascript',
                        'woff': 'font/woff', 'woff2': 'font/woff2',
                        'ttf': 'font/ttf', 'eot': 'application/vnd.ms-fontobject',
                        'mp4': 'video/mp4', 'webm': 'video/webm', 'mp3': 'audio/mpeg',
                        'json': 'application/json', 'map': 'application/json',
                    }
                    self.send_response(200)
                    self.send_header('Content-Type', mime_map.get(ext, 'application/octet-stream'))
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.send_header('Cache-Control', 'public, max-age=86400')
                    self.end_headers()
                    self.wfile.write(content)
                    return
            self.send_response(404)
            self.end_headers()
            return

        self._serve_html()

    def do_POST(self):
        self._serve_html()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.end_headers()

    def _serve_html(self):
        body = self.page_html.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _serve_file(self, path):
        ext = os.path.splitext(path)[1].lower()
        mime = {
            '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
            '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
            '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
            '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
            '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
        }.get(ext, 'application/octet-stream')
        with open(path, 'rb') as f:
            body = f.read()
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def log_message(self, format, *args):
        pass  # 静默


# ================================================================
# 7. 主入口
# ================================================================
_cli_password = [None]  # 通过 --password 传入时使用（用列表避免 global）

def _decrypt_pghost(filepath):
    """解密 .pghost 加密快照文件 (AES-256-GCM + PBKDF2)"""
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
        from cryptography.hazmat.primitives import hashes
    except ImportError:
        print("[!] 解密需要 cryptography 库，正在安装...")
        import subprocess
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'cryptography', '-q'])
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
        from cryptography.hazmat.primitives import hashes

    with open(filepath, 'rb') as f:
        raw = f.read()

    magic = raw[:6]
    if magic != b'PGHOST':
        raise ValueError("不是有效的 .pghost 加密文件")

    # version = raw[6]  # 目前只有 v1
    salt = raw[7:23]
    iv = raw[23:35]
    ciphertext = raw[35:]

    password = _cli_password[0] or getpass.getpass('[PageGhost] 输入快照密码: ')

    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=100000)
    key = kdf.derive(password.encode('utf-8'))

    aesgcm = AESGCM(key)
    try:
        plaintext = aesgcm.decrypt(iv, ciphertext, None)
    except Exception:
        print("[!] 密码错误，解密失败")
        sys.exit(1)

    return json.loads(plaintext.decode('utf-8'))


def _load_snapshot(filepath):
    """加载快照：自动判断明文 JSON 或加密 .pghost"""
    with open(filepath, 'rb') as f:
        header = f.read(6)

    if header == b'PGHOST':
        print("[*] 检测到加密快照，需要输入密码")
        return _decrypt_pghost(filepath)
    else:
        with open(filepath, 'r') as f:
            return json.load(f)


def serve(snapshot_path, port=8080, assets_dir=None, no_open=False):
    print(f"[*] 读取快照: {snapshot_path}")
    data = _load_snapshot(snapshot_path)

    meta = data.get('metadata', {})
    fp = data.get('fingerprint', {})
    scr = fp.get('screen', {})
    network = data.get('networkReplay', [])
    logs = data.get('consoleLogs', [])
    errors = [l for l in logs if l.get('level') in ('error', 'uncaught', 'unhandledrejection')]

    print(f"[*] 原始 URL: {meta.get('url', 'N/A')}")
    print(f"[*] 采集时间: {meta.get('timestamp', 'N/A')}")
    print(f"[*] 屏幕: {scr.get('width', '?')}×{scr.get('height', '?')} @{scr.get('dpr', '?')}x")
    print(f"[*] 网络: {len(network)} API, {len(errors)} 错误, {len(logs)} 日志")

    page_html = build_page(data, assets_dir)

    print(f"[*] 页面大小: {len(page_html) / 1024 / 1024:.1f} MB")

    LocalEnvServer.page_html = page_html
    LocalEnvServer.assets_dir = assets_dir
    # 从快照 URL 提取原始站点 base，用于代理静态资源（图片、字体等）
    origin_url = meta.get('url', '')
    if origin_url:
        parsed = urllib.parse.urlparse(origin_url)
        LocalEnvServer.origin_base = f"{parsed.scheme}://{parsed.netloc}"
        print(f"[*] 静态资源代理: {LocalEnvServer.origin_base}")

    # 尝试多个端口
    server = None
    for p in range(port, port + 10):
        try:
            server = HTTPServer(('127.0.0.1', p), LocalEnvServer)
            port = p
            break
        except OSError:
            continue

    if not server:
        print(f"[!] 端口 {port}-{port+9} 全部被占用")
        sys.exit(1)

    url = f'http://127.0.0.1:{port}'
    print(f"\n{'='*50}")
    print(f"  页面已就绪: {url}")
    print(f"  左侧 DEBUG 按钮打开调试面板")
    print(f"{'='*50}")
    print(f"  Ctrl+C 停止\n")

    if not no_open:
        webbrowser.open(url)

    # 心跳检测线程：3 分钟没收到心跳就关闭服务器
    import time, threading
    server._last_heartbeat = time.time()

    def heartbeat_checker():
        while True:
            time.sleep(60)
            if time.time() - server._last_heartbeat > 180:
                print("\n[*] 3 分钟未收到心跳，网页可能已关闭，服务器停止")
                server.shutdown()
                break

    hb_thread = threading.Thread(target=heartbeat_checker, daemon=True)
    hb_thread.start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] 停止")
        server.shutdown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='环境还原 + 调试面板')
    parser.add_argument("--import", dest="snapshot", required=True, help="快照 JSON")
    parser.add_argument("--port", type=int, default=8080, help="端口 (默认 8080)")
    parser.add_argument("--assets", dest="assets_dir", help="静态资源目录 (crawler 输出)")
    parser.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    parser.add_argument("--password", dest="password", help=".pghost 解密密码（不指定则交互输入）")
    args = parser.parse_args()

    if args.password:
        _cli_password[0] = args.password

    if not os.path.isfile(args.snapshot):
        print(f"[!] 文件不存在: {args.snapshot}")
        sys.exit(1)

    serve(args.snapshot, port=args.port, assets_dir=args.assets_dir, no_open=args.no_open)
