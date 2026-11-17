# 鱼鱼画画 · 引擎实测 NOTES

实测日期：2026-11-17（本机 RTX 3070 8GB / Windows / 驱动 616.92）
实测人：engine-smith。所有数字都是真跑出来的，没跑过的项在第 5 节明确标「未测」。

## 1. 装好的东西（位置 + 版本 + 体积）

| 项 | 值 |
| --- | --- |
| venv python | `D:\新建文件夹\DSK\dsh-fish-paint\data\.venv\Scripts\python.exe`（Python **3.12.2**，基础解释器 `C:\Program Files\Python312\python.exe`） |
| venv 体积 | **5013544521 B**（≈4781 MiB） |
| torch | **2.6.0+cu124**（SJTU 预编译 wheel，`torch.cuda.is_available()=True`，CUDA 12.4） |
| diffusers | **0.35.0** |
| transformers | **4.49.0** |
| accelerate | 1.2.1 |
| safetensors | 0.5.2 |
| pillow | 11.1.0 |
| 模型文件 | `data\models\Illustrious-XL-v2.0.safetensors` = **6938040674 B**（6616.6 MiB），safetensors 头校验通过 |
| SDXL config/tokenizer | `data\models\sdxl-base\` 共 **14** 个小文件（model_index.json、scheduler/text_encoder/text_encoder_2/unet/vae 的 config、tokenizer+tokenizer_2 的 vocab/merges/special_tokens_map/tokenizer_config）；清单见 `engine/setup.mjs` 的 `SDXL_SMALL_FILES` |
| setup.json | `data\state\setup.json`，收尾状态 ok=true / running=false / phase=done / percent=100 |
| 日志 | `data\state\setup.log`（安装+冒烟）、`data\state\worker.log`（插件侧转存 worker stderr） |

安装耗时与幂等：
- 首次 `node engine/setup.mjs --install`：约 10 分钟（torch wheel 2415MB 从 SJTU 约 40s；模型 6.9GB 从 ModelScope 实测 ~14MB/s；其余 pip 走 aliyun 镜像）。
- 重跑 `node engine/setup.mjs --install --json`：**8.7s，exit 0**，全部命中已装状态（幂等）。
- `node engine/setup.mjs --verify --json`：**~24s（含 512² 20 步冒烟 13.6-14.8s），exit 0**。

## 2. 实测数字（offload / auto 自动判定）

本机桌面常态占 1.3-1.9GB 显存，`torch.cuda.mem_get_info()` 空闲约 7000-7114MiB < 7400MiB，所以 **auto 每次都判 offload**（`enable_model_cpu_offload()`）。判定规则：启动/首次生成时 `free < 7400MiB → offload`，否则 full；显式 `FISH_PAINT_VRAM=full|offload` 可覆盖，但 full 仍会走 §3 的显存预检。每轮 bench 的协议自检都真跑过并全为 true：ping=pong、未知 op→BAD_REQUEST、缺 prompt→BAD_REQUEST、非 JSON 行→BAD_REQUEST、出错后 worker 仍存活。

下表是 `node engine/bench.mjs --mode offload --cases 512,1024,832x1216 --sticker --steps 28 --seed 424242` 一轮真实结果（总墙钟 162.4s，4/4 成功，协议自检全 true）：

| case | 生成尺寸 | 生图 elapsedSec | 墙钟 | loadSec | vramMode | 显存峰值 alloc/reserved | PNG 字节 | PNG 实际尺寸 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 512x512 | 512×512 | **19.2s**（28 步） | 20.5s | **1.3s**（首次加载） | offload | 5113 / 5428 MiB | 348040 | 512×512 |
| 1024x1024 | 1024×1024 | **58.0s**（28 步） | 58.0s | 0（已加载） | offload | 5345 / **7974** MiB | 1300864 | 1024×1024 |
| 832x1216（portrait） | 832×1216 | **40.1s**（28 步） | 40.1s | 0 | offload | 5324 / 7698 MiB | 1237633 | 832×1216 |
| sticker（1024→resize 512） | 512×512 | **38.4s**（28 步） | 38.4s | 0 | offload | 5345 / 7974 MiB | 364262 | 512×512 |

补充实测：
- `count=2, seed=-1, clipSkip=3`，512²×6 步：**19.3s 出 2 张**，两张 PNG 各 338424 / 337344 B、512×512，随机 seed = 3119092584 / 408493808 → count>1 的 seed+i 与随机种子、clip skip 参数映射都正常。
- `node engine/setup.mjs --verify`（512² / 20 步 / cfg5.5 / seed42）：13.6-14.8s，loadSec 1.3s，PNG 240042 B（同 seed 多次运行字节数一致，PNG 可复现）。
- 显存峰值来自 worker stderr 行：`显存峰值（本轮）：allocated=..MiB reserved=..MiB`；offload 模式 reserved 会顶到 7.9G 左右是正常现象（allocated 才是实际张量占用），空闲显存仍剩 7GB。

留档 PNG（可以直接打开对照）：
- 512²：`data\out\bench-offload-1794919079008\20261117-203824-424242.png`
- 1024²：`data\out\bench-offload-1794919079008\20261117-203922-424242.png`（已人工看过：画质正常）
- 832×1216：`data\out\bench-offload-1794919079008\20261117-204002-424242.png`
- sticker 512：`data\out\bench-offload-1794919079008\20261117-204041-424242.png`（chibi + 白描边，已人工看过）
- count=2：`data\out\bench-offload-1794919429199\20261117-204407-3119092584.png`、`...-408493808.png`
- verify 冒烟：`data\out\verify\20261117-204327-42.png`
- 机器可读结果：`data\state\bench-offload.json`、`bench-count2.json`、`bench-full.json`、`bench-smoke.json`（同名 `.log` 是 worker stderr 原文）

## 3. full（整卡）模式：8G 卡不可用 + 预检回退

- **旧行为实测（失败）**：`bench --mode full --cases 512 --steps 28` 整卡加载后卡死 —— GPU 7948/8192 MiB、free 71 MiB、util 100%，**600s 请求超时也不出图、不抛 CUDA OOM**（Windows 驱动的 sysmem fallback 把显存溢出兜到系统内存，表现是静默 thrash）。手动 kill worker 后恢复。
- 结论：8GB 卡 + 桌面占 1.3-1.9GB 时 SDXL 整卡（≈6.6GB 权重 + 1.3-1.6GB 推理峰值）**不可用**，正确路径是 offload（auto 已经这么做）。
- **机制修复**：worker 在 full 模式加载前做 OOM 预检 `_full_need_mib()` = 模型文件字节(MiB) + 1600MiB 推理余量；空闲显存不够就直接抛 OOM，交给 `ensure_loaded()` 清缓存回退 offload 重试（符合 CONTRACT §3 的 OOM 回退语义，且不会把机器拖进 thrash）。
- **修复后实测**：`bench --mode full --cases 512 --steps 8` → 日志 `整卡加载 OOM，清缓存后回退 offload 重试：整卡加载需要约 8217MiB 空闲显存，当前只有 7114MiB（共 8192MiB）` → done 上报 `vramMode=offload`，13.4s 出图（PNG 335126 B / 512×512），bench exit 0。日志：`data\state\bench-full.log`。
- 调试用：`FISH_PAINT_FULL_MIN_FREE_MIB` 可覆盖预检阈值（例如人为调低去触发真实 CUDA OOM / 调高强制回退），默认不要动。

## 4. 协议 / 实现坑（插件侧必看）

1. **生图过程中 status/ping 会排队**：worker 是单线程 JSONL 循环，`generate` 执行期间不读 stdin；此时发 `status` 要等这张图跑完才回（1024² 28 步最长约 58s，count=4 更久）。插件侧对 status 的超时必须给足（建议 ≥300s），**不要**用「status 几秒没回」判断 worker 挂了/空闲退出。
2. **loadSec 很小是正常的**：`from_single_file` 用 safetensors mmap，权重按需 page-in，实测冷加载 1.3s；首次生图里含有权重缺页成本。不要按「加载快 = 没加载」怀疑。
3. `StableDiffusionXLPipeline.from_single_file` 的离线加载靠 `config=<本地目录>`（`data\models\sdxl-base`）；**`use_safetensors` 不是它的合法 kwarg**（传了 TypeError），已删除。
4. clip skip 语义：diffusers 0.35 的 SDXL `__call__` 原生支持 `clip_skip`，默认 `hidden_states[-2]`（等价 A1111 clip skip 2），worker 传 `clip_skip = clipSkip - 2`；老 diffusers 的回退实现（包装 text_encoder forward 截 hidden_states，drop=S-2）留作兜底。S=1 无法表达（仅老版本回退路径如此，当前 pin 0.35 走原生参数）。
5. worker **stdout 只允许 JSON 行**，日志全部走 stderr（UTF-8）；Node 侧转存 `data/state/worker.log` 即可。显存峰值那行也在 stderr，可解析用在 draw_status 里。
6. 收尾：worker 收到 EOF / SIGTERM / `shutdown` 都正常退出；`shutdown` 回 `bye` 后 exit 0。
7. **setup.mjs 收尾竞态（已修）**：`--verify` 结束时 worker 的最后一个 stderr chunk 可能在 `logStream.end()` 之后到达，旧实现会 `ERR_STREAM_WRITE_AFTER_END` 把 node 打崩（现象：冒烟明明 ok 但 exit 1）。修复：`writeLogStream()` 检查 `writableEnded/destroyed`、等 worker 真正 close 后再摘 stderr 监听、`logStream` 加 error 兜底。另修 `setup.json` 收尾：`--verify` 的进度会把状态写成 `running=true/phase=verify` 就再也不更新，修复后跑完统一落 `ok=true, running=false, phase=done`（失败才保留 error 状态）。
8. bench.mjs 对每 case 有独立超时（`--case-timeout`，默认 300s），超时/worker 退出会立刻 kill 并落盘 JSON+日志；不会再现「白跑 15 分钟什么都没有」。

## 5. 未测 / 已知限制

- **未测真实 CUDA OOM 异常路径**：本机 Windows 驱动把显存溢出兜成 sysmem fallback，不抛 OOM；实测到的是「预检 OOM → 回退 offload」这条等价回退路径。真实 `torch.cuda.OutOfMemoryError` 分支代码存在但没在真机触发过。
- **8G 卡 full 模式不可用**（见 §3）；auto 在本机恒 offload。换大卡（≥12-16G 且桌面占用小）时 full 才会真正走 `pipe.to("cuda")`，未测。
- **未测下载中断续传**：下载器实现了 `.part` + Range + 416 处理，但首次安装一次跑通，没有人为 kill 再重跑验证断点续传。
- **未测插件侧并发/多 worker**：worker 按单实例设计，没有并发请求测试；插件侧对 generate 请求要串行（队列）。
- **未测其他 GPU / 驱动 / Python 版本**；兜底 Python（3.12.14）没实际用到。
- **未测** `resize` 非法尺寸的报错路径（worker 有校验：必须是 8 的倍数、64-2048）与 BAD_REQUEST 的 hint 文案在插件 UI 里的展示，只有 bench 的坏请求协议测试覆盖。
- 显存峰值是 `torch.cuda.max_memory_allocated/reserved`，含 torch 缓存分配器预留，不代表驱动报告的进程显存（nvidia-smi 会更大）。

## 6. 验证命令备忘

```powershell
cd "D:\新建文件夹\DSK\dsh-fish-paint"

# 安装（幂等，断点续传；进度 data/state/setup.json，日志 data/state/setup.log）
node engine\setup.mjs --install
node engine\setup.mjs --verify            # 512x512 冒烟，成功 exit 0
node engine\setup.mjs --json              # 结束时 stdout 一行 JSON

# 引擎真实压测（自动起 worker、按 CONTRACT §3 JSONL 协议喂请求）
node engine\bench.mjs --mode offload --cases 512,1024,832x1216 --sticker --steps 28 --out-file data\state\bench-offload.json
node engine\bench.mjs --mode full --cases 512 --steps 8 --out-file data\state\bench-full.json   # 会预检 OOM 并回退 offload
node engine\bench.mjs --mode offload --cases 512 --steps 6 --count 2 --seed -1 --clip-skip 3 --out-file data\state\bench-count2.json
```
