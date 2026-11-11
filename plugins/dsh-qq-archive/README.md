# dsh-qq-archive

把 QQ 群聊变成**可检索的记忆**，把群友变成**可查询的人物档案**。

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的插件：只读本地消息库（SnowLuma / OneBot），在插件自己的 SQLite 里建索引，然后让 AI 用这些工具查——

| 工具 | 干什么 |
| --- | --- |
| `qq_find` | 在历史消息里搜：关键词、会话、发送者、时间、消息类型；可导出成 MD / HTML |
| `qq_ask` | 用一句人话问：语义 + 关键词双路检索，模型作答并给出 `[n]` 引用 |
| `qq_people` | 群友档案：在哪些群、说了多少话、常聊什么、和谁互动多、最近在聊什么 + 人物印象；可导出档案卡 PNG / HTML |
| `qq_links` | 链接资源库：按域名聚合、搜索、导出 |
| `qq_topic` | 群梗考古：一个词第一次出现、谁最爱说、按月热度、语境样本 |
| `qq_highlights` | 名场面：自动找爆聊时段，用模型写成 120~220 字回顾 |
| `qq_report` | 周报 / 月报：按自然周 / 自然月聚合，从 2026-11-06 起 |
| `qq_archive` | 同步 / 状态 / 会话 / 媒体缓存 / 语音转写 / 批量印象 / 语义索引 / 日报 / 看板 / 导出 / 推送开关 / 重建 |

## 为什么不用现成的

- 桥接层只保留最近窗口，翻不了三个月前那句话；
- 全文搜中文时，SQLite FTS5 的 `unicode61` 把整句当一个 token、`trigram` 搜不到两个字；
- 群里的图片、语音、转发，在索引里应该各是一个可过滤的类型，而不是一串占位符。

这个插件把历史消息一次性落在本地，用「分词 + 单字倒排」两层索引解决中文检索，媒体按类型分开存，全程只读源库、零外传。

## 快速开始

```bash
# 装进 DSH（本地目录）
dsh plugin install /path/to/dsh-qq-archive
```

插件启动后自动探测本机 SnowLuma：

```text
<SnowLuma 目录>/data/<QQ号>/messages.db
```

探测顺序：显式配置 `sourcePath` → 环境变量 `QQ_ARCHIVE_SOURCE` → `%APPDATA%` / `%LOCALAPPDATA%` / 用户目录下的 `SnowLuma*` → 各盘 `DPQQ/SnowLuma*`。

首次同步会把历史全量拉进来（3 万条约 7 秒），之后每 10 分钟增量同步。

没有 SnowLuma 也可以用 OneBot：`source: onebot` + `onebot.baseUrl`（NapCat / LLOneBot 的 HTTP 接口，需要实现 `get_group_msg_history` / `get_friend_msg_history`）。局限：HTTP 历史接口只能往回拿固定条数，第一次全量每个会话最多 200 条；要完整历史优先用 SnowLuma 的库。

## 工具

### `qq_find`

```jsonc
{
  "query": "打牌",           // 关键词；不填 = 按条件扫描
  "chat": "123456789",       // 群号 / QQ号 / group:xxx
  "sender": "大肥鱼",         // 昵称或 QQ 号
  "from": "2026-10-01",      // 也支持 7d / 2h / unix 秒
  "to": "now",
  "kind": "all",             // all | text | image | voice | video | file | forward | link | card
  "limit": 20,
  "context": 0,              // >0 时带出前后 N 条
  "offset": 0,
  "semantic": false,         // true = 语义检索（需先建索引）
  "export": "md",            // md | html；给了就顺手导出
  "out": ""                  // 导出路径，默认 home/exports/search-<时间>.md|html
}
```

搜索优先级：**原文连续子串**（单字倒排，能搜到分词词典外的词）→ 分词 AND → 分词 OR（按词覆盖率过滤）→ 单关键词模糊。查不到就明说查不到，不会拿「的」凑数。

导出结果带筛选条件、命中统计和每条消息的时间 / 群 / 发送者 / 上下文；HTML 是单文件、午夜墨配色，打开还能再筛。

### `qq_ask`

```jsonc
{ "question": "上个月大家为什么突然开始聊坦克世界？", "chat": "", "from": "30d", "to": "now" }
```

- 语义索引（`qq_archive action=semantic`）可用时，语义 top-k + 关键词 top-20 合并去重，语义命中优先；
- 材料按时间排序编号，每条截 200 字喂给 DSH 的模型，回答里的 `[n]` 就是引用列表的编号；
- **没有材料就不调模型**，直接说没找到；
- 语义索引没建 / 不可用时自动降级成纯关键词检索，并在结果里说明。

### `qq_people`

```jsonc
{ "who": "大肥鱼", "chat": "123456789", "impression": false, "format": "png", "out": "" }
```

返回：这个人在哪些群、消息量、活跃时段、常用词、@ 过谁 / 被谁 @、最近发言，以及人物印象。

- `impression: true` 当场用 DSH 的模型生成/刷新一份，写进库；不开就只读已有缓存。
- 昵称对不上多个人时返回 `ambiguous: true` + 候选列表，指定 QQ 号再查。
- `format: png | html` 会把这个人导出成档案卡（需要 `chat`，按群隔离）；默认写到 `home/card-<QQ>-<群号>.png|html`。

### `qq_links`

```jsonc
{ "action": "list", "q": "bilibili", "domain": "", "chat": "", "from": "30d", "limit": 50 }
```

- 从消息正文和卡片消息里抽 http(s) 链接（不抽裸域名、不展开短链）；
- `domains` 是按域名聚合的总量 / 最后出现时间，`byChat` 是每个会话的链接数；
- `action: "export"` 写一份 Markdown 资源库（默认 `home/links.md`）。

### `qq_topic`

```jsonc
{ "word": "大肥鱼", "chat": "", "from": "", "to": "", "limit": 80 }
{ "top": true }   // 不给 word 就看最近的高频词
```

词按**子串**匹配（LIKE，`%` `_` `\` 都转义），返回总次数、第一次 / 最后一次、按月热度、常出现的群、最爱说的人、语境样本（最多 30 条均匀采样）。群梗、黑话、突然火起来的词都用它考古。

### `qq_highlights`

```jsonc
{ "action": "build", "chat": "", "from": "30d", "to": "now", "limit": 12, "force": false }
```

- 先按 10 分钟窗口找「爆聊」：窗口内 ≥40 条，间隔 <10 分钟的相邻窗口合并，取最密的锚点窗口；
- 每个窗口交给模型写成 120~220 字回顾，存 `highlights` 表（按会话 + 起止时间判重）；
- `action: list | build | show`，`build` 后看板会自动重建。

### `qq_report`（周报 / 月报）

```jsonc
{ "action": "generate", "kind": "week", "chat": "", "offset": 0, "force": false }
```

- `kind: week` 按自然周（周一 00:00 起），`kind: month` 按自然月；`offset: -1` 看上一期；
- 起点硬性裁到 **2026-11-06**（库里日报从这天开始），更早的周期直接报错，不补假数据；
- 周期内 0 条消息不调模型；生成结果存 `period_reports`，看板「群总结」下方按周 / 月展示；
- `action: status | list | generate | show`。

### `qq_archive`

```jsonc
{ "action": "status" }
// status | sync | chats | media | voice | impressions | report | push | dashboard | export | semantic | reset
```

| action | 说明 |
| --- | --- |
| `status` | 数据源、索引规模、上次同步、媒体缓存数、语义索引状态、日报定时与上次日报、日报推送状态 |
| `sync` | 立即增量同步；`full: true` 全量重读 |
| `chats` | 列出会话（群名 / 条数 / 最后时间） |
| `media` | 把新消息里的图片/语音缓存到 `media/`（`kinds` 可只选 image / voice） |
| `voice` | 转写已缓存的语音（faster-whisper，`limit` 控制条数），结果写回正文可搜 |
| `impressions` | 批量生成人物印象（`users` / `minMsgs` / `limit` / `force`） |
| `export` | 生成单文件浏览页 `viewer.html`（`out` / `title`） |
| `semantic` | 建语义索引（bge-small-zh，`rebuild: true` 强制重建） |
| `report` | 生成群聊日报（`day`: today / yesterday / YYYY-MM-DD，`chat` 限定会话，`force` 重刷） |
| `push` | 日报主动推送：`enabled` 开关、`target`（默认取桥接 allow.private 第一个人）、`scope: digest|all`、`test: true` 先发一条测试 |
| `dashboard` | 生成单文件看板 `dashboard.html`（10 个栏目，见下） |
| `reset` | 删库重建（含全量同步） |

## 日报 / 周报 / 月报

`qq_archive action=report` 会给每个群和「全部会话」各写一份日报：今天聊了多少、谁最活跃、时段分布、高频词、值得回看的链接和长句采样，交给 DSH 的模型写成三段（今天聊了什么 / 值得一看 / 群友动态），落进 `reports` 表，同一天同一会话重复生成是覆盖。

默认每天 `00:30` 自动生成一次的「昨天」的日报（`report.schedule` 可改，留空就只手动）。跑过会记 `last_report_day`，当天不重复；插件停过几天再启动只补昨天，不追更早的。

```text
群聊日报 · 2026-11-07：生成 7 份，跳过 0 份。
模型：deepseek-account/deepseek-flash
```

周报 / 月报用 `qq_report`，按自然周 / 自然月聚合这段日子里的日报和消息统计，同样交给模型写成回顾；起点裁到 2026-11-06，不补更早的。

### 日报主动送达

日报生成后可以**立刻私聊**发给你（不用等你去翻看板）：

- 最顺手的方式：打开看板「群总结」页，顶部有一条「日报主动送达」开关条——点开关启停，右边下拉选 `digest`（只推全群汇总）/ `all`（每群各一份），「发条测试」当场验证链路，旁边会显示当前状态和上次发送结果；
- 命令行等价写法：

```jsonc
{ "action": "push", "enabled": true, "scope": "digest" }   // digest = 只推「全部会话」汇总；all = 每群各推一份
{ "action": "push", "test": true }                          // 先发一条测试消息确认链路
```

- 走本机 qq-bridge 的**控制台操作者通道** `POST /api/test-send`（自动读 `consolePort` / `state/console-token`），不是 agent 通道，不受单条 500 字限制；
- 桥接入参自动探测：环境变量 `QQ_BRIDGE_HOME` → `~/DPQQ` → `D:\DPQQ` 下的 `qq-bridge-*` 目录；也可以用 `push.baseUrl` / `push.token` / `push.tokenFile` 显式指定；
- 默认收件人取桥接 `allow.private` 的第一个人，可以用 `push.target` 或 `action=push target=123456789` 覆盖；
- 开关状态存在库的 meta 里（`push_enabled` / `push_target` / `push_scope`），`qq_archive action=push enabled=false` 随时关；
- 只支持私聊；超长按段落切成最多 3 条；发送结果记 `push_last_at` / `push_last_result`，`status` 里能看。

## 本地看板

`qq_archive action=dashboard` 生成 `dashboard.html`（单文件、离线、双击即开），午夜墨风格，10 个栏目：

- **群总结**：最近 7 天的日报按天归档，日期栏点哪天看哪天（只列真有日报的日子，最新在前）；每个群一张卡片，卡片底部可以直接写批注（按天存浏览器 localStorage）；顶部是**日报主动送达开关条**（开关 / 范围 / 发条测试 / 状态与上次结果）；下方是**周报 / 月报**卡片；
- **日历**：近三个月的活跃热力图（全局 + 按群），颜色越深越吵；点某天看当天的消息数、发言人数、图片/语音数、链接数、时段分布、最活跃的人和群；
- **资源库**：按域名分组的所有链接，可按域名 chip + 关键词过滤；
- **群梗**：高频词建议，点一个词就考古：总次数、第一次/最后一次、按月热度、常出现的群、最爱说的人、语境样本；
- **名场面**：`qq_highlights build` 生成的爆聊回顾；
- **人事图**：一个群一块板子（卷宗标签切换，默认「全部卷宗」）。照片是群友，红线是互相 @；**可以切全部时间 / 本周 / 上周 / 本月**；点照片看线索卡：发言数、@ 过谁、被谁 @、人物印象，还能一键跳去完整档案或导出档案卡；
- **榜单**：本周至今 vs 上周同期（等长时段，避免周中看到假的 -70%），上升 / 下跌 / 新面孔 / 失踪人口；
- **群友**：先选一个群，再看这个群里的人。卡片上是头像、QQ、发言数、人物印象和标签，点开看完整档案；
- **收藏夹**：从消息流里收藏值得留的句子，一键导出 JSON / Markdown 存档；
- **最近档案**：最近消息流，悬停可收藏。

「全部群友」取发言最多的 60 人，每个群各取该群发言最多的 40 人；卡片上的印象来自 `qq_people impression=true` 或 `qq_archive action=impressions` 批量生成的结果，没生成过的会显示提示。

看板同时通过 `/qq-archive/` 提供几个**只读在线接口**（离线打开 HTML 时这些栏目会显示已固化在页面里的快照，并提示需要在线；唯一例外是 `/api/push`，看板顶部开关会用它写状态）：

| 接口 | 说明 |
| --- | --- |
| `/qq-archive/api/day?date=YYYY-MM-DD&chat=` | 某天的时段分布、最活跃的人 / 群 |
| `/qq-archive/api/topic?word=&chat=&from=&to=` | 群梗考古（任意词，实时查库） |
| `/qq-archive/api/graph?chat=&range=all|week|lastweek|month` | 关系图时间切片 |
| `/qq-archive/api/links?q=&domain=&chat=&limit=` | 资源库在线过滤 |
| `/qq-archive/api/push` | `GET` 读日报推送开关状态；`POST` 改开关 / 范围 / 收件人，或 `{ "test": true }` 发测试（整站唯一写接口，只接受同源请求） |

批注和收藏平时在 localStorage，点「导出存档」才会落成文件——那才是永久档。

## 浏览页

`qq_archive action=export` 会在插件家目录生成 `viewer.html`，双击就能看：

- 左侧会话列表，右侧消息流（默认最近 200 条，往上滚加载更早）；
- 搜索框回车过滤（消息正文 / 昵称 / 群名 / QQ 号）；
- 点会话只看该群，点昵称只看该人（并显示他的人物印象）；
- 已缓存的图片直接显示，点开看原图；没缓存的显示类型标签。

> QQ 的图片/语音链接带 rkey，会过期（实测约一周）。**只有同步之后新到的媒体能缓存**，历史媒体下不动，会标记失效、不反复重试。

## 熟人卡：喂给 QQ 对话

`qq_archive action=dashboard` 会顺手写一份 `people.json`（约 40KB）：每个会话发言最多的 24 人，配上名字、总条数、一句话人物印象、几个标签。

这份文件就是给 QQ 桥接（qq-bridge）读的。桥在每次唤醒时按当前会话取前 8 个人，拼成一段「本群的熟人」放进提示词——于是 QQ 那边的大肥鱼开口就认得这些人，不用每次重新认识。

- 桥那边的开关是 `config.json` 的 `socialV2.peopleCard`：`enabled`（默认 true）、`maxPeople`（默认 8）、`maxChars`（默认 1400）、`path`（默认 `~/.dsh/qq-archive/people.json`）；
- 印象为空的人不会进这张卡，所以想让人被认出来，先跑 `qq_archive action=impressions`；
- 改完 `people.json` 不用重启桥：桥按文件 mtime 缓存，下次唤醒自动重读。

## 档案卡：群里问「你怎么看某某」

QQ 里有人 @ 大肥鱼问「查查某某」「你觉得某某是个什么样的人」，桥接会调 `qq_person_card`，把那个人的档案卡渲染成一张图发到群里。

- 卡片由本插件渲染：`/qq-archive/card?chat=group:123&who=昵称`（或 `&user=QQ号`）返回 PNG，服务端用本机 Edge/Chrome 无头截图，一张约 2~3 秒，同一个人 5 分钟内复用；
- 加 `&format=html` 返回单文件 HTML 档案卡；看板上点开群友详情，也有「导出档案卡 PNG / HTML」两个按钮；
- 内容就是看板里那张详情页：头像、发言数、人物印象、标签、24 小时活跃分布、常说的话、在哪些会话、@ 关系；
- **只能查当前会话里的人**：`who` 只在该会话的成员里找；桥接那边还会用会话令牌校验 key，跨群既查不到也发不出去；
- 重名会返回候选列表（409），让提问的人再确认一次；
- 没生成过人物印象的人，卡片上会写「还没有人物印象」，先跑 `qq_archive action=impressions`。

## 配置

插件配置在 `cordis.patch.yml` 里，全部可选：

```yaml
config:
  source: auto            # auto | snowluma | onebot | json
  sourcePath: ''          # 显式指定 messages.db 或 OneBot HTTP 根地址
  home: ''                # 索引目录，默认 <DSH home>/qq-archive
  syncIntervalMin: 10
  media:
    maxCount: 2000        # 媒体缓存上限，到顶就不再下
  llm:
    provider: ''          # 日报 / 问答 / 名场面 / 周期报告用的模型；空 = 自动挑第一个可用 provider
    model: ''
  impression:
    schedule: ''          # '02:30' 这样写 = 每晚到点批量生成；空 = 只手动
    minMsgs: 20
    limit: 30             # 一次最多生成几个人
    sample: 60            # 每个人取样多少条消息喂给模型
  report:
    schedule: '00:30'     # 每天这个点自动生成「昨天」的日报；留空 = 只手动
    maxChats: 12          # 一次最多生成几个会话（按消息量倒序）
  push:
    enabled: false        # 日报生成后立刻私聊（库里的 push_enabled 覆盖它）
    discover: true        # 自动探测本机 qq-bridge
    baseUrl: 'http://127.0.0.1:3100'
    token: ''             # 不填就读 <桥接>/state/console-token
    tokenFile: ''
    target: ''            # 不填就用桥接 allow.private 的第一个人
    scope: digest         # digest = 只推「全部会话」汇总；all = 每群一份
  enhance:
    voice: false          # 语音转写（faster-whisper）
    image: false          # 图片描述/以文搜图（Qwen2.5-VL / CLIP）
    semantic: false       # 语义检索（bge-small-zh）
    impression: false     # 每晚批量生成人物印象（走 DSH 的 llm 服务）
```

核心功能零 npm 依赖，只用 Node 内置的 `node:sqlite`、`Intl.Segmenter`、`node:http`。增强层默认全关：

- **人物印象 / 问答 / 名场面 / 周报月报**：走 DSH 自己的 `llm` 服务，不额外装东西；
- **媒体缓存**：纯 Node，无依赖；
- **语义检索**：需要 Python + `sentence-transformers`（或直接 `transformers` + `torch`）+ bge-small-zh-v1.5，索引落在 `home/semantic/`（`ids.npy` + `vectors.npy`），检索时用同一个模型编码查询后做余弦；
- **语音转写**：需要 Python + `faster-whisper`，模型默认 `small`，CPU int8 也能跑。

国内下载模型建议设 `HF_ENDPOINT=https://hf-mirror.com`。

## 隐私

- 全程**只读**源消息库，不写、不改、不上传；
- 索引只落在本机 `home` 目录；
- 仓库不含任何 Token / 账号 / 聊天记录，`data/`、`*.db` 已在 `.gitignore` 里；
- 嵌入/检索默认走本地模型；日报推送只发到你自己配的 QQ 号。

## 开发

```bash
npm test        # node:test，23 个测试文件 / 118 个用例
```

目录：

```text
index.js                 工具注册（qq_find / qq_ask / qq_people / qq_links / qq_topic / qq_highlights / qq_report / qq_archive）
lib/config.mjs           配置 + SnowLuma 探测
lib/adapters/            snowluma（只读 SQLite）| onebot | json
lib/normalize.mjs        OneBot 事件 → 统一消息
lib/segment.mjs          中文分词 + 单字索引 + FTS 查询构造
lib/db.mjs               schema / 入库 / 搜索 / 上下文
lib/ingest.mjs           增量同步
lib/people.mjs           人物档案统计
lib/llm.mjs              DSH llm 服务的薄封装（流式收集文本）
lib/impression.mjs       人物印象：取样 → 约束提示词 → 解析 → 落库
lib/media.mjs            图片/语音缓存（新消息边到边下）
lib/voice.mjs            语音转写：调 scripts/transcribe.py，结果写回正文
lib/semantic.mjs         语义检索：调 scripts/embed.py，向量落 home/semantic
lib/ask.mjs              自然语言问答：双路检索 + 引用
lib/findexport.mjs       搜索结果导出（单文件 MD / HTML）
lib/export.mjs           单文件浏览页生成
lib/report.mjs           群聊日报：统计 + 采样 + 落库
lib/period.mjs           周报 / 月报：periodBounds / buildPeriod / runPeriodReport
lib/push.mjs             日报主动送达：桥接探测 + /api/test-send
lib/links.mjs            链接资源库：抽取 / 聚合 / 过滤 / 导出
lib/calendar.mjs         活跃日历：按日聚合 / 单日明细
lib/leaderboard.mjs      活跃榜 / 失踪人口（本周至今 vs 上周同期）
lib/topics.mjs           群梗考古 / 高频词
lib/highlights.mjs       爆聊窗口识别 + 名场面摘要
lib/graph.mjs            @ 互动关系图（节点 / 边，支持时间切片）
lib/graphrange.mjs       本周 / 上周 / 本月的时间窗口
lib/dashboard.mjs        艺术化本地看板（10 个栏目 + 在线接口）
lib/card.mjs             人物档案卡 HTML / 无头浏览器截图
lib/web.mjs              /qq-archive 页面、媒体、档案卡与只读 JSON API
scripts/embed.py         bge-small-zh 编码 / 查询
scripts/transcribe.py    faster-whisper 转写
docs/design.md           设计文档
docs/design-archive-plus.md  2026-11 扩展设计（问答 / 日历 / 资源库 / 榜单 / 名场面 / 周期报告 / 推送）
```

## 路线

- [x] M1 索引内核：SQLite + FTS5 + 单字索引 + 中文搜索 + 增量同步
- [x] M2 人物档案 `qq_people`
- [x] M3 人物印象（LLM，默认关）+ 媒体缓存
- [x] M4 单文件 HTML 浏览页
- [x] 语义检索（bge-small-zh，默认关）
- [x] 语音转写（faster-whisper，默认关）
- [x] OneBot v11 数据源
- [x] 群聊日报（LLM 总结，落 `reports` 表）
- [x] 本地看板（午夜墨：群总结 + 关系图 + 收藏夹 + 消息流）
- [x] 自然语言问答 `qq_ask`（语义 + 关键词 + 引用）
- [x] 链接资源库 / 搜索结果导出 / 活跃日历 / 群梗考古 / 名场面 / 活跃榜与失踪人口 / 关系图时间切片
- [x] 人物档案卡导出 PNG / HTML
- [x] 周报 / 月报 + 日报主动推送
- [ ] JSON / JSONL 导入（离线备份）
- [ ] 图片描述 / 以文搜图（需要多模态/CLIP 模型）

MIT
