"""
crawler.py - 静态资源爬取器 (V2)

改进：
- 支持更多标签类型（video, audio, source, picture, object, embed）
- 解析 CSS 中的 url() 引用（字体、背景图等）
- 解析 srcset 属性
- 保留目录结构避免文件名冲突
- 与快照 JSON 关联，输出资源清单
"""

import urllib.request
import urllib.parse
from html.parser import HTMLParser
import os
import re
import json
import hashlib
import ssl


# 忽略 SSL 验证（开发环境用）
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE


class AssetCrawler(HTMLParser):
    # 需要提取的标签和属性映射
    TAG_ATTR_MAP = {
        'link': ['href'],
        'script': ['src'],
        'img': ['src', 'srcset'],
        'video': ['src', 'poster'],
        'audio': ['src'],
        'source': ['src', 'srcset'],
        'picture': [],  # picture 本身无 src，但 source 子元素会被捕获
        'object': ['data'],
        'embed': ['src'],
        'input': ['src'],  # type=image
        'meta': ['content'],  # og:image 等
        'iframe': ['src'],
    }

    def __init__(self, base_url, output_dir):
        super().__init__()
        self.base_url = base_url
        self.output_dir = output_dir
        self.assets = set()
        self.inline_css = []

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        attr_names = self.TAG_ATTR_MAP.get(tag, [])

        for attr_name in attr_names:
            value = attrs_dict.get(attr_name)
            if not value:
                continue

            if attr_name == 'srcset':
                # srcset 格式: "url1 1x, url2 2x, ..."
                for part in value.split(','):
                    url = part.strip().split()[0] if part.strip() else ''
                    if url:
                        self._add_url(url)
            elif tag == 'meta' and attr_name == 'content':
                # 只提取 og:image 等图片 meta
                prop = attrs_dict.get('property', '') or attrs_dict.get('name', '')
                if 'image' in prop.lower() or 'icon' in prop.lower():
                    self._add_url(value)
            elif tag == 'link':
                rel = attrs_dict.get('rel', '')
                # 提取 stylesheet, icon, preload 等
                if any(r in rel for r in ['stylesheet', 'icon', 'preload', 'prefetch', 'manifest']):
                    self._add_url(value)
            else:
                self._add_url(value)

        # 收集 inline style
        style = attrs_dict.get('style', '')
        if style:
            self._extract_css_urls(style)

    def handle_data(self, data):
        pass

    def handle_endtag(self, tag):
        pass

    def _add_url(self, url):
        if not url or url.startswith('data:') or url.startswith('javascript:') or url.startswith('blob:'):
            return
        full_url = urllib.parse.urljoin(self.base_url, url)
        self.assets.add(full_url)

    def _extract_css_urls(self, css_text):
        """提取 CSS 中的 url(...) 引用。"""
        for match in re.finditer(r'url\(\s*["\']?([^"\')\s]+)["\']?\s*\)', css_text):
            self._add_url(match.group(1))

    def parse_css_file(self, css_url, css_content):
        """解析 CSS 文件内容，提取 url() 和 @import。"""
        # @import
        for match in re.finditer(r'@import\s+(?:url\(\s*)?["\']?([^"\')\s;]+)', css_content):
            import_url = urllib.parse.urljoin(css_url, match.group(1))
            self.assets.add(import_url)

        # url(...)
        for match in re.finditer(r'url\(\s*["\']?([^"\')\s]+)["\']?\s*\)', css_content):
            ref_url = match.group(1)
            if not ref_url.startswith('data:'):
                full_url = urllib.parse.urljoin(css_url, ref_url)
                self.assets.add(full_url)

    def _url_to_filepath(self, url):
        """将 URL 转为本地文件路径（保留目录结构）。"""
        parsed = urllib.parse.urlparse(url)
        path = parsed.path.lstrip('/')
        if not path or path.endswith('/'):
            # 为没有文件名的 URL 生成 hash 名
            path = hashlib.md5(url.encode()).hexdigest()[:12]
        # 用 domain 作为子目录
        domain = parsed.netloc.replace(':', '_')
        return os.path.join(self.output_dir, domain, path)

    def download_all(self, parse_css=True):
        """下载所有发现的资源。返回资源清单。"""
        manifest = []
        downloaded = set()
        to_download = list(self.assets)
        css_files = []

        while to_download:
            url = to_download.pop(0)
            if url in downloaded:
                continue
            downloaded.add(url)

            save_path = self._url_to_filepath(url)
            os.makedirs(os.path.dirname(save_path), exist_ok=True)

            try:
                req = urllib.request.Request(url, headers={
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                    'ngrok-skip-browser-warning': 'true',
                    'Accept': '*/*'
                })
                with urllib.request.urlopen(req, timeout=15, context=SSL_CTX) as response:
                    content_type = response.headers.get('Content-Type', '')
                    data = response.read()
                    with open(save_path, 'wb') as f:
                        f.write(data)

                    manifest.append({
                        'url': url,
                        'localPath': save_path,
                        'contentType': content_type,
                        'size': len(data)
                    })
                    print(f"[+] {len(data):>8d} B  {url}")

                    # 如果是 CSS 文件，解析其中的引用
                    if parse_css and ('css' in content_type or url.endswith('.css')):
                        try:
                            css_text = data.decode('utf-8', errors='replace')
                            self.parse_css_file(url, css_text)
                            # 新发现的 URL 加入队列
                            for new_url in self.assets:
                                if new_url not in downloaded:
                                    to_download.append(new_url)
                        except Exception:
                            pass

            except Exception as e:
                manifest.append({'url': url, 'error': str(e)})
                print(f"[-] FAIL     {url}: {e}")

        return manifest


def crawl_from_snapshot(snapshot_path, output_dir):
    """从快照 JSON 读取 URL，爬取该页面的所有静态资源。"""
    with open(snapshot_path) as f:
        data = json.load(f)

    target_url = data.get('metadata', {}).get('url', data.get('url', ''))
    if not target_url:
        print("[!] 快照中没有目标 URL")
        return

    print(f"[*] 目标: {target_url}")
    print(f"[*] 输出: {output_dir}")

    # 获取页面 HTML
    # 优先使用快照中的 DOM
    html = data.get('domSnapshot', '')
    if not html:
        print("[*] 快照无 DOM，从远程获取...")
        req = urllib.request.Request(target_url, headers={
            'User-Agent': data.get('metadata', {}).get('userAgent', 'Mozilla/5.0')
        })
        with urllib.request.urlopen(req, timeout=15, context=SSL_CTX) as f:
            html = f.read().decode('utf-8', errors='replace')

    parser = AssetCrawler(target_url, output_dir)
    parser.feed(html)
    print(f"[*] 发现 {len(parser.assets)} 个资源引用")

    manifest = parser.download_all()

    # 保存资源清单
    manifest_path = os.path.join(output_dir, '_manifest.json')
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    print(f"\n[*] 完成！共 {len(manifest)} 个资源，清单: {manifest_path}")

    return manifest


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(description='静态资源爬取器')
    p.add_argument('--snapshot', help='从快照 JSON 文件提取 URL 和 DOM')
    p.add_argument('--url', help='直接指定目标 URL')
    p.add_argument('--output', default='/tmp/site_assets', help='输出目录')
    args = p.parse_args()

    if args.snapshot:
        crawl_from_snapshot(args.snapshot, args.output)
    elif args.url:
        print(f"[*] 目标: {args.url}")
        req = urllib.request.Request(args.url, headers={
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        })
        with urllib.request.urlopen(req, timeout=15, context=SSL_CTX) as f:
            html = f.read().decode('utf-8', errors='replace')
        parser = AssetCrawler(args.url, args.output)
        parser.feed(html)
        manifest = parser.download_all()
        manifest_path = os.path.join(args.output, '_manifest.json')
        with open(manifest_path, 'w') as f:
            json.dump(manifest, f, indent=2, ensure_ascii=False)
        print(f"\n[*] 完成！共 {len(manifest)} 个资源")
    else:
        print("[!] 请指定 --snapshot 或 --url")
