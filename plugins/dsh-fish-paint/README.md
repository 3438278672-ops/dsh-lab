# 鱼鱼画画（dsh-fish-paint）

DeepSeek Harness 的画图插件：本地常驻一个 diffusers worker（Illustrious-XL-v2.0 / SDXL），
把 agent 组织好的 danbooru tags 变成二次元插画或表情包，落盘保存，需要时直接发到 QQ 会话。

- 出图完全在本机 GPU 上跑，不走任何在线画图服务。
- 常驻 worker 只在第一次出图时加载模型（约 40s），之后一直热着；空闲 30 分钟自动退出省显存，下次再按需拉起。
- 中文需求由 agent 翻成 tags，插件本身不调用任何 LLM。

## 效果

本机 RTX 3070 8G 实拍原图（28 步，仅转成 JPG）：

| 角色插画 `portrait` 832×1216 | 角色插画 `anime` 1024² |
| --- | --- |
| ![portrait](docs/samples/portrait_832x1216.jpg) | ![anime](docs/samples/anime_1024.jpg) |

| 表情包 `sticker` 512² | 场景横图 `landscape` 1216×832 |
| --- | --- |
| ![sticker](docs/samples/sticker_512.jpg) | ![landscape](docs/samples/landscape_1216x832.jpg) |

## 画自己 / 大肥鱼

「画你 / 画大肥鱼 / 画 DeepSeek-chan」有固定人设：蓝发鲸娘女仆（人设图由号主提供，
原图授权 CC BY-NC-SA 4.0，不随仓库分发）。固定 tag、按用途裁剪的写法与来源说明见
[docs/characters/deepseek-chan.md](docs/characters/deepseek-chan.md)。

![DeepSeek-Chan](docs/samples/deepseek-chan_832x1216.jpg)

## 特性

| 能力 | 说明 |
| --- | --- |
| `draw_image` | 出 1-4 张图，支持预设/尺寸/步数/CFG/seed/变体；可选自动发 QQ |
| `draw_status` | 安装状态、worker 状态、显存、队列、最近 5 张、最近错误、下一步建议 |
| `draw_setup` | 一键安装（后台）、冒烟验证、只读状态 |
| `draw_recent` | 回看最近生成（按条数 / 日期 / target 过滤） |
| 预设 | `anime` 1024²、`portrait` 832×1216、`landscape` 1216×832、`sticker` 1024² 出图后缩到 512² |
| R18 硬闸 | 每张图带 rating sidecar，发送时由 qq-bridge 的 r18-guard 判定，群聊默认发不出去 |

## 环境要求

- Windows + NVIDIA 显卡（参考环境：RTX 3070 8G；`auto` 显存策略会按剩余显存选整卡 / cpu_offload）
- Node.js >= 20（宿主要求；本插件零 npm 依赖，只用 `node:` 内置模块）
- Python 3.12：由安装脚本自动建 `data/.venv`，不需要自己装
- 磁盘约 15GB：venv + torch(cu124) + 模型（`Illustrious-XL-v2.0.safetensors`，约 6.6GB）

## 安装

1. **拿到插件**（本仓库是 `dsh-lab` 多插件仓，插件在 `plugins/dsh-fish-paint`）：

   ```powershell
   git clone git@github.com:3438278672-ops/dsh-lab.git
   ```

2. **挂进 DSH**：把插件目录当 bundle 安装，重启或 HMR 后四个工具就会出现：

   ```
   plugin_manager action=install_bundle target=<dsh-lab>/plugins/dsh-fish-paint
   ```

   也可以按 `cordis.patch.yml` 的 `fish-paint` 条目手动挂进 profile（`config: {}` 即全默认）。
3. **装引擎**：调工具 `draw_setup({ action: "install" })`，或手动跑：

   ```powershell
   cd <dsh-lab>\plugins\dsh-fish-paint
   node engine/setup.mjs --install     # 建 venv → 装 torch cu124 → 装依赖 → 下模型
   node engine/setup.mjs --verify      # 用 512×512 冒烟图确认能画（成功 exit 0）
   ```

   安装进度写在 `data/state/setup.json`，日志在 `data/state/setup.log`；`draw_status` 会读这两份。
   整个安装约 30-40 分钟（取决于网速），中断后重跑会续传。

   安装脚本会自动找 Python 3.12（`py -3` / PATH 里的 `python`）；找不到时用
   `node engine/setup.mjs --install --python C:\Python312\python.exe`（或设 `FISH_PAINT_PYTHON`）。

## 工具

### `draw_image`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `prompt` | string，必填 | 英文 danbooru tags，逗号分隔 |
| `negative` | string | 负面词；不传用默认那一串 |
| `preset` | `anime` / `portrait` / `landscape` / `sticker` | 画风与尺寸预设，默认 `anime` |
| `width` / `height` | number | 覆盖预设尺寸，按 8 取整，范围 256-2048 |
| `steps` | number | 采样步数，默认 28（4-80） |
| `cfg` | number | CFG scale，默认 5.5（1-20） |
| `seed` | number | `-1`/不填 = 随机；返回实际 seed，可复现 |
| `variants` | number | 一次出几张，1-4，默认 1 |
| `rating` | `sfw` / `nsfw` | 默认 sfw；nsfw 写 `rating=r18` 的 sidecar |
| `target` | string | `group:群号` / `private:QQ号`，给了就出图后自动发送 |
| `note` | string | 备注（谁要的/什么梗），写进元数据 |

返回 JSON（`execute` 的 payload 会被渲染成文本给模型）：

```json
{
  "ok": true,
  "images": [{ "path": "D:\\...\\data\\out\\2026-11-17\\20261117-201500-123456789.png",
               "seed": 123456789, "width": 1024, "height": 1024 }],
  "elapsedSec": 23.4,
  "model": "Illustrious-XL-v2.0",
  "engine": { "mode": "offload", "cold": false },
  "prompt": "…归一后的完整正向词…",
  "negative": "…",
  "preset": "anime",
  "rating": "sfw",
  "sent": { "key": "group:1104418054", "kind": "group", "count": 1, "messageId": 123 },
  "summary": "已生成 1 张（anime 1024×1024，耗时 23.4s，seed …）。文件：… 已发送到 …"
}
```

发送失败**不会丢图**：图已经落盘，`payload.sentError` 里给出原因（例如不在白名单、R18 闸拒绝），
可以把同一批 path 再发一次。

### `draw_status`

无参数。返回 `ok`、`installed`、`python`/`model` 探测、`worker`（running/ready/pid/队列/显存等）、
安装进度、最近 5 张、最近错误、`next` 建议列表与 `summary`。画图失败先看它。

### `draw_setup`

| action | 行为 |
| --- | --- |
| `status` | 只读：setup.json + 环境探测，不会启动任何进程 |
| `install` | 后台 spawn `node engine/setup.mjs --install`（detached，输出追加到 `data/state/setup.log`），立即返回，用 `draw_status` 看进度 |
| `verify` | 用已装好的引擎生成一张 512×512 的 `1girl, solo, masterpiece` 冒烟图并落 metadata |

### `draw_recent`

参数 `limit`（1-50，默认 10）、`date`（`YYYY-MM-DD`，本地时区）、`target`（`group:…` / `private:…`）。
返回 `items`，每项含路径、prompt 摘要、时间、rating、seed、target。

## 输出与元数据

```
data/
├─ .venv/                               Python 环境（安装脚本建）
├─ models/Illustrious-XL-v2.0.safetensors
├─ out/
│  └─ 2026-11-17/
│     ├─ 20261117-201500-123456789.png        图片（文件名由 worker 决定）
│     ├─ 20261117-201500-123456789.png.json   同名元数据
│     └─ 20261117-201500-123456789.png.meta.json  rating sidecar（发送闸用）
└─ state/
   ├─ setup.json / setup.log            安装进度与日志
   ├─ worker.json                       worker pid 记录（启动前清死进程）
   ├─ worker.log                        worker stderr（>5MB 轮转成 worker.log.1）
   └─ index.jsonl                       所有记录的追加索引
```

元数据字段：`path, prompt, negative, preset, width, height, steps, cfg, seed, model,
engine:{vramMode, loadSec}, rating, target, note, createdAt`（另有 `elapsedSec`）。
sidecar：`{"rating":"all"|"r18","source":"dsh-fish-paint","createdAt":ISO}`，sfw → `all`，nsfw → `r18`。

## 配置

patch 里 `config` 可覆盖（全部有默认值，**没有任何必须手填的绝对路径**）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `<插件根>/data` | 数据目录（venv、模型、输出、状态都在下面） |
| `pythonPath` | `<dataDir>/.venv/Scripts/python.exe` | worker 用的 Python |
| `modelPath` | `<dataDir>/models/Illustrious-XL-v2.0.safetensors` | SDXL 模型 |
| `bridgeDir` | 自动探测 | qq-bridge 目录（发 QQ / R18 判定用）；探测不到时填这里 |
| `ffmpegPath` | 自动探测（PATH） | 图片 >10MB 时转 JPEG 用 |
| `idleMinutes` | `30` | worker 空闲多少分钟自动退出；0 关闭 |
| `maxVariants` | `4` | 单次最多几张（1-4） |
| `steps` / `cfg` | `28` / `5.5` | 工具参数没传时的默认值 |
| `vramMode` | `auto` | `auto` / `full`（整卡） / `offload`（cpu_offload） |

相对路径都按插件根目录解析。

**环境变量**（不想改 patch 时用，优先级高于自动探测、低于 `config` 显式值）：

| 变量 | 作用 |
| --- | --- |
| `FISH_PAINT_BRIDGE_DIR` | qq-bridge 目录（含 `config.json`） |
| `QQ_BRIDGE_DIR` | 同上（兼容写法） |
| `FISH_PAINT_FFMPEG` | ffmpeg 可执行文件路径 |
| `FISH_PAINT_PYTHON` | 装引擎用的 Python 3.12 |
| `FISH_PAINT_VRAM` | `full` / `offload`，覆盖 `vramMode` |

`bridgeDir` 的自动探测：在插件所在盘根、当前目录盘根、用户主目录、`LOCALAPPDATA`、`ProgramData`
下按名字找像 `qq-bridge` / `qqbridge` 的目录，支持 `qq-bridge-x.y.z/qq-bridge-x.y.z` 这种套一层的结构；
并且要求 `config.json` 是**真正的桥配置**（`allow.groups` / `allow.private` 是数组，且含 `snowluma` / `consolePort` / `ownerQQ` 之一）。
名字像但结构不对、或只是碰巧带 `config.json` 的目录都会被跳过——否则会把别的工具目录误认成桥，导致白名单和 R18 名单读成空。
找不到时 `draw_status` 会提示，发 QQ 相关操作会给明确报错（不会静默失败）。

示例：

```yaml
- insert:
    - id: fish-paint
      name: dsh-fish-paint
      config:
        idleMinutes: 15
        vramMode: auto
        bridgeDir: D:\DPQQ\qq-bridge-0.2.1-r1\qq-bridge-0.2.1-r1   # 只在自动探测不到时填
```

## R18 口径

- 群聊默认只发 sfw；`rating: "nsfw"` 的图只应发到私聊或 qq-bridge 配置里的 R18 白名单会话。
- 插件不自己维护第二份名单：每张图落盘时写 rating sidecar，`sendImages` 发送前动态加载
  bridge 的 `src/r18-guard.js` 做硬闸（`policyFromConfig` / `checkR18Send`）。
- bridge 模块缺失时 **fail-closed**（宁可拒发）；被拒时图仍在本地，`payload.sentError` 会说明原因。
- 别用「换 target / 换工具」绕过闸；agent 侧的系统提示也明确写了这一点。

## 排障

1. 先 `draw_status`：能区分「没装好」「worker 没起来」「冷却中」「队列忙」。
2. 没装好 → `draw_setup({ action: "install" })`，然后看 `data/state/setup.json` 的 `phase/percent/message`。
3. 装了但画不出来 → `draw_setup({ action: "verify" })`；还失败就看 `data/state/worker.log`。
4. 常见错误码：

| code | 含义 / 处理 |
| --- | --- |
| `NOT_INSTALLED` | venv / worker 脚本缺失，跑 `draw_setup install` |
| `MODEL_MISSING` | 模型文件不在，重跑安装（会续传） |
| `OOM` | 显存不够：降尺寸/步数，或 `vramMode: "offload"`；worker 会先自动清缓存重试一次 |
| `COOLDOWN` | worker 连续崩溃 3 次进入 60s 冷却；看 `worker.log` |
| `START_TIMEOUT` / `OP_TIMEOUT` | 启动 / 出图超时；看日志确认是不是卡在模型加载 |
| `BAD_REQUEST` | 参数不对（prompt 空、target 格式、resize 非 8 倍数等），按提示改 |
| `sentError` | 图已生成但 QQ 发送失败：查 bridge 是否在跑、target 是否在白名单、R18 闸 |

空闲自动退出后第一次出图会重新加载模型（`engine.cold=true`、`loadSec>0`），这是预期行为。

## 测试

```powershell
cd <dsh-lab>\plugins\dsh-fish-paint
node --check index.js
node --test test/          # 35 个用例：engine 12 / presets 10 / store 7 / index 6
```

- `test/engine.test.mjs` 用 `test/fake-worker.mjs`（一个按 CONTRACT §3 协议说话的 Node 假 worker）
  覆盖 spawn、JSONL 分发、串行排队、崩溃重启/重试一次、连续崩溃冷却、启动/操作超时、
  空闲退出、pid 文件与错误映射；**不需要真的 Python/GPU/模型**。
- `test/fake-worker.mjs` 开头有守卫：不是被引擎 spawn（缺 `--model/--data-dir`）就直接退出，
  免得被测试运行器当成测试文件挂住 stdin。
- `test/index.js` 是给 `node --test test/` 用的入口 shim：某些 Node 版本（v24.14.0 实测）
  把目录参数当入口模块执行，它会自动 import 所有 `*.test.mjs`。
- `test/store.test.mjs` 验证 sidecar 文件名必须是 `<png 绝对路径>.meta.json`、sfw→all / nsfw→r18、
  index.jsonl 追加、`listRecent` 的 date/target/limit 过滤，以及删掉 index 后回退扫元数据。

## 目录结构

```
dsh-fish-paint/
├─ index.js            宿主入口：4 个工具 + systemPrompt section + 生命周期
├─ cordis.patch.yml    bundle 补丁（id: fish-paint）
├─ lib/
│  ├─ engine.js        常驻 worker 管理：JSONL、串行、重启、冷却、空闲退出、pid
│  ├─ presets.js       预设/质量词/负面词/参数归一（纯函数）
│  ├─ store.js         落盘、元数据、rating sidecar、index.jsonl
│  └─ qq.js            QQ 投递 + bridge r18-guard 硬闸
├─ engine/
│  ├─ worker.py        Python 侧 diffusers worker（CONTRACT §3 协议）
│  ├─ setup.mjs        安装/验证脚本
│  └─ bench.mjs        显存/速度基准（可选）
├─ locale/             zh/en 文案
├─ icon.svg            插件图标
├─ docs/samples/       效果图（README 引用）
└─ test/               单测 + 假 worker
```

## 已验证 / 已知限制

**已在本机端到端验证（2026-11-17，详见 PLAN.md §13 与 engine/NOTES.md）：**

- 真机出图：portrait 832×1216 42.9s、anime 1024² 36.9s、sticker 36.5s、landscape 1216×832 52.4s、
  512² 12-19s、variants=2 @512 24.2s（RTX 3070 8G，auto=offload，28 步）。
- 真发 QQ：sfw 发 owner 私聊成功（含 2 张分批）；nsfw sidecar 发非白名单群被 r18-guard 拒绝且图未丢。
- `draw_setup action=verify` 512² 冒烟 15.2s；`draw_recent`、sidecar、同名 metadata、index.jsonl 均正确。
- 插件已 `install_bundle` 进 profile，`ctx.effect` / `tools.register` / systemPrompt 注入在宿主里真实生效。
- `node --test test/` = 35 pass / 0 fail；`node --check` 全过。

**已知限制：**

- 8G 卡只能走 offload：1024² 一张约 40-60s，出图在插件内部串行排队（worker 单线程，一次只跑一个请求）。
- `vramMode: auto` 的实际规则是「剩余显存 < 7400MiB 就用 offload」——8G 卡上桌面常驻约 1.6-2GB，
  所以本机恒定 offload；`full` 在 8G 卡不可用属预期（worker 会预检并回退 offload，不是 bug）。
- 目前只有 Windows 路径处理（`.exe/.cmd/.bat` 探测、`Scripts/python.exe`）；macOS/Linux 未测。
- 未测：真实 CUDA OOM 异常分支（Windows 驱动会把显存溢出兜成 sysmem fallback）、下载中断续传恢复、
  多 worker 并发（设计为单 worker）、非 3070 显卡的速度/显存表现。
- `plugin_lint`：可发，0 error / 0 warn（文档里的本机路径字样是历史记录，仅 info）。
