# 施工契约 · dsh-fish-paint（鱼鱼画画）

这份文件是「引擎侧」与「插件侧」并行施工的唯一接口约定。任何一方都不许单方面改协议；要改先找 Lead。

- 计划：`D:\新建文件夹\DSK\dsh-fish-paint\PLAN.md`（用户已批准 2026-11-17）
- 插件根：`D:\新建文件夹\DSK\dsh-fish-paint`
- 数据根：`D:\新建文件夹\DSK\dsh-fish-paint\data`

## 0. 文件归属（并行施工，别越界）

| 谁 | 只写这些 |
| --- | --- |
| engine-smith（引擎） | `engine/**`、`data/**` |
| plugin-smith（插件） | `package.json`、`cordis.patch.yml`、`index.js`、`lib/engine.js`、`lib/presets.js`、`lib/store.js`、`locale/**`、`icon.svg`、`README.md`、`.gitignore`、`test/**` |
| lead（集成） | `CONTRACT.md`、`PLAN.md`、`lib/qq.js`，集成阶段再改其它文件 |

禁止：改 profile（`C:\Users\Administrator\.dsh\profiles\desktop`）、改 qq-bridge 源码/config、安装 bundle（Lead 统一做）、重启 DSH、引入 npm 依赖、动对方文件。

## 1. 目录结构

```
dsh-fish-paint\
├─ package.json / cordis.patch.yml / index.js / icon.svg / README.md / .gitignore
├─ lib\
│  ├─ engine.js     常驻 worker 管理（spawn/JSONL/队列/重启/空闲退出）
│  ├─ presets.js    预设、尺寸、质量词、默认负面词
│  ├─ store.js      输出目录、PNG 元数据、rating sidecar、index.jsonl
│  └─ qq.js         QQ 投递 + R18 硬闸（Lead 写）
├─ engine\
│  ├─ setup.mjs     一键安装（venv/torch/依赖/模型），写 data\state\setup.json
│  ├─ worker.py     常驻 diffusers worker（JSONL 协议见 §3）
│  └─ requirements.txt
├─ test\            plugin-smith 的单元测试（假 worker 等）
└─ data\            .venv / models / out / state（不进 npm files，.gitignore 排除）
```

## 2. 引擎安装（setup.mjs）

CLI：`node engine/setup.mjs [--install] [--verify] [--json]`，默认 `--install`。

- venv：`data/.venv`，Python 3.12（优先 `C:\Program Files\Python312\python.exe`，失败退回 `C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`）。
- torch：`pip install "https://mirror.sjtu.edu.cn/pytorch-wheels/cu124/torch-2.6.0%2Bcu124-cp312-cp312-win_amd64.whl"`（SJTU 实测 53MB/s）。
- 其余依赖：diffusers、transformers、accelerate、safetensors、pillow（aliyun pypi 镜像 `https://mirrors.aliyun.com/pypi/simple/`，实测 ~1MB/s 可用）。
- 模型：从 ModelScope `OnomaAIResearch/Illustrious-XL-v2.0` 下载 `Illustrious-XL-v2.0.safetensors`（6616.6MB 左右）到 `data/models/`。
  - 文件列表 API：`GET https://www.modelscope.cn/api/v1/models/{owner}/{name}/repo/files?Revision=master&Root=`；
  - 下载：`GET https://www.modelscope.cn/api/v1/models/{owner}/{name}/repo?Revision=master&FilePath={file}`（支持 Range 断点续传，实测 14.5MB/s）；
  - 完成校验：本地字节数与服务器 `Content-Length`（或文件列表 `Size`）一致。
- 断点续传：`data/models/<file>.part` + Range；完成后改名；重跑幂等跳过。
- 进度：原子写 `data/state/setup.json`（tmp+rename），字段：
  `{"ok":bool,"running":bool,"phase":"venv|torch|deps|model|tokenizer|verify|done|error","percent":0-100,"message":"人话","startedAt":ISO,"updatedAt":ISO,"error":null,"bytes":{"done":0,"total":0},"sizes":{"venv":0,"model":0}}`
- 日志：`data/state/setup.log`（setup.mjs 自己的 stdout/stderr 都进这里，别刷屏）。
- `--verify`：装完后启动 worker 跑一张 512×512「1girl, solo, masterpiece」冒烟图，成功 `exit 0`。
- 若 `from_single_file` 启动需要 SDXL 的 tokenizer/config 小文件，从 ModelScope `AI-ModelScope/stable-diffusion-xl-base-1.0` 预取到 `data/models/sdxl-base/`，**并保证 worker 全离线可启动**（`HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1` 下自测通过）。具体取哪些文件由引擎侧实测决定，记录在 `engine/NOTES.md`。

## 3. worker.py JSONL 协议（钉死）

启动（Node 侧负责）：
```
<data>/.venv/Scripts/python.exe engine/worker.py --model <绝对路径> --data-dir <绝对路径>
```
- cwd = 插件根；env：`PYTHONUNBUFFERED=1`、`PYTHONIOENCODING=utf-8`、`HF_HUB_OFFLINE=1`、`TRANSFORMERS_OFFLINE=1`，另可传 `FISH_PAINT_VRAM=auto|full|offload`。
- **stdout 只允许 JSON 行（一行一个，立即 flush）**；stderr 随便写日志（Node 转存 `data/state/worker.log`）。
- 收到 EOF / SIGTERM 要正常退出；任何异常必须变成 `error` 行，进程不能悄悄死。

### Node → worker（stdin）

```json
{"id":"a1","op":"generate","prompt":"1girl, solo, ...","negative":"lowres, ...","width":1024,"height":1024,"steps":28,"cfg":5.5,"seed":-1,"count":1,"clipSkip":2,"outDir":"D:\\...\\data\\out\\2026-11-17","resize":{"width":512,"height":512}}
```
- `seed`：-1 = 每张随机；>=0 = 第 i 张用 seed+i（count>1 时）。
- `count` 1–4；`resize` 可选（生成后 LANCZOS 缩放再存，width/height 必须是 8 的倍数）。
- `outDir` 不存在则创建；文件名 worker 自己定：`<outDir>\<YYYYmmdd-HHMMSS>-<seed>.png`。
- 其它 op：
  - `{"id":"s1","op":"status"}` → status 行
  - `{"id":"p1","op":"ping"}` → `{"id":"p1","type":"pong"}`
  - `{"id":"l1","op":"load"}` → `{"id":"l1","type":"loaded","loadSec":41.2,"vramMode":"offload"}`（可选实现，不强求）
  - `{"id":"q1","op":"shutdown"}` → `{"id":"q1","type":"bye"}` 然后 exit 0

### worker → Node（stdout）

启动即输出一次（模型还没加载）：
```json
{"type":"ready","pid":1234,"python":"3.12.2","torch":"2.6.0+cu124","diffusers":"0.35.0","cuda":true,"deviceName":"NVIDIA GeForce RTX 3070","modelPath":"..."}
```
进度（可选，节流 ≥500ms 一条）：
```json
{"id":"a1","type":"progress","stage":"load|generate|save","step":12,"total":28,"variant":0}
```
成功：
```json
{"id":"a1","type":"done","images":[{"path":"D:\\...\\2026-11-17T20-15-01.png","seed":123456,"width":1024,"height":1024}],"elapsedSec":23.4,"loadSec":0,"vramMode":"offload","model":"Illustrious-XL-v2.0"}
```
失败：
```json
{"id":"a1","type":"error","code":"OOM|MODEL_MISSING|BAD_REQUEST|CUDA_ERROR|INTERNAL","message":"...","hint":"可直接给人看的下一步建议"}
```
status 回应：
```json
{"id":"s1","type":"status","loaded":true,"loading":false,"vramMode":"offload","device":"cuda","gpu":{"totalMiB":8192,"freeMiB":5300},"loadSec":41.2,"model":"Illustrious-XL-v2.0"}
```
未知 op → error 行，code=BAD_REQUEST。

### 语义要求

- 模型懒加载：第一次 generate 时加载，`loadSec` 上报本次加载耗时；之后为 0。
- `elapsedSec` = 纯生图（含变体循环）耗时，不含加载。
- sampler 固定 DPM++ 2M Karras（`DPMSolverMultistepScheduler.from_config(pipe.scheduler.config, algorithm_type='dpmsolver++', use_karras_sigmas=True)`）；`clipSkip` 默认 2（不支持的 diffusers 版本就映射到可用的等价做法，或忽略并在 stderr 记一行）。
- 显存：`auto` = 启动/首次生成时看 `torch.cuda.mem_get_info()`，剩余 < 7400MiB 直接 `enable_model_cpu_offload()`，否则整卡；一旦 OOM：清缓存、若还不是 offload 就切 offload、重试同请求一次；再 OOM 就返回 code=OOM + hint（建议换 sticker/降尺寸）。
- 质量设置：fp16、`torch.backends.cuda.matmul.allow_tf32 = True`、VAE slicing。
- worker 不写 sidecar、不写 jsonl、不判断 rating —— 那是插件侧 store.js 的活。

## 4. 插件侧约定

- 纯 ESM，`engines.node >= 20`，**零 npm 依赖**（只许 node: 内置模块）。
- 所有默认路径以插件根 `path.dirname(fileURLToPath(import.meta.url))` 为基准，config 可覆盖。
- 配置对象（cordis.patch.yml 传 `{}`，全部有默认值）：
  `modelPath`、`dataDir`、`pythonPath`、`bridgeDir`（默认 `D:\DPQQ\qq-bridge-0.2.1-r1\qq-bridge-0.2.1-r1`）、`idleMinutes`（默认 30）、`maxVariants`（默认 4）、`steps`（默认 28）、`cfg`（默认 5.5）、`vramMode`（默认 auto）。
- `lib/engine.js` 对 index.js 暴露：
  ```js
  export function createEngine(opts)
  // opts: {root, dataDir, pythonPath, modelPath, idleMinutes, vramMode, onLog}
  // 返回 { generate(req), status(), shutdown(), isRunning() }
  // generate(req) 的 req = {prompt, negative, width, height, steps, cfg, seed, count, clipSkip, outDir, resize}
  // 成功 resolve worker 的 done 对象；失败 reject Error（message 用 error.hint 优先）
  ```
- `lib/store.js` 对 index.js 暴露：`ensureDirs(dataDir)`、`todayDir(dataDir)`、`recordImage({dataDir, image, meta})`（写 `.json` + `.png.meta.json` + index.jsonl）、`listRecent(dataDir, opts)`。
- `lib/qq.js`（Lead 写）对 index.js 暴露：
  ```js
  export function bridgeStatus(bridgeDir)            // 同步，缺配置抛错
  export async function sendImages({key, paths, text, bridgeDir, tmpDir}) // resolve {ok, kind, id, sent:[{path,messageId}]}；失败抛 Error，message 可直接给人看
  ```
- **输出契约**：PNG 存 `data/out/YYYY-MM-DD/`；同名 `.json` 元数据字段：`prompt, negative, preset, width, height, steps, cfg, seed, model, engine:{vramMode,loadSec}, rating, target, note, createdAt`；同名 `.png.meta.json` sidecar：`{"rating":"all"|"r18","source":"dsh-fish-paint","createdAt":ISO}`（rating: sfw→all，nsfw→r18），**sidecar 路径必须是 `<png路径>.meta.json`**（跟 bridge 的 r18-guard 契约完全对齐）。
- 默认负面词（presets.js）：
  `lowres, bad anatomy, bad hands, text, error, missing finger, extra digits, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, bad eyes, mutated`
- 质量词（anime/portrait/landscape 正向追加）：`masterpiece, best quality, very aesthetic, absurdres`
- 预设：anime 1024×1024；portrait 832×1216；landscape 1216×832；sticker 1024×1024 + `chibi, simple background, thick outline, vibrant colors`，存 512×512（通过 worker 的 resize）。
- 工具返回：`[{type:'text', text: JSON.stringify(payload)}]`，payload 含 `ok` 与 `summary`（人话）。
- 工具超时：draw_image `timeoutMs: 600000`。

## 5. 测试与验收

- 引擎：命令行手动喂 JSONL，512²、1024² 各出一张 PNG；记录 loadSec / 生图秒数 / 显存峰值 / full vs offload 实测，写 `engine/NOTES.md`。
- 插件：`node --check index.js lib/*.js engine/setup.mjs`；用 `test/fake-worker.mjs`（模拟 ready/progress/done）单测 lib/engine.js 的 spawn/队列/崩溃重启/空闲退出；presets/store 纯函数可单测。
- 集成（Lead）：`plugin_manager install_bundle` → `draw_status` → `draw_setup verify` → `draw_image` → SFW 发私聊实测；NSFW 目标不在白名单时必须被 r18-guard 拒。

## 6. 汇报格式（teammate → Lead，用 send_message）

1. 完成的文件清单（路径）；
2. 实际跑过的验证命令 + 关键输出数字（loadSec/生图秒数/VRAM/文件大小/PNG 尺寸）；
3. 没做/没验证的部分，风险，要 Lead 决策的点；
4. 不要贴大段代码和日志，不要贴完整文件内容。

## 7. 通用约束

- 不打补丁式修复（USER.md critical）：发现机制不对就改机制，不要 if 特判。
- 不写假数据、不谎报测试通过；没验证就明说「未验证」。
- 中文注释、UTF-8 无 BOM；风格对齐 `D:\新建文件夹\DSK\dsh-coser-fish`。
- 长任务放后台 job，别在前台干等超时；不要重启 DSH、不要动线上 QQ 桥配置。
