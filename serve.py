#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""茂名展示馆 · 普通静态文件服务（零第三方依赖，仅 Python 3.8+ 标准库）

定位：只做一个「普通静态服务器」——站点根目录就是 web/，URL 路径与
磁盘文件一一对应，不做多根回退、不做路径重写、不依赖任何外部服务。
因此本目录放到 IIS / nginx / Apache / 任意静态服务器上行为一致。

保留的能力：
    · HTTP Range 206（SOG 是 ZIP 式容器，浏览器必须按字节范围读取）
    · ETag / Cache-Control（大二进制长期缓存，网页与脚本协商缓存）
    · 两个只读信息端点 __server_info.json / __web_patch.json
      （展厅页「复制局域网地址」等按钮会读取；缺失时页面会自行降级）
    · 局域网绑定、自动打开浏览器、根路径直接返回 web/index.html

启动失败（缺目录 / 缺入口 / 端口异常 / 权限 / 未捕获异常）会把原因与
完整堆栈写入同目录 serve.log，同时在控制台打印，窗口不会一闪而过。

手动运行：
    python serve.py                      # 默认 8099，允许局域网，自动开浏览器
    python serve.py --port 8080 --no-browser
    python serve.py --local-only         # 只监听 127.0.0.1
"""
import argparse
import datetime
import json
import mimetypes
import os
import socket
import sys
import threading
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(ROOT, "web")
LOG_PATH = os.path.join(ROOT, "serve.log")
DEFAULT_PAGE = "index.html"

MIME = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon",
    ".webp": "image/webp", ".txt": "text/plain; charset=utf-8",
    # 本地视频投射：Chromium 依赖正确的 MIME 才会启用流式 Range 播放
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm",
    ".ogv": "video/ogg", ".mov": "video/quicktime",
    ".sog": "application/octet-stream", ".ply": "application/octet-stream",
    ".btree": "application/octet-stream", ".glb": "model/gltf-binary",
    ".config": "application/xml",
}
IMMUTABLE_EXT = {".sog", ".ply", ".btree", ".glb", ".jpg", ".jpeg",
                 ".png", ".webp", ".wasm", ".ico"}
VIDEO_EXTS = {".mp4", ".m4v", ".webm", ".ogv", ".mov"}

_LOG_LOCK = threading.Lock()
SERVER = {"port": 8099, "lan": True, "lan_ip": None}


# ---------------------------------------------------------------- 日志
def log(msg, level="INFO"):
    """同时写 serve.log 与控制台；任何写失败都不能影响服务本身。"""
    line = "[%s] [%s] %s" % (
        datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), level, msg)
    with _LOG_LOCK:
        try:
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass
    try:
        print(line, flush=True)
    except Exception:
        pass


def fail(msg, with_trace=False):
    log(msg, "ERROR")
    if with_trace:
        log("调用堆栈：\n" + traceback.format_exc().strip(), "ERROR")
    log("启动失败，请把 serve.log 发给技术支持。日志位置：" + LOG_PATH, "ERROR")
    return 1


def rotate_log():
    """超过 1 MB 时只保留最近 2000 行，避免长期运行日志无限膨胀。"""
    try:
        if os.path.isfile(LOG_PATH) and os.path.getsize(LOG_PATH) > 1024 * 1024:
            with open(LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
            with open(LOG_PATH, "w", encoding="utf-8") as f:
                f.writelines(lines[-2000:])
    except Exception:
        pass


# ---------------------------------------------------------------- 工具
def mime_of(key):
    ext = os.path.splitext(key)[1].lower()
    return MIME.get(ext, mimetypes.guess_type(key)[0] or "application/octet-stream")


def cache_of(key):
    if key.startswith("__"):
        return "no-store"
    if key.endswith("exhibits.json"):
        return "no-cache"
    ext = os.path.splitext(key)[1].lower()
    if ext in IMMUTABLE_EXT:
        return "public, max-age=31536000, immutable"
    if key.startswith("maoming-showroom/views/") or ext in (".css", ".js"):
        return "no-cache"
    if ext == ".json":
        return "public, max-age=300"
    return "no-cache"


def lan_ipv4():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("223.5.5.5", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip.startswith("169.254.") or ip.startswith("127."):
            return None
        return ip
    except OSError:
        return None


def locate(key):
    """单根查找：web/<key>。禁止越出 web/ 目录。"""
    root = os.path.normpath(WEB_DIR)
    p = os.path.normpath(os.path.join(root, *key.split("/")))
    if p != root and not p.startswith(root + os.sep):
        return None
    if os.path.isfile(p):
        return p
    # 目录默认取该目录下的 index.html
    if os.path.isdir(p):
        q = os.path.join(p, "index.html")
        if os.path.isfile(q):
            return q
    return None


# ---------------------------------------------------------------- 请求处理
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MaomingStatic/1.0"

    def log_message(self, fmt, *args):
        # 正常访问不打日志（避免日志被几百个资源请求刷满），只记录错误
        pass

    def send_json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def handle_request(self, head=False):
        parts = urlparse(self.path)
        key = unquote(parts.path).lstrip("/")
        if not key:
            key = DEFAULT_PAGE
        if ".." in key or "\\" in key:
            log("已拒绝非法路径：" + self.path, "WARN")
            self.send_error(404)
            return

        p = SERVER["port"]
        ip = SERVER["lan_ip"]
        if key == "__server_info.json":
            self.send_json({
                "port": p, "lan": SERVER["lan"], "lanIp": ip,
                "defaultPage": DEFAULT_PAGE,
                "localUrl": "http://127.0.0.1:%d/" % p,
                "homeUrl": "http://127.0.0.1:%d/" % p,
                "viewerUrl": "http://127.0.0.1:%d/gs-viewer.html" % p,
                "lanUrl": ("http://%s:%d/" % (ip, p)) if ip else "",
            })
            return
        if key == "__web_patch.json":
            # 目录版直接改 web/ 文件即可，无需单文件补丁
            self.send_json({"active": False, "label": "", "files": 0,
                            "bytes": 0, "error": None})
            return

        path = locate(key)
        if not path:
            log("404 文件不存在：" + self.path, "ERROR")
            self.send_error(404)
            return
        total = os.path.getsize(path)
        ext = os.path.splitext(key)[1].lower()
        ctype = mime_of(key)
        cache = cache_of(key)
        etag = '"%x-%x"' % (int(os.path.getmtime(path)), total)
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        start, end, code = 0, total - 1, 200
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes="):
            spec = rng[6:].split(",")[0].strip()
            a, _, b = spec.partition("-")
            try:
                if a:
                    start = int(a)
                    end = min(int(b), total - 1) if b else total - 1
                    # 播放器首包通常请求 "Range: bytes=0-"；若把 99MB 的本地
                    # 测试视频一次性返回，起播要等整个文件传完。按 1MB 分片
                    # 返回 206，Chromium 会按需续传后续字节，边下边播。
                    if not b and ext in VIDEO_EXTS and total > 4 * 1024 * 1024:
                        end = min(total - 1, start + 1024 * 1024 - 1)
                else:
                    n = int(b)
                    start, end = max(0, total - n), total - 1
                if start <= end and start < total:
                    code = 206
                else:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % total)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
            except ValueError:
                start, end, code = 0, total - 1, 200
        length = max(0, end - start + 1)

        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", cache)
        self.send_header("Access-Control-Allow-Origin", "*")
        if code == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, total))
        self.end_headers()
        if head or length == 0:
            return
        with open(path, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(65536, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def _safe_handle(self, head=False):
        try:
            self.handle_request(head=head)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 浏览器取消请求，属正常现象
        except Exception:
            log("处理请求异常 %s：\n%s" % (self.path, traceback.format_exc().strip()),
                "ERROR")
            try:
                self.send_error(500)
            except Exception:
                pass

    def do_GET(self):
        self._safe_handle()

    def do_HEAD(self):
        self._safe_handle(head=True)


# ---------------------------------------------------------------- 启动
def main(argv=None):
    # 控制台编码兜底：部分服务器 / PowerShell 宿主的 OEM 代码页无法编码中文，
    # 不能让 print 抛 UnicodeEncodeError 导致服务起不来。日志始终为完整 UTF-8。
    try:
        sys.stdout.reconfigure(errors="replace")
        sys.stderr.reconfigure(errors="replace")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="茂名展示馆 · 普通静态文件服务")
    ap.add_argument("--port", type=int, default=8099, help="监听端口（默认 8099）")
    ap.add_argument("--local-only", action="store_true", help="只监听 127.0.0.1")
    ap.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    ap.add_argument("--edit", action="store_true",
                    help="启动后直接打开标注编辑模式（等价于 /?edit=1；默认打开浏览态，点「标注编辑」进入）")
    a = ap.parse_args(argv)

    rotate_log()
    log("=" * 60)
    log("启动普通静态服务 | Python %s | PID %d" % (sys.version.split()[0], os.getpid()))
    log("程序目录 : " + ROOT)
    log("站点根   : " + WEB_DIR)
    log("日志位置 : " + LOG_PATH)

    # ---- 启动前置检查：任何一项不满足都明确写日志后退出 ----
    if sys.version_info < (3, 8):
        return fail("Python 版本过低：需要 3.8 及以上，当前 " + sys.version.split()[0])
    if not os.path.isdir(WEB_DIR):
        return fail("缺少站点目录 web/：" + WEB_DIR + "（请完整解压整个文件夹）")
    if not os.path.isfile(os.path.join(WEB_DIR, DEFAULT_PAGE)):
        return fail("缺少入口文件 web/" + DEFAULT_PAGE + "（请完整解压整个文件夹）")
    if not os.access(WEB_DIR, os.R_OK):
        return fail("站点目录 web/ 不可读，请检查文件夹权限或以管理员身份运行")
    try:
        with open(LOG_PATH, "a", encoding="utf-8"):
            pass
    except Exception:
        # 只读部署目录（网络共享 / 受管服务器）依然可以正常提供静态服务。
        # log() 已对写失败静默降级为仅控制台输出，这里只提示，不再终止启动。
        log("无法写入日志 " + LOG_PATH + "（目录只读），本次仅输出到控制台", "WARN")

    # ---- 绑定端口 ----
    # 不依赖 errno 判断：Windows 下端口被占用常报 WinError 10013（权限语义），
    # 与真正的权限不足无法区分。统一策略 = 先自动换空闲端口，再退回回环地址，
    # 全部失败才判定启动失败并写日志。任何一次失败都保留原始错误文本。
    host = "127.0.0.1" if a.local_only else "0.0.0.0"
    SERVER["lan"] = not a.local_only
    httpd = None
    try:
        httpd = ThreadingHTTPServer((host, a.port), Handler)
    except OSError as e1:
        log("绑定 %s:%d 失败（常见于端口已被占用 / 系统保留端口 / 权限不足）：%s"
            % (host, a.port, e1), "WARN")
        log("尝试自动改用系统分配的空闲端口…", "WARN")
        try:
            httpd = ThreadingHTTPServer((host, 0), Handler)
        except OSError as e2:
            log("空闲端口仍绑定失败（%s），尝试回退到仅本机 127.0.0.1" % e2, "WARN")
            try:
                host = "127.0.0.1"
                SERVER["lan"] = False
                httpd = ThreadingHTTPServer((host, 0), Handler)
            except OSError as e3:
                return fail("无法启动服务：端口 %d 及所有备用地址均绑定失败（%s）"
                            % (a.port, e3), with_trace=True)
        log("已自动改用端口 %d" % httpd.server_address[1], "WARN")

    port = httpd.server_address[1]
    SERVER.update(port=port, lan_ip=lan_ipv4() if SERVER["lan"] else None)
    base = "http://127.0.0.1:%d/" % port
    url = base + ("?edit=1" if a.edit else "")

    print("=" * 60, flush=True)
    print("  茂名展示馆 · 3DGS 实景展厅 / 标注编辑器（普通静态服务）", flush=True)
    print("-" * 60, flush=True)
    print("  本机访问 : " + base, flush=True)
    print("  标注编辑 : " + base + "?edit=1  （或点页面左下角「标注编辑」）", flush=True)
    print("  站点根   : web/  （URL 路径与文件一一对应）", flush=True)
    if SERVER["lan_ip"]:
        print("  局域网   : http://%s:%d/" % (SERVER["lan_ip"], port), flush=True)
    print("  日志     : " + LOG_PATH, flush=True)
    print("  保持本窗口开启，Ctrl+C 停止服务", flush=True)
    print("=" * 60, flush=True)

    log("服务已启动：%s（监听 %s:%d）" % (url, host, port), "INFO")
    if not a.no_browser:
        try:
            threading.Timer(0.4, lambda: webbrowser.open(url)).start()
        except Exception:
            log("自动打开浏览器失败，请手动访问 " + url, "WARN")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("收到 Ctrl+C，服务正常停止", "INFO")
    except Exception:
        log("服务运行异常：\n" + traceback.format_exc().strip(), "ERROR")
        httpd.server_close()
        return 1
    finally:
        try:
            httpd.server_close()
        except Exception:
            pass
    log("服务已停止", "INFO")
    return 0


if __name__ == "__main__":
    try:
        _code = main()
    except SystemExit:
        raise
    except BaseException:
        try:
            log("未捕获异常，服务未能启动：\n" + traceback.format_exc().strip(), "ERROR")
            log("详见日志：" + LOG_PATH, "ERROR")
        except Exception:
            traceback.print_exc()
        _code = 1
    sys.exit(_code)
