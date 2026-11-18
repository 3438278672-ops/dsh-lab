"""gpuqueue.py（dsh-gpu-queue 的 Python 客户端）的自检，不碰真队列、不碰真显卡。

覆盖：
  1. 直接发牌 → release 带上令牌与 id，只发一次；
  2. 先排队再发牌 → 轮询到 granted 才返回 Ticket；
  3. 一直排不到 → 抛 GpuQueueTimeout，并顺手把排队项撤掉（POST /gpu/cancel）；
  4. 服务不可达 → GpuQueueUnavailable；acquire_or_warn 打日志回落成「不排队照唱」；
  5. 令牌从 DSH_SERVICES_DIR/gpu-queue.token 读。

跑法：python tests\\test_gpuqueue.py   （退出码 0 = 全过）
"""
import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

TOKEN = "t" * 48
passed = 0


def ok(name):
    global passed
    passed += 1
    print("PASS %s" % name)


def fail(name, detail):
    print("FAIL %s: %s" % (name, detail))
    raise SystemExit(1)


class Fake(object):
    """一台假队列：按 mode 决定发牌还是让人排队，并记下收到的令牌与请求。"""

    def __init__(self):
        self.mode = "grant"  # grant | queue_then_grant | queue_forever
        self.requests = []
        self.headers = []
        self.ticket_polls = 0
        self.lock = threading.Lock()


def make_server(fake):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _body(self):
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                return json.loads(raw.decode("utf8") or "{}")
            except Exception:
                return {}

        def _send(self, code, payload):
            body = json.dumps(payload, ensure_ascii=False).encode("utf8")
            self.send_response(code)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            with fake.lock:
                fake.requests.append(("GET", self.path))
                fake.headers.append(self.headers.get("x-control-token") or "")
            if self.path.startswith("/gpu/ticket"):
                fake.ticket_polls += 1
                if fake.mode == "queue_then_grant" and fake.ticket_polls >= 2:
                    return self._send(200, {"ok": True, "state": "granted", "id": "t-2"})
                return self._send(200, {"ok": True, "state": "queued", "id": "t-2", "position": 1})
            return self._send(200, {"ok": True})

        def do_POST(self):
            body = self._body()
            with fake.lock:
                fake.requests.append(("POST", self.path))
                fake.headers.append(self.headers.get("x-control-token") or "")
            if self.path.startswith("/gpu/acquire"):
                if fake.mode == "grant":
                    return self._send(200, {"ok": True, "state": "granted", "id": "t-1"})
                return self._send(200, {"ok": True, "state": "queued", "id": "t-2", "position": 1})
            if self.path.startswith("/gpu/release"):
                fake.released = body
                return self._send(200, {"ok": True, "released": True})
            if self.path.startswith("/gpu/cancel"):
                fake.cancelled = body
                return self._send(200, {"ok": True, "cancelled": True})
            if self.path.startswith("/gpu/heartbeat"):
                return self._send(200, {"ok": True, "state": "granted"})
            return self._send(404, {"ok": False, "error": "no route"})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, "http://127.0.0.1:%d" % server.server_address[1]


def client(base, **kwargs):
    import gpuqueue

    kwargs.setdefault("poll_seconds", 0.15)
    kwargs.setdefault("wait_seconds", 5)
    kwargs.setdefault("log", lambda message: None)
    return gpuqueue.GpuQueue(base=base, **kwargs)


def main():
    import gpuqueue

    tmp = tempfile.mkdtemp(prefix="gq-py-")
    os.environ["DSH_SERVICES_DIR"] = tmp
    with open(os.path.join(tmp, "gpu-queue.token"), "w", encoding="utf8") as fh:
        fh.write(TOKEN + "\n")

    # 1. 直接发牌 + release
    fake = Fake()
    fake.mode = "grant"
    server, base = make_server(fake)
    queue = client(base)
    ticket = queue.acquire("sing", "唱一首")
    if ticket.id != "t-1":
        fail("granted", "id=%r" % ticket.id)
    if ticket.release() is not True:
        fail("granted", "release 没回 True")
    if ticket.release() is not False:
        fail("granted", "release 被重复发送")
    time.sleep(0.1)
    if getattr(fake, "released", None) != {"id": "t-1"}:
        fail("granted", "release body=%r" % getattr(fake, "released", None))
    if not all(h == TOKEN for h in fake.headers if h):
        fail("granted", "写端点令牌没带上：%r" % fake.headers)
    server.shutdown()
    ok("直接发牌 → release 带上令牌与 id，且只发一次")

    # 2. 先排队再发牌
    fake = Fake()
    fake.mode = "queue_then_grant"
    server, base = make_server(fake)
    logs = []
    queue = client(base, log=logs.append)
    ticket = queue.acquire("draw", "画一张")
    if ticket.id != "t-2":
        fail("queued", "id=%r" % ticket.id)
    if fake.ticket_polls < 2:
        fail("queued", "没有轮询 ticket：%d" % fake.ticket_polls)
    if not any("排队" in line for line in logs):
        fail("queued", "排队没打日志：%r" % logs)
    ticket.release()
    server.shutdown()
    ok("先排队再发牌 → 轮询到 granted 才回 Ticket")

    # 3. 排不到：超时 + 撤单
    fake = Fake()
    fake.mode = "queue_forever"
    server, base = make_server(fake)
    queue = client(base, wait_seconds=0.6, poll_seconds=0.1)
    started = time.time()
    try:
        queue.acquire("draw", "画一张")
        fail("timeout", "居然发牌了")
    except gpuqueue.GpuQueueTimeout as exc:
        if time.time() - started < 0.5:
            fail("timeout", "超时太早：%.2fs" % (time.time() - started))
        if "排队超时" not in str(exc):
            fail("timeout", "文案=%r" % str(exc))
    time.sleep(0.1)
    if getattr(fake, "cancelled", None) != {"id": "t-2"}:
        fail("timeout", "没撤单：%r" % getattr(fake, "cancelled", None))
    server.shutdown()
    ok("排不到 → 抛 GpuQueueTimeout 并撤掉排队项")

    # 4. 服务不可达：宽松版照唱，但要说清楚
    logs = []
    queue = client("http://127.0.0.1:1", log=logs.append)
    try:
        queue.acquire("sing", "唱一首")
        fail("down", "不可达居然成功了")
    except gpuqueue.GpuQueueUnavailable:
        pass
    if queue.acquire_or_warn("sing", "唱一首") is not None:
        fail("down", "acquire_or_warn 不该发牌")
    if not any("GPU 队列不可用" in line for line in logs):
        fail("down", "没打回落日志：%r" % logs)
    ok("服务不可达 → GpuQueueUnavailable，宽松版打日志照唱")

    # 5. 令牌来源
    if gpuqueue.read_token() != TOKEN:
        fail("token", "read_token=%r" % gpuqueue.read_token())
    os.environ.pop("DSH_SERVICES_DIR", None)
    ok("令牌从 DSH_SERVICES_DIR/gpu-queue.token 读")

    print("\n%d checks passed" % passed)


if __name__ == "__main__":
    main()
