# 档案馆扩展设计（2026-11-11）

本文是这一批 11 个功能的设计记录：数据从哪来、落在哪个模块、看板怎么放、工具怎么调。
所有模块都是纯 ESM、零 npm 依赖、只读数据库；写入只发生在 `qq_archive` 的显式动作里。

## 总原则

- 每个功能先有独立的 lib 模块（纯函数 + 明确的返回结构），再由 `index.js` 暴露成工具、由
  `dashboard.mjs` 放进看板、由 `web.mjs` 暴露需要的实时查询接口。不把查询逻辑塞进模板字符串。
- 看板仍然以「一屏能翻完」为准：稳定、可静态烘焙的数据直接内联进 `dashboard.html`；
  只有「用户输入什么就查什么」的部分（群梗搜索、关系图时间切片、某天明细）走
  `/qq-archive/api/*`，离线打开时给出提示。
- 新增数据要进看板快照的，必须 bump `snapshot.mjs` 的 `CACHE_VERSION`，并让
  `dbFingerprint` 覆盖它，否则页面不会重建。
- 周报/月报从 2026-11-06 起算，更早不补（用户 2026-11-11 确认）。

## 功能与落点

| 功能 | 模块 | 工具 | 看板 |
| --- | --- | --- | --- |
| 自然语言问答 | `lib/ask.mjs` | `qq_ask` | — |
| 链接/资源库 | `lib/links.mjs` | `qq_links` | 「资源库」标签 |
| 搜索结果导出 | `lib/findexport.mjs` | `qq_find` 的 `export` 参数 | — |
| 活跃日历 | `lib/calendar.mjs` | —（看板 + `/api/day`） | 「日历」标签 |
| 群梗/话题考古 | `lib/topics.mjs` | `qq_topic` | 「群梗」标签 + `/api/topic` |
| 名场面回顾 | `lib/highlights.mjs` | `qq_highlights` | 「名场面」标签 |
| 人物卡导出 | 复用 `lib/card.mjs` | `qq_people` 的 `format` 参数 | 档案弹窗「保存卡片」 |
| 活跃榜/失踪人口 | `lib/leaderboard.mjs` | —（看板） | 「榜单」标签 |
| 关系图时间切片 | `lib/graphrange.mjs` + `graph.mjs` | —（看板 + `/api/graph`） | 「人事图」范围按钮 |
| 日报主动送达 | `lib/push.mjs` | `qq_archive action=push` | — |
| 周报/月报 | `lib/period.mjs` | `qq_report` | 「群总结」里的周期视图 |

## 数据表新增（`lib/db.mjs` SCHEMA）

```sql
create table highlights(
  id integer primary key autoincrement,
  chat_key text not null, from_ts integer not null, to_ts integer not null,
  msg_count integer not null default 0, stats text, summary text, model text,
  created_at integer not null default 0,
  unique(chat_key, from_ts, to_ts)
);
create table period_reports(
  kind text not null,            -- 'week' | 'month'
  from_date text not null, to_date text not null,
  chat_key text not null, text text, stats text, model text,
  created_at integer not null default 0,
  primary key(kind, from_date, chat_key)
);
```

## 模块契约

### lib/links.mjs

```js
extractUrls(text) -> string[]
buildLinkIndex(db, { chatKey=null, fromTs=0, toTs=0, limit=4000 }) -> {
  total, domains: [{domain, count, lastTs}],
  links: [{id, url, domain, title, chatKey, chatName, senderId, senderName, ts, kind}],
  byChat: [{chatKey, chatName, count}]
}
filterLinks(index, { q='', domain='', chatKey='', limit=200 }) -> links[]
linksMarkdown(index, { title, limit }) -> string
```

链接来源：`text like '%http%'`；`kind='card'` 的消息额外尝试从 `raw` JSON 里抽 `jumpUrl` /
`meta.detail_1.title` 等（拿不到就留空）。同一消息同一 URL 只记一次。

### lib/calendar.mjs

```js
buildCalendar(db, { months=3, chatKey=null, now=new Date() }) -> {
  fromDate, toDate, maxDay, totals: { messages, activeDays, avgPerDay },
  days: [{ date, total, speakers, media, links, chats: [[chatKey, count], ...] }]
}
dayBreakdown(db, { date, chatKey=null }) -> {
  date, total, speakers, media, links, hourly: number[24],
  chats: [{ chatKey, name, count }], topSenders: [{ userId, name, count }]
}
```

按本地时区分日；`days` 从旧到新连续（没有消息的日子 total=0，保持格子完整）。

### lib/leaderboard.mjs

```js
weekBounds(ref=new Date(), offset=0) -> { fromTs, toTs, fromDate, toDate }
buildLeaderboard(db, { chatKey=null, now=new Date(), top=30 }) -> {
  week: { fromDate, toDate }, prev: { fromDate, toDate },
  totals: { cur, prev, delta },
  people: [{ userId, name, cur, prev, delta, status: 'up'|'down'|'flat'|'new'|'gone',
             chats: [{ chatKey, name, count }] }],
  chats: [{ chatKey, name, cur, prev, delta }],
  missing: [{ userId, name, prev, lastTs }]
}
```

周从周一 00:00 本地时间起算；`missing` = 上周有发言、本周 0 条的人，按上周条数降序。

### lib/topics.mjs

```js
investigateTopic(archive, { word, chatKey=null, fromTs=0, toTs=0, limit=80 }) -> {
  word, total, byMonth: [{ month, count }], byChat: [{ chatKey, name, count }],
  topUsers: [{ userId, name, count }],
  first: { id, ts, chatKey, chatName, senderId, senderName, text } | null,
  last: 同上, samples: [{ id, ts, chatKey, chatName, senderId, senderName, text }]
}
topWords(db, { chatKey=null, fromTs=0, toTs=0, limit=24 }) -> [{ word, count }]
```

统计用 `text like '%word%'`（转义 `% _ \`）；`samples` 按时间均匀取。`topWords` 复用
`segment.mjs` 的 `tokenize`，过滤 `STOP_WORDS` 与单字/纯数字。

### lib/highlights.mjs

```js
findBursts(db, { chatKey=null, fromTs=0, toTs=0, windowSec=600, minMessages=40,
                 gapSec=600, limit=12 }) -> [{
  chatKey, chatName, fromTs, toTs, count,
  participants: [{ userId, name, count }], topWords: [{ word, count }],
  samples: [{ ts, senderName, text }]
}]
generateHighlightSummary({ db, llm, route, burst }) -> { summary, model }
runHighlights({ db, llm, cfg, fromTs?, toTs?, limit=12, force=false, signal, onProgress })
  -> { found, built, skipped, results: [{ chatKey, fromTs, fromDate, summary, ok, error? }] }
listHighlights(db, { limit=20, chatKey=null }) -> [{ id, chatKey, chatName, fromTs, toTs,
  msgCount, summary, model, createdAt, stats }]
readHighlight(db, id) -> 同 list 的单条（stats 已 JSON.parse）
```

爆聊窗口：把消息按时间排序后，`windowSec` 内 >= `minMessages` 的滑动窗口；遇到 `gapSec`
以上空档就切段；相邻重叠窗口合并成一段，取段内消息最多的窗口作为锚点。已写过的
`(chat_key, from_ts, to_ts)` 默认跳过，`force=true` 重写。

### lib/period.mjs

```js
periodBounds(kind='week'|'month', ref=new Date(), offset=0) -> {
  kind, fromTs, toTs, fromDate, toDate, label
}
buildPeriod(db, { chatKey=null, kind, ref, offset }) -> 复用 report.buildReport 的结构
  + { fromDate, toDate, topDays: [{ date, count }] }
runPeriodReport({ db, llm, cfg, kind, chatKey=null, ref, offset=0, force=false, signal, onProgress })
  -> { saved, skipped, text, model, kind, fromDate, toDate }
listPeriodReports(db, { kind, limit=12 }) -> [...]
readPeriodReport(db, { kind, fromDate, chatKey }) -> {...} | null
```

只允许 `fromDate >= '2026-11-06'`；早于该日期的周期要么拒绝，要么只覆盖交集（`fromDate`
裁剪到 11-06）。提示词要求 Markdown，分「这段时间聊了什么 / 值得回看的 / 人物与关系 /
下周期待」，400-600 字。

### lib/push.mjs

```js
readBridgeConfig(cfg) -> { baseUrl, token, target }   // 优先 cfg.push.*；token 空则读 tokenFile
sendPrivate({ baseUrl, token, userId, message, fetchImpl=fetch }) -> { ok, status, data }
pushReport(cfg, { date, chatKey, chatName, text }) -> { ok, target, parts, error? }
effectivePushSettings(db, cfg) -> { enabled, target, baseUrl, tokenReady }  // meta 覆盖 config
setPushSettings(db, { enabled, target }) -> 写 meta
```

桥接接口：`POST {baseUrl}/api/send/private`，JSON `{ userId, message }`，头
`x-console-token`。单条不超过 ~1800 字，超了按段落切多条（最多 3 条）。

### lib/ask.mjs

```js
askArchive({ archive, db, llm, cfg, question, chatKey=null, fromTs=0, toTs=0,
             k=60, signal, onProgress }) -> {
  question, mode: 'semantic+keyword' | 'keyword',
  answer, citations: [{ n, id, ts, chatKey, chatName, senderName, text }],
  used: [{ id, score, source: 'semantic'|'keyword' }]
}
```

检索：语义索引（`semanticReady`）top-k + 关键词 top-20，按 id 去重合并；每条截断 200 字，
编号后交给模型；系统提示要求「只依据材料回答、每条结论后标 [n]、找不到就说找不到、不编造」。
测试用注入的假 `llm`（`streamText` 兼容形状）或 `_generate` 回调，不联网。

### lib/graphrange.mjs

```js
graphRangeBounds(range, now=new Date()) -> { range, fromTs, toTs, label }
// range: 'all' | 'week' | 'lastweek' | 'month'
```

`graph.mjs` 已有 `buildGraph(db,{chatKey,sinceTs,maxNodes})`，切片只换算时间窗。

### lib/findexport.mjs

```js
renderFindMarkdown(result, { title }) -> string
renderFindHtml(result, { title }) -> string   // 单文件、午夜墨风格、可直接双击
exportFind({ home, result, format='md', outPath }) -> { path, bytes }
```

`result` 是 `qq_find` 返回的对象（`summary/hits/coverage/mode`），导出里保留命中统计、筛选条件、
每条消息的时间/群/发送者/正文与上下文。

## 看板结构

标签从 5 个扩到 10 个：群总结 / 日历 / 资源库 / 群梗 / 名场面 / 榜单 / 人事图 / 群友 / 收藏夹 / 本月档案。
「群总结」加「日报 / 周报 / 月报」切换；「人事图」加「全部 / 本周 / 上周 / 本月」范围按钮（在线时走
`/api/graph`，离线保留全部范围的内联数据）；「群友」弹窗加「保存档案卡」按钮（`/card` 接口）。

内联数据（`buildBoardData` 新增字段）：

```js
calendar, leaderboard, links, highlights, periods, topicSeeds
```

实时接口（`web.mjs`，全部 GET + JSON，只读）：

```
/api/topic?word=&chat=&from=&to=
/api/graph?chat=&range=all|week|lastweek|month
/api/day?date=YYYY-MM-DD&chat=
/api/links?q=&domain=&chat=&limit=
```

## 工具

- `qq_ask`：`question` 必填，`chat`、`from`、`to`、`limit`。
- `qq_links`：`action=list|export`，`q`、`domain`、`chat`、`from`、`to`、`limit`、`out`。
- `qq_topic`：`word` 必填（或 `top=true` 只看高频词）、`chat`、`from`、`to`、`limit`。
- `qq_highlights`：`action=list|build|show`，`chat`、`from`、`to`、`limit`、`force`、`id`。
- `qq_report`：`action=week|month|list|show`，`chat`、`ref`、`offset`、`force`。
- `qq_people` 新增 `format=text|html|png` 与 `out`。
- `qq_find` 新增 `export=md|html` 与 `out`。
- `qq_archive` 新增 `action=push`：不带参数读开关，`enabled=true|false` 与 `target` 写开关；
  `action=report` / 定时日报生成后，开关开着就私聊推送。
- `qq_archive action=dashboard` 的 summary 与返回值补上新数据量（links/highlights/periods）。

## 测试

每个新模块一份 `tests/<module>.test.mjs`，用 `mkdtemp + openArchive + normalizeOneBot + insertBatch`
造 5~20 条固定消息，断言纯函数输出；涉及模型的用注入假 llm；涉及网络的用假 `fetchImpl`。
`npm test` 必须全绿。
