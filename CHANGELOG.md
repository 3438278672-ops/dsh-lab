# 更新说明

仓库 2026-11-07 建立以来的变化，最新在上。按「一次可感知的变化」归并，不逐条抄 commit 消息；只在插件自己声明了 `package.json` 版本号时才写版本（如 `0.2.0`）。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

每个条目后的短哈希（如 `45259d2`）是仓库里的对应提交，`git show <hash>` 能看完整改动。

---

## 2026-11-19

### dsh-gpu-queue `0.1.0`（新插件）

- 新增：一块 8G 显存给画画、唱歌、语音合成共用。以前三边各跑各的——SDXL worker 常驻占着约 5GB，
  唱歌的 UVR5 / RVC 再上去就是 `memory.used 7428 / 8192 MiB`，谁的进程被驱动踢掉全看运气。
- 形态是**本机令牌服务**（`127.0.0.1:31879`，单通道 FIFO）：`POST /gpu/acquire` 领牌、`GET /gpu/ticket` 排队轮询、
  `POST /gpu/heartbeat` 续命、`POST /gpu/release` 交回、`POST /gpu/cancel` 撤掉自己的排队项、`GET /gpu/state` 看现场。
  写端点要 `~/.dsh/dsh-services/gpu-queue.token`，读端点只读。
- 语义拍板：唱歌只在**真正吃显存的翻唱段**占队（找歌、发送不占）；发唱歌牌之前先
  `POST /paint/yield` 让画画的 worker 把显存吐出来（等 20 秒，失败也照发、只记 `yieldWarning`）；
  语音合成插队但不抢占持有者；持有者 60 秒没心跳或进程死了回收，排队项 90 秒不轮询丢弃。
- 两个坑记在案：`pump` 写成 `pumping = (async () => {…})()` 时，函数体同步跑完会让 `finally` 抢在赋值前执行，
  之后所有 pump 永久空转（改成先存 `task`、`finally` 里比对再清）；`grant` 早期不检查现有持有者，会把别人的牌顶掉。
- 测试：17 个（9 个纯状态机 + 8 个 HTTP 行为），另有 `tools/e2e-python.mjs` 真跑一遍「唱歌 → 画画 → 语音」串行。

### dsh-floatball `0.1.0`（新插件）

- 新增：桌面右下角一颗鲸鱼球。点开是控制台——点歌（在唱进度、排单、暂停接新单、掐掉这首、CD 与白名单）、
  画画（接单状态、worker、在飞的那张、暂停接新图、中止）、顶部一条显卡队列。以前这些只能让智能体去调工具，
  现在人自己伸手就能按。
- 球是自带 Electron 运行时的小窗（`%LOCALAPPDATA%\dsh-floatball\runtime\44.0.0`，首启从 npmmirror 下载、GitHub 兜底）：
  透明置顶、`setIgnoreMouseEvents` 穿透、拖动按光标跟手、位置落盘、父进程（DSH）没了自动退。
- 两个 Electron 坑值得单独记：① DSH 环境里继承着 `ELECTRON_RUN_AS_NODE=1`，不剔掉 electron.exe 会以 Node 模式启动，
  报 `Cannot find module 'electron'`；② **Chromium 不接受含中文的 exe 路径**——放在 `D:\新建文件夹\…` 下启动直接
  `STATUS_BREAKPOINT`（`code=-2147483645`），一行脚本都跑不到。所以运行时固定装到 ASCII 路径，旧位置存在时自动复制复用。
- 窗口坐标也踩了混合 DPI（主屏 1.0 / 副屏 1.5）：同一组数字换块屏就是另一个物理点，曾经把球丢进两块屏之间的死区。
  现在启动/接显示器都过一遍 `resolvePosition`（不在任何屏上就回主屏右下角），拖动改由主进程读光标、只夹所有屏的外接矩形。
- 测试：32 个（格式化、运行时安装、看护进程、快照、位置解析），另有 `tools/e2e-ui.mjs` 用 CDP 真点一遍面板（14 项）。

### dsh-fish-paint

- 新增：`lib/control.js` 控制口（`127.0.0.1:31878`，写端点要 `x-control-token`）：`GET /paint.json` 快照
  （暂停、限流、worker、在飞、队列、冷却名单）、`POST /paint/pause`、`POST /paint/yield`（有在画的就 409）、
  `POST /paint/abort`。桌面那颗球就是靠这几个端点干活。
- 新增：**全局暂停**（`data/state/paint-paused.json`）。暂停只拦新点图，在画的照常画完；主会话也拦，没有旁路。
- 新增：每张图先领 `draw` 令牌（最多等 10 分钟，超时回 `QUEUE_TIMEOUT`），画完在 `finally` 里释放；
  面板中止会把在飞的那张映射成 `ABORTED`，冷却自动退回。
- 修：`draw_setup action=verify` 的冒烟图不受暂停影响（诊断用），但同样排队。

### dsh-qq-sing

- 新增：`POST /qqsing/cancel?alsoQueue=0|1`（只认令牌），把「掐掉当前这首」从工具里抽成 `cancelCurrent()`，
  工具与球共用一套；没在唱时回 `{cancelled:false}` 而不是报错，`jobId` 对不上回 409。
- 新增：`/qqsing.json` 补 `limits`（CD 时长、排单上限、白名单 / VIP 计数）与 `cooldowns`（还要等多久），
  球上不用再猜。
- 新增：`python/gpuqueue.py`（纯标准库客户端）替掉 `gpu_lock("rvc")`，UVR5 分离与 RVC 转换共用一个唱歌令牌；
  队列不可用时**打日志照唱**（队列挂了画画那边会明确失败，不会同时吃卡）。
- 修：`server.on('error')` 不再吞 `EADDRINUSE`，写进 `<name>.status.json`，球能分清「没开」和「端口被占」。

### dsh-qq-voice

- 新增：`gpu-token.mjs`——真正合成前领一个 `voice` 令牌（30 秒），显卡正被画图占着就回一句
  「等它画完再念」；队列不可达时照念（不让「没装队列插件」变成「发不了语音」）。

---

## 2026-11-18

### dsh-llm-refusal-fix `0.1.0`（新插件）

> 2026-11-18 起该插件已迁移到独立仓库 <https://github.com/3438278672-ops/dsh-llm-refusal-fix>，
> 本仓库不再保留副本；以下记录保留为迁移前在 dsh-lab 里的首次发布。

- 新增：把 DeepSeek Messages 的合法终止原因从 `MALFORMED_RESPONSE` 里救回来。`stop_reason: "refusal"`
  （模型内容安全拒答）此前被适配器的 `stopReason()` 当作协议损坏，agent 回合直接变成 error；
  QQ 桥随后把 `DeepSeek Messages stream: unsupported stop reason refusal` 原样贴进群。
- 修法是补契约而不是特判：`refusal` → 正常结束 + 一条可读说明文本块（同时避免 `EMPTY_RESPONSE`）；
  `pause_turn` / `cancelled` → 正常结束；`model_context_window_exceeded` → `max-tokens`；
  未知值仍然 `MALFORMED_RESPONSE`（不放宽真损坏）。
- 落地为 profile 级 bundle：vendor 修补版 adapter + account provider，patch 行禁用内置
  `llm-deepseek-account` 并由本包同名接管（`settingsNs: llm-deepseek-account`，账号 / 模型 / 既有设置全沿用）。
- 测试：9 个离线 fixture（`npm test`，依赖装在 `tests/.work/`，不在插件根目录留 `node_modules`）
  + 装好后的 `llm_refusal_fix_selftest` 真机冒烟 7/7；真机核验内置行 `inactive`、本包行活跃、正常对话可用。
  环境、真机核验与上游原始 SSE 证据见独立仓库的 [TESTING.md](https://github.com/3438278672-ops/dsh-llm-refusal-fix/blob/main/TESTING.md)；
  同一套 fixture 由独立仓库的 CI workflow `.github/workflows/test.yml` 跑。
- 上游讨论 #11337 / #13611；0.2.2-rc.4 只把错误码改成 `CONTENT_REFUSED`、可恢复性仍未修，上游修好后本包可卸载。

### 仓库

- 新增根目录 `.gitattributes`：文本**存 LF、检出 LF**，`png / jpg / db / safetensors` 等按二进制处理。
  此前只有 `dsh-qq-archive`、`dsh-idea-log` 自带 `* text=auto eol=lf`，其余插件按 `core.autocrlf` 检出成 CRLF——
  从插件本体目录（LF）同步代码进来时，整目录都会假报 modified，实际内容一个字没变。（`aa274ac`）

### dsh-qq-archive

- 工具化改造：`index.js` 从约 1500 行瘦到 34 行，9 个 MCP 工具的实现搬到 `tools/qq_*.mjs`
  （`qq_archive` / `qq_find` / `qq_ask` / `qq_people` / `qq_impression` / `qq_links` / `qq_topic` / `qq_highlights` / `qq_report`）。（`102c7e4`）
- 新增 `lib/tooling/{contracts,registry,selfcheck}.mjs`：工具契约、动态注册与自检；
  新增 `lib/runtime.mjs`、`lib/report-run.mjs`、`lib/format.mjs`（运行时 / 报告 / 格式化从 `index.js` 拆出）。
- 数据目录（home）解析顺序定死并写进 `cordis.patch.yml`：显式 `home` → 环境变量 `QQ_ARCHIVE_HOME` → 默认 `~/.dsh/qq-archive`；
  `node --test` 下**不允许隐式默认**，测试必须显式传 home 或设环境变量。
- `package.json`：`files` 补 `tools`，`test` 先过 `tests/setup-sandbox.mjs`。
- 新增 5 个测试文件：`tools.smoke`、`tooling.registry`、`home-resolution`、`impressioncard`，加一个测试辅助 `setup-sandbox.mjs`。

### dsh-coser-fish `0.2.0`

- `xSearch` 改成严格阶梯：先把所有作者名的 **X（推特）** 搜完，整级没命中才降级**微博 / B站**；
  有命中就停在这一级，不再往下搜。同时做平台隔离——X 阶段捞到的微博链接不会被当成 X 号。（`8095210`）
- 返回新增 `xSearch: { tried, found, searched }`，调用方能看出这次到底搜没搜成。
- 引擎 5xx / 超时、或宿主搜索服务不可用时不写缓存：那是环境问题，不是这张图的结论。
- 代码量：`index.js` +152/−69，`src/fish-find-chicken.js` +98/−30，`test/social.mjs` 覆盖新阶梯。

### dsh-qq-sing

- 排单：有人在唱时不再直接回 `busy`，进 FIFO（最多 5 首，返回 `queued` + `position`，排满才 `queueFull`）。（`6d3b255`）
- 搜索拿不准先征询：返回 `needConfirm` + token + 最多 3 个候选，回 `confirm` / `pick` 才起唱。
- 新增 `python/songsearch.py`（选源）：频道优先（JLRS-jayfm / LeoFM）、标题边界命中，
  排除试听 / 录音棚 / nightcore / 翻唱 / 教学这类脏源；普通搜索回退时先问、不自动挑。
- 新增 `python/intro_trim.py`；`fetch_song.py` 拆成 `--plan`（只搜、看候选）与 `--bvid`（确认后按 BV 下）两段。
- 新增 `/qqsing/pause` 暂停端点（悬浮球卡片的按钮走的就是它）。
- 新增 `tests/confirm.test.mjs`、`tests/test_channels.py`，排队 / 冷却 / 集成测试同步更新。

### dsh-adb-phone

- 同步 `README.md`、`make-ping.py`、`probe-unicode.mjs`。`ping.png` 是 `make-ping.py` 的产物，不入库。（`be4ea42`）

---

## 2026-11-17

### dsh-fish-paint（新收入仓库）

- 整包入库：diffusers 常驻 worker、四个尺寸预设（anime / portrait / landscape / sticker）、出图落盘 + rating sidecar、QQ 投递、41 个单测。（`087c76c`）
- 固定「画自己 / 大肥鱼」人设 prompt（DeepSeek-Chan 鲸娘女仆）+ 文档与样张。（`d97e3e7`）
- 默认负面词补通用手部 / 肢体硬约束；`negative` 参数只能追加，不能替换默认词。（`c5884e0`）
- 限流：一人 1 小时一次，VIP 名单（2220222310）不限。（`d4e40b8`）
- 点名角色先查 P 站对齐标签：`px_search` → `名字 (系列)` + 3–6 个外观词，再出图。（`6e8410c`）
- 双模型：Illustrious-XL-v2.0 之外加 WAI-NSFW-illustrious，`draw_image` 加 `model` 参数（`auto / base / nsfw`）。（`45259d2`）

---

## 2026-11-11

### dsh-qq-archive `0.2.0`

43 个文件、+8114/−134：11 项新能力 + 10 栏看板。（`03904bf`）

- 新工具 5 个：`qq_ask`（自然语言问答，带 `[n]` 引用）、`qq_links`（链接资源库）、`qq_topic`（群梗考古）、
  `qq_highlights`（名场面）、`qq_report`（周报 / 月报）。
- 新模块：`lib/ask.mjs`、`lib/links.mjs`、`lib/topics.mjs`、`lib/highlights.mjs`、`lib/calendar.mjs`、
  `lib/leaderboard.mjs`、`lib/period.mjs`、`lib/findexport.mjs`、`lib/push.mjs`、`lib/graphrange.mjs`；
  `lib/dashboard.mjs` 重写（+988）。
- `qq_archive` 新增 `push`（日报主动送达）、`dashboard`（生成单文件看板）、`export`、`semantic`（语义索引）等 action。
- 看板扩到 10 栏（群总结 / 探案板 / 群友 / 日历 / 资源库 / 名场面 …），补活跃日历热力图与活跃榜。
- 12 个新单测（ask / calendar / dashboard / findexport / graphrange / highlights / leaderboard / links / llm / period / push / topics），`report` 测试同步更新；
  设计记录见 `docs/design-archive-plus.md`。

---

## 2026-11-09

### 文档

- README 删掉「没有放进来的」一节（OPCG 与 dsh-see-now 不在本仓库分发的说明不再留在正文里）。（`74f3b03`）

---

## 2026-11-08

### dsh-qq-archive

- 新增 `lib/card.mjs`（群友档案卡）、`lib/board.mjs`（探案板）、`lib/mentions.mjs`（@ 关系）、`lib/snapshot.mjs`（增量快照）；
  看板改成增量生成，配套 `tests/card.test.mjs`、`tests/incremental.test.mjs` 与 `docs/design-incremental-dashboard.md`。（`70edf5b`）
- 修：档案卡地址改由 `endpoint.json` 发布；同步索引加超时保护。（`6b349b1`）

### dsh-idea-log

- 新增 `lib/watch.mjs`：盯会话文件的变化，灵感墙与提炼不用等下一轮扫描；配套 `tests/watch.test.mjs`。（`70edf5b`）
- 修：人物印象 JSON 解析、灵感墙「开工」链路。

---

## 2026-11-07

### 建库

- 初始提交：`dsh-qq-sing`、`dsh-coser-fish`、`dsh-qq-voice`、`dsh-self-extend`、`dsh-adb-phone` 五个插件，
  加 `mcp/pixiv-duty`、`mcp/bili-duty` 两个 MCP，附 README 的三个设计故事、LICENSE 与 `.gitignore`。（`b8c42ed`）
- 收入 `dsh-qq-archive` 与 `dsh-idea-log`，README 补两条设计故事。（`49bad98`）
- 两个有界面的插件补上假数据截图：档案馆看板、灵感墙。（`83ed81a`）
- 灵感账本：锁住「孵化中」的开工，同一条不会反复开成几个对话；README 记一条设计决定。（`906d4b6`）
