"""dsh-gpu-queue 的 Python 客户端（只用标准库）。

画图和唱歌抢同一张 8G 显卡（RTX 3070，8192MiB），队列服务 dsh-gpu-queue 监听
127.0.0.1:31879，协议：
    POST /gpu/acquire   {kind, label, ownerPid}  -> {state: granted|queued, id, position}
    GET  /gpu/ticket?id=                         -> {state, position}
    POST /gpu/heartbeat {id}                     持有期间每 15s 一次
    POST /gpu/release   {id}
写端点要 x-control-token（~/.dsh/dsh-services/gpu-queue.token，DSH_SERVICES_DIR 可覆盖）。

唱歌这边的口径：**连不上队列就照唱**（这时画画那边会明确失败，不会同时吃卡），
但要打日志说清楚；连上了就老实排队，轮到我们再让 UVR5 / RVC 上卡。
"""
import atexit
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE = "http://127.0.0.1:31879"


class GpuQueueError(RuntimeError):
    pass


class GpuQueueUnavailable(GpuQueueError):
    pass


class GpuQueueTimeout(GpuQueueError):
    pass


def services_dir():
    override = os.environ.get("DSH_SERVICES_DIR")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".dsh", "dsh-services")


def read_token():
    path = os.path.join(services_dir(), "gpu-queue.token")
    try:
        with open(path, "r", encoding="utf8") as fh:
            return fh.read().strip()
    except Exception:
        return ""


class Ticket(object):
    """一张被授予的令牌；持有时定时心跳，用完 release()。"""

    def __init__(self, client, ticket_id, label="", log=None):
        self.client = client
        self.id = ticket_id
        self.label = label
        self.log = log or (lambda message: None)
        self._released = False
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._beat, name="gpu-heartbeat", daemon=True)
        self._thread.start()
        atexit.register(self.release)

    def _beat(self):
        interval = max(5.0, float(self.client.heartbeat_seconds))
        while not self._stop.wait(interval):
            try:
                self.client.call("POST", "/gpu/heartbeat", {"id": self.id}, timeout=3)
            except Exception as exc:  # 心跳丢了队列会在 60s 后回收，别让线程死掉
                self.log("GPU 令牌心跳失败：%s" % exc)

    def release(self):
        if self._released:
            return False
        self._released = True
        self._stop.set()
        try:
            self.client.call("POST", "/gpu/release", {"id": self.id}, timeout=3)
            self.log("GPU 令牌已释放（%s）" % (self.label or self.id))
            return True
        except Exception as exc:
            self.log("释放 GPU 令牌失败：%s" % exc)
            return False


class GpuQueue(object):
    def __init__(self, base=None, wait_seconds=300.0, poll_seconds=2.0, heartbeat_seconds=15.0, log=None):
        self.base = (base or os.environ.get("GPU_QUEUE_URL") or DEFAULT_BASE).rstrip("/")
        self.wait_seconds = float(wait_seconds)
        self.poll_seconds = max(0.5, float(poll_seconds))
        self.heartbeat_seconds = float(heartbeat_seconds)
        self.log = log or (lambda message: None)
        self.token = read_token()

    def call(self, method, path, body=None, timeout=5):
        url = self.base + path
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body).encode("utf8")
            headers["content-type"] = "application/json"
        if self.token:
            headers["x-control-token"] = self.token
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf8") or "{}")
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf8", "replace")[:200]
            except Exception:
                pass
            raise GpuQueueError("GPU 队列返回 %s：%s" % (exc.code, detail)) from exc
        except Exception as exc:
            raise GpuQueueUnavailable("连不上 GPU 队列（%s）：%s" % (self.base, exc)) from exc
        if isinstance(payload, dict) and payload.get("ok") is False:
            raise GpuQueueError(payload.get("error") or "GPU 队列拒绝了请求")
        return payload

    def ping(self):
        try:
            self.call("GET", "/gpu/ping", timeout=2)
            return True
        except Exception:
            return False

    def acquire(self, kind, label=""):
        """领一张牌：拿不到就排队轮询到发牌；超时抛 GpuQueueTimeout。"""
        started = self.call("POST", "/gpu/acquire", {"kind": kind, "label": str(label)[:120], "ownerPid": os.getpid()})
        state = started.get("state")
        ticket_id = started.get("id") or ""
        if state == "granted":
            self.log("GPU 令牌到手（%s）" % (label or kind))
            return Ticket(self, ticket_id, label=label, log=self.log)
        if state != "queued":
            raise GpuQueueError("GPU 队列没接这次请求（state=%s）" % state)
        position = int(started.get("position") or 1)
        self.log("排队等显卡：%s（前面还有 %d 个）" % (label or kind, max(0, position - 1)))
        deadline = time.time() + self.wait_seconds
        while time.time() < deadline:
            time.sleep(self.poll_seconds)
            try:
                ticket = self.call("GET", "/gpu/ticket?id=%s" % urllib.parse.quote(ticket_id), timeout=5)
            except GpuQueueUnavailable as exc:
                raise GpuQueueTimeout("排队时和队列断开了：%s" % exc) from exc
            state = ticket.get("state")
            if state == "granted":
                self.log("GPU 令牌到手（%s）" % (label or kind))
                return Ticket(self, ticket_id, label=label, log=self.log)
            if state == "queued":
                now_position = int(ticket.get("position") or position)
                if now_position != position:
                    position = now_position
                    self.log("排队位置变成第 %d 位" % position)
                continue
            if state == "cancelled":
                raise GpuQueueTimeout("排队被面板撤掉了")
            raise GpuQueueTimeout("排队状态丢了（%s）" % state)
        try:
            self.call("POST", "/gpu/cancel", {"id": ticket_id}, timeout=2)
        except Exception:
            pass
        raise GpuQueueTimeout("排队超时（等了约 %.0f 分钟）" % (self.wait_seconds / 60.0))

    def acquire_or_warn(self, kind, label=""):
        """唱歌用的宽松版：队列连不上/排太久就打日志照唱（这时画画那边会拒绝，不会撞车）。"""
        try:
            return self.acquire(kind, label=label)
        except GpuQueueUnavailable as exc:
            self.log("GPU 队列不可用，这次不排队直接唱：%s" % exc)
            return None
        except GpuQueueTimeout as exc:
            self.log("排队没等到，先唱了：%s" % exc)
            return None
