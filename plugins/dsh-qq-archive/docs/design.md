# dsh-qq-archive 设计

> 状态：待你点头。点头后按「实施顺序」开工。

## 一句话

把 QQ 群聊变成**可检索的记忆**和**可查询的人物档案**：搜得回几个月前的一句话、一张图、一条语音；说得出群里每个人是什么样的人。

## 为什么要做

- 群聊是信息密度最高、遗忘最快的地方。QQ 自带搜索只按关键词，找不回「上次谁说那个链接」。
- AI 在群里没有长期记忆，每次都是第一次见人。
- 同类开源项目（QQ 桥 / 机器人）只做收发，不做归档；这件事网上几乎没有现成的。

## 边界

做：
- 只读已有消息（SnowLuma SQLite / 标准 OneBot v11 / JSON 导入）
- 本地索引 + 本地 ML（可选）
- 工具 + 单文件 HTML 浏览页

不做：
- 不发消息、不改桥、不碰 QQ 协议
- 不上传任何数据、不内置任何本机凭证
- 不替代 QQ 客户端

## 独立性（开源的前提）

- **数据适配层隔离**：`adapters/snowluma.mjs`、`adapters/onebot.mjs`、`adapters/json.mjs`，每个只做「读原始数据 → 规范化事件」，核心不认任何一家实现。
- **核心零 npm 依赖**：Node 内置 `node:sqlite`（SQLite 3.51 + FTS5）、`Intl.Segmenter` 分词、`node:http`。`npm i` 之后直接可用。
- **ML 全可选**：模型下载到插件家目录，Python 依赖按需装，默认关。
- **数据源自动探测**：不写死本机路径；扫常见位置（`%APPDATA%`、`%LOCALAPPDATA%` 等）找 `messages.db`，找到就用。本机命中，开源用户零配置。

## 数据流

```
SnowLuma messages.db（只读）──┐
OneBot v11（HTTP 历史 + WS）──┼──► adapter 规范化 ──► ingest ──► archive.db（SQLite）
JSON / JSONL 导入 ───────────┘                                    │
                                                                  ├─ messages
                                                                  ├─ messages_fts（FTS5）
                                                                  ├─ members / chats
                                                                  ├─ media（元数据 + 本地缩略图）
                                                                  ├─ embeddings（可选）
                                                                  └─ profiles（统计 + 印象）
```

同步：启动后 5 秒首次增量，之后默认每 10 分钟一次；`message_hash` 幂等去重；单批 1000 条事务。

## Schema（archive.db）

- `messages(id INTEGER PK, source TEXT, source_key TEXT UNIQUE, chat_key TEXT, chat_type TEXT, chat_id TEXT, sender_id TEXT, sender_name TEXT, ts INTEGER, kind TEXT, text TEXT, reply_to TEXT, media_id INTEGER, raw TEXT, meta TEXT)`
- `messages_fts`：FTS5(unicode61, 预分词)，rowid = messages.id；`text` 写入前用 `Intl.Segmenter('zh-CN', {granularity:'word'})` 切词、空格连接。2 字词（打牌）实测可召回。
- `members(chat_key, user_id, names TEXT[JSON 历史昵称/群名片], first_seen, last_seen, msg_count, PRIMARY KEY(chat_key,user_id))`
- `chats(chat_key PK, type, id, name, meta)`
- `media(id PK, source_key UNIQUE, kind, file_name, url, size, width, height, local_path, thumb_path, status, extra)`
- `profiles(chat_key, user_id, stats TEXT[JSON], impression TEXT, impression_at INTEGER, PRIMARY KEY(chat_key,user_id))`
- `meta(key, value)`：last_sync_ts、schema_version、adapter、counts

## 工具（3 个）

### `qq_find` — 搜群聊
参数：`query`（关键词；开语义检索后可整句）、`chat`（群号/群名，可选）、`sender`（QQ 号/昵称，可选）、`from`/`to`（ISO 或 `7d`/`2026-10`）、`kind`（text/image/voice/video/file/link/all）、`limit`、`offset`、`mode`（exact/auto/semantic）。
返回：`hits[] { ts, chat, sender, text, kind, messageId, media?, context? }` + `total` + `summary`（人话摘要）。
命中带上下文（前后各 2 条），模型不用二次查询就能讲清楚。

### `qq_people` — 人物档案
参数：`who`（QQ 号/昵称/群名片；空=全体）、`chat`（可选）、`action`（profile/rank/list）、`refresh`（强制重算）。
返回：发言量、活跃时段、口头禅、常聊话题、发过的图/语音数、互动最多的几个人、最近时间线、一句印象（见增强层）。

### `qq_archive` — 管理
参数：`action`（sync/status/rebuild/export/serve）。
`status` 给：条数、时间跨度、群列表、索引大小、增强层进度；`sync` 手动增量；`serve` 起本地浏览服务。

## 增强层（默认关，config 开；本机全开）

1. **语音转写**：faster-whisper large-v3-turbo（CUDA，3070 够），509 条几分钟跑完；结果写回 `messages.text`，语音就能搜。
2. **图片描述**：缩略图落盘（512px JPEG，约 270MB）；Qwen2.5-VL-3B 批量生成一句中文描述，写回 `text`，实现「以文搜图」——比 CLIP 更适合中文，也更省心。
3. **语义检索**：bge-small-zh-v1.5 给每条消息 embedding（384 维 float32，4 万条约 61MB）；查询时全量点积，<20ms，不需要向量库。
4. **人物印象**：每晚（或手动）对活跃成员采样最近 200 条有代表性的消息，走 `ctx.llm.stream()`（配置指定 provider/model，缺省自动选第一个可用），生成一句白话；失败降级为统计模板。

所有任务后台队列、可中断、单条标记状态，重启续跑。

## HTML 浏览页

`~/.dsh/qq-archive/index.html`（单文件，双击可用）：
- 消息流：按群/人/时间/类型筛选，全文搜索框直接调 FTS（浏览器端做不太行——所以页面加载时把索引数据以 `data/*.js` 形式内嵌/引入，本地搜索）
- 人物卡：点人名看档案
- 点图片看原图（缩略图本地，原图按需下载）
- 搜索高亮、日期跳转

数据以 `data/messages.js`、`data/people.js` 形式生成（`<script src>` 加载，绕开 file:// 的 fetch 限制），超过阈值自动分片。

## 配置（cordis.patch.yml）

```yaml
- insert:
    - id: qq-archive
      name: dsh-qq-archive
      config:
        source: auto            # auto | snowluma | onebot | json
        home: ""                # 空 = ~/.dsh/qq-archive
        syncIntervalMin: 10
        enhance:
          voice: false
          image: false
          semantic: false
          impression: false
```

本机开全：`voice/image/semantic/impression: true`。

## 开源

- MIT；README（安装、配置、隐私说明）；`cordis.patch.yml` 不含任何本机路径；`.gitignore` 掉数据/模型/缓存。
- 隐私写清楚：数据只在本地，不上传；删掉 `~/.dsh/qq-archive/` 即彻底清除。

## 实施顺序

- **M1 索引内核**：adapter(snowluma) + schema + 同步 + FTS + `qq_find` → 能搜回真实历史（验收：搜「打牌」出结果、增量幂等）
- **M2 人物档案**：统计聚合 + `qq_people`（profile/list/rank）
- **M3 HTML 浏览页**：消息流 + 搜索 + 人物卡
- **M4 增强层**：语音转写 → 图片描述 + 缩略图 → 语义检索（每项独立可关）
- **M5 印象 + 打磨 + 开源**：LLM 印象、onebot/json adapter、README、测试

每完成一个里程碑给你看一次实际效果，不憋到最后。

## 风险与对策

- `node:sqlite` 是实验性 API → 启动探测，失败时降级为「JSON 便携索引 + LIKE 搜索」（功能少但能跑）。
- 图片 URL 带 rkey 会过期 → 增强层开启时立即落盘缩略图；未开启时页面显示占位。
- 中文分词对词典外词（链接→链/接）会切碎 → 兜底：查询串同时做 FTS 与 LIKE 合并。
- 群聊隐私 → 本地存储、gitignore、README 明示。
