# dsh-qq-archive

把 QQ 群聊变成**可检索的记忆**，把群友变成**可查询的人物档案**。

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的插件：只读本地消息库（SnowLuma / OneBot），在插件自己的 SQLite 里建索引，然后让 AI 用两个工具查——

| 工具 | 干什么 |
| --- | --- |
| `qq_find` | 在历史消息里搜：按关键词、会话、发送者、时间、消息类型（文字/图片/语音/转发/链接） |
| `qq_people` | 群友档案：谁在哪些群、说过多少话、常聊什么、和谁互动多、最近在聊什么 + 人物印象 |
| `qq_archive` | 同步 / 状态 / 会话 / 媒体缓存 / 语音转写 / 批量印象 / 语义索引 / 群聊日报 / 本地看板 / 导出浏览页 / 重建 |

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
  "offset": 0
}
```

搜索优先级：**原文连续子串**（单字倒排，能搜到分词词典外的词）→ 分词 AND → 分词 OR（按词覆盖率过滤）→ 单关键词模糊。查不到就明说查不到，不会拿「的」凑数。

### `qq_people`

```jsonc
{ "who": "大肥鱼", "chat": "123456789", "impression": false }
```

返回：这个人在哪些群、消息量、活跃时段、常用词、@ 过谁 / 被谁 @、最近发言，以及人物印象。

- `impression: true` 当场用 DSH 的模型生成/刷新一份，写进库；不开就只读已有缓存。
- 昵称对不上多个人时返回 `ambiguous: true` + 候选列表，指定 QQ 号再查。

### `qq_archive`

```jsonc
{ "action": "status" }   // status | sync | chats | media | voice | impressions | export | semantic | report | dashboard | reset
```

| action | 说明 |
| --- | --- |
| `status` | 数据源、索引规模、上次同步、媒体缓存数、语义索引状态、日报定时与上次日报 |
| `sync` | 立即增量同步；`full: true` 全量重读 |
| `chats` | 列出会话（群名 / 条数 / 最后时间） |
| `media` | 把新消息里的图片/语音缓存到 `media/`（`kinds` 可只选 image / voice） |
| `voice` | 转写已缓存的语音（faster-whisper，`limit` 控制条数），结果写回正文可搜 |
| `impressions` | 批量生成人物印象（`users` / `minMsgs` / `limit` / `force`） |
| `export` | 生成单文件浏览页 `viewer.html`（`out` / `title`） |
| `semantic` | 建语义索引（bge-small-zh，`rebuild: true` 强制重建） |
| `report` | 生成群聊日报（`day`: today / yesterday / YYYY-MM-DD，`chat` 限定会话，`force` 重刷） |
| `dashboard` | 生成单文件看板 `dashboard.html`（日报 + @ 关系图 + 收藏夹 + 最近档案） |
| `reset` | 删库重建（含全量同步） |

### 群聊日报

`qq_archive action=report` 会给每个群和「全部会话」各写一份日报：今天聊了多少、谁最活跃、时段分布、高频词、值得回看的链接和长句采样，交给 DSH 的模型写成三段（今天聊了什么 / 值得一看 / 群友动态），落进 `reports` 表，同一天同一会话重复生成是覆盖。

默认每天 `00:30` 自动生成一次的「昨天」的日报（`report.schedule` 可改，留空就只手动）。跑过会记 `last_report_day`，当天不重复；插件停过几天再启动只补昨天，不追更早的。

```text
群聊日报 · 2026-11-07：生成 7 份，跳过 0 份。
模型：deepseek-account/deepseek-flash
```

### 本地看板

`qq_archive action=dashboard` 生成 `dashboard.html`（单文件、离线、双击即开），午夜墨风格：

- **今日总结**：每个群一张日报卡片，卡片底部可以直接写批注（存浏览器 localStorage）；
- **探案板**：一个群一块板子（卷宗标签切换，默认「全部卷宗」）。照片是群友，红线是互相 @；点照片看线索卡：发言数、@ 过谁、被谁 @、人物印象，还能一键跳去完整档案；
- **群友**：先选一个群，再看这个群里的人。上面的标签是会话（「全部群友」+ 每个群 / 私聊），选中后卡片只统计这个群里的发言；卡片上是头像、QQ、发言数、人物印象和标签，点开看完整档案——24 小时活跃分布、常说的话、在哪些会话、@ 关系、最近说过的话。可搜这个群里的昵称或 QQ；
- **收藏夹**：从消息流里收藏值得留的句子，一键导出 JSON / Markdown 存档；
- **最近档案**：最近消息流，悬停可收藏。

「全部群友」取发言最多的 60 人，每个群各取该群发言最多的 40 人；卡片上的印象来自 `qq_people impression=true` 或 `qq_archive action=impressions` 批量生成的结果，没生成过的会显示提示。

批注和收藏平时在 localStorage，点「导出存档」才会落成文件——那才是永久档。

### 浏览页

`qq_archive action=export` 会在插件家目录生成 `viewer.html`，双击就能看：

- 左侧会话列表，右侧消息流（默认最近 200 条，往上滚加载更早）；
- 搜索框回车过滤（消息正文 / 昵称 / 群名 / QQ 号）；
- 点会话只看该群，点昵称只看该人（并显示他的人物印象）；
- 已缓存的图片直接显示，点开看原图；没缓存的显示类型标签。

> QQ 的图片/语音链接带 rkey，会过期（实测约一周）。**只有同步之后新到的媒体能缓存**，历史媒体下不动，会标记失效、不反复重试。

### 熟人卡：喂给 QQ 对话

`qq_archive action=dashboard` 会顺手写一份 `people.json`（约 40KB）：每个会话发言最多的 24 人，配上名字、总条数、一句话人物印象、几个标签。

这份文件就是给 QQ 桥接（qq-bridge）读的。桥在每次唤醒时按当前会话取前 8 个人，拼成一段「本群的熟人」放进提示词——于是 QQ 那边的大肥鱼开口就认得这些人，不用每次重新认识。

- 桥那边的开关是 `config.json` 的 `socialV2.peopleCard`：`enabled`（默认 true）、`maxPeople`（默认 8）、`maxChars`（默认 1400）、`path`（默认 `~/.dsh/qq-archive/people.json`）；
- 印象为空的人不会进这张卡，所以想让人被认出来，先跑 `qq_archive action=impressions`；
- 改完 `people.json` 不用重启桥：桥按文件 mtime 缓存，下次唤醒自动重读。

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
    provider: ''          # 人物印象用的模型；空 = 自动挑第一个可用 provider
    model: ''
  impression:
    schedule: ''          # '02:30' 这样写 = 每晚到点批量生成；空 = 只手动
    minMsgs: 20
    limit: 30             # 一次最多生成几个人
    sample: 60            # 每个人取样多少条消息喂给模型
  report:
    schedule: '00:30'     # 每天这个点自动生成「昨天」的日报；留空 = 只手动
    maxChats: 12          # 一次最多生成几个会话（按消息量倒序）
  enhance:
    voice: false          # 语音转写（faster-whisper）
    image: false          # 图片描述/以文搜图（Qwen2.5-VL / CLIP）
    semantic: false       # 语义检索（bge-small-zh）
    impression: false     # 每晚批量生成人物印象（走 DSH 的 llm 服务）
```

核心功能零 npm 依赖，只用 Node 内置的 `node:sqlite`、`Intl.Segmenter`、`node:http`。增强层默认全关：

- **人物印象**：走 DSH 自己的 `llm` 服务，不额外装东西；
- **媒体缓存**：纯 Node，无依赖；
- **语义检索**：需要 Python + `sentence-transformers`（或直接 `transformers` + `torch`）+ bge-small-zh-v1.5，索引落在 `home/semantic/`（`ids.npy` + `vectors.npy`），检索时用同一个模型编码查询后做余弦；
- **语音转写**：需要 Python + `faster-whisper`，模型默认 `small`，CPU int8 也能跑。

国内下载模型建议设 `HF_ENDPOINT=https://hf-mirror.com`。

## 隐私

- 全程**只读**源消息库，不写、不改、不上传；
- 索引只落在本机 `home` 目录；
- 仓库不含任何 Token / 账号 / 聊天记录，`data/`、`*.db` 已在 `.gitignore` 里；
- 嵌入/检索默认走本地模型。

## 开发

```bash
npm test        # node:test，覆盖分词、单字索引、入库、搜索、上下文
```

目录：

```text
index.js                 工具注册（qq_find / qq_people / qq_archive）
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
lib/export.mjs           单文件浏览页生成
lib/report.mjs           群聊日报：统计 + 采样 + 落库
lib/graph.mjs            @ 互动关系图（节点 / 边）
lib/dashboard.mjs        艺术化本地看板：日报 + 关系图 + 收藏夹 + 消息流
scripts/embed.py         bge-small-zh 编码 / 查询
scripts/transcribe.py    faster-whisper 转写
docs/design.md           设计文档
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
- [x] 本地看板（午夜墨：日报 + @ 关系图 + 收藏夹 + 消息流）
- [ ] JSON / JSONL 导入（离线备份）
- [ ] 图片描述 / 以文搜图（需要多模态/CLIP 模型）

MIT
