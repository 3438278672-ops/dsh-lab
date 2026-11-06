#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一首歌 → 若干条 QQ 语音，对齐隔壁 RVC 会话的新标准：
ffmpeg 抽音轨 → UVR5 分离 → 定调(key_adjust) → 静音处切段 → RVC 一次批量转换 →
整首混音(1.15/0.9/limit 0.89，DJ/搞笑歌先用 adlib 踩点加怪叫) → 静音边界切片 → 写 LESSONS 复盘。

用法：
  python pipeline.py --input source.m4a --workdir <jobdir> [--title 标题] [--song 点歌原文]
                     [--chunk 48] [--max-seg 56]

stdout 只打印两类行（Node 侧解析）：
  STAGE=<name>               进度阶段
  RESULT=<json>              成功结果（含 segments 数组）
失败：stderr 打印原因，stdout 打印 ERROR=<msg>，退出码非 0。
"""
import argparse
import datetime
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

GSV = r"D:\GSV\GPT-SoVITS-v2pro-20250604"
GSV_PY = os.path.join(GSV, "runtime", "python.exe")
RVC = r"D:\GSV\rvc\RVC"
RVC_PY = r"D:\GSV\rvc\venv\Scripts\python.exe"
FFMPEG = r"C:\ffmpeg\bin\ffmpeg.exe"
FFPROBE = r"C:\ffmpeg\bin\ffprobe.exe"
MODEL = "assets/weights/dfy2_sing_v3.pth"
INDEX = "assets/indices/dfy2_sing_v3_added_IVF2671_Flat_nprobe_1_dfy2_sing_v3_v2.index"
KEY_ADJUST = r"D:\GSV\rvc\key_adjust.py"
KEYFIT = r"D:\GSV\rvc\keyfit.py"
SECTIONS = r"D:\GSV\rvc\sections.py"
F0_BATCH = r"D:\GSV\rvc\f0_batch.py"
# 分段自适应：(index_rate, protect)；protect 上限 0.5（RVC CLI 限制）
ADAPTIVE = os.environ.get("ADAPTIVE", "1") != "0"
# 低于该中位基频的段改用 pm 提取 f0（rmvpe 在低音区会抓错八度）
LOW_PM_HZ = float(os.environ.get("LOW_PM_HZ", "240"))
PARAMS = {
    "verse": (float(os.environ.get("VERSE_IR", "0.5")), float(os.environ.get("VERSE_PROTECT", "0.5"))),
    "chorus": (float(os.environ.get("CHORUS_IR", "0.6")), float(os.environ.get("CHORUS_PROTECT", "0.5"))),
    "uniform": (float(os.environ.get("UNIFORM_IR", "0.75")), float(os.environ.get("UNIFORM_PROTECT", "0.33"))),
}
SONGCHECK = r"D:\GSV\tools\dsh-soundcheck-main\engine\analyze.py"
SEP_PY = r"D:\GSV\sep\venv\Scripts\python.exe"
RUN_SEP = r"D:\GSV\sep\run_sep.py"
ADLIB = r"D:\GSV\rvc\adlib.py"
MIXCHAIN = r"D:\GSV\rvc\mixchain.py"
MIX_PRESET = os.environ.get("MIX_PRESET", "vocal2")
MIX_LUFS = os.environ.get("MIX_LUFS", "-14")
FEIYU_PY = r"D:\GSV\feiyu\venv\Scripts\python.exe"
LESSONS = r"D:\GSV\rvc\LESSONS.md"
# 伴奏清洁脚本：以前这里少定义，名字错了一直被 except 吞掉、清洁从未生效
CLEAN_CHECK = os.environ.get("CLEAN_CHECK", r"D:\GSV\rvc\clean_check.py")

# 歌名/标题里出现这些词，就按对应风格踩点加怪叫（ADLIB=dj|funny|party 强制，ADLIB=0 关闭）
DJ_WORDS = ("dj", "电音", "舞曲", "remix", "蹦迪", "慢摇", "夜店", "土嗨")
FUNNY_WORDS = ("搞笑", "鬼畜", "沙雕", "整活", "恶搞", "魔性")
CHUNK = 48.0

LOG_FH = None

# 统一 UTF-8 输出：Node 侧按 UTF-8 解析，避免 Windows 控制台默认 GBK 把中文/emoji 弄坏
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def log(msg):
    print(msg, flush=True)
    # 同一份内容也落盘：Node 侧只把 stdout 前 64KB 留在内存里，挂一次就没有现场了
    if LOG_FH:
        try:
            LOG_FH.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), msg))
            LOG_FH.flush()
        except Exception:
            pass


def stage(name, extra=""):
    print("STAGE=%s%s" % (name, (" " + extra) if extra else ""), flush=True)


def run(cmd, cwd=None, timeout=1800, check=True, capture_err=False, env=None):
    if LOG_FH:
        LOG_FH.write("\n>> " + " ".join(str(c) for c in cmd) + "\n")
        LOG_FH.flush()
    t0 = time.time()
    proc = subprocess.run(
        [str(c) for c in cmd],
        cwd=cwd,
        env=env,
        stdout=LOG_FH if LOG_FH else subprocess.DEVNULL,
        stderr=subprocess.PIPE if capture_err else (LOG_FH if LOG_FH else subprocess.DEVNULL),
        timeout=timeout,
    )
    dt = time.time() - t0
    if check and proc.returncode != 0:
        # 不要把整条命令行（含本机绝对路径）抛到聊天里：完整命令已经写进 pipeline.log
        raise RuntimeError("命令失败(rc=%s)，耗时%.0fs，详情见 pipeline.log" % (proc.returncode, dt))
    return proc


def ffprobe_duration(path):
    proc = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of",
         "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True,
    )
    try:
        return float(proc.stdout.strip())
    except Exception:
        return 0.0


def mean_volume(path):
    proc = subprocess.run(
        [FFMPEG, "-hide_banner", "-nostats", "-i", str(path), "-af", "volumedetect",
         "-f", "null", "-"],
        capture_output=True, text=True,
    )
    m = re.search(r"mean_volume:\s*(-?[\d.]+) dB", proc.stderr)
    return float(m.group(1)) if m else 0.0


def peak_volume(path):
    proc = subprocess.run(
        [FFMPEG, "-hide_banner", "-nostats", "-i", str(path), "-af", "volumedetect",
         "-f", "null", "-"],
        capture_output=True, text=True,
    )
    m = re.search(r"max_volume:\s*(-?[\d.]+) dB", proc.stderr)
    return float(m.group(1)) if m else 0.0


def detect_style(*texts):
    """按点歌原文/视频标题猜怪叫风格；ADLIB 环境变量可强制或关掉。"""
    env = (os.environ.get("ADLIB") or "").strip().lower()
    if env == "0":
        return ""
    if env in ("dj", "funny", "party"):
        return env
    t = " ".join(x for x in texts if x).lower()
    if any(k in t for k in DJ_WORDS):
        return "dj"
    if any(k in t for k in FUNNY_WORDS):
        return "funny"
    return ""


def detect_silences(path, noise="-32dB", dur=0.4):
    proc = subprocess.run(
        [FFMPEG, "-hide_banner", "-nostats", "-i", str(path), "-af",
         "silencedetect=noise=%s:d=%s" % (noise, dur), "-f", "null", "-"],
        capture_output=True, text=True,
    )
    txt = proc.stderr
    starts = [float(x) for x in re.findall(r"silence_start:\s*(-?[\d.]+)", txt)]
    ends = [float(x) for x in re.findall(r"silence_end:\s*(-?[\d.]+)", txt)]
    silences = []
    for i, s in enumerate(starts):
        e = ends[i] if i < len(ends) else s
        if e > s:
            silences.append((max(0.0, s), e))
    return silences, txt


def plan_boundaries(total, silences, chunk=48.0, max_seg=56.0, min_seg=12.0, secs=None):
    """在静音中点附近切，保证每段 <= max_seg，段尾不要过短。

    没有合规静音时优先退到主歌/副歌边界（sections），最后才硬切——
    硬切最容易把半个字劈成两段，听感上就是「突然断一下」。
    """
    # 掐掉过长的纯伴奏头尾
    start = 0.0
    end = total
    if silences:
        head_gap = silences[0][1]
        if head_gap > 18:
            start = max(0.0, head_gap - 4.0)
        tail_gap = total - silences[-1][0]
        if tail_gap > 18:
            end = min(total, silences[-1][0] + 5.0)
    if end - start < min_seg:
        start, end = 0.0, total

    mids = [((s + e) / 2.0, e - s) for s, e in silences]
    bounds = []
    for s in secs or []:
        for key in ("start", "end"):
            try:
                bounds.append(float(s[key]))
            except (KeyError, TypeError, ValueError):
                pass
    cuts = [start]
    pos = start
    on_silence = on_section = hard_cut = 0
    while end - pos > max_seg:
        ideal = pos + chunk
        lo, hi = pos + min_seg, pos + max_seg - 5.0
        cands = [m for m, w in mids if w >= 0.28 and lo <= m <= hi]
        if cands:
            cut = min(cands, key=lambda c: abs(c - ideal))
            on_silence += 1
        else:
            near = [b for b in bounds if lo <= b <= hi]
            if near:
                cut = min(near, key=lambda c: abs(c - ideal))
                on_section += 1
            else:
                cut = ideal
                hard_cut += 1
        if cut <= pos + 3:
            cut = min(pos + chunk, end)
            hard_cut += 1
        cuts.append(cut)
        pos = cut
    cuts.append(end)
    if len(cuts) > 2 and cuts[-1] - cuts[-2] < min_seg:
        cuts.pop(-2)
    if on_section or hard_cut:
        log("切段参考：静音 %d 刀 / 段落边界 %d 刀 / 硬切 %d 刀" % (on_silence, on_section, hard_cut))
    return [(cuts[i], cuts[i + 1]) for i in range(len(cuts) - 1)]


def separate(workdir, wav):
    voc_dir = os.path.join(workdir, "vocals")
    ins_dir = os.path.join(workdir, "instrument")
    os.makedirs(voc_dir, exist_ok=True)
    os.makedirs(ins_dir, exist_ok=True)
    used_bs = False
    if os.environ.get("SEP_BS", "1") != "0" and os.path.exists(SEP_PY):
        try:
            run([SEP_PY, RUN_SEP, wav, voc_dir, ins_dir], cwd=GSV, timeout=3600)
            used_bs = bool(glob.glob(os.path.join(voc_dir, "vocal_*.wav")))
        except Exception as exc:
            log("BS-Roformer 失败，退回 HP5: %s" % exc)
            shutil.rmtree(voc_dir, ignore_errors=True)
            shutil.rmtree(ins_dir, ignore_errors=True)
            os.makedirs(voc_dir, exist_ok=True)
            os.makedirs(ins_dir, exist_ok=True)
    if not used_bs:
        sep_script = os.path.join(workdir, "_sep.py")
        with open(sep_script, "w", encoding="utf8") as fh:
            fh.write(
                "# -*- coding: utf-8 -*-\n"
                "import os, json, sys, torch\n"
                "sys.path.insert(0, os.path.join(r'%(gsv)s', 'tools', 'uvr5'))\n"
                "sys.path.insert(0, r'%(gsv)s')\n"
                "from vr import AudioPre\n"
                "w = os.path.join(r'%(gsv)s', 'tools', 'uvr5', 'uvr5_weights')\n"
                "pre = AudioPre(agg=10, model_path=os.path.join(w, 'HP5_only_main_vocal.pth'),\n"
                "               device='cuda:0' if torch.cuda.is_available() else 'cpu',\n"
                "               is_half=torch.cuda.is_available())\n"
                "pre._path_audio_(r'%(wav)s', r'%(ins)s', r'%(voc)s', format='wav')\n"
                "print('separated', flush=True)\n"
                % {"gsv": GSV, "wav": wav, "ins": ins_dir, "voc": voc_dir}
            )
        run([GSV_PY, sep_script], cwd=GSV, timeout=1800)
    vocals = sorted(glob.glob(os.path.join(voc_dir, "vocal_*.wav")))
    ins = sorted(glob.glob(os.path.join(ins_dir, "instrument_*.wav")))
    if not vocals or not ins:
        raise RuntimeError("人声分离没有出结果")
    # 伴奏洁净度：漏进来的残留人声按增益减掉，脏的段落让伴奏退一点
    vocal, ins = vocals[0], ins[0]
    cleaned = os.path.join(workdir, "instrument_clean.wav")
    if not (CLEAN_CHECK and os.path.exists(CLEAN_CHECK)):
        log("clean_check 脚本不存在（%s），跳过伴奏清洁" % CLEAN_CHECK)
        return vocal, ins
    try:
        rc = subprocess.run([GSV_PY, CLEAN_CHECK, "--instrumental", ins, "--vocal", vocal,
                             "--out", cleaned, "--report", os.path.join(workdir, "clean.json"),
                             "--win", "20"], capture_output=True, text=True, timeout=3600)
        line = [l for l in rc.stdout.splitlines() if l.startswith("{")]
        log("clean_check %s" % (line[-1] if line else rc.stdout[-200:]))
        if rc.returncode == 0 and os.path.exists(cleaned) and os.path.getsize(cleaned) > 100000:
            ins = cleaned
    except Exception as exc:
        log("clean_check failed, keep raw instrument: %s" % exc)
    return vocal, ins


def detect_sections(workdir, vocal):
    """人声轨切主歌/副歌；失败返回 None（退回统一参数）。"""
    if not ADAPTIVE:
        return None
    out = os.path.join(workdir, "sections.json")
    try:
        run([GSV_PY, SECTIONS, vocal, "--json", out], timeout=600)
        if os.path.exists(out):
            data = json.loads(Path(out).read_text(encoding="utf8"))
            secs = data.get("sections") or []
            if secs:
                log("sections: " + ", ".join("%s %.0f-%.0f" % (s["kind"], s["start"], s["end"]) for s in secs))
                return secs
    except Exception as exc:
        log("sections failed: %s" % exc)
    return None


def kind_at(t, secs):
    if not secs:
        return None
    for s in secs:
        if s["start"] <= t < s["end"]:
            return s["kind"]
    return secs[-1]["kind"]


def median_f0(path):
    """段的中位基频（Hz）；pyworld 不可用时返回 0（回落到 rmvpe）。"""
    try:
        import numpy as np
        import pyworld as pw
        import soundfile as sf
        y, sr = sf.read(path, dtype="float32")
        if y.ndim > 1:
            y = y.mean(axis=1)
        f, _ = pw.harvest(y.astype(np.float64), sr, f0_floor=60, f0_ceil=900, frame_period=10)
        v = f[f > 0]
        return float(np.median(v)) if len(v) else 0.0
    except Exception:
        return 0.0


def convert(workdir, vocal, segments, pitch=0, secs=None):
    sys.path.insert(0, r"D:\GSV\rvc")
    from gpulock import gpu_lock
    chunks = os.path.join(workdir, "chunks")
    conv = os.path.join(workdir, "conv")
    shutil.rmtree(chunks, ignore_errors=True)
    shutil.rmtree(conv, ignore_errors=True)
    os.makedirs(chunks, exist_ok=True)
    os.makedirs(conv, exist_ok=True)

    plan = []
    for idx, (s, e) in enumerate(segments, 1):
        name = "c%02d" % idx
        src = os.path.join(chunks, name + ".wav")
        run([FFMPEG, "-y", "-ss", "%.3f" % s, "-to", "%.3f" % e, "-i", vocal,
             "-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", src], timeout=300)
        plan.append((idx, s, e, name, src, kind_at((s + e) / 2.0, secs)))

    stage("rvc", "%d" % len(plan))
    t0 = time.time()
    lock = gpu_lock("rvc").acquire()   # 同一时刻只允许一个任务吃显存
    log("GPU 锁已获取，开始转换")
    try:
        _convert_groups(chunks, conv, plan, pitch)
    finally:
        # 以前要等进程退出才靠 atexit 放锁，后面的混音/切片一直白占着显存
        try:
            lock.release()
            log("GPU 锁已释放")
        except Exception as exc:
            log("释放 GPU 锁失败：%s" % exc)

    missing = [n for _, _, _, n, _, _ in plan if not os.path.exists(os.path.join(conv, n + ".wav"))]
    if missing:
        raise RuntimeError("RVC 有 %d 段没转出来（%s）" % (len(missing), ",".join(missing)))
    log("RVC done in %.0fs" % (time.time() - t0))
    return plan


def _convert_groups(chunks, conv, plan, pitch):
    """f0 分组 + RVC 批量转换；批量挂掉时收回已生成的段，缺的逐段重试一次。"""
    # 这里的解释器是 RVC 的 venv（没有 pyworld），f0 交给 GSV runtime python 批量算一次
    f0map = {}
    try:
        lst = os.path.join(chunks, "_f0list.txt")
        with open(lst, "w", encoding="utf8") as fh:
            for item in plan:
                fh.write(item[4] + "\n")
        proc = subprocess.run([GSV_PY, F0_BATCH, lst], capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=2400)
        for row in json.loads(proc.stdout.strip().splitlines()[-1]):
            f0map[os.path.basename(row["path"])] = float(row.get("median_f0") or 0.0)
        log("f0 批量读取 %d 段" % len(f0map))
    except Exception as exc:
        log("批量 f0 读取失败（全部按 rmvpe）：%s" % exc)
    groups = {}
    for item in plan:
        med = f0map.get(os.path.basename(item[4]), 0.0)
        method = "pm" if 0 < med < LOW_PM_HZ else "rmvpe"
        groups.setdefault((item[5] or "uniform", method), []).append(item)
    for (kind, method), items in groups.items():
        ir, pr = PARAMS.get(kind, PARAMS["uniform"])
        sub_in = os.path.join(chunks, "_" + kind)
        sub_out = os.path.join(conv, "_" + kind)
        shutil.rmtree(sub_in, ignore_errors=True)
        shutil.rmtree(sub_out, ignore_errors=True)
        os.makedirs(sub_in, exist_ok=True)
        for item in items:
            run([FFMPEG, "-y", "-i", item[4], "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", os.path.join(sub_in, item[3] + ".wav")], timeout=300)
        log("rvc %s(%s): %d 段 ir=%.2f protect=%.2f" % (kind, method, len(items), ir, pr))
        # 批量是「一条命令转一组」：一组里挂一段，以前 check=True 会把整首判死、已转好的段白扔
        proc = run([RVC_PY, "-m", "infer.cli", "--model", MODEL, "--input", sub_in, "--output", sub_out,
                    "--index", INDEX, "--index-rate", str(ir), "--protect", str(pr),
                    "--f0-method", method, "--pitch", str(pitch),
                    "--format", "wav", "--overwrite"], cwd=RVC, timeout=3600, check=False,
                   # CUDA Graph 对每种音频长度都要重新捕获一遍（每段 ~55s），批量短音频反而慢 15 倍
                   env=dict(os.environ, RVC_CUDA_GRAPH="0", PYTHONPATH=RVC))
        if proc.returncode != 0:
            log("RVC 批量返回 rc=%s，先把已经转出来的段收回来" % proc.returncode)
        for item in items:
            src = os.path.join(sub_out, item[3] + ".wav")
            if os.path.exists(src):
                shutil.move(src, os.path.join(conv, item[3] + ".wav"))
        pending = [it for it in items if not os.path.exists(os.path.join(conv, it[3] + ".wav"))]
        if pending:
            log("RVC 缺 %d 段，逐段重试：%s" % (len(pending), ",".join(it[3] for it in pending)))
            for it in pending:
                run([RVC_PY, "-m", "infer.cli", "--model", MODEL, "--input", it[4], "--output", conv,
                     "--index", INDEX, "--index-rate", str(ir), "--protect", str(pr),
                     "--f0-method", method, "--pitch", str(pitch),
                     "--format", "wav", "--overwrite"], cwd=RVC, timeout=1200, check=False,
                    env=dict(os.environ, RVC_CUDA_GRAPH="0", PYTHONPATH=RVC))


def concat_converted(workdir, plan):
    """把 RVC 分块结果按顺序拼回整条人声，混音和怪叫都在整条上做。"""
    conv_dir = os.path.join(workdir, "conv")
    lst = os.path.join(workdir, "conv_list.txt")
    with open(lst, "w", encoding="utf8") as fh:
        for idx, s, e, name, src, _kind in plan:
            p = os.path.join(conv_dir, name + ".wav").replace("\\", "/").replace("'", "'\\''")
            fh.write("file '%s'\n" % p)
    out = os.path.join(workdir, "converted.wav")
    run([FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", lst,
         "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", out], timeout=900)
    if not os.path.exists(out) or os.path.getsize(out) < 200000:
        raise RuntimeError("人声拼接失败")
    return out


def build_full_mix(workdir, ins, converted, style, offset=0.0, trim_end=None):
    """整首混音：DJ/搞笑歌交给 adlib.py（自带 1.15/0.9/limit 0.89 + 踩点怪叫），否则纯混。

    offset/trim_end：plan 掐掉长伴奏头尾时，人声块已经从那一段开始，伴奏也必须裁成
    同一段再混；否则整首错位（人声在 41s 处、伴奏还在 0s），最后几段还会超出混音长度。
    """
    mix_full = os.path.join(workdir, "mix_full.wav")
    if offset > 0.001 or (trim_end is not None and trim_end > 0):
        ins_trim = os.path.join(workdir, "instrument_trim.wav")
        cut = ["-ss", "%.3f" % offset]
        if trim_end:
            cut += ["-t", "%.3f" % max(0.5, trim_end - offset)]
        run([FFMPEG, "-y", *cut, "-i", ins,
             "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", ins_trim], timeout=600)
        log("伴奏裁到 %.2f..%ss（人声同步段）" % (offset, "%.2f" % trim_end if trim_end else "末尾"))
        ins = ins_trim
    if style:
        stage("adlib", style)
        t0 = time.time()
        proc = subprocess.run(
            [FEIYU_PY, ADLIB, "--instrumental", ins, "--vocal", converted,
             "--out", mix_full, "--style", style, "--seed", "7"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=workdir, timeout=1800,
            env=dict(os.environ, PYTHONIOENCODING="utf-8"),
        )
        out = (proc.stdout or "") + (proc.stderr or "")
        with open(os.path.join(workdir, "adlib.log"), "w", encoding="utf8") as fh:
            fh.write(out)
        m = re.search(r"DONE .*?\(([\d.]+)s, (\d+) adlibs\)", out)
        if proc.returncode == 0 and m and os.path.exists(mix_full) and os.path.getsize(mix_full) > 200000:
            n = int(m.group(2))
            log("adlib style=%s, %d 处, %.0fs" % (style, n, time.time() - t0))
            stage("mix", "adlib %d" % n)
            return mix_full, n
        tail = out.strip().splitlines()[-1][:180] if out.strip() else ""
        log("adlib 失败(rc=%s)，退回普通混音：%s" % (proc.returncode, tail))
    stage("mix", "plain")
    mixed = False
    try:
        run([GSV_PY, MIXCHAIN, "--vocal", converted, "--inst", ins, "--out", mix_full,
             "--preset", MIX_PRESET, "--target", MIX_LUFS], timeout=1800)
        mixed = os.path.exists(mix_full) and os.path.getsize(mix_full) > 200000
    except Exception as exc:  # noqa: BLE001 - 任何失败都退回旧链
        log("mixchain 失败(%s)，退回旧混音" % exc)
    if not mixed:
        run([FFMPEG, "-y",
             "-i", converted, "-i", ins,
             "-filter_complex",
             "[0:a]aresample=48000,volume=1.15[v];"
             "[1:a]aresample=48000,volume=0.9[i];"
             "[v][i]amix=inputs=2:normalize=0:duration=shortest,"
             "alimiter=limit=0.89:level=false[out]",
             "-map", "[out]", "-ac", "2", "-ar", "48000", mix_full], timeout=900)
    return mix_full, 0


def slice_segments(workdir, mix_full, segments, out_dir, offset=0.0):
    os.makedirs(out_dir, exist_ok=True)
    results = []
    for idx, (s, e) in enumerate(segments, 1):
        seg_path = os.path.join(out_dir, "seg%02d.wav" % idx)
        # 混音从 plan 的第一段开始（offset），切段要用相对时间
        rs, re_ = s - offset, e - offset
        length = max(0.5, re_ - rs)
        # 3s 淡入淡出会吃掉半个字（尤其接得紧的情歌），压到 1.5s 以内还能压住爆音
        fade = min(1.5, length / 12.0)
        fc = (
            "[0:a]atrim=start=%.3f:end=%.3f,asetpts=PTS-STARTPTS,"
            "aresample=44100,"
            "afade=t=in:st=0:d=%.2f,afade=t=out:st=%.2f:d=%.2f[a]"
            % (rs, re_, fade, max(0.0, length - fade), fade)
        )
        run([FFMPEG, "-y",
             "-i", mix_full,
             "-filter_complex", fc, "-map", "[a]",
             "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", seg_path], timeout=300)
        dur = ffprobe_duration(seg_path)
        size = os.path.getsize(seg_path)
        if dur < 1.0 or size < 20000:
            raise RuntimeError("第 %d 段混音结果异常" % idx)
        results.append({
            "index": idx,
            "file": seg_path,
            "name": os.path.basename(seg_path),
            "start": round(s, 2),
            "end": round(e, 2),
            "duration": round(dur, 2),
            "bytes": size,
        })
    return results


def append_lesson(work, src, title, pitch, med, klass, style, adlib_count, nseg,
                  peak, mean, mix_dur, movie):
    """每首做完往 LESSONS.md 追加一条复盘，下次做歌前先看。"""
    try:
        stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
        rec = (
            "\n## %s · %s\n"
            "- 输入：`%s`，人声中位 %.1fHz（%s），变调 %+d → %.1fHz\n"
            "- 参数：dfy2_sing_v3，index-rate 0.75，rmvpe，%ss 分块 %d 段，"
            "混音 人声1.15/伴奏0.9/limit0.89\n"
            "- 味道：%s（%d 处怪叫）\n"
            "- 电平：峰值 %+.1f dB，平均 %+.1f dB；成片 %s（%.0fs）\n"
            "- 下次可试：%s\n"
        ) % (
            stamp, (title or os.path.basename(work))[:40],
            src, med, klass, pitch, med * 2 ** (pitch / 12.0) if med else 0.0,
            int(CHUNK), nseg,
            (style or "没有怪叫"), adlib_count,
            peak, mean, movie, mix_dur,
            "怪叫密度可再加密；副歌高音发虚就降 1 个半音；伴奏残留多换 BS-Roformer。",
        )
        with open(LESSONS, "a", encoding="utf8") as fh:
            fh.write(rec)
        log("LESSONS 已追加")
    except Exception as exc:
        log("LESSONS 写入失败：%s" % exc)


def main():
    global LOG_FH
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--title", default="", help="B 站视频标题，用来判断风格")
    ap.add_argument("--song", default="", help="群友点歌原文")
    ap.add_argument("--chunk", type=float, default=48.0)
    ap.add_argument("--max-seg", dest="max_seg", type=float, default=56.0)
    args = ap.parse_args()

    src = os.path.abspath(args.input)
    work = os.path.abspath(args.workdir)
    os.makedirs(work, exist_ok=True)
    LOG_FH = open(os.path.join(work, "pipeline.log"), "a", encoding="utf8", errors="replace")
    out_dir = os.path.join(work, "voice")

    t_all = time.time()
    total = ffprobe_duration(src)
    if total < 20:
        raise RuntimeError("音源太短或读不出来（%.0fs）" % total)

    stage("extract")
    wav = os.path.join(work, "song.wav")
    if not os.path.exists(wav) or os.path.getsize(wav) < 100000:
        run([FFMPEG, "-y", "-i", src, "-vn", "-ac", "2", "-ar", "48000",
             "-c:a", "pcm_s16le", wav], timeout=600)

    # 源曲体检：拍速 / 调性 / 削波 → analysis.json（SONGCHECK=0 可关）
    if os.environ.get("SONGCHECK", "1") != "0":
        try:
            ck = subprocess.run([GSV_PY, SONGCHECK, wav, "--json", "--brief"],
                                capture_output=True, text=True, encoding="utf-8",
                                errors="replace", timeout=1800)
            if ck.stdout.strip().startswith("{"):
                info = json.loads(ck.stdout.strip())
                with open(os.path.join(work, "analysis.json"), "w", encoding="utf8") as fh:
                    json.dump(info, fh, ensure_ascii=False, indent=1)
                k = info.get("key") or {}
                ld = info.get("loud") or {}
                log("songcheck %.1fBPM %s %.2f peak %.1f clipped=%s" % (
                    info.get("bpm", 0), k.get("best", "?"), k.get("r", 0),
                    ld.get("peak", 0), ld.get("clipped")))
        except Exception as exc:
            log("songcheck skipped: %s" % exc)

    stage("separate")
    vocal, ins = separate(work, wav)
    voc_dur = ffprobe_duration(vocal)
    if mean_volume(vocal) < -48:
        raise RuntimeError("这首歌没分出人声（可能是纯音乐版），换一首吧")

    # 定调：以她自己的音域为准（key_adjust.py：中位基频 → 365Hz，只升不降、上限 +7）
    pitch, med, klass = 0, 0.0, "?"
    try:
        proc = subprocess.run([GSV_PY, KEY_ADJUST, vocal], capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=900)
        info = json.loads(proc.stdout.strip().splitlines()[-1])
        pitch = int(info.get("pitch", 0))
        med = float(info.get("median_f0", 0.0) or 0.0)
        klass = str(info.get("class") or "?")
        log("pitch %+d (%s, %.1fHz -> %.1fHz)" % (
            pitch, klass, med, info.get("out_median_f0", 0)))
    except Exception as exc:
        log("pitch detect failed, keep 0: %s" % exc)
    if os.environ.get("RVC_PITCH"):
        pitch = int(os.environ["RVC_PITCH"])
        log("pitch overridden by RVC_PITCH -> %+d" % pitch)
    if klass == "no-voice" and pitch == 0:
        # 纯音乐/纯伴奏：RVC 只会往噪声上乱合成，直接拦下来
        raise RuntimeError("没检测到人声（voiced<10%%），这看起来是纯音乐，不是唱歌素材")

    # 伴奏同步移调：人声升 n 个半音，伴奏也升 n，整首歌换调、调内关系不变
    if pitch:
        shifted = os.path.join(work, "instrument_shift.wav")
        if os.path.exists(shifted):
            os.remove(shifted)
        subprocess.run([GSV_PY, KEYFIT, str(pitch), ins, shifted], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ins = shifted
        log("instrument transposed %+d semitones" % pitch)

    stage("plan")
    silences, _ = detect_silences(vocal)
    # 段落边界只算一次：切点要用，RVC 参数分组也要用（原来只在 convert 里算，切点完全没用上）
    secs = detect_sections(work, vocal)
    segments = plan_boundaries(voc_dur or total, silences, args.chunk, args.max_seg, secs=secs)
    log("SEGMENTS=%d" % len(segments))

    plan = convert(work, vocal, segments, pitch, secs)
    converted = concat_converted(work, plan)
    conv_dur = ffprobe_duration(converted)
    offset = segments[0][0]
    seg_end = segments[-1][1]
    if abs(conv_dur - (seg_end - offset)) > 3.0:
        log("警告：转换后长度 %.1fs 和分段跨度 %.1fs 不一致" % (conv_dur, seg_end - offset))

    stage("style")
    style = detect_style(args.title, args.song)
    log("style=%s" % (style or "none"))
    mix_full, adlib_count = build_full_mix(work, ins, converted, style, offset, seg_end)

    peak = peak_volume(mix_full)
    mean = mean_volume(mix_full)
    mix_dur = ffprobe_duration(mix_full)
    if mix_dur + 1.0 < seg_end - offset:
        raise RuntimeError("混音长度 %.1fs 不够 %d 段（需要 %.1fs）" % (
            mix_dur, len(segments), seg_end - offset))

    stage("slice", "%d" % len(segments))
    results = slice_segments(work, mix_full, segments, out_dir, offset)

    # 留一份整首 m4a 方便回听，然后清掉大中间文件
    mix_m4a = os.path.join(work, "mix_full.m4a")
    try:
        run([FFMPEG, "-y", "-i", mix_full, "-c:a", "aac", "-b:a", "192k", mix_m4a], timeout=600)
    except Exception as exc:
        log("整首 m4a 转码失败：%s" % exc)
        mix_m4a = ""

    for d in ("chunks", "conv", "vocals", "instrument"):
        shutil.rmtree(os.path.join(work, d), ignore_errors=True)
    for f in (wav, converted, mix_full, os.path.join(work, "conv_list.txt"),
              os.path.join(work, "instrument_trim.wav"),
              os.path.join(work, "instrument_shift.wav")):
        try:
            os.remove(f)
        except OSError:
            pass

    append_lesson(work, src, args.title or args.song, pitch, med, klass, style,
                  adlib_count, len(results), peak, mean, mix_dur,
                  os.path.basename(mix_m4a) if mix_m4a else "?")

    result = {
        "ok": True,
        "segments": results,
        "count": len(results),
        "total": round(sum(r["duration"] for r in results), 1),
        "elapsed": round(time.time() - t_all, 1),
        "pitch": pitch,
        "style": style or "",
        "adlibs": adlib_count,
        "movie": mix_m4a,
    }
    with open(os.path.join(work, "manifest.json"), "w", encoding="utf8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
    print("RESULT=" + json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        print("ERROR=" + str(exc).replace("\n", " ")[:300], flush=True)
        sys.exit(2)
    finally:
        if LOG_FH:
            LOG_FH.close()
