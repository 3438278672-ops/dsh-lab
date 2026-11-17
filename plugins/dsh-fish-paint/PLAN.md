# 计划：鱼鱼画画（dsh-fish-paint）

给「大肥鱼」内置一套本地产图能力：听得懂人话、自己填提示词、出图后能自检重试，并把图发到当前 QQ 会话。

- 日期：2026-11-17
- 状态：**已完成（2026-11-17，用户已确认计划与模型；实测见 §13）**
- 插件源码目录：`D:\新建文件夹\DSK\dsh-fish-paint`
- 参考风格：仿 `D:\新建文件夹\DSK\dsh-coser-fish`（Host 插件 + `ctx.tools` + `inject ['tools','systemPrompt']`）

---

## 1. Goal

在 DSH 里，我（大肥鱼）收到「画个提丰在雨里撑伞」这种中文要求后，能自己完成：

1. 把中文要求翻成 danbooru 标签 + 负面词，选画风/尺寸/seed；
2. 调本地 SDXL 动漫模型（Illustrious-XL v2.0）出图，热引擎下 1024² 约 20-40s；
3. 用 `read_image` 自己看图，不满意就改 prompt / 换 seed 重试（最多 2 轮）；
4. 图存本地（PNG + metadata + rating sidecar），并可自动发到当前 QQ 会话；
5. 成人向只在私聊 / R18 白名单会话放行，群聊默认安全。

## 2. 用户已确认

| 项 | 决定 |
| --- | --- |
| 引擎 | 内置轻量引擎：diffusers 常驻 Python 进程（不装 ComfyUI/绘世） |
| 画风 | 二次元角色插画/立绘 + 表情包/贴纸 |
| 投递 | 存本地 + 自动发到当前 QQ 会话 |
| 尺度 | 允许成人向，但仅私聊 / R18 白名单会话 |

## 3. 环境侦察（已实测，2026-11-17）

- 硬件：i5-13400F / 31.8G RAM / **RTX 3070 8G**（驱动 616.92）；2TB 致态 NVMe（C/D 同盘），D 盘剩 308G。
- 侦察时显存已用 1947MiB、剩 6072MiB（桌面/Steam/QQ 等 WDDM 占用，非 TTS 常驻）。
- 本机**没有任何** SD / ComfyUI / 绘世 / 模型文件；也没有 7860/8188 端口。
- 网络实测：
  - **ModelScope 14.5MB/s**（下 6.6G 模型约 8 分钟）✓
  - **SJTU pytorch 镜像 53MB/s**（torch cu124 约 1 分钟）✓
  - GitHub 直连、hf-mirror 只有 0.5-0.7MB/s ✗（不走）
- 模型候选：`OnomaAIResearch/Illustrious-XL-v2.0`（ModelScope，单文件 **6616.6MB**）。
- qq-bridge 现成能力：
  - `D:\DPQQ\qq-bridge-0.2.1-r1\qq-bridge-0.2.1-r1\config.json` 有 `allow.groups/private`、`r18.groups/private`、`ownerQQ`、`snowluma.httpUrl=http://127.0.0.1:3000` + accessToken；
  - R18 硬闸契约：图片旁 `<图片路径>.meta.json` 的 `rating`（`all` / `r18` / `r18g`）由 `src/r18-guard.js` 统一判定，所有发图路径共用；没有 sidecar 视为未知、放行。
  - 发图方式：OneBot HTTP `send_group_msg` / `send_private_msg`，image 段用 `base64://`（单张 ≤10MB）。
- 当前 R18 白名单：群 426954436、1104418054；私聊 2220222310（= ownerQQ）。

## 4. 架构

```
DSH 宿主插件 dsh-fish-paint
├─ index.js               注册工具 + systemPrompt 注入 + Config
├─ lib/engine.js          常驻 python worker 管理：spawn / JSONL / 串行队列 / 崩溃重启 / 空闲退出 / pid 清理
├─ lib/presets.js         画风预设、尺寸预设、质量词、默认负面词、sampler
├─ lib/store.js           输出目录、PNG 落盘、metadata json、rating sidecar、index.jsonl
├─ lib/qq.js              读 bridge config → allow 名单 → 导入 r18-guard → 发送（OneBot HTTP）
└─ engine/
   ├─ worker.py           常驻：加载 Illustrious-XL-v2.0 → 收 JSONL → 生图 → 回路径/进度
   ├─ setup.mjs           一键安装：venv + torch + 依赖 + 模型下载（可后台、可续传）
   └─ requirements.txt
data/                     models/（6.6G）、.venv/、out/、state/
```

数据流：`draw_image` → 队列 → worker.py（diffusers txt2img）→ PNG → store（sidecar/index）→ 可选 qq.js 发送 → 返回 JSON + 人话。

## 5. 工具接口

### `draw_image`（主工具）

```text
参数:
  prompt       string  必填，英文 danbooru tags（由 agent 组织；也接受自然语言，但质量靠 tags）
  negative     string  可选，默认取 preset 负面词
  preset       enum    anime（默认）| sticker | portrait | landscape
  width/height number  可选，覆盖 preset
  steps        number  默认 28
  cfg          number  默认 5.5
  seed         number  可选，-1/不填 = 随机；返回实际 seed
  variants     number  1-4，默认 1
  rating       enum    sfw（默认）| nsfw —— nsfw 会写 sidecar rating=r18
  target       string  可选，"group:群号" / "private:QQ号"；给了就出图后自动发送
  note         string  可选备注（谁要的/什么梗）
返回:
  { ok, images:[{path,seed,width,height}], elapsedSec, model, engine:{mode,cold}, sent?:{messageId,key} }
  外加一段人话摘要（路径 + 用了什么提示词 + 耗时）
```

### `draw_status`

引擎安装状态（venv/torch/模型是否就绪）、显存、当前 vramMode、队列、最近 5 张（路径/提示词/时间/rating）、最近错误。没装好时给出下一步（draw_setup install）。

### `draw_setup`

`action: status | install | verify`
- install：后台线程做 venv/torch/依赖/模型下载，进度写 `data/state/setup.json`，立即返回 job 提示；
- verify：跑一张 512² 冒烟图（"1girl, solo, masterpiece"）。

### `draw_recent`

列最近生成（limit、按日期/target 过滤），返回路径 + 元信息，方便我回看/重发。

## 6. 关键设计决策（含理由）

1. **diffusers 常驻 worker，而不是 ComfyUI**：少一层 HTTP 服务 + 前端 + 工作流 JSON，安装面小、故障面小；3070 跑 SDXL 够用；以后要 GUI 再加 ComfyUI 适配层，不改工具契约。
2. **模型选 Illustrious-XL-v2.0**：danbooru tag 体系、二次元插画/角色目前最强一档；单文件 6.6G 走 ModelScope（14.5MB/s 实测）。tokenizer/配置小文件从 ModelScope 的 SDXL 仓库预取，绕开 hf-mirror 慢。
3. **显存 auto 策略**：先整卡 fp16 跑（`pipe.to('cuda')`）；OOM 捕获后自动退 `enable_model_cpu_offload()`（峰值约 5-6G，速度变慢）；`draw_status` 显示当前模式 + 实测耗时。桌面占 1.9G，这一步必须真机验证。
4. **R18 不另造名单**：生成图一律写 sidecar（`rating: all|r18`）；发送前 `import` bridge 的 `src/r18-guard.js`（同一份源码，白名单唯一数据源），模块缺失时 **fail-closed**（拒绝 nsfw 外发）。
5. **输出契约**：`out/YYYY-MM-DD/<时间戳>-<seed>.png` + 同名 `.json`（prompt/negative/参数/模型/seed/rating/target/createdAt）+ `state/index.jsonl` 追加；seed 可复现。
6. **提示词由我组织，插件不调 LLM**：systemPrompt 里固化 tag 规范（质量词、角色命名 `name (series)`、负面词、比例、自检重试流程）；插件只做拼装/去重/补质量词。
7. **表情包**：sticker preset = chibi + 简单背景 + 方图 1024²，出图后缩到 512² 输出（透明底后续可选，不在 MVP）。

## 7. 预设（MVP）

| preset | 尺寸 | 说明 |
| --- | --- | --- |
| anime（默认） | 1024×1024 | 正向补 `masterpiece, best quality, very aesthetic, absurdres` |
| portrait | 832×1216 | 立绘/半身 |
| landscape | 1216×832 | 场景/横图 |
| sticker | 1024² → 存 512² | `chibi, simple background, thick outline, vibrant colors` |

默认负面词（Illustrious 向）：`lowres, bad anatomy, bad hands, text, error, missing finger, extra digits, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, bad eyes, mutated`

## 8. 目录与数据

```
D:\新建文件夹\DSK\dsh-fish-paint\
├─ package.json / cordis.patch.yml / index.js / locale/{zh,en}.json / icon.svg / README.md
├─ lib/…  engine/…
└─ data\
   ├─ .venv\                  (约 6G，含 torch cu124)
   ├─ models\Illustrious-XL-v2.0.safetensors   (6.6G)
   ├─ out\2026-11-17\…
   └─ state\{index.jsonl, worker.log, setup.json, engine.json}
```

`.gitignore` 排除 `data/`；npm `files` 白名单只带代码/资源，不带模型与 venv。

## 9. 分阶段任务与验收

### Phase 0 · 装引擎（预计 30-40 分钟，主要等下载）

- [ ] `engine/requirements.txt`：torch 2.6.0+cu124（SJTU wheel URL）、diffusers、transformers、accelerate、safetensors、pillow
- [ ] `engine/setup.mjs`：建 venv（本机 Python 3.12）→ pip 装依赖 → 从 ModelScope 下载模型（Range 续传 + 大小校验）→ 预取 SDXL tokenizer/配置小文件
- [ ] `engine/worker.py`：加载单文件 SDXL、JSONL 协议、进度回传、OOM 回退、512² 冒烟
- [ ] 实测记录：冷加载秒数、1024² 热出图秒数、显存峰值、full/offload 两模式对比
- **验收**：命令行跑 worker 生成 1 张 512² 和 1 张 1024²，PNG 可打开；`draw_setup verify` 同一路径可跑通

### Phase 1 · 插件骨架与工具（1-1.5 小时）

- [ ] `package.json`（type module、exports、dsh.bundle.patch、files）、`cordis.patch.yml`
- [ ] `index.js`：`export const name/inject`、Config schema、4 个工具注册、systemPrompt 段
- [ ] `lib/engine.js`：spawn、stdout JSONL 解析、请求队列、stderr→worker.log、崩溃自动重启、空闲 30 分钟退出、pid 文件清理
- [ ] `lib/presets.js`、`lib/store.js`
- [ ] `draw_image` / `draw_status` / `draw_setup` / `draw_recent`
- **验收**：`plugin_manager install_bundle` 装上后 draw_status 正常；draw_image 出 1024² 图并落盘 metadata

### Phase 2 · QQ 投递与 R18 闸（约 45 分钟）

- [ ] `lib/qq.js`：读 bridge config（路径可配）、allow 白名单校验、`import` r18-guard、OneBot 发送、10MB 上限（超限转 JPEG）
- [ ] rating=nsfw + 非白名单目标：**发送前拒绝**；sidecar 写法与 r18-guard 契约对齐
- **验收**：sfw 发自己私聊成功；nsfw 发白名单外群被拒（无实际发送）；nsfw 发白名单私聊成功（可只在私聊实测）

### Phase 3 · 质量与自主循环（约 1 小时）

- [ ] systemPrompt 调优：tag 规范、角色命名、比例建议、负面词、工作流（写 tag→出图→`read_image` 自检→改/重试→发送）
- [ ] variants / seed 复现 / 失败人话化（引擎没装、模型缺失、显存不足、QQ 桥不可达分别给可操作提示）
- **验收**：3 个真实请求（角色立绘、表情包、模糊中文要求）各 1-2 轮出可发图

### Phase 4 · 交付打磨（约 30 分钟）

- [ ] locale zh/en、icon.svg、README（安装/使用/配置/R18 说明）
- [ ] `plugin_lint` 通过（可发）；`draw_status` 与 README 一致
- [ ] 出 3-5 张样张给用户看，更新本计划状态

### Phase 5（可选，后续）

- DSH 网页画廊/表单（client UI）；SD1.5 快档模型；透明底表情包；LoRA；img2img/局部重绘；ComfyUI 适配层。

## 10. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 8G 显存被桌面占 1.9G，SDXL 可能 OOM | auto 回退 cpu_offload；必要时 1024→832；status 显示模式；不达标再谈换轻模型 |
| 与 GPT-SoVITS/RVC 抢显存，语音变卡 | 现在语音服务未常驻占卡；若冲突，后续加「画图前卸语音」开关（本次不做） |
| ModelScope 下载中断 | Range 续传 + 完成校验；失败可从日志重试 |
| from_single_file 需要 SDXL tokenizer/配置 | 从 ModelScope SDXL 仓库预取小文件，离线可复现 |
| 中文提示词效果差 | 我负责翻成 danbooru tags；systemPrompt 固化规则 |
| QQ 发送 10MB 上限 | 超过自动转 JPEG（质量 92）再发 |
| 插件/引擎进程残留 | pid 文件 + 启动清理 + DSH 卸载/退出时 kill |

## 11. 成本

- 磁盘：约 10.5G（venv 6G + 模型 6.6G ≈ 12.6G，粗估，落 D 盘）
- 一次性下载：约 10-15 分钟（ModelScope 8 分钟 + 依赖 2-3 分钟）
- 每张图：免费；1024² 约 20-40s（待实测），表情包 512² 更快

## 12. 待用户确认

1. 插件名/工具名：`dsh-fish-paint`（鱼鱼画画），工具 `draw_image / draw_status / draw_setup / draw_recent` —— 可以吗？
2. 模型就选 **Illustrious-XL v2.0**（6.6G，二次元插画/角色）—— 还是想先装 SDXL base 那种通用底模？
3. 安装位置 `D:\新建文件夹\DSK\dsh-fish-paint\data`（占约 12G）—— 换路径也行。
4. 确认后按 Phase 0 → 4 顺序做，每阶段结束给你看样张/结果。

---

## 13. 施工结果（2026-11-17 实测完成）

**结论：插件已装进 profile 并端到端跑通（真机出图 + 真发 QQ + R18 硬闸生效）。**

### 13.1 最终产物

| 项 | 值 |
| --- | --- |
| 插件包 | `D:\新建文件夹\DSK\dsh-fish-paint`（name `dsh-fish-paint` 0.1.0，已 `install_bundle`，HMR 生效） |
| 工具 | `draw_image` / `draw_status` / `draw_setup` / `draw_recent`（systemPrompt 段 `fish-paint`@900 已注入） |
| 引擎 | `data\.venv`（Python 3.12.2，torch 2.6.0+cu124 / diffusers 0.35.0 / transformers 4.49.0），`engine/worker.py` 常驻 JSONL 进程 |
| 模型 | `data\models\Illustrious-XL-v2.0.safetensors`（6938040674 B），SDXL config/tokenizer 14 个小文件 |
| 数据 | `data\{models,out,state}` 合计约 12.3G；出图 `data\out\YYYY-MM-DD\<ts>-<seed>.png` |
| 文档 | `README.md`、`engine\NOTES.md`（引擎实测/协议坑/限制）、`CONTRACT.md`（施工契约） |

### 13.2 端到端验收（全真跑）

1. `draw_status`：引擎已装、worker 状态、显存、QQ 桥白名单（7 群 + 1 私聊、R18 名单 3）全部正确。
2. `draw_image`（portrait 832×1216，sfw，target=private:2220222310）：**42.9s** 出图 + **真实发到 QQ 私聊**（messageId=-958701722）。
3. `draw_image`（nsfw sidecar，target=group:271381098 非 R18 白名单）：图已存本地，**发送被 r18-guard 拒绝**，错误文案原样返回、图未丢。
4. `draw_setup action=verify`：512² 冒烟 **15.2s**，PNG 正常，seed=42 可复现。
5. `draw_image variants=2`（512²×2，target=owner）：**24.2s** 出 2 张，一次分批发送成功（messageId=-1427097363）。
6. `draw_recent`：8 条记录、prompt/rating/seed/target/note 正确；落盘三件套齐全（同名 `.json`、`<png>.meta.json` sidecar、`state\index.jsonl`）。
7. 样张 3 张（`data\out\2026-11-17\`）：1024² 角色插画 36.9s、sticker 表情包 36.5s（存 512²）、1216×832 场景 52.4s，画质正常。

### 13.3 实测性能（offload，RTX 3070 8G，28 步）

| 尺寸 | 生图秒数 | 说明 |
| --- | --- | --- |
| 512×512 | 12-19s | 热引擎；冷启动 +1.3s 加载 |
| 832×1216 | 40-43s | 立绘预设 |
| 1024×1024 | 37-58s | 方图预设；bench 58s 含首个用例抖动 |
| 1216×832 | 52s | 横图预设 |
| sticker（1024→512） | 36-38s | 生成后缩放存 512² |
| variants=2 @512 | 24s | 串行出 2 张 |

auto 显存策略：空闲显存 <7400MiB → offload（本机恒成立）；full 模式在 8G 卡经预检 OOM 自动回退 offload（详见 `engine\NOTES.md` §3），不会 thrash。

### 13.4 已知限制（如实）

- 8G 卡只能 offload：1024² 一张约 40-60s，群聊里连续点图会排队（插件内部串行队列）。
- full 模式在本机不可用（预检后回退 offload 是正常路径，不是 bug）。
- `plugin_lint`：5 个 error 全是同一类——本机绝对路径默认值（QQ 桥目录、ffmpeg 路径、Python 路径），属于**内部插件**的可配置默认值，不是发布包；其余检查（清单/补丁/编码/依赖/凭证/仓库卫生/文档/图标/语法）全过。用户若要发布再改成环境变量/相对探测。
- 未测：真实 CUDA OOM 异常分支（Windows 驱动把显存溢出兜成 sysmem fallback）、断点续传中断恢复、多 worker 并发（设计为单 worker 串行）。
- R18 只在私聊/白名单会话放行；群聊默认 sfw。

### 13.5 后续可选（未做）

DSH 网页画廊/表单（client UI）、SD1.5 快档模型、透明底表情包、LoRA、img2img/局部重绘、ComfyUI 适配层、语音/画图互斥开关。
