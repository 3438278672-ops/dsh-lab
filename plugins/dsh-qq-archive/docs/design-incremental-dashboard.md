# 看板增量重建（B+D）

状态：**已实施并验证**（2026-11-07；实现记录见 §14）
背景：灵感账本 #15。看板超过 5 分钟就整块重建，数据量大时打开要等；用户要求按机制改，不做补丁。

## 1. 目标

1. 数据没变时，打开看板**不构建**（只做一次廉价校验）。
2. 数据变了时，只重建**真正变了的部分**（群 → 群内的人 → 跨群人），其余复用。
3. 写库（同步 / 日报 / 人物印象）之后主动增量刷新，让打开时通常已经没有待构建内容。
4. 顺带把「@ 关系」从「每人一条全表 LIKE」改成一遍扫描的索引，并把显示名改成最新昵称。

## 2. 现状与成本（实测：33,574 消息 / 12 会话 / 258 人）

| 环节 | 耗时 |
|---|---|
| 一次全量 `buildDashboardData` | 9.2 s |
| └ 人物档案（每群前 40 + 全局前 60，共 ~540 份） | 8.6 s |
| └ @ 关系图（1 张总图 + 12 张群图） | 0.2 s |
| └ 日报 / 消息流 / 今日昨日计数 | < 0.05 s |
| 单个档案里「被谁 @」的全表 LIKE | 13.7–16.8 ms |
| `count(*),max(id),max(ts)` 全局 | 1.7 ms |
| 按群分组同样三项 | 3.3 ms |
| 单群按发送者分组 | 11.6 ms |
| `members` 全表（258 行） | 0.6 ms |

两个结构性问题：
- 触发只看**时间**（`web.mjs` 的 `STALE_MS=5min` + 进程内 `lastBuild`），与数据是否变化无关；重启后 `lastBuild=0` 必全量。
- 构建粒度只有「全部」：任何一个群多一条消息，540 份档案全部重算，同一个人在全群档与群档里各算一遍。

## 3. 总览

```
打开页面 ──→ board.check(db) ── 3ms 全局指纹 ──→ 一致？──是──→ 直接发 dashboard.html
                                   │
                                   否
                                   └→ board.ensureFresh(db)  （单飞，后台）
                                         │
同步/日报/印象写库 ────────────────→ board.ensureFresh(db)（1.5s 防抖）
                                         │
                                         ▼
                                  buildIncremental()
                                   ├ 群指纹比对 → 脏群集合
                                   ├ 脏群：人指纹比对 → 只算变了的人
                                   ├ 全局：跨群合计指纹 → 只算变了的人
                                   ├ @ 索引（一遍扫，38ms）+ 名字表
                                   └ 装配 → render → 原子写 HTML → 原子写快照
```

## 4. 快照缓存

文件：`<home>/dashboard.cache.json`（与 `dashboard.html` 同目录，可随时删除，删了自动全量重建）。

```jsonc
{
  "version": 1,
  "builtAt": 1762530000000,
  "fp": "<全局指纹>",              // 与 dashboard.html 对应的数据版本
  "html": { "bytes": 1007787, "mtimeMs": 1762530000000 },
  "chats": {
    "group:562437955": {
      "sig": "<群指纹>",
      "graph": { … buildGraph 输出 … },
      "people": [ { "id": "111", "sig": "<人指纹>", "p": { …buildProfile 去掉 summary/mentions… } } ],
      "users":  { "111": [1234, 1762529999, 12] }   // 该用户在本群的 [消息数, 最后时间, 媒体数]
    }
  },
  "global": {
    "people": [ { "id": "111", "sig": "<跨群人指纹>", "p": { … } } ]
  }
}
```

不变量（写入时必须同时成立，否则视为无效快照）：
1. `version` 与代码一致；JSON 可解析；结构完整。
2. `cache.html.bytes / mtimeMs` 与 `dashboard.html` 的实际 `stat` 一致——**先写 HTML，再写快照**；两步之间崩溃只会导致下次多构建一次，不会出现「快照新、页面旧」。
3. 快照里的每个群 / 人都在当前库里存在（多余的条目读取时丢弃）。

写入一律 `写 .tmp → rename`；`dashboard.html` 同样处理（现在直接 `writeFileSync`，中途失败会留半截文件）。

例外（实测踩到）：Windows 上目标文件可能被别的进程打开且不允许删除/改名（本机就是宿主自己预览过 `dashboard.html`）。此时 rename 无论如何重试都是 `EPERM`，发布退化为**原地覆盖**（句柄允许写），内容照样换新，只是少了原子替换这一层；两种路径都会清掉 `.tmp`，不会留下半成品。`writeFileAtomic` 返回 `'rename' | 'inplace'`，调用方据此在日志里说明。

## 5. 指纹

**全局（请求路径，~3 ms）**
```sql
select count(*), max(id), max(ts) from messages            -- 1.7ms
select count(*), max(id) from media                        -- ~0.5ms
select count(*), max(created_at), sum(length(impression)) from profiles
select count(*), max(created_at) from reports
select count(*), sum(msg_count), max(last_ts) from chats
select chat_key, name from chats                           -- 名字哈希
```
拼成一个字符串存进快照的 `fp`。消息只插不改、`source_key` 唯一，因此这六项足以覆盖消息/媒体/日报/印象/群名/群册的所有变化。

**群**：`(count, max(id), max(ts))` + 群名，按 `group by chat_key` 一次取全（3.3 ms）。

**人（群内）**：`select sender_id, count(*), max(ts) from messages where chat_key=? group by sender_id`（11.6 ms）+ 同群 media 分组（~4 ms），合成 `[c, ts, media]`。

**人（跨群）**：由各群的 `users` 表按人求和 / 取最大——干净群的 `users` 直接从快照读，脏群现算，所以不需要额外的 61 ms 全表分组。

**名字版本**：`chats` 的 `(key,name)` 哈希 + `members.names` 最新名的哈希，进每个档案和每张图的签名（改名只在有新消息时发生，实际几乎不触发额外构建）。

## 6. 增量构建算法

```js
buildIncremental(db, { home, snapshot, force }) {
  ctx   = collectContext(db)        // 今日/昨日计数、群卡片、日报卡、消息流（全部便宜，每次现算）
  chats = chatFingerprints(db)      // 3.3ms
  dirty = chats.filter(k => !snapshot?.chats[k] || snapshot.chats[k].sig !== sigOf(chats[k]))

  for (const key of allChats) {
    if (!dirty.has(key) && snapshot) { reuseGraph; reusePeople;  }
    else {
      users = userFingerprints(db, key)          // 11.6ms + media 4ms
      if (graphSigChanged) graph = buildGraph(db, { chatKey: key, maxNodes: 45 })
      people = topByCount(users, 40).map(u => {
        const cached = snapshot?.chats[key]?.people.find(p => p.id === u.id)
        return cached && cached.sig === u.sig
          ? cached.p
          : strip(buildProfile(db, names, { userId: u.id, chatKey: key, topLimit: 500, mentions }))
      })
    }
  }

  // 全局：成员表取前 60，指纹用各群 users 合计
  globalPeople = topByMembers(60).map(u => {
    const sig = aggregate(u.id)                  // Σc, max ts, Σmedia
    const cached = snapshot?.global.people.find(p => p.id === u.id)
    return cached && cached.sig === sig ? cached.p
         : strip(buildProfile(db, names, { userId: u.id, topLimit: 500, mentions }))
  })

  data = { generatedAt, …ctx, graph, graphs, profiles, peopleByChat }
  return { data, snapshot: next, stats: { ms, reusedChats, rebuiltChats, reusedProfiles, rebuiltProfiles } }
}
```

`mentions` 是本次构建的 @ 索引（见 §7），档案只缓存「统计部分」，`mentionsOut / mentionedBy` 每次从索引现贴——别人新 @ 了你，不需要重算你的档案。

`buildDashboardData(db, opts)` 保留为「无快照 = 全量」的现有入口（测试与外部调用不受影响）；`exportDashboard(db, { snapshot })` 走增量并返回 `stats`。

## 7. @ 关系改成索引

现状：每份档案两条 SQL——「@ 了谁」取自己最近 3000 条正则统计；「被谁 @」`where text like '%@uid%'` 全表扫（15 ms/人）。

改为：构建开始时**一遍扫**（`select chat_key, sender_id, text from messages where text like '%@%'`，4525 行 → 37.8 ms），用 `/@(\d{5,12})(?!\d)/` 抽目标（同条重复只计一次、排除自我 @），同时产出全局与每个群的「谁 @ 谁」计数表；`mentionsOut / mentionedBy` 取前 8。

- 计数等价性已在真实库上验证：243 个 (人, 群/全局) 组合**全部一致，0 处不匹配**。
- 显示名改为 `members.names` 的最新名（回退到该人最后一条消息的 `sender_name`），不再取分组里任意一条旧名。实测 130/243 的组合当前显示的是旧名（如 619692732 显示「小主人」，最新是「小肥鱼」）。
- 「被谁 @」原有的过滤（`/加入|邀请|撤回|禁言|红包/` 丢弃系统味名字）保留，但作用对象变成最新名。已知误伤：群名片里恰好含这些词的真实成员会被漏掉（库里 2 人，其一 `Ami（速速加入…）`）——这是数据质量问题（名片被写成了入群通知文本），**不在本次范围**，登记为后续。
- `buildProfile` 增加可选参数 `opts.mentions`；不传时仍走原 SQL（`qq_people` 单人查询不受影响，但同样改用最新名解析）。

## 8. 触发与单飞

| 触发点 | 行为 |
|---|---|
| `GET /qq-archive/` | `board.check(db)`（3 ms）一致 → 直接发文件；不一致 → 后台 `ensureFresh`，仍发旧文件；文件不存在 → 等待页（维持现状） |
| 同步插入消息后 | `board.prewarm(db)`，1.5 s 防抖，合并连续写入 |
| 写日报 / 人物印象后 | 同上 |
| 插件启动（首轮同步后） | 同上 |
| `qq_archive action=dashboard` | `force: true`，构建完再返回（并带 `stats`） |

`ensureFresh` 进程内单飞：同一时刻只有一次构建，后来的复用同一个 Promise。`STALE_MS`、`lastBuild` 全部删除——新鲜度只由指纹决定。

## 9. 模块职责

| 文件 | 变更 |
|---|---|
| `lib/snapshot.mjs` | 新增：`CACHE_VERSION`、`dbFingerprint`、`chatFingerprints`、`userFingerprints`、`namesVersion`、`loadSnapshot`、`saveSnapshot`（原子写 + HTML stat 校验） |
| `lib/mentions.mjs` | 新增：`buildMentionIndex(db, {chatKey})`、`mentionsFor(index, userId)`、`resolveNames(db)` |
| `lib/people.mjs` | `mentionedBy` 走索引时使用最新名；`buildProfile` 接受 `opts.mentions` |
| `lib/dashboard.mjs` | 拆出 `collectContext`；新增 `buildIncremental`；`exportDashboard` 接受 `snapshot/force`，返回 `stats` 与 `snapshot` |
| `lib/board.mjs` | 新增：快照读写、内存态、`check/ensureFresh/prewarm/build`、单飞与防抖 |
| `lib/web.mjs` | 删除 `STALE_MS/lastBuild/building`，改用 `board` |
| `index.js` | 创建 board 并传给 web；同步/日报/印象后预热；`action=dashboard` 走 board |

## 10. 错误处理

- 快照损坏 / 版本不符 / HTML 缺失或大小不符 → 视为无快照，全量重建，不报错。
- 构建抛错 → 保留旧 HTML 与旧快照，记日志，`ensureFresh` 回到未运行态（下次请求重试）。
- 构建期间进程退出 → 旧 HTML 完好（tmp + rename），快照未更新，下次重建。
- 任何构建耗时超过预期都只是慢，不影响正确性：页面永远发「上一次成功构建」的文件。

## 11. 测试（`tests/incremental.test.mjs`）

1. 无变化二次构建：`rebuiltChats=0`、`rebuiltProfiles=0`，数据与首次深比较一致（忽略 `generatedAt`）。
2. 某群插入一条消息：只该群重建；数据与「全量重建」深比较一致。
3. 只 @ 不发言：被 @ 者的 `mentionedBy` 更新，但其档案未被重算（计数断言）。
4. 快照损坏 / 版本不符 / HTML 被删 → 自动全量重建且结果正确。
5. 各表（messages/media/reports/profiles/chats）任一变化都改变全局指纹。
6. @ 索引与旧 SQL 在夹具上计数一致；显示名取最新名。
7. 原子写：构建中途抛错时旧 HTML 与新快照都不被破坏。
8. 现有 `npm test` 全绿。

## 12. 实测（真实库：33,574 消息 / 12 会话 / 258 人）

| 场景 | 改造前 | 改造后 |
|---|---|---|
| 打开页面（无变化） | 0 构建，但 5 分钟后下一次必全量 | 全局指纹约定 3 ms，0 构建（`board.build` 跳过 1–3 ms） |
| 一个群多了一条消息 | 全量 9.2 s | 240–257 ms（重算 1 群 2 人，复用 11 群 241 人） |
| 首次（无缓存） | 9.2 s | 2.0–2.6 s（@ 索引一遍扫替代每人一次全表 LIKE 是大头） |
| HTML 被删、快照还在 | 全量 9.2 s | 55–72 ms（0 人重算，纯渲染+写盘） |
| 插件重启后第一次打开 | 进程内 `lastBuild=0`，必然全量 | 指纹一致即命中快照，0 构建 |

产物：`dashboard.html` 1,009,480 字节（与改造前同一量级；人物档里多了 @ 最新名），`dashboard.cache.json` 约 649 KB。

## 13. 明确不做

- 不改 `dashboard.html` 的结构与视觉，不改 `people.json` 熟人卡。
- 不做服务端分页/流式渲染（单文件 HTML 是刻意设计）。
- 不引入新依赖（继续 `node:sqlite`）。
- 不修「群名片被写成入群通知」的入库数据质量问题（另开）。
- 不改 `action=export` 的浏览页。

## 14. 实施记录（2026-11-07）

**模块**（与 §9 的规划基本一致；类名以实际代码为准）

| 文件 | 实际落地 |
|---|---|
| `lib/snapshot.mjs` | 新增。`dbFingerprint`（六项统计 + 群名 sha1）、`chatFingerprints`、`userFingerprints`、`userSig`、`aggregateUsers`、`serializeUsers/restoreUsers`、`loadSnapshot/saveSnapshot`、`htmlStat`、`writeFileAtomic`（`'rename'｜'inplace'`） |
| `lib/mentions.mjs` | 新增。`resolveNames`、`buildMentionIndex`（扫描 `text like '%@%'`，`/@(\d{5,12})(?!\d)/`，同条去重、排除自我，同时产出 `'*'` 与各群两个 scope）、`mentionsFor` |
| `lib/dashboard.mjs` | `buildBoardData`（增量，返回 `{data, snapshot, stats}`）、`stripProfile`、`decorate`；`buildDashboardData` 保留为无快照全量的兼容入口；`exportDashboard` 接受 `snapshot`，返回 `stats` 与 `snapshot` |
| `lib/board.mjs` | 新增。`createBoard({home, getDb, log})` → `isFresh/build/ensureFresh/prewarm/invalidate/status`，单飞 + 1.5 s 防抖 |
| `lib/web.mjs` | 删除 `STALE_MS/lastBuild/building`；`/` 改为「文件在 → 发文件 + 后台 `ensureFresh`；不在 → 等待页 + 触发构建」 |
| `index.js` | `board` 注入 web；同步 / 日报（`done>0`）/ 印象后 `prewarm()`；启动首轮同步后预热；`action=dashboard` 走 `board.build({force:true})` 并输出本次增量统计；`action=reset` 后 `invalidate()` |
| `lib/people.mjs` | `buildProfile(..., {mentions})` 接受外部 @ 结果；`mentionedBy` 的 SQL 补 tie-breaker，显示名走最新名 |

**测试**：`tests/incremental.test.mjs` 9 条全过（快照复用 / 单群重建 / @ 只更新计数 / @ 计数等价 / 五种表变化都改指纹 / board 冷启动与自愈 / 坏快照自愈 / 导出不污染缓存 / 发布在占用下仍换新内容且不留 .tmp）；全量 10 个测试文件 38 条全绿。`node --test` 在本机沙箱里会因为 spawn 子进程报 `EPERM`，逐个 `node tests/xxx.test.mjs` 跑。

**与规划的偏差**
1. 快照里没有单独的 `namesVersion`：群名哈希已经进全局指纹，`members.names` 最新名不再进指纹——改名只会在该群有新消息时顺带刷新，这是刻意取舍（改名极少见，不值得为它让全局指纹对每次新昵称都变）。
2. 「@ 显示名取最新名」用 `messages` 里 `max(id)` 那条的 `sender_name`（4.7 ms / 233 行），没有用 `members.names`：实测两者 230/233 一致，消息侧更贴近「现在叫什么」。
3. 构建入口命名是 `buildBoardData`（不是规划里的 `buildIncremental`），因为「增量」是它的行为而不是另一条代码路径——`buildDashboardData` 只是 `buildBoardData(db, opts).data`。
4. `writeFileAtomic` 多了原地覆盖兜底（见 §4 末），否则本机 dashboard.html 永远发布不出去。

**验证（热重载后真实家目录）**：`dashboard.html` 21:55 的旧文件被 1,009,480 字节新内容替换，`dashboard.cache.json` 生成；`GET /qq-archive/` 两次都返回 200 / 1,009,480 字节，第二次不再触发构建（文件 mtime 不变）。
