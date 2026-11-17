# 更新说明

仓库 2026-11-07 建立以来的变化，最新在上。按「一次可感知的变化」归并，不逐条抄 commit 消息；只在插件自己声明了 `package.json` 版本号时才写版本（如 `0.2.0`）。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

每个条目后的短哈希（如 `45259d2`）是仓库里的对应提交，`git show <hash>` 能看完整改动。

---

## 2026-11-18

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
