#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""开头「话痨」检测：视频开头主持人/UP 主讲了一堆、音乐还没进来，唱的时候要跳过。

判据：伴奏轨在开头一段里基本是静的（音乐还没开始），之后出现连续 ≥1.5s 的持续伴奏，
且这段空白 ≥4s、空白里人声有响度 → 认为音乐前面是导语，裁到音乐进入处。
清唱开头（人声有音高）用浊音率做提示，但不作为硬门槛——实测真人说话浊音率
反而比带混响的演唱高，单靠浊音率分不开；宁可少裁（≥4s 才动手、最多 45s），
也不要把整段清唱开头当话痨切掉。

用法：
  <GSV_PY> intro_trim.py --vocal vocal.wav --instrument instrument.wav [--json out.json]
stdout 最后一行是 JSON：{"trim": 12.3, "music_start": 12.6, "voiced": 0.12, "reason": "..."}
"""
import argparse
import json
import sys

import numpy as np

SR = 16000
HOP = 0.1          # 能量帧 100ms
LEAD_LIMIT = 120.0  # 最多只看开头 120s
SUSTAIN = 1.5       # 伴奏连续响多久算「音乐开始了」
MIN_GAP = 4.0       # 音乐前这段空白至少多长才裁（太短可能是弱起/清唱前奏）
MAX_TRIM = 45.0     # 一次最多裁 45s，剩下的话痨宁可留着也不冒险切掉正片


def load_mono(path):
    import librosa
    import soundfile as sf

    y, sr = sf.read(path, dtype="float32", always_2d=False)
    if y.ndim > 1:
        y = y.mean(axis=1)
    if sr != SR:
        y = librosa.resample(y, orig_sr=sr, target_sr=SR)
    return np.ascontiguousarray(y, dtype=np.float32)


def rms_frames(y):
    n = int(SR * HOP)
    m = len(y) // n
    if m < 4:
        return np.zeros(0, dtype=np.float64)
    z = y[: m * n].reshape(m, n).astype(np.float64)
    return np.sqrt((z * z).mean(axis=1) + 1e-12)


def first_sustained(mask, run):
    if len(mask) < run:
        return None
    # 先看重采样后的帧数够不够，再横扫第一段连续 run 帧
    s = np.convolve(mask.astype(np.int32), np.ones(run, dtype=np.int32), mode="valid")
    idx = np.flatnonzero(s == run)
    return int(idx[0]) if len(idx) else None


def voiced_ratio(y):
    try:
        import pyworld as pw

        if len(y) < SR // 2:
            return 0.0
        f0, _ = pw.harvest(y.astype(np.float64), SR, f0_floor=60.0, f0_ceil=900.0, frame_period=10.0)
        return float((f0 > 0).mean()) if len(f0) else 0.0
    except Exception:
        return 0.0


def detect(vocal_path, ins_path):
    vocal = load_mono(vocal_path)[: int(LEAD_LIMIT * SR)]
    ins = load_mono(ins_path)[: int(LEAD_LIMIT * SR)]
    v_rms = rms_frames(vocal)
    i_rms = rms_frames(ins)
    if len(v_rms) < 6 or len(i_rms) < 6:
        return {"trim": 0.0, "music_start": 0.0, "voiced": 0.0, "reason": "太短，跳过"}

    # 伴奏自己的基准响度：取开头 120s 里偏上的分位，避免整段安静时阈值过低
    base = float(np.percentile(i_rms, 80))
    if base <= 1e-5:
        return {"trim": 0.0, "music_start": 0.0, "voiced": 0.0, "reason": "没有伴奏轨（可能是清唱），不裁"}
    active = i_rms > max(base * 0.08, 3e-4)
    run = max(3, int(round(SUSTAIN / HOP)))
    idx = first_sustained(active, run)
    if idx is None:
        return {"trim": 0.0, "music_start": 0.0, "voiced": 0.0, "reason": "没找到音乐进入点，不裁"}
    music_start = idx * HOP
    if music_start < MIN_GAP:
        return {"trim": 0.0, "music_start": music_start, "voiced": 0.0, "reason": "音乐很快就进来了，不裁"}

    lead = vocal[: int(music_start * SR)]
    lead_db = 20 * np.log10(float(np.sqrt((lead.astype(np.float64) ** 2).mean() + 1e-12)) + 1e-9)
    if lead_db < -45:
        return {"trim": 0.0, "music_start": music_start, "voiced": 0.0, "reason": "开头几乎是静音"}
    vr = voiced_ratio(lead)
    # 留 0.3s 余量，别把第一个音切掉；一次最多裁 MAX_TRIM，剩下的保留
    trim = min(MAX_TRIM, max(0.0, music_start - 0.3))
    return {
        "trim": round(trim, 2),
        "music_start": round(music_start, 2),
        "voiced": round(vr, 3),
        "reason": "音乐前有 %.1fs 空白（人声浊音率 %.2f），裁到音乐进入处" % (music_start, vr),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vocal", required=True)
    ap.add_argument("--instrument", required=True)
    ap.add_argument("--json", default="")
    args = ap.parse_args()
    try:
        result = detect(args.vocal, args.instrument)
    except Exception as exc:  # noqa: BLE001
        result = {"trim": 0.0, "music_start": 0.0, "voiced": 0.0, "reason": "检测失败：%s" % exc}
    line = json.dumps(result, ensure_ascii=False)
    if args.json:
        try:
            with open(args.json, "w", encoding="utf8") as fh:
                fh.write(line)
        except Exception:
            pass
    print(line, flush=True)


if __name__ == "__main__":
    sys.exit(main())
