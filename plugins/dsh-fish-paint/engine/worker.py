#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""鱼鱼画画（dsh-fish-paint）· 常驻 diffusers worker

协议钉死，见 CONTRACT.md §3：
  stdin  ：每行一个 JSON 请求（generate / status / ping / load / shutdown）
  stdout ：每行一个 JSON 应答（**只允许 JSON**，一行一个，立即 flush）
  stderr ：随便写的日志（Node 侧转存 data/state/worker.log）

启动：
  <data>/.venv/Scripts/python.exe engine/worker.py --model <模型绝对路径> --data-dir <data 绝对路径>
  env：HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 FISH_PAINT_VRAM=auto|full|offload

本文件属于引擎侧（engine/**），不写 sidecar、不写 jsonl、不判断 rating —— 那些是插件侧 store.js 的活。
"""

import argparse
import gc
import inspect
import json
import os
import platform
import random
import signal
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

# ---- 这些环境变量必须在 import transformers / diffusers 之前设好（离线启动）----
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

# 进度节流下限（CONTRACT §3：≥500ms 一条）
PROGRESS_INTERVAL_SEC = 0.5


def _log(msg: str) -> None:
    sys.stderr.write("[worker %s] %s\n" % (time.strftime("%H:%M:%S"), msg))
    sys.stderr.flush()


def _emit(obj) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


# ---- 依赖导入（失败也要给 Node 一个明确的 JSON 信号，不能悄悄死）----
try:
    import torch
    from PIL import Image
    import diffusers
    import transformers
    from diffusers import DPMSolverMultistepScheduler, StableDiffusionXLPipeline
except Exception as _exc:  # noqa: BLE001
    _log("导入引擎依赖失败：\n" + traceback.format_exc())
    _emit(
        {
            "type": "error",
            "code": "INTERNAL",
            "message": "引擎 Python 依赖导入失败：%s" % _exc,
            "hint": "先运行 draw_setup install（node engine/setup.mjs --install）把引擎装好",
        }
    )
    sys.exit(2)


class WorkerError(Exception):
    """带错误码的业务异常：会被转成一行 error JSON。"""

    def __init__(self, code: str, message: str, hint: str = ""):
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint


def _is_oom(exc) -> bool:
    """是否属于「显存不够」：真实 CUDA OOM、或我们自己的 OOM 预检。"""
    if isinstance(exc, torch.cuda.OutOfMemoryError):
        return True
    if isinstance(exc, WorkerError) and exc.code == "OOM":
        return True
    text = str(exc).lower()
    return "out of memory" in text or "cuda error: out of memory" in text


def _free_mib():
    free, total = torch.cuda.mem_get_info()
    return free / (1024.0 * 1024.0), total / (1024.0 * 1024.0)


def _unique_png_path(out_dir: Path, seed: int) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = out_dir / ("%s-%d.png" % (stamp, seed))
    n = 1
    while path.exists():
        path = out_dir / ("%s-%d-%d.png" % (stamp, seed, n))
        n += 1
    return path


class Worker:
    def __init__(self, model_path: str, data_dir: str, vram: str = None):
        self.model_path = str(model_path)
        self.data_dir = Path(data_dir)
        requested = (vram or os.environ.get("FISH_PAINT_VRAM") or "auto").strip().lower()
        self.requested_vram = requested if requested in ("auto", "full", "offload") else "auto"
        self.model_name = Path(self.model_path).stem
        self.pipe = None
        self.vram_mode = None  # 实际生效的模式：full / offload
        self.load_sec = 0.0
        self.loading = False
        self.has_clip_skip_arg = False
        self._clip_skip_current = None
        self._orig_forwards = {}
        self._last_progress_at = 0.0

    # ------------------------------------------------------------ 输出

    def emit_ready(self) -> None:
        cuda = torch.cuda.is_available()
        device_name = ""
        if cuda:
            try:
                device_name = torch.cuda.get_device_name(0)
            except Exception:  # noqa: BLE001
                device_name = "unknown"
        _emit(
            {
                "type": "ready",
                "pid": os.getpid(),
                "python": platform.python_version(),
                "torch": torch.__version__,
                "diffusers": diffusers.__version__,
                "cuda": cuda,
                "deviceName": device_name,
                "modelPath": self.model_path,
            }
        )

    def progress(self, rid, stage: str, step: int, total: int, variant: int = 0, force: bool = False) -> None:
        now = time.time()
        if not force and now - self._last_progress_at < PROGRESS_INTERVAL_SEC:
            return
        self._last_progress_at = now
        _emit(
            {
                "id": rid,
                "type": "progress",
                "stage": stage,
                "step": int(step),
                "total": int(total),
                "variant": int(variant),
            }
        )

    # ------------------------------------------------------------ 模型加载

    def _config_dir(self):
        """from_single_file 离线启动用的 SDXL config/tokenizer 目录（setup.mjs 预取）。"""
        d = self.data_dir / "models" / "sdxl-base"
        return str(d) if (d / "model_index.json").is_file() else None

    def _clear_vram(self) -> None:
        gc.collect()
        if torch.cuda.is_available():
            try:
                torch.cuda.empty_cache()
            except Exception:  # noqa: BLE001
                pass

    def unload(self) -> None:
        self.pipe = None
        self.vram_mode = None
        self._clip_skip_current = None
        self._orig_forwards = {}
        self._clear_vram()

    def _full_need_mib(self) -> float:
        """整卡（full）模式需要的最小空闲显存估算。

        = 模型常驻显存（fp16 权重，≈ safetensors 文件大小）+ 推理工作区余量。
        8G 卡上 SDXL 整卡常驻约 6.5G，再叠加 1024² 的 UNet/VAE 峰值，实机根本塞不下；
        而 Windows 驱动在显存不够时默认会退到「系统内存回退」，不会抛 CUDA OOM，
        表现为 util 100%、显存打满、一张图几分钟都出不来（实测 600s 超时）。
        所以这里先做 OOM 预检：显存明显不够就直接按 OOM 处理，交给 ensure_loaded 回退 offload，
        不把机器拖进静默 thrash。可用 FISH_PAINT_FULL_MIN_FREE_MIB 覆盖估算值（调试用）。
        """
        override = os.environ.get("FISH_PAINT_FULL_MIN_FREE_MIB", "").strip()
        if override:
            try:
                return float(override)
            except ValueError:
                _log("FISH_PAINT_FULL_MIN_FREE_MIB=%r 不是数字，忽略" % override)
        try:
            model_mib = os.path.getsize(self.model_path) / 1024.0 / 1024.0
        except OSError:
            model_mib = 6616.0  # Illustrious-XL-v2.0 的实测大小，文件读不到时的兜底
        # 单次 1024² 推理（UNet 中间激活 + VAE 解码）实测会额外占 ~1.3-1.6G
        return model_mib + 1600.0

    def _choose_mode(self) -> str:
        if self.requested_vram in ("full", "offload"):
            return self.requested_vram
        free_mib, total_mib = _free_mib()
        _log("auto 显存判断：空闲 %.0fMiB / 共 %.0fMiB" % (free_mib, total_mib))
        return "offload" if free_mib < 7400 else "full"

    def _install_clip_skip(self, skip: int) -> None:
        """diffusers 不支持原生 clip_skip 时：把 text encoder 的 hidden_states 往前截掉若干层。

        A1111 口径（clipSkip=S）：取 hidden_states[-S]；diffusers 默认取 hidden_states[-2]。
        把 H 末尾截掉 d 层得 H'，则 H'[-2] = H[-(d+2)]，令 d+2 = S 即 d = S-2。
        所以 S=2（本机默认）不需要打补丁；S>=3 截 S-2 层。S=1（取最后一层）无法靠截断实现，
        该 diffusers 版本又不支持原生参数时只能记日志忽略。
        """
        skip = max(1, int(skip))
        if self._clip_skip_current == skip:
            return
        # 先把之前包装过的 forward 恢复成原始实现，避免反复叠加
        for attr, orig in self._orig_forwards.items():
            enc = getattr(self.pipe, attr, None)
            if enc is not None:
                enc.forward = orig
        self._orig_forwards = {}
        self._clip_skip_current = skip
        drop = skip - 2
        if drop <= 0:
            return
        try:
            from transformers.modeling_outputs import BaseModelOutputWithPooling
        except Exception as exc:  # noqa: BLE001
            _log("clip skip：拿不到 BaseModelOutputWithPooling，忽略（%s）" % exc)
            return
        for attr in ("text_encoder", "text_encoder_2"):
            enc = getattr(self.pipe, attr, None)
            if enc is None:
                continue
            orig = enc.forward
            self._orig_forwards[attr] = orig

            def make_forward(inner, drop_layers):
                def forward(*args, **kwargs):
                    kwargs = dict(kwargs)
                    kwargs["output_hidden_states"] = True
                    out = inner(*args, **kwargs)
                    hs = getattr(out, "hidden_states", None)
                    if hs is None or len(hs) <= drop_layers:
                        return out
                    hs2 = hs[:-drop_layers]
                    return BaseModelOutputWithPooling(
                        last_hidden_state=hs2[-1],
                        pooler_output=getattr(out, "pooler_output", None),
                        hidden_states=hs2,
                    )

                return forward

            enc.forward = make_forward(orig, drop)
        _log("clip skip %d：已包装 text_encoder/text_encoder_2（hidden_states 截掉 %d 层）" % (skip, drop))

    def load(self, mode: str = None, rid=None) -> None:
        if self.pipe is not None:
            return
        if not os.path.isfile(self.model_path):
            raise WorkerError(
                "MODEL_MISSING",
                "模型文件不存在：%s" % self.model_path,
                "先运行 draw_setup install（node engine/setup.mjs --install），或检查配置里的 modelPath",
            )
        if not torch.cuda.is_available():
            raise WorkerError(
                "CUDA_ERROR",
                "torch 看不到 CUDA 设备（torch.cuda.is_available()=False）",
                "检查 NVIDIA 驱动、以及 setup 是否装的是 cu124 版 torch（draw_setup status）",
            )

        chosen = mode or self._choose_mode()
        if chosen == "full":
            free_mib, total_mib = _free_mib()
            need_mib = self._full_need_mib()
            if free_mib < need_mib:
                raise WorkerError(
                    "OOM",
                    "整卡加载需要约 %.0fMiB 空闲显存，当前只有 %.0fMiB（共 %.0fMiB）"
                    % (need_mib, free_mib, total_mib),
                    "空闲显存不足，已自动回退 offload 加载（8G 卡跑 SDXL 建议直接用 offload）",
                )
            _log("full 预检通过：需要 %.0fMiB，空闲 %.0fMiB / 共 %.0fMiB" % (need_mib, free_mib, total_mib))
        self.loading = True
        t0 = time.time()
        _log("开始加载模型：%s（vram=%s）" % (self.model_path, chosen))
        self.progress(rid, "load", 1, 3, force=True)
        try:
            kwargs = dict(torch_dtype=torch.float16)
            cfg = self._config_dir()
            if cfg:
                kwargs["config"] = cfg
            _log("from_single_file(config=%s, dtype=fp16)" % cfg)
            try:
                pipe = StableDiffusionXLPipeline.from_single_file(self.model_path, **kwargs)
            except TypeError as exc:
                # 极少数 diffusers 版本不认识 config 关键字：退回不传 config 再试一次
                if "config" not in kwargs or "config" not in str(exc):
                    raise
                _log("当前 diffusers 不支持 config 参数，改用默认加载：%s" % exc)
                kwargs.pop("config", None)
                pipe = StableDiffusionXLPipeline.from_single_file(self.model_path, **kwargs)
            self.progress(rid, "load", 2, 3, force=True)

            try:
                pipe.set_progress_bar_config(disable=True)
            except Exception:  # noqa: BLE001
                pass
            try:
                pipe.enable_vae_slicing()
            except Exception as exc:  # noqa: BLE001
                _log("enable_vae_slicing 失败（忽略）：%s" % exc)

            # sampler 固定 DPM++ 2M Karras
            pipe.scheduler = DPMSolverMultistepScheduler.from_config(
                pipe.scheduler.config,
                algorithm_type="dpmsolver++",
                use_karras_sigmas=True,
            )
            # fp16 + TF32
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True
            try:
                torch.backends.cuda.matmul.fp32_precision = "tf32"
            except Exception:  # noqa: BLE001
                pass

            self.has_clip_skip_arg = "clip_skip" in inspect.signature(pipe.__call__).parameters
            _log("pipeline 原生 clip_skip 参数：%s" % self.has_clip_skip_arg)
            self.pipe = pipe  # 放到这里再赋值：下面 to/offload 失败时能重新加载
            # 新实例要重新打 clip skip 补丁（旧实例的包装引用已失效）
            self._clip_skip_current = None
            self._orig_forwards = {}
            self.progress(rid, "load", 3, 3, force=True)

            if chosen == "offload":
                pipe.enable_model_cpu_offload()
            else:
                pipe.to("cuda")

            self.load_sec = time.time() - t0
            self.vram_mode = chosen
            _log("模型加载完成：%.1fs，模式 %s" % (self.load_sec, chosen))
        except Exception:
            self.loading = False
            self.pipe = None
            self._clear_vram()
            raise
        finally:
            self.loading = False

    def ensure_loaded(self) -> bool:
        """确保模型已加载，返回本次是否执行了加载。"""
        if self.pipe is not None:
            return False
        try:
            self.load()
        except Exception as exc:  # noqa: BLE001
            if not _is_oom(exc):
                raise
            _log("整卡加载 OOM，清缓存后回退 offload 重试：%s" % exc)
            self.unload()
            self.load(mode="offload")
        return True

    # ------------------------------------------------------------ 参数校验

    def validate_generate(self, req) -> dict:
        prompt = req.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise WorkerError(
                "BAD_REQUEST",
                "prompt 不能为空",
                "prompt 用英文 danbooru 标签，例如 '1girl, solo, masterpiece'",
            )
        negative = req.get("negative", "")
        if negative is None:
            negative = ""
        if not isinstance(negative, str):
            raise WorkerError("BAD_REQUEST", "negative 必须是字符串")

        def as_int(name, default, lo, hi):
            value = req.get(name, default)
            try:
                iv = int(value)
            except (TypeError, ValueError):
                raise WorkerError("BAD_REQUEST", "%s 必须是整数：%r" % (name, value))
            if iv < lo or iv > hi:
                raise WorkerError("BAD_REQUEST", "%s 超出范围 %d-%d：%d" % (name, lo, hi, iv))
            return iv

        width = as_int("width", 1024, 256, 2048)
        height = as_int("height", 1024, 256, 2048)
        if width % 8 or height % 8:
            raise WorkerError("BAD_REQUEST", "width/height 必须是 8 的倍数：%dx%d" % (width, height))
        steps = as_int("steps", 28, 1, 150)
        count = as_int("count", 1, 1, 4)
        seed = as_int("seed", -1, -1, 2**32 - 1)
        clip_skip = as_int("clipSkip", 2, 1, 8)

        try:
            cfg = float(req.get("cfg", 5.5))
        except (TypeError, ValueError):
            raise WorkerError("BAD_REQUEST", "cfg 必须是数字：%r" % req.get("cfg"))
        if not (0.0 <= cfg <= 30.0):
            raise WorkerError("BAD_REQUEST", "cfg 超出范围 0-30：%s" % cfg)

        out_dir = req.get("outDir")
        if not isinstance(out_dir, str) or not out_dir.strip():
            raise WorkerError("BAD_REQUEST", "outDir 必须是输出目录的绝对路径字符串")

        resize = req.get("resize")
        if resize is not None:
            if not isinstance(resize, dict):
                raise WorkerError("BAD_REQUEST", "resize 必须是 {width,height} 对象")
            rw = as_int_pair(resize)
            resize = rw

        return {
            "id": req.get("id"),
            "prompt": prompt,
            "negative": negative,
            "width": width,
            "height": height,
            "steps": steps,
            "cfg": cfg,
            "seed": seed,
            "count": count,
            "clip_skip": clip_skip,
            "out_dir": out_dir,
            "resize": resize,
        }

    # ------------------------------------------------------------ 生图

    def _make_step_callback(self, rid, total_steps: int, variant: int):
        def callback_on_step_end(pipe, step, timestep, callback_kwargs):  # noqa: ARG001
            self.progress(rid, "generate", int(step) + 1, int(total_steps), variant)
            return callback_kwargs

        return callback_on_step_end

    def run_generate(self, p: dict):
        out_dir = Path(p["out_dir"])
        out_dir.mkdir(parents=True, exist_ok=True)
        total_steps = p["steps"]
        if torch.cuda.is_available():
            try:
                torch.cuda.reset_peak_memory_stats()
            except Exception:  # noqa: BLE001
                pass

        images = []
        t0 = time.time()
        for i in range(p["count"]):
            seed = random.randint(0, 2**32 - 1) if p["seed"] < 0 else (p["seed"] + i) % (2**32)
            generator = torch.Generator(device="cpu").manual_seed(int(seed))
            kwargs = dict(
                prompt=p["prompt"],
                negative_prompt=p["negative"],
                width=p["width"],
                height=p["height"],
                num_inference_steps=total_steps,
                guidance_scale=p["cfg"],
                generator=generator,
                callback_on_step_end=self._make_step_callback(p["id"], total_steps, i),
            )
            if self.has_clip_skip_arg:
                # diffusers 的 clip_skip 语义：默认取倒数第二层（等价 A1111 clip skip 2），
                # 参数值 = 在默认基础上再多往前跳几层。这里把 A1111 口径换算成 diffusers 口径：
                # A1111 clipSkip=S → 取 hidden_states[-S]；diffusers 取 [-(clip_skip+2)]，
                # 所以 diffusers_clip_skip = S - 2（S=2 → 0，即默认行为）。
                kwargs["clip_skip"] = p["clip_skip"] - 2

            started = time.time()
            result = self.pipe(**kwargs)
            image = result.images[0]
            if p["resize"]:
                image = image.resize(
                    (p["resize"]["width"], p["resize"]["height"]),
                    Image.Resampling.LANCZOS,
                )
            path = _unique_png_path(out_dir, seed)
            image.save(path, format="PNG")
            images.append(
                {"path": str(path), "seed": int(seed), "width": int(image.width), "height": int(image.height)}
            )
            _log(
                "第 %d/%d 张完成：%s（%dx%d，seed=%d，%.1fs）"
                % (i + 1, p["count"], path.name, image.width, image.height, seed, time.time() - started)
            )

        elapsed = time.time() - t0
        if torch.cuda.is_available():
            try:
                alloc = torch.cuda.max_memory_allocated() / (1024.0 * 1024.0)
                reserved = torch.cuda.max_memory_reserved() / (1024.0 * 1024.0)
                _log("显存峰值（本轮）：allocated=%.0fMiB reserved=%.0fMiB" % (alloc, reserved))
            except Exception:  # noqa: BLE001
                pass
        return images, elapsed

    def generate(self, req) -> None:
        rid = req.get("id")
        p = self.validate_generate(req)
        p["id"] = rid

        did_load = self.ensure_loaded()
        if not self.has_clip_skip_arg:
            self._install_clip_skip(p["clip_skip"])

        try:
            try:
                images, elapsed = self.run_generate(p)
            except Exception as exc:  # noqa: BLE001
                if not _is_oom(exc):
                    raise
                if self.vram_mode == "offload":
                    raise WorkerError(
                        "OOM",
                        "显存不足（offload 模式下仍然 OOM）：%s" % exc,
                        "建议换小尺寸（512x512 / sticker 预设）或减少 count，再不行就跑 draw_setup status 看看显存占用",
                    )
                _log("生图 OOM，清缓存切 offload 重建后重试一次：%s" % exc)
                self.unload()
                self.load(mode="offload")
                did_load = True
                self._install_clip_skip(p["clip_skip"])
                images, elapsed = self.run_generate(p)
        except WorkerError:
            raise
        except Exception as exc:  # noqa: BLE001
            if _is_oom(exc):
                raise WorkerError(
                    "OOM",
                    "显存不足：%s" % exc,
                    "建议换小尺寸（512x512 / sticker 预设），或在插件配置里把 vramMode 设为 offload",
                )
            raise

        load_sec = self.load_sec if did_load else 0.0
        _emit(
            {
                "id": rid,
                "type": "done",
                "images": images,
                "elapsedSec": round(elapsed, 1),
                "loadSec": round(load_sec, 1),
                "vramMode": self.vram_mode,
                "model": self.model_name,
            }
        )

    # ------------------------------------------------------------ 其它 op

    def status(self, rid) -> None:
        cuda = torch.cuda.is_available()
        gpu = {}
        if cuda:
            try:
                free_mib, total_mib = _free_mib()
                gpu = {"totalMiB": round(total_mib), "freeMiB": round(free_mib)}
            except Exception:  # noqa: BLE001
                gpu = {}
        _emit(
            {
                "id": rid,
                "type": "status",
                "loaded": self.pipe is not None,
                "loading": self.loading,
                "vramMode": self.vram_mode or self.requested_vram,
                "device": "cuda" if cuda else "cpu",
                "gpu": gpu,
                "loadSec": round(self.load_sec, 1),
                "model": self.model_name,
            }
        )

    def handle_load(self, rid) -> None:
        did_load = self.pipe is None
        if did_load:
            self.ensure_loaded()
        _emit(
            {
                "id": rid,
                "type": "loaded",
                "loadSec": round(self.load_sec if did_load else 0.0, 1),
                "vramMode": self.vram_mode,
            }
        )


def as_int_pair(resize: dict):
    try:
        rw = int(resize.get("width"))
        rh = int(resize.get("height"))
    except (TypeError, ValueError):
        raise WorkerError("BAD_REQUEST", "resize.width/height 必须是整数")
    if rw % 8 or rh % 8:
        raise WorkerError("BAD_REQUEST", "resize.width/height 必须是 8 的倍数：%dx%d" % (rw, rh))
    if rw < 64 or rh < 64 or rw > 2048 or rh > 2048:
        raise WorkerError("BAD_REQUEST", "resize.width/height 超出范围 64-2048：%dx%d" % (rw, rh))
    return {"width": rw, "height": rh}


def _map_exception(exc) -> WorkerError:
    if isinstance(exc, WorkerError):
        return exc
    if _is_oom(exc):
        return WorkerError("OOM", "显存不足：%s" % exc, "建议换小尺寸，或在插件配置里把 vramMode 设为 offload")
    text = str(exc)
    if "CUDA" in text or "cuda" in text:
        return WorkerError("CUDA_ERROR", "CUDA 调用失败：%s" % text, "跑 draw_setup status 看 GPU 状态；必要时重启 DSH/驱动")
    return WorkerError("INTERNAL", "生图失败：%s" % text, "看 data/state/worker.log 里的完整异常")


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="dsh-fish-paint worker（JSONL 协议，见 CONTRACT.md §3）")
    ap.add_argument("--model", required=True, help="模型单文件绝对路径（.safetensors）")
    ap.add_argument("--data-dir", required=True, help="数据目录（models/、out/、state/ 的父目录）")
    ap.add_argument(
        "--vram",
        default=None,
        choices=("auto", "full", "offload"),
        help="显存模式；默认读环境变量 FISH_PAINT_VRAM，再默认 auto",
    )
    return ap.parse_args(argv)


def _on_signal(signum, frame):  # noqa: ARG001
    _log("收到信号 %s，退出" % signum)
    raise SystemExit(0)


def main(argv=None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    args = parse_args(argv)
    try:
        signal.signal(signal.SIGINT, _on_signal)
        signal.signal(signal.SIGTERM, _on_signal)
    except Exception:  # noqa: BLE001
        pass

    worker = Worker(args.model, args.data_dir, args.vram)
    _log("启动：python=%s torch=%s diffusers=%s" % (platform.python_version(), torch.__version__, diffusers.__version__))
    worker.emit_ready()

    try:
        while True:
            line = sys.stdin.readline()
            if not line:
                _log("stdin EOF，退出")
                break
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except Exception as exc:  # noqa: BLE001
                _emit(
                    {
                        "type": "error",
                        "code": "BAD_REQUEST",
                        "message": "请求不是合法 JSON：%s" % exc,
                        "hint": "每行必须是一个 JSON 对象",
                    }
                )
                continue
            if not isinstance(req, dict):
                _emit(
                    {
                        "type": "error",
                        "code": "BAD_REQUEST",
                        "message": "请求必须是 JSON 对象",
                        "hint": "每行必须是一个 JSON 对象",
                    }
                )
                continue

            rid = req.get("id")
            op = req.get("op")
            try:
                if op == "generate":
                    worker.generate(req)
                elif op == "status":
                    worker.status(rid)
                elif op == "ping":
                    _emit({"id": rid, "type": "pong"})
                elif op == "load":
                    worker.handle_load(rid)
                elif op == "shutdown":
                    _emit({"id": rid, "type": "bye"})
                    _log("收到 shutdown，退出")
                    break
                else:
                    raise WorkerError(
                        "BAD_REQUEST",
                        "未知 op：%r" % (op,),
                        "支持 generate / status / ping / load / shutdown",
                    )
            except WorkerError as exc:
                _emit({"id": rid, "type": "error", "code": exc.code, "message": exc.message, "hint": exc.hint})
            except SystemExit:
                break
            except Exception as exc:  # noqa: BLE001
                _log("处理请求异常：\n" + traceback.format_exc())
                mapped = _map_exception(exc)
                _emit({"id": rid, "type": "error", "code": mapped.code, "message": mapped.message, "hint": mapped.hint})
    finally:
        try:
            worker.unload()
        except Exception:  # noqa: BLE001
            pass
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001
        _log("worker 顶层异常：\n" + traceback.format_exc())
        _emit(
            {
                "type": "error",
                "code": "INTERNAL",
                "message": "worker 顶层异常，进程退出",
                "hint": "看 data/state/worker.log",
            }
        )
        sys.exit(1)
