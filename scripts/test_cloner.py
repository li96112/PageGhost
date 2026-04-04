"""
test_cloner.py - 环境克隆器集成测试 (V3)

测试覆盖：
- 快照 JSON schema 正确性
- 还原脚本生成
- HTML 注入逻辑
- 本地服务器启动和响应
- Network Replay 浏览器端拦截
- Crawler 资源提取
"""

import json
import os
import sys
import tempfile
import threading
import time
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))

# ============================================================
# Mock Snapshot（V2 Schema）
# ============================================================
MOCK_SNAPSHOT = {
    "version": 2,
    "metadata": {
        "timestamp": "2026-04-04T15:35:00Z",
        "url": "https://example.com/app?tab=settings",
        "userAgent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        "title": "My App - Settings",
        "referrer": "https://example.com/"
    },
    "storage": {
        "localStorage": {"theme": "dark", "user_prefs": '{"fontSize": 16}', "lang": "zh-CN"},
        "sessionStorage": {"session_id": "abc123", "cart": '["item1","item2"]'},
        "cookies": "auth_token=xyz789; user_id=98765; _ga=GA1.2.123456"
    },
    "indexedDB": {
        "appDB": {
            "users": {
                "meta": {
                    "keyPath": "id",
                    "autoIncrement": False,
                    "indexes": [
                        {"name": "by_email", "keyPath": "email", "unique": True, "multiEntry": False}
                    ]
                },
                "records": [
                    {"id": 1, "name": "Alice", "email": "alice@example.com", "role": "admin"},
                    {"id": 2, "name": "Bob", "email": "bob@example.com", "role": "user"}
                ]
            }
        }
    },
    "runtime": {
        "initialState": {"isLoggedIn": True, "user": {"id": 1, "name": "Alice"}},
        "appState": {"currentTab": "settings"},
        "nuxtData": None,
        "nextData": None,
        "historyState": {"scrollPos": 150}
    },
    "fingerprint": {
        "screen": {"width": 375, "height": 812, "availWidth": 375, "availHeight": 812, "dpr": 3, "colorDepth": 24},
        "viewport": {"innerWidth": 375, "innerHeight": 635},
        "touch": True,
        "maxTouchPoints": 5,
        "gpu": "Apple GPU",
        "timezone": "Asia/Shanghai",
        "timezoneOffset": -480,
        "language": "zh-CN",
        "languages": ["zh-CN", "zh", "en"],
        "platform": "iPhone",
        "hardwareConcurrency": 6,
        "deviceMemory": 4,
        "connection": {"effectiveType": "4g", "downlink": 10, "rtt": 50},
        "prefersColorScheme": "dark",
        "prefersReducedMotion": False
    },
    "interaction": {
        "scroll": {"x": 0, "y": 350},
        "focus": "input#search",
        "selection": None
    },
    "formState": [
        {"index": 0, "tagName": "INPUT", "type": "text", "name": "search", "id": "search",
         "selector": "input#search", "value": "hello world"},
        {"index": 1, "tagName": "INPUT", "type": "checkbox", "name": "remember", "id": "remember",
         "selector": "input#remember", "checked": True},
        {"index": 2, "tagName": "SELECT", "type": "select-one", "name": "sort", "id": "sort",
         "selector": "select#sort", "selectedIndex": 2, "value": "date"}
    ],
    "domSnapshot": "<html><head><title>My App</title></head><body><div id='app'>Hello</div></body></html>",
    "cssVariables": {"--primary-color": "#3b82f6", "--bg-color": "#1a1a2e"},
    "networkReplay": [
        {
            "type": "fetch",
            "url": "https://example.com/api/user",
            "method": "GET",
            "requestHeaders": {"authorization": "Bearer xyz789"},
            "status": 200,
            "statusText": "OK",
            "responseHeaders": {"content-type": "application/json"},
            "latency": 120,
            "body": "eyJpZCI6MSwibmFtZSI6IkFsaWNlIn0="
        },
        {
            "type": "xhr",
            "url": "https://example.com/api/settings",
            "method": "POST",
            "requestHeaders": {"content-type": "application/json"},
            "status": 200,
            "statusText": "OK",
            "responseHeaders": {"content-type": "application/json"},
            "latency": 85,
            "body": "eyJvayI6dHJ1ZX0="
        }
    ],
    "wsReplay": [
        {"url": "wss://example.com/ws", "messages": [
            {"direction": "out", "data": '{"type":"ping"}', "ts": 1712234100000},
            {"direction": "in", "data": '{"type":"pong"}', "ts": 1712234100050}
        ]}
    ],
    "consoleLogs": [
        {"level": "log", "message": "App initialized", "ts": 1712234100000},
        {"level": "error", "message": "Failed to load resource", "ts": 1712234100500}
    ],
    "serviceWorkers": [
        {"scope": "https://example.com/", "scriptURL": "https://example.com/sw.js", "state": "activated"}
    ],
    "permissions": {
        "geolocation": "prompt",
        "notifications": "denied",
        "camera": "prompt",
        "microphone": "prompt",
        "clipboard-read": "granted",
        "clipboard-write": "granted"
    }
}


def write_snapshot(data=None):
    data = data or MOCK_SNAPSHOT
    fd, path = tempfile.mkstemp(suffix='.json', prefix='test_snapshot_')
    with os.fdopen(fd, 'w') as f:
        json.dump(data, f, indent=2)
    return path


# ============================================================
# 测试用例
# ============================================================

def test_schema_completeness():
    required = [
        'version', 'metadata', 'storage', 'indexedDB', 'runtime',
        'fingerprint', 'interaction', 'formState', 'domSnapshot',
        'cssVariables', 'networkReplay', 'wsReplay', 'consoleLogs',
        'serviceWorkers', 'permissions'
    ]
    missing = [k for k in required if k not in MOCK_SNAPSHOT]
    assert not missing, f"缺失: {missing}"
    print("[PASS] test_schema_completeness")


def test_restore_script_generation():
    from mount_env import build_restore_script
    script = build_restore_script(MOCK_SNAPSHOT)

    assert '<script data-env-restore="true">' in script
    assert 'localStorage.setItem' in script
    assert 'sessionStorage.setItem' in script
    assert '__INITIAL_STATE__' in script
    assert '_replayMap' in script
    assert 'indexeddb' in script.lower()
    assert 'formData' in script
    assert 'scrollTo' in script
    # 确保 network replay entries 被内联
    assert 'eyJpZCI6MSwibmFtZSI6IkFsaWNlIn0=' in script  # base64 body
    print("[PASS] test_restore_script_generation")


def test_html_injection():
    from mount_env import inject_into_html

    # 正常 HTML
    html = '<html><head><title>Test</title></head><body><div>Hello</div></body></html>'
    result = inject_into_html(html, '<script>RESTORE</script>', '<div>INFO</div>')
    assert '<head><script>RESTORE</script>' in result
    assert '<body><div>INFO</div>' in result

    # 无 <head> 的 HTML
    html2 = '<html><body>Hello</body></html>'
    result2 = inject_into_html(html2, '<script>RESTORE</script>', '<div>INFO</div>')
    assert '<script>RESTORE</script>' in result2

    # 纯文本
    html3 = '<div>Just content</div>'
    result3 = inject_into_html(html3, '<script>R</script>', '<div>I</div>')
    assert '<script>R</script>' in result3

    print("[PASS] test_html_injection")


def test_info_bar_generation():
    from mount_env import build_info_bar
    bar = build_info_bar(MOCK_SNAPSHOT)
    assert '__env_restore_bar__' in bar
    assert 'example.com' in bar
    assert '375' in bar  # screen width
    assert '2 API' in bar  # network replay count
    print("[PASS] test_info_bar_generation")


def test_local_server():
    from mount_env import LocalEnvServer, build_restore_script, build_info_bar, inject_into_html
    from http.server import HTTPServer

    # 准备页面
    dom = MOCK_SNAPSHOT['domSnapshot']
    script = build_restore_script(MOCK_SNAPSHOT)
    bar = build_info_bar(MOCK_SNAPSHOT)
    page_html = inject_into_html(dom, script, bar)

    LocalEnvServer.page_html = page_html
    LocalEnvServer.snapshot_data = MOCK_SNAPSHOT
    LocalEnvServer.assets_dir = None

    server = HTTPServer(('127.0.0.1', 18888), LocalEnvServer)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    time.sleep(0.3)

    # 测试主页面
    with urllib.request.urlopen('http://127.0.0.1:18888/', timeout=5) as resp:
        assert resp.status == 200
        body = resp.read().decode()
        assert 'data-env-restore' in body
        assert '__env_restore_bar__' in body
        assert 'Hello' in body  # 原始 DOM 内容
        assert 'localStorage.setItem' in body

    # 测试 __env_info__ 接口
    with urllib.request.urlopen('http://127.0.0.1:18888/__env_info__', timeout=5) as resp:
        assert resp.status == 200
        info = json.loads(resp.read())
        assert info['metadata']['url'] == 'https://example.com/app?tab=settings'
        assert info['networkReplayCount'] == 2

    # SPA fallback: 任意路径都返回主页面
    with urllib.request.urlopen('http://127.0.0.1:18888/some/random/path', timeout=5) as resp:
        assert resp.status == 200
        body = resp.read().decode()
        assert 'data-env-restore' in body

    server.shutdown()
    print("[PASS] test_local_server")


def test_snapshot_roundtrip():
    path = write_snapshot()
    with open(path) as f:
        loaded = json.load(f)
    assert loaded['version'] == 2
    assert loaded['metadata']['url'] == MOCK_SNAPSHOT['metadata']['url']
    assert len(loaded['networkReplay']) == 2
    os.unlink(path)
    print("[PASS] test_snapshot_roundtrip")


def test_form_state_structure():
    for item in MOCK_SNAPSHOT['formState']:
        assert 'selector' in item
        assert 'tagName' in item
        if item['type'] in ('checkbox', 'radio'):
            assert 'checked' in item
        elif item['tagName'] == 'SELECT':
            assert 'selectedIndex' in item
        else:
            assert 'value' in item
    print("[PASS] test_form_state_structure")


def test_crawler_html_parsing():
    from crawler import AssetCrawler
    html = '''
    <html>
    <head>
        <link rel="stylesheet" href="/css/main.css">
        <link rel="icon" href="/favicon.ico">
        <script src="/js/app.js"></script>
    </head>
    <body>
        <img src="/img/logo.png" srcset="/img/logo@2x.png 2x, /img/logo@3x.png 3x">
        <video src="/video/intro.mp4" poster="/img/poster.jpg"></video>
        <audio><source src="/audio/bgm.mp3"></audio>
        <div style="background: url('/img/bg.jpg')"></div>
    </body>
    </html>
    '''
    parser = AssetCrawler('https://example.com/', '/tmp/test_assets')
    parser.feed(html)
    urls = parser.assets
    expected = ['/css/main.css', '/favicon.ico', '/js/app.js', '/img/logo.png',
                '/img/logo@2x.png', '/img/logo@3x.png', '/video/intro.mp4',
                '/img/poster.jpg', '/audio/bgm.mp3', '/img/bg.jpg']
    for p in expected:
        assert 'https://example.com' + p in urls, f"未发现: {p}"
    print(f"[PASS] test_crawler_html_parsing ({len(urls)} 资源)")


def test_css_url_extraction():
    from crawler import AssetCrawler
    parser = AssetCrawler('https://example.com/', '/tmp/test_assets')
    css = '''
    @import url("components.css");
    @import 'reset.css';
    body { background: url('/img/bg.jpg'); }
    @font-face { src: url('/fonts/Inter.woff2'); }
    '''
    parser.parse_css_file('https://example.com/css/main.css', css)
    urls = parser.assets
    assert 'https://example.com/css/components.css' in urls
    assert 'https://example.com/img/bg.jpg' in urls
    assert 'https://example.com/fonts/Inter.woff2' in urls
    print(f"[PASS] test_css_url_extraction ({len(urls)} URLs)")


def test_no_dom_fallback():
    """测试无 DOM 快照时生成占位页面。"""
    from mount_env import build_restore_script, build_info_bar, inject_into_html

    data = dict(MOCK_SNAPSHOT)
    data['domSnapshot'] = ''

    # mount_env.serve() 内部的逻辑：无 DOM 时生成占位页
    dom = data.get('domSnapshot', '')
    if not dom:
        dom = '<html><head><title>Fallback</title></head><body><h1>环境快照已还原</h1></body></html>'

    script = build_restore_script(data)
    bar = build_info_bar(data)
    result = inject_into_html(dom, script, bar)

    assert '环境快照已还原' in result
    assert 'data-env-restore' in result
    print("[PASS] test_no_dom_fallback")


# ============================================================
if __name__ == "__main__":
    tests = [
        test_schema_completeness,
        test_restore_script_generation,
        test_html_injection,
        test_info_bar_generation,
        test_local_server,
        test_snapshot_roundtrip,
        test_form_state_structure,
        test_crawler_html_parsing,
        test_css_url_extraction,
        test_no_dom_fallback,
    ]

    passed = failed = 0
    for t in tests:
        try:
            t()
            passed += 1
        except Exception as e:
            print(f"[FAIL] {t.__name__}: {e}")
            failed += 1

    print(f"\n{'='*50}")
    print(f"结果: {passed} 通过, {failed} 失败, 共 {len(tests)} 项")
    print(f"{'='*50}")
