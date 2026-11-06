"""pipeline.py 的纯函数级自检（不碰 ffmpeg/RVC，几秒跑完）。

覆盖本轮修复里最容易悄悄退化的三处：
  1. 没有合规静音时，切点要退到主歌/副歌边界（sections），而不是直接按 48s 硬切；
  2. run() 失败时抛出的文案不能带整条命令行/本机路径（会原样进 QQ 聊天）；
  3. log() 除了 print，也要真的落进 pipeline.log。

跑法：python tests\\test_pipeline.py   （退出码 0 = 全过）
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

import pipeline  # noqa: E402

passed = 0


def ok(name):
    global passed
    passed += 1
    print("PASS %s" % name)


def check_plain():
    segs = pipeline.plan_boundaries(237.0, [])
    # 每段都不超过 max_seg(56)，且首尾接得上、盖住整首
    assert segs[0][0] == 0.0, segs
    assert abs(segs[-1][1] - 237.0) < 1e-6, segs
    for a, b in segs:
        assert b - a <= 56.0 + 1e-6, (a, b)
    for i in range(len(segs) - 1):
        assert abs(segs[i][1] - segs[i + 1][0]) < 1e-6, segs
    ok("plan_boundaries: 纯硬切也能盖满整首且每段 <= 56s")


def check_sections():
    secs = [
        {"start": 0.0, "end": 64.2},
        {"start": 64.2, "end": 112.4},
        {"start": 112.4, "end": 192.0},
        {"start": 192.0, "end": 237.5},
    ]
    segs = pipeline.plan_boundaries(237.0, [], secs=secs)
    ends = [b for _, b in segs[:-1]]
    # 至少有一刀落在段落边界上（以前一律 48/96/144/192 硬切）
    boundaries = {64.2, 112.4, 192.0, 0.0, 237.5}
    hits = [e for e in ends if any(abs(e - b) < 1e-6 for b in boundaries)]
    assert hits, "切点没落在段落边界上：%s" % ends
    ok("plan_boundaries: 无静音时退到段落边界（%d 刀）" % len(hits))


def check_error_text():
    try:
        pipeline.run([sys.executable, "-c", "raise SystemExit(3)"])
    except RuntimeError as exc:
        text = str(exc)
        assert "rc=3" in text, text
        assert "python" not in text.lower(), "报错文案泄露了解释器路径：%s" % text
        assert "-c" not in text, "报错文案泄露了命令行：%s" % text
        assert "pipeline.log" in text, text
        ok("run(): 失败文案只给 rc/耗时，命令行进日志")
    else:
        raise AssertionError("rc=3 应该抛 RuntimeError")


def check_log_file():
    fd, path = tempfile.mkstemp(suffix=".log")
    os.close(fd)
    fh = open(path, "w", encoding="utf-8")
    old = pipeline.LOG_FH
    try:
        pipeline.LOG_FH = fh
        pipeline.log("落盘自检 marker-42")
        fh.flush()
        with open(path, "r", encoding="utf-8") as r:
            body = r.read()
        assert "marker-42" in body, body
        ok("log(): 同时写进 pipeline.log")
    finally:
        pipeline.LOG_FH = old
        fh.close()
        try:
            os.unlink(path)
        except OSError:
            pass


if __name__ == "__main__":
    check_plain()
    check_sections()
    check_error_text()
    check_log_file()
    print("\n%d checks passed" % passed)
