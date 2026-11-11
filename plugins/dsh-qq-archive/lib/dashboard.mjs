/**
 * 本地看板：单文件 HTML，深色「档案馆」风格。
 *
 * 数据在导出时快照进 HTML；收藏与批注存在浏览器 localStorage，
 * 「导出存档」把这两样和当天日报一起落成文件——这才算永久档。
 */
import { resolve } from 'node:path'
import { buildCalendar } from './calendar.mjs'
import { buildGraph } from './graph.mjs'
import { splitStoredImpression } from './impression.mjs'
import { buildLeaderboard } from './leaderboard.mjs'
import { buildLinkIndex } from './links.mjs'
import { listHighlights } from './highlights.mjs'
import { buildMentionIndex, mentionsFor } from './mentions.mjs'
import { buildProfile } from './people.mjs'
import { listPeriodReports } from './period.mjs'
import { dayBounds, fmtDay } from './report.mjs'
import { topWords } from './topics.mjs'
import {
  CACHE_VERSION,
  aggregateUsers,
  chatFingerprints,
  dbFingerprint,
  htmlPath,
  htmlStat,
  restoreUsers,
  serializeUsers,
  userFingerprints,
  userSig,
  writeFileAtomic,
} from './snapshot.mjs'

const PLACEHOLDER_RE = /^\[[^\]]{1,6}\]$/

/** 看板「群总结」放最近几天的日报（含今天）。 */
const REPORT_DAYS = 7

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function chatNameOf(db, key) {
  if (key === '*') return '全部会话'
  return db.prepare('select name from chats where chat_key = ?').get(key)?.name || key
}

function countOf(db, chatKey, fromTs, toTs) {
  const f = chatKey && chatKey !== '*' ? ' and chat_key = ?' : ''
  const args = chatKey && chatKey !== '*' ? [chatKey] : []
  return db
    .prepare(`select count(*) c from messages where ts between ? and ?${f}`)
    .get(fromTs, toTs, ...args).c
}

/**
 * 导出看板用的全部数据（全量：不读快照，所有档案都现算）。
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function buildDashboardData(db, opts = {}) {
  return buildBoardData(db, opts).data
}

/**
 * 组装看板数据，能复用的复用。
 *
 * 粒度：会话 → 会话里的人 → 跨群合计的人。没变的会话、没变的人直接拿上一份
 * 快照里的结果；@ 关系不缓存（一遍扫描的索引每次现算 40 ms），所以别人新
 * @ 了你，不需要重算你的档案。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [opts]
 * @param {object|null} [opts.snapshot] 上一次的快照；null / 不传 = 全量
 * @returns {{ data: object, snapshot: object, stats: object }}
 */
export function buildBoardData(db, { feedLimit = 300, peopleLimit = 60, peoplePerChat = 40, snapshot = null } = {}) {
  const started = Date.now()
  const today = dayBounds('today')
  const yesterday = dayBounds('yesterday')

  const chats = db
    .prepare('select chat_key, type, name, msg_count, last_ts from chats order by msg_count desc')
    .all()
    .map((c) => ({
      key: c.chat_key,
      type: c.type,
      name: c.name || c.chat_key,
      msgCount: c.msg_count,
      lastTs: c.last_ts,
      todayTotal: countOf(db, c.chat_key, today.fromTs, today.toTs),
      yesterdayTotal: countOf(db, c.chat_key, yesterday.fromTs, yesterday.toTs),
    }))
    .filter((c) => c.msgCount > 0)

  // 最近 REPORT_DAYS 天，每天都有哪些群的日报。日期栏只列「这天真有日报」的日子，
  // 所以窗口是固定 7 天，但显示出来的天数由库里实际写过的日报决定。
  const dayWindow = []
  for (let i = 0; i < REPORT_DAYS; i++) {
    const base = new Date(today.fromTs * 1000)
    dayWindow.push(fmtDay(new Date(base.getFullYear(), base.getMonth(), base.getDate() - i)))
  }
  const oldest = dayWindow[dayWindow.length - 1]
  const reportRows = db
    .prepare('select date, chat_key, text, stats, model from reports where date >= ? and date <= ?')
    .all(oldest, today.day)
  const reportsByDay = new Map()
  for (const r of reportRows) {
    if (!reportsByDay.has(r.date)) reportsByDay.set(r.date, [])
    reportsByDay.get(r.date).push(r)
  }
  // 卡片顺序：全群汇总在前，其余按会话活跃度（chats 已按 msg_count desc 排），未知会话垫底。
  const chatOrder = new Map(['*', ...chats.map((c) => c.key)].map((k, i) => [k, i]))
  const reportDays = dayWindow
    .map((date) => ({
      date,
      cards: (reportsByDay.get(date) || [])
        .map((r) => ({
          chatKey: r.chat_key,
          chatName: chatNameOf(db, r.chat_key),
          text: r.text,
          model: r.model,
          stats: safeJson(r.stats),
        }))
        .sort((a, b) => (chatOrder.get(a.chatKey) ?? 1e6) - (chatOrder.get(b.chatKey) ?? 1e6)),
    }))
    .filter((d) => d.cards.length > 0)

  // 稳定聚合：日历（全局 + 每群）、资源库、群梗种子词、名场面、周/月报、活跃榜。
  // 这些不进历史快照，每次重建现算一遍；本地量级下合计几十毫秒。
  const calendarGlobal = buildCalendar(db, { months: 3 })
  const calendarByChat = { '*': calendarGlobal.days }
  for (const c of chats) {
    calendarByChat[c.key] = buildCalendar(db, { months: 3, chatKey: c.key }).days
  }
  const linkIndex = buildLinkIndex(db, { limit: 4000 })
  const leaderboard = buildLeaderboard(db, { top: 30 })

  const feed = db
    .prepare(
      `select id, chat_key, sender_id, sender_name, ts, kind, text from messages
        where text <> '' order by ts desc limit ?`,
    )
    .all(feedLimit)
    .map((r) => ({
      id: r.id,
      chatKey: r.chat_key,
      chatName: chatNameOf(db, r.chat_key),
      senderId: String(r.sender_id || ''),
      sender: r.sender_name || String(r.sender_id || ''),
      ts: r.ts,
      kind: r.kind,
      text: String(r.text).slice(0, 400),
    }))
    .filter((m) => !PLACEHOLDER_RE.test(m.text.trim()))
    .reverse()

  const chatNames = new Map(chats.map((c) => [c.key, c.name]))

  const profiles = {}
  const profileRows = db.prepare("select user_id, impression, tags from profiles where chat_key = '*'").all()
  const tagOf = new Map()
  for (const r of profileRows) {
    const { text, tags } = splitStoredImpression(r.impression, r.tags)
    if (text) profiles[String(r.user_id)] = text
    tagOf.set(String(r.user_id), tags)
  }

  // @ 关系：一遍扫描的索引，全局与每个群一起算
  const mentionIndex = buildMentionIndex(db)

  // 哪些群变了
  const fps = chatFingerprints(db)
  const prevChats = snapshot?.chats || {}
  const dirty = new Set()
  for (const c of chats) {
    if (!prevChats[c.key] || prevChats[c.key].sig !== (fps.get(c.key)?.sig || '')) dirty.add(c.key)
  }
  const structureChanged = !snapshot || dirty.size > 0 || Object.keys(prevChats).length !== chats.length

  const stats = { rebuiltChats: 0, reusedChats: 0, rebuiltProfiles: 0, reusedProfiles: 0 }

  const graph = structureChanged || !snapshot?.graph ? buildGraph(db, { sinceTs: 0, maxNodes: 70 }) : snapshot.graph
  const graphAll = structureChanged || !snapshot?.graphAll ? buildGraph(db, { sinceTs: 0, maxNodes: 50 }) : snapshot.graphAll

  const userMaps = new Map()
  const nextChats = {}
  const graphs = { '*': graphAll }
  const peopleByChat = {}

  for (const c of chats) {
    const prev = prevChats[c.key]
    const clean = !dirty.has(c.key) && Boolean(prev)
    const users = clean ? restoreUsers(prev.users) : userFingerprints(db, c.key)
    userMaps.set(c.key, users)

    let chatGraph
    let entries
    if (clean) {
      chatGraph = prev.graph
      entries = prev.people
      stats.reusedChats++
      stats.reusedProfiles += entries.length
    } else {
      chatGraph = buildGraph(db, { chatKey: c.key, sinceTs: 0, maxNodes: 45 })
      const cached = new Map((prev?.people || []).map((e) => [e.id, e]))
      entries = [...users.entries()]
        .sort((a, b) => b[1][0] - a[1][0] || Number(a[0]) - Number(b[0]))
        .slice(0, peoplePerChat)
        .map(([id]) => {
          const sig = userSig(users.get(id))
          const hit = cached.get(id)
          if (hit && hit.sig === sig) {
            stats.reusedProfiles++
            return hit
          }
          stats.rebuiltProfiles++
          const p = buildProfile(db, chatNames, {
            userId: id,
            chatKey: c.key,
            topLimit: 500,
            mentions: mentionsFor(mentionIndex, id, c.key),
          })
          return { id, sig, p: stripProfile(p) }
        })
      stats.rebuiltChats++
    }

    nextChats[c.key] = { sig: fps.get(c.key)?.sig || '', graph: chatGraph, people: entries, users: serializeUsers(users) }
    graphs[c.key] = chatGraph
    peopleByChat[c.key] = entries.map((e) => decorate(e, mentionIndex, c.key, profiles, tagOf))
  }

  // 跨群「全部」：名单来自 members 的发言合计，指纹用各群的人指纹合计
  const agg = aggregateUsers(userMaps)
  const cachedGlobal = new Map((snapshot?.global?.people || []).map((e) => [e.id, e]))
  const globalRows = db
    .prepare('select user_id, sum(msg_count) as n from members group by user_id order by n desc limit ?')
    .all(peopleLimit)
  const globalEntries = globalRows.map((row) => {
    const id = String(row.user_id)
    const sig = userSig(agg.get(id) || [0, 0, 0])
    const hit = cachedGlobal.get(id)
    if (hit && hit.sig === sig) {
      stats.reusedProfiles++
      return hit
    }
    stats.rebuiltProfiles++
    const p = buildProfile(db, chatNames, { userId: id, topLimit: 500, mentions: mentionsFor(mentionIndex, id, '*') })
    return { id, sig, p: stripProfile(p) }
  })
  peopleByChat['*'] = globalEntries.map((e) => decorate(e, mentionIndex, '*', profiles, tagOf))

  const totalMsgs = db.prepare('select count(*) c from messages').get().c
  const generatedAt = Date.now()
  const data = {
    generatedAt,
    today: today.day,
    yesterday: yesterday.day,
    totalMsgs,
    chats,
    reportDays,
    calendar: {
      days: calendarGlobal.days,
      maxDay: calendarGlobal.maxDay,
      byChat: calendarByChat,
    },
    links: {
      total: linkIndex.total,
      domains: linkIndex.domains,
      byChat: linkIndex.byChat,
      // 内联只放最近 600 条供离线翻；完整检索走 /qq-archive/api/links
      links: linkIndex.links.slice(0, 600),
    },
    topics: { words: topWords(db, { limit: 24 }) },
    highlights: listHighlights(db, { limit: 12 }).map((h) => ({
      ...h,
      chatName: chatNameOf(db, h.chatKey),
      count: h.msgCount,
    })),
    periods: {
      weeks: listPeriodReports(db, { kind: 'week', limit: 8 }),
      months: listPeriodReports(db, { kind: 'month', limit: 6 }),
    },
    leaderboard,
    feed,
    graph,
    graphs,
    profiles,
    peopleByChat,
  }
  const next = {
    version: CACHE_VERSION,
    builtAt: generatedAt,
    fp: '',
    html: null,
    chats: nextChats,
    global: { people: globalEntries },
    graph,
    graphAll,
  }
  return { data, snapshot: next, stats: { ...stats, ms: Date.now() - started } }
}

/** 档案里会变的展示字段（@ 关系、印象标签）不进缓存，装配时现贴。 */
function stripProfile(p) {
  const { summary, mentionsOut, mentionedBy, ...rest } = p
  return rest
}

function decorate(entry, index, scope, profiles, tagOf) {
  const { mentionsOut, mentionedBy } = mentionsFor(index, entry.id, scope)
  return {
    ...entry.p,
    mentionsOut,
    mentionedBy,
    impression: profiles[entry.id] || '',
    tags: tagOf.get(entry.id) || [],
  }
}

function safeJson(s) {
  try {
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
}

/* ───────────────────────── 渲染 ───────────────────────── */

export function renderDashboard(data, { title = '群聊档案馆' } = {}) {
  // 数据 JSON 里 '</' 会提前闭合 script，统一转义
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(data.today)}</title>
<style>
${CSS}
</style>
</head>
<body>
<div class="grain" aria-hidden="true"></div>

<header class="mast">
  <div class="mast-inner">
    <div class="mast-left">
      <p class="kicker">QQ · ARCHIVE</p>
      <h1 class="title">${esc(title)}</h1>
      <p class="lede">把群聊里值得留下的东西，收进一座只属于你的档案馆。</p>
    </div>
    <div class="mast-right">
      <div class="date-big">${esc(data.today.slice(5).replace('-', '·'))}</div>
      <div class="date-sub">${esc(data.today)} 期</div>
    </div>
  </div>
  <div class="rule"></div>
  <div class="strip">
    <div class="strip-item"><b>${fmt(data.totalMsgs)}</b><span>条消息存档</span></div>
    <div class="strip-item"><b>${data.chats.length}</b><span>个会话</span></div>
    <div class="strip-item"><b>${data.graph.nodes.length}</b><span>位常驻群友</span></div>
    <div class="strip-item"><b>${fmt(data.graph.totalAt)}</b><span>次互相点名</span></div>
  </div>
</header>

<nav class="tabs" role="tablist">
  <button class="tab active" data-tab="today">群总结</button>
  <button class="tab" data-tab="calendar">日历</button>
  <button class="tab" data-tab="links">资源库</button>
  <button class="tab" data-tab="topics">群梗</button>
  <button class="tab" data-tab="highlights">名场面</button>
  <button class="tab" data-tab="graph">人事图</button>
  <button class="tab" data-tab="rank">榜单</button>
  <button class="tab" data-tab="people">群友</button>
  <button class="tab" data-tab="saved">收藏夹</button>
  <button class="tab" data-tab="feed">本月档案</button>
</nav>

<main>
  <!-- 群总结 -->
  <section class="panel active" id="panel-today">
    <div class="section-head"><span class="num">01</span><h2>群总结</h2><span class="hint">最近 7 天 · 点日期翻看 · 只列写过日报的日子</span></div>
    <div class="push-bar" id="push-bar">
      <span class="push-label">日报主动送达</span>
      <button type="button" class="push-switch" id="push-toggle" role="switch" aria-checked="false" aria-label="日报主动送达开关"><span class="push-knob"></span></button>
      <select class="push-scope" id="push-scope" aria-label="推送范围">
        <option value="digest">只推全群汇总</option>
        <option value="all">每群各一份</option>
      </select>
      <button type="button" class="push-test" id="push-test">发条测试</button>
      <span class="push-state" id="push-state">正在读推送设置……</span>
      <span class="push-hint" id="push-hint"></span>
    </div>
    <div class="day-rail" id="day-rail"></div>
    <div class="cards" id="cards"></div>

    <div class="period-block">
      <div class="section-head"><span class="num">01b</span><h2>周报 / 月报</h2><span class="hint">按周期攒成大篇 · 让 DSH 跑 qq_report 生成</span></div>
      <div class="periods" id="periods"></div>
    </div>
  </section>

  <!-- 活跃日历 -->
  <section class="panel" id="panel-calendar">
    <div class="section-head"><span class="num">02</span><h2>群活跃日历</h2><span class="hint">近三个月 · 颜色越深这天越吵 · 点一天看明细</span></div>
    <div class="files" id="cal-files"></div>
    <div class="calendars" id="calendars"></div>
    <div class="day-detail" id="day-detail"><p class="empty">点日历上的某一天，看看那天发生了什么。</p></div>
  </section>

  <!-- 链接资源库 -->
  <section class="panel" id="panel-links">
    <div class="section-head"><span class="num">03</span><h2>链接资源库</h2><span class="hint">群里发过的链接按域名收着 · 搜标题、发送者、地址</span></div>
    <div class="link-tools">
      <input id="link-search" class="people-search" type="search" placeholder="搜链接：标题 / 域名 / 发送者 / 群……">
      <div class="chips" id="link-domains"></div>
    </div>
    <div id="link-list" class="link-list"></div>
  </section>

  <!-- 群梗考古 -->
  <section class="panel" id="panel-topics">
    <div class="section-head"><span class="num">04</span><h2>群梗考古</h2><span class="hint">一个词从哪来、谁最爱说、都在什么语境里</span></div>
    <div class="topic-tools">
      <input id="topic-search" class="people-search" type="search" placeholder="输入一个词，比如：绑定 / 大肥鱼 / 打牌">
      <button class="btn" id="topic-go">考古</button>
    </div>
    <div class="chips" id="topic-suggest"></div>
    <div id="topic-result" class="topic-result"><p class="empty">输入一个词，或者点上面一个热词。</p></div>
  </section>

  <!-- 名场面 -->
  <section class="panel" id="panel-highlights">
    <div class="section-head"><span class="num">05</span><h2>名场面</h2><span class="hint">一段时间里突然刷屏的爆聊段 · 让 DSH 跑 qq_highlights 生成摘要</span></div>
    <div id="highlight-list" class="highlights"></div>
  </section>

  <!-- 人事图 -->
  <section class="panel" id="panel-graph">
    <div class="section-head"><span class="num">06</span><h2>探案板</h2><span class="hint">一个群一块板子 · 红线是互相 @ · 点一张照片看卷宗</span></div>
    <div class="files" id="case-files"></div>
    <div class="railtabs" id="graph-ranges"></div>
    <div class="board-wrap">
      <canvas id="net"></canvas>
      <p class="board-empty" id="board-empty">这块板子上还没有红线——这个群里没人互相 @ 过。</p>
      <aside class="inspector" id="inspector">
        <p class="insp-empty">把光标放到一张照片上，看看这个人。</p>
      </aside>
    </div>
  </section>

  <!-- 榜单 -->
  <section class="panel" id="panel-rank">
    <div class="section-head"><span class="num">07</span><h2>活跃榜</h2><span class="hint">本周至今 vs 上周同期（等长）· 上升、下跌、新面孔和失踪人口</span></div>
    <div class="rank-summary" id="rank-summary"></div>
    <div class="rank-cols">
      <div><h3 class="rank-h">本周发言榜</h3><div id="rank-people" class="rank-list"></div></div>
      <div><h3 class="rank-h">失踪人口</h3><div id="rank-missing" class="rank-list"></div></div>
    </div>
  </section>

  <!-- 群友 -->
  <section class="panel" id="panel-people">
    <div class="section-head"><span class="num">08</span><h2>群友档案</h2><span class="hint">先选一个群，再看这个群里的人 · 点头像看完整档案</span></div>
    <div id="people-files" class="files people-files"></div>
    <input id="people-search" class="people-search" type="search" placeholder="搜这个群里的昵称或 QQ……">
    <div id="people-grid" class="people"></div>
  </section>

  <!-- 收藏 -->
  <section class="panel" id="panel-saved">
    <div class="section-head"><span class="num">09</span><h2>值得留下的话</h2><span class="hint">收藏和批注只存在这台浏览器 · 导出后才算永久档</span></div>
    <div class="saved-tools">
      <button class="btn" id="export-json">导出存档 JSON</button>
      <button class="btn" id="export-md">导出 Markdown</button>
      <span class="saved-count" id="saved-count"></span>
    </div>
    <div id="saved-list" class="saved-list"></div>
    <div class="notes-head"><h3>今日批注</h3><span class="hint">写给自己的三两句话，自动保存</span></div>
    <textarea id="note" class="note" placeholder="今天这个群……"></textarea>
  </section>

  <!-- 消息流 -->
  <section class="panel" id="panel-feed">
    <div class="section-head"><span class="num">10</span><h2>最近的档案</h2><span class="hint">点「收藏」把它放进收藏夹</span></div>
    <div id="feed" class="feed"></div>
  </section>
</main>

<div class="modal" id="person-modal" aria-hidden="true">
  <div class="modal-panel" role="dialog" aria-modal="true">
    <button class="modal-close" id="person-close" aria-label="关闭">×</button>
    <div id="person-body"></div>
  </div>
</div>

<footer class="foot">
  <p>${esc(title)} · 由 dsh-qq-archive 生成 · ${new Date(data.generatedAt).toLocaleString('zh-CN')}</p>
  <p class="foot-dim">这份 HTML 本身就是一份快照；把它和导出的存档文件放在一起，就是你的永久存档。</p>
</footer>

<script type="application/json" id="d">${json}</script>
<script>
${JS}
</script>
</body>
</html>`
}

function fmt(n) {
  if (n >= 10000) return (n / 10000).toFixed(1) + ' 万'
  return String(n)
}

/**
 * 导出看板 HTML。
 *
 * 传 snapshot 就能增量：只重算变了的会话与变了的人；返回的 snapshot 是这一次
 * 构建后的新快照，调用方负责落盘。outPath 指到别处时不返回快照（避免拿一份
 * 写歪的 HTML 去当缓存凭据）。
 *
 * @returns {{path, bytes, chats, reports, reportDays, latestReportDay, nodes, people, peopleByChat, links, highlights, periods, date, stats, snapshot}}
 */
export function exportDashboard(db, { home = '', outPath, title = '群聊档案馆', feedLimit = 300, snapshot = null } = {}) {
  const { data, snapshot: next, stats } = buildBoardData(db, { feedLimit, snapshot })
  const html = renderDashboard(data, { title })
  const path = outPath || htmlPath(home)
  const publish = writeFileAtomic(path, html)
  next.fp = dbFingerprint(db)
  next.html = htmlStat(path)
  const canonical = !outPath || resolve(path) === resolve(htmlPath(home))
  return {
    path,
    bytes: Buffer.byteLength(html, 'utf8'),
    publish,
    chats: data.chats.length,
    reports: data.reportDays.reduce((n, d) => n + d.cards.length, 0),
    reportDays: data.reportDays.length,
    latestReportDay: data.reportDays[0]?.date || '',
    nodes: data.graph.nodes.length,
    people: (data.peopleByChat['*'] || []).length,
    peopleByChat: Object.keys(data.peopleByChat).length,
    links: data.links.total,
    linkDomains: data.links.domains.length,
    highlights: data.highlights.length,
    periods: data.periods.weeks.length + data.periods.months.length,
    date: data.today,
    stats,
    snapshot: canonical ? next : null,
  }
}

const CSS = `
:root{
  --paper:#0e0d0c; --paper-2:#1a1714; --paper-3:#211d19;
  --ink:#ece2cf; --body:#d5ccbb; --muted:#9a8c75;
  --accent:#d4a04a; --accent-soft:#3a2a14; --accent-dim:#875c00;
  --line:#373430; --line-subtle:#23211f;
  --font-display:'Playfair Display','Noto Serif SC','Source Han Serif SC','Songti SC',serif;
  --font-serif:'Source Serif 4','Noto Serif SC','Source Han Serif SC','Songti SC',Georgia,serif;
  --font-sans:'Noto Sans SC','PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif;
  --font-mono:'IBM Plex Mono',ui-monospace,'SF Mono',Menlo,monospace;
  color-scheme:dark;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0; background:var(--paper); color:var(--body);
  font-family:var(--font-sans); font-size:15px; line-height:1.75;
  -webkit-font-smoothing:antialiased;
  background-image:
    radial-gradient(1200px 600px at 82% -10%, rgba(212,160,74,.09), transparent 60%),
    radial-gradient(900px 500px at -10% 20%, rgba(212,160,74,.05), transparent 55%);
  background-attachment:fixed;
}
.grain{position:fixed;inset:0;pointer-events:none;z-index:50;opacity:.5;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.045'/%3E%3C/svg%3E");}
.wrap-mid{max-width:1240px;margin:0 auto;padding:0 40px}

.mast{max-width:1240px;margin:0 auto;padding:64px 40px 0}
.mast-inner{display:flex;justify-content:space-between;align-items:flex-end;gap:40px}
.kicker{font-family:var(--font-mono);font-size:11px;letter-spacing:.42em;color:var(--accent);margin:0 0 18px;text-transform:uppercase}
.title{font-family:var(--font-display);font-weight:500;font-size:clamp(42px,7vw,84px);line-height:1.02;letter-spacing:.02em;color:var(--ink);margin:0 0 20px}
.lede{font-family:var(--font-serif);font-size:15px;color:var(--muted);margin:0;max-width:34em}
.mast-right{text-align:right;padding-bottom:6px;flex-shrink:0}
.date-big{font-family:var(--font-display);font-size:clamp(40px,5vw,64px);color:var(--accent);line-height:1;letter-spacing:.04em;font-variant-numeric:tabular-nums}
.date-sub{font-family:var(--font-mono);font-size:11px;letter-spacing:.24em;color:var(--muted);margin-top:10px}
.rule{height:1px;background:linear-gradient(90deg,var(--line),var(--line-subtle) 70%,transparent);margin:44px 0 0}
.strip{display:flex;gap:48px;padding:24px 0 4px;flex-wrap:wrap}
.strip-item b{display:block;font-family:var(--font-display);font-size:28px;font-weight:500;color:var(--ink);line-height:1.2;font-variant-numeric:tabular-nums}
.strip-item span{font-family:var(--font-mono);font-size:10.5px;letter-spacing:.16em;color:var(--muted)}

.tabs{position:sticky;top:0;z-index:20;max-width:1240px;margin:36px auto 0;padding:0 40px;
  display:flex;flex-wrap:wrap;gap:8px;background:linear-gradient(180deg,var(--paper) 72%,transparent);}
.tab{appearance:none;border:1px solid transparent;background:none;color:var(--muted);
  font-family:var(--font-sans);font-size:13px;letter-spacing:.08em;padding:10px 18px;border-radius:2px;cursor:pointer;
  transition:color .2s var(--ease, ease),border-color .2s}
.tab:hover{color:var(--ink)}
.tab.active{color:var(--accent);border-color:var(--line);background:var(--paper-2)}

main{max-width:1240px;margin:0 auto;padding:0 40px 80px}
.panel{display:none;animation:rise .5s cubic-bezier(.22,1,.36,1) both}
.panel.active{display:block}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.section-head{display:flex;align-items:baseline;gap:16px;margin:40px 0 24px;flex-wrap:wrap}
.num{font-family:var(--font-mono);font-size:11px;color:var(--accent);letter-spacing:.2em;border:1px solid var(--line);padding:3px 8px;border-radius:2px}
.section-head h2{font-family:var(--font-serif);font-weight:500;font-size:26px;color:var(--ink);margin:0;letter-spacing:.05em}
.hint{font-family:var(--font-mono);font-size:10.5px;color:var(--muted);letter-spacing:.04em;margin-left:auto}

.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(440px,100%),1fr));gap:20px;align-items:start}

/* 群总结的日期栏：一排卷宗脊背，点哪天翻哪天的卡片 */
.day-rail{display:flex;gap:8px;overflow-x:auto;padding:2px 2px 18px;scrollbar-width:thin}
.day-rail::-webkit-scrollbar{height:4px}
.day{flex:0 0 auto;appearance:none;cursor:pointer;text-align:left;padding:9px 16px 10px;
  background:linear-gradient(180deg,var(--paper-2),rgba(26,23,20,.6));border:1px solid var(--line-subtle);border-radius:2px;
  color:var(--muted);font-family:var(--font-mono);font-size:10.5px;letter-spacing:.05em;
  transition:border-color .2s,color .2s}
.day b{display:block;font-family:var(--font-display);font-size:19px;font-weight:500;line-height:1.25;
  color:var(--body);letter-spacing:.03em;font-variant-numeric:tabular-nums;margin-bottom:2px}
.day span{display:block;letter-spacing:.08em}
.day:hover{border-color:var(--line)}
.day:hover b{color:var(--ink)}
.day.active{border-color:var(--accent-dim);background:var(--accent-soft)}
.day.active b,.day.active span{color:var(--accent)}

/* 群总结顶上的「日报主动送达」开关条 */
.push-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 18px;padding:10px 14px;
  border:1px solid var(--line-subtle);border-radius:3px;
  background:linear-gradient(180deg,var(--paper-2),rgba(26,23,20,.35))}
.push-label{font-family:var(--font-mono);font-size:10.5px;letter-spacing:.14em;color:var(--body);text-transform:uppercase}
.push-switch{appearance:none;position:relative;flex:0 0 auto;width:38px;height:20px;padding:0;cursor:pointer;
  border:1px solid var(--line);border-radius:999px;background:var(--paper);transition:background .2s,border-color .2s}
.push-switch .push-knob{position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;
  background:var(--muted);transition:left .2s,background .2s}
.push-switch[aria-checked="true"]{background:var(--accent-soft);border-color:var(--accent-dim)}
.push-switch[aria-checked="true"] .push-knob{left:20px;background:var(--accent)}
.push-switch:disabled{opacity:.45;cursor:default}
.push-scope{appearance:none;background:var(--paper);border:1px solid var(--line);border-radius:2px;
  color:var(--body);font-family:var(--font-mono);font-size:10.5px;padding:4px 8px;cursor:pointer}
.push-scope:disabled{opacity:.45;cursor:default}
.push-test{appearance:none;background:transparent;border:1px solid var(--line);border-radius:2px;
  color:var(--muted);font-family:var(--font-mono);font-size:10.5px;padding:4px 10px;cursor:pointer;transition:color .2s,border-color .2s}
.push-test:hover{color:var(--ink);border-color:var(--accent-dim)}
.push-test:disabled{opacity:.4;cursor:default}
.push-state{font-family:var(--font-mono);font-size:10.5px;color:var(--muted);letter-spacing:.03em}
.push-state.on{color:var(--accent)}
.push-hint{font-family:var(--font-mono);font-size:10px;color:var(--muted);margin-left:auto}
.push-hint.bad{color:#c97a6b}

/* 周报 / 月报 */
.period-block{margin-top:56px}
.period-block .section-head{margin-top:0}
.periods{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(420px,100%),1fr));gap:18px;align-items:start}
.period-card{background:linear-gradient(180deg,var(--paper-2),rgba(26,23,20,.55));border:1px solid var(--line-subtle);
  border-radius:3px;padding:22px 24px 20px;position:relative;overflow:hidden;transition:border-color .3s}
.period-card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--accent);opacity:.5}
.period-card-head{display:flex;align-items:baseline;gap:12px;margin-bottom:4px}
.period-card-head h3{font-family:var(--font-serif);font-weight:500;font-size:17px;color:var(--ink);margin:0}
.period-kind{font-family:var(--font-mono);font-size:9.5px;color:var(--accent);border:1px solid var(--line);padding:2px 7px;border-radius:999px;letter-spacing:.08em}
.period-meta{font-family:var(--font-mono);font-size:10.5px;color:var(--muted);letter-spacing:.04em;margin:0 0 14px}
.period-card .report{font-size:14px}

/* 活跃日历 */
.calendars{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(360px,100%),1fr));gap:26px;margin-top:8px}
.cal-month{border:1px solid var(--line-subtle);border-radius:3px;padding:18px 20px 20px;background:linear-gradient(180deg,var(--paper-2),rgba(26,23,20,.4))}
.cal-title{font-family:var(--font-serif);font-size:16px;color:var(--ink);margin:0 0 4px}
.cal-sub{font-family:var(--font-mono);font-size:9.5px;color:var(--muted);letter-spacing:.08em;margin:0 0 12px}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.cal-dow{font-family:var(--font-mono);font-size:9px;color:var(--muted);text-align:center;padding-bottom:2px;letter-spacing:.06em}
.cal-cell{appearance:none;border:1px solid transparent;background:transparent;border-radius:2px;cursor:pointer;
  min-height:38px;padding:4px 3px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;
  color:var(--muted);font-family:var(--font-mono);font-size:9.5px;transition:border-color .15s,background .15s}
.cal-cell.empty{visibility:hidden}
.cal-cell:hover{border-color:var(--line);color:var(--ink)}
.cal-cell.active{border-color:var(--accent-dim);background:var(--accent-soft)}
.cal-num{font-family:var(--font-mono);font-size:10px;color:var(--body);letter-spacing:.02em}
.cal-n{font-family:var(--font-mono);font-size:8.5px;color:var(--muted)}
.cal-cell[data-level="1"]{background:rgba(212,160,74,.10)}
.cal-cell[data-level="2"]{background:rgba(212,160,74,.20)}
.cal-cell[data-level="3"]{background:rgba(212,160,74,.32)}
.cal-cell[data-level="4"]{background:rgba(212,160,74,.46)}
.cal-cell[data-level="5"]{background:rgba(212,160,74,.62)}
.cal-cell[data-level="5"] .cal-num{color:#2a1d08}
.cal-cell[data-level="4"] .cal-num{color:var(--ink)}
.day-detail{margin-top:26px;border:1px solid var(--line-subtle);border-radius:3px;padding:22px 24px;background:var(--paper-2)}
.dd-head{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:6px}
.dd-head h3{font-family:var(--font-serif);font-size:19px;color:var(--ink);margin:0;font-weight:500}
.dd-head span{font-family:var(--font-mono);font-size:10px;color:var(--muted);letter-spacing:.06em}
.dd-grid{display:flex;gap:26px;flex-wrap:wrap;margin:14px 0 6px}
.dd-stat b{display:block;font-family:var(--font-display);font-size:22px;color:var(--accent);font-weight:400;font-variant-numeric:tabular-nums}
.dd-stat span{font-family:var(--font-mono);font-size:9.5px;color:var(--muted);letter-spacing:.1em}
.dd-hours{display:flex;align-items:flex-end;gap:2px;height:46px;margin-top:12px}
.dd-hours i{flex:1;background:var(--accent-soft);min-height:2px;border-radius:1px 1px 0 0}
.dd-hours i.hot{background:var(--accent)}

/* 链接资源库 */
.link-tools{margin-bottom:18px}
.link-tools .people-search{margin-bottom:12px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.chip-btn{appearance:none;cursor:pointer;background:var(--paper-2);border:1px solid var(--line-subtle);color:var(--body);
  font-family:var(--font-mono);font-size:10.5px;padding:4px 10px;border-radius:999px;letter-spacing:.03em;transition:.15s}
.chip-btn:hover{border-color:var(--line);color:var(--ink)}
.chip-btn.on{border-color:var(--accent-dim);background:var(--accent-soft);color:var(--accent)}
.chip-btn b{color:var(--accent);font-weight:400;margin-left:5px}
.link-list{display:flex;flex-direction:column;border-top:1px solid var(--line-subtle)}
.link-item{display:grid;grid-template-columns:92px 1fr;gap:16px;padding:13px 0;border-bottom:1px solid var(--line-subtle);align-items:start}
.link-item:hover{background:rgba(212,160,74,.025)}
.link-when{font-family:var(--font-mono);font-size:10px;color:var(--muted);letter-spacing:.03em;padding-top:3px;line-height:1.6}
.link-title{font-family:var(--font-serif);font-size:14px;line-height:1.7;color:var(--body);word-break:break-word}
.link-title a{color:var(--body);text-decoration:none;border-bottom:1px solid var(--line)}
.link-title a:hover{color:var(--accent);border-color:var(--accent-dim)}
.link-meta{font-family:var(--font-mono);font-size:10px;color:var(--muted);margin-top:4px;letter-spacing:.03em}
.link-domain{color:var(--accent)}

/* 群梗考古 */
.topic-tools{display:flex;gap:10px;align-items:flex-start}
.topic-tools .people-search{flex:1;margin-bottom:0}
.topic-tools .btn{flex:0 0 auto;padding:11px 20px}
.topic-result{margin-top:20px}
.topic-big{font-family:var(--font-display);font-size:34px;color:var(--ink);letter-spacing:.04em;margin:0 0 4px}
.topic-body{font-family:var(--font-mono);font-size:11px;color:var(--muted);letter-spacing:.04em}
.topic-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0}
.topic-stat{border:1px solid var(--line-subtle);border-radius:2px;padding:12px 14px}
.topic-stat b{display:block;font-family:var(--font-display);font-size:20px;color:var(--accent);font-weight:400}
.topic-stat span{font-family:var(--font-mono);font-size:9.5px;color:var(--muted);letter-spacing:.1em}
.topic-months{display:flex;align-items:flex-end;gap:5px;height:56px;margin:12px 0 6px}
.topic-months i{flex:1;background:var(--accent-soft);min-height:2px;border-radius:1px 1px 0 0;position:relative}
.topic-months i.hot{background:var(--accent)}
.sample{border-left:2px solid var(--line);padding:6px 0 6px 14px;margin:0 0 8px}
.sample time{font-family:var(--font-mono);font-size:10px;color:var(--muted);display:block;margin-bottom:2px}
.sample .who{color:var(--accent);font-family:var(--font-serif);font-size:12px;margin-right:8px}
.sample .txt{font-family:var(--font-serif);font-size:13.5px;line-height:1.8;color:var(--body)}

/* 名场面 */
.highlights{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(460px,100%),1fr));gap:20px;align-items:start}
.hl-card{border:1px solid var(--line-subtle);border-radius:3px;padding:22px 24px;background:linear-gradient(180deg,var(--paper-2),rgba(26,23,20,.5));position:relative}
.hl-card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:#b75a59;opacity:.6}
.hl-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:4px}
.hl-head h3{font-family:var(--font-serif);font-weight:500;font-size:17px;color:var(--ink);margin:0}
.hl-time{font-family:var(--font-mono);font-size:10px;color:var(--muted);letter-spacing:.04em}
.hl-meta{font-family:var(--font-mono);font-size:10px;color:var(--muted);margin:0 0 14px;letter-spacing:.03em}
.hl-meta b{color:var(--accent);font-weight:400}
.hl-summary{font-family:var(--font-serif);font-size:14px;line-height:1.9;color:var(--body)}
.hl-samples{margin-top:14px;padding-top:12px;border-top:1px solid var(--line-subtle)}
.hl-empty{font-family:var(--font-serif);color:var(--muted);font-style:italic}

/* 人事图时间切片 */
.railtabs{display:flex;gap:6px;margin:4px 0 16px;flex-wrap:wrap}
.railtab{appearance:none;cursor:pointer;background:transparent;border:1px solid var(--line-subtle);color:var(--muted);
  font-family:var(--font-mono);font-size:10.5px;letter-spacing:.08em;padding:5px 12px;border-radius:999px;transition:.15s}
.railtab:hover{border-color:var(--line);color:var(--ink)}
.railtab.on{border-color:var(--accent-dim);background:var(--accent-soft);color:var(--accent)}

/* 榜单 */
.rank-summary{display:flex;gap:34px;flex-wrap:wrap;padding:18px 0 8px;border-bottom:1px solid var(--line-subtle);margin-bottom:22px}
.rank-summary span{font-family:var(--font-mono);font-size:10.5px;color:var(--muted);letter-spacing:.06em}
.rank-summary b{font-family:var(--font-display);font-size:26px;color:var(--accent);font-weight:400;margin-right:8px;font-variant-numeric:tabular-nums}
.rank-cols{display:grid;grid-template-columns:1.4fr 1fr;gap:40px;align-items:start}
.rank-h{font-family:var(--font-serif);font-size:17px;color:var(--ink);font-weight:500;margin:0 0 12px}
.rank-list{display:flex;flex-direction:column}
.rank-row{display:grid;grid-template-columns:26px 1fr auto auto;gap:12px;align-items:baseline;padding:9px 0;border-bottom:1px solid var(--line-subtle)}
.rank-no{font-family:var(--font-mono);font-size:10px;color:var(--muted)}
.rank-name{font-family:var(--font-serif);font-size:14px;color:var(--body);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rank-name small{font-family:var(--font-mono);font-size:9.5px;color:var(--muted);margin-left:8px}
.rank-cur{font-family:var(--font-mono);font-size:11px;color:var(--accent);font-variant-numeric:tabular-nums}
.rank-delta{font-family:var(--font-mono);font-size:10px;min-width:44px;text-align:right;font-variant-numeric:tabular-nums}
.rank-delta.up{color:#7fae6a}.rank-delta.down{color:#b75a59}.rank-delta.flat{color:var(--muted)}
.rank-delta.new{color:#d4a04a}.rank-delta.gone{color:#9a8c75}
.api-note{font-family:var(--font-mono);font-size:10.5px;color:var(--muted);letter-spacing:.03em;
  border:1px dashed var(--line);padding:10px 14px;border-radius:2px;margin:12px 0 18px}
.api-note code{font-family:var(--font-mono);color:var(--accent)}
.mp-actions{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap}

/* 群友档案 */
.people-search{width:100%;box-sizing:border-box;background:var(--paper-2);border:1px solid var(--line-subtle);
  color:var(--body);font-family:var(--font-sans);font-size:13px;padding:11px 14px;border-radius:2px;margin-bottom:24px;outline:none}
.people-search:focus{border-color:var(--line)}
.people{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
.person{display:flex;gap:14px;align-items:flex-start;background:var(--paper-2);border:1px solid var(--line-subtle);
  border-radius:3px;padding:16px;cursor:pointer;text-align:left;transition:border-color .25s,transform .25s}
.person:hover{border-color:var(--line);transform:translateY(-2px)}
.avatar{flex:0 0 auto;width:44px;height:44px;border-radius:50%;display:grid;place-items:center;
  background:var(--accent-soft);color:var(--accent);font-family:var(--font-display);font-size:18px;
  border:1px solid var(--accent-dim);text-transform:uppercase}
.person-main{min-width:0;flex:1}
.person-name{display:block;font-family:var(--font-serif);font-size:15.5px;color:var(--ink);margin:0 0 2px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.person-id{display:block;font-family:var(--font-mono);font-size:10px;color:var(--muted);letter-spacing:.08em;margin-bottom:6px}
.person-line{display:block;font-family:var(--font-mono);font-size:10.5px;color:var(--muted)}
.person-line b{color:var(--accent);font-weight:400}
.person-quote{display:block;font-family:var(--font-serif);font-size:12.5px;line-height:1.7;color:var(--body);
  margin:8px 0 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.person-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.tag{font-family:var(--font-mono);font-size:9.5px;letter-spacing:.06em;color:var(--accent);
  border:1px solid var(--line);padding:2px 6px;border-radius:999px;background:rgba(212,160,74,.05)}

.modal{position:fixed;inset:0;z-index:80;display:none;place-items:center;padding:28px;
  background:rgba(6,5,4,.72);backdrop-filter:blur(3px)}
.modal.on{display:grid}
.modal-panel{position:relative;width:min(720px,100%);max-height:86vh;overflow:auto;
  background:var(--paper-2);border:1px solid var(--line);border-radius:4px;padding:34px 36px 40px;
  box-shadow:0 30px 90px rgba(0,0,0,.55)}
.modal-close{position:absolute;right:16px;top:12px;appearance:none;background:none;border:0;
  color:var(--muted);font-size:24px;line-height:1;cursor:pointer}
.modal-close:hover{color:var(--ink)}
.mp-head{display:flex;gap:18px;align-items:center;border-bottom:1px solid var(--line-subtle);padding-bottom:20px}
.mp-head .avatar{width:60px;height:60px;font-size:24px}
.mp-name{font-family:var(--font-serif);font-size:24px;font-weight:500;color:var(--ink);margin:0}
.mp-id{font-family:var(--font-mono);font-size:10.5px;color:var(--muted);letter-spacing:.1em;margin-top:4px}
.mp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin:22px 0}
.mp-stat{border:1px solid var(--line-subtle);padding:12px 14px;border-radius:2px}
.mp-stat b{display:block;font-family:var(--font-display);font-size:22px;color:var(--accent);font-weight:400}
.mp-stat span{font-family:var(--font-mono);font-size:10px;color:var(--muted);letter-spacing:.12em}
.mp-h{font-family:var(--font-mono);font-size:10.5px;color:var(--accent);letter-spacing:.18em;
  text-transform:uppercase;margin:26px 0 10px;display:flex;align-items:center;gap:10px}
.mp-h::after{content:"";flex:1;height:1px;background:var(--line-subtle)}
.mp-h:first-child{margin-top:0}
.mp-quote{font-family:var(--font-serif);font-size:14.5px;line-height:1.95;color:var(--body);
  border-left:2px solid var(--accent);padding-left:16px}
.hours{display:flex;align-items:flex-end;gap:3px;height:64px}
.hours i{flex:1;background:var(--accent-soft);min-height:2px;border-radius:1px 1px 0 0}
.hours i.hot{background:var(--accent)}
.hours-x{display:flex;justify-content:space-between;font-family:var(--font-mono);font-size:9px;
  color:var(--muted);margin-top:5px}
.mp-chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font-family:var(--font-sans);font-size:11.5px;color:var(--body);border:1px solid var(--line-subtle);
  padding:3px 9px;border-radius:999px}
.chip b{color:var(--accent);font-weight:400;font-family:var(--font-mono);font-size:10px;margin-left:4px}
.mp-list{display:flex;flex-direction:column;gap:9px}
.mp-msg{font-size:12.5px;line-height:1.7;color:var(--body);border-left:1px solid var(--line);padding-left:12px}
.mp-msg time{font-family:var(--font-mono);font-size:10px;color:var(--muted);margin-right:8px}
.mp-empty{color:var(--muted);font-style:italic;font-size:12.5px}
.card{background:linear-gradient(180deg,var(--paper-2),rgba(26,23,20,.55));border:1px solid var(--line-subtle);
  border-radius:3px;padding:26px 26px 20px;position:relative;overflow:hidden;transition:border-color .3s}
.card:hover{border-color:var(--line)}
.card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--accent);opacity:.5}
.card-head{display:flex;align-items:baseline;gap:12px;margin-bottom:6px}
.card-head h3{font-family:var(--font-serif);font-weight:500;font-size:19px;color:var(--ink);margin:0;letter-spacing:.03em}
.card-meta{font-family:var(--font-mono);font-size:10.5px;color:var(--muted);letter-spacing:.04em;margin:0 0 18px}
.card-meta b{color:var(--accent);font-weight:400}
.report{font-family:var(--font-serif);font-size:14.5px;line-height:1.95;color:var(--body)}
.report h2{font-family:var(--font-serif);font-size:15px;font-weight:500;color:var(--accent);letter-spacing:.08em;margin:22px 0 8px}
.report h2:first-child{margin-top:0}
.report p{margin:0 0 10px}
.report b{color:var(--ink);font-weight:500}
.report a{color:var(--accent);text-decoration:none;border-bottom:1px solid var(--accent-dim)}
.report code{font-family:var(--font-mono);font-size:12.5px;background:var(--paper-3);padding:1px 5px;border-radius:2px}
.report-empty{font-family:var(--font-serif);font-size:14px;color:var(--muted);font-style:italic}
.card-note{width:100%;height:46px;margin-top:18px;background:transparent;border:0;border-top:1px dashed var(--line);
  padding:12px 0 0;color:var(--body);font-family:var(--font-serif);font-size:13.5px;resize:vertical;outline:none}
.card-note::placeholder{color:var(--muted);opacity:.6}

/* 探案板：软木底色 + 卷宗标签 + 拍立得照片钉在板上 */
.files{display:flex;gap:8px;overflow-x:auto;padding:2px 2px 14px;scrollbar-width:thin}
.people-files{margin:16px 0 14px;padding-bottom:12px}
.files::-webkit-scrollbar{height:4px}
.file{flex:0 0 auto;appearance:none;cursor:pointer;text-align:left;padding:10px 16px 11px;
  background:linear-gradient(180deg,#2b241d,#221c16);border:1px solid var(--line-subtle);border-radius:2px;
  color:var(--muted);font-family:var(--font-mono);font-size:11px;letter-spacing:.04em;
  position:relative;transition:border-color .2s,color .2s,transform .2s}
.file b{display:block;font-family:var(--font-serif);font-size:13.5px;font-weight:500;color:var(--body);
  letter-spacing:0;margin-bottom:3px}
.file:hover{border-color:var(--line);transform:translateY(-1px)}
.file.active{border-color:var(--accent-dim);color:var(--accent);background:linear-gradient(180deg,#33291e,#261f18)}
.file.active b{color:var(--ink)}
.file::before{content:"";position:absolute;left:50%;top:-4px;width:7px;height:7px;border-radius:50%;
  background:var(--accent-soft);border:1px solid var(--accent-dim);transform:translateX(-50%)}

.board-wrap{position:relative;border:1px solid #3d3036;border-radius:3px;overflow:hidden;  background-color:#241c17;
  background-image:radial-gradient(circle at 20% 30%,rgba(120,80,45,.10),transparent 42%),
    radial-gradient(circle at 78% 70%,rgba(90,60,40,.12),transparent 46%),
    repeating-linear-gradient(0deg,rgba(255,255,255,.012) 0 1px,transparent 1px 3px),
    repeating-linear-gradient(90deg,rgba(255,255,255,.008) 0 1px,transparent 1px 4px);
  box-shadow:inset 0 0 90px rgba(0,0,0,.65)}
#net{display:block;width:100%;height:min(74vh,700px);cursor:crosshair}
.board-empty{display:none;position:absolute;inset:0;place-items:center;margin:0;padding:40px;text-align:center;
  color:var(--muted);font-family:var(--font-serif);font-style:italic;font-size:14px}
.board-empty.on{display:grid}
.inspector{position:absolute;right:18px;top:18px;width:272px;background:rgba(16,13,11,.92);backdrop-filter:blur(8px);
  border:1px solid var(--line);border-radius:2px;padding:18px;font-family:var(--font-serif);font-size:13px;color:var(--body);transition:opacity .25s;
  box-shadow:0 12px 34px rgba(0,0,0,.5)}
.insp-empty{color:var(--muted);font-style:italic;margin:0}
.insp-name{font-family:var(--font-serif);font-size:17px;color:var(--ink);margin:0 0 2px}
.insp-id{font-family:var(--font-mono);font-size:10px;color:var(--muted);letter-spacing:.1em;margin-bottom:12px}
.insp-row{display:flex;justify-content:space-between;border-top:1px solid var(--line-subtle);padding:6px 0;font-size:12.5px}
.insp-row span:last-child{color:var(--accent);font-variant-numeric:tabular-nums}
.insp-quote{margin-top:12px;padding-top:10px;border-top:1px solid var(--line-subtle);color:var(--muted);font-size:12.5px;line-height:1.8}
.insp-more{margin-top:12px;width:100%;text-align:center}

.saved-tools{display:flex;gap:10px;align-items:center;margin-bottom:20px}
.btn{appearance:none;background:transparent;border:1px solid var(--line);color:var(--ink);
  font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;padding:9px 16px;border-radius:2px;cursor:pointer;transition:.2s}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.saved-count{font-family:var(--font-mono);font-size:10.5px;color:var(--muted);margin-left:auto}
.saved-list{display:flex;flex-direction:column;gap:0}
.saved-item{display:grid;grid-template-columns:104px 1fr auto;gap:18px;padding:16px 0;border-top:1px solid var(--line-subtle);align-items:start}
.saved-item:first-child{border-top:0}
.saved-when{font-family:var(--font-mono);font-size:10.5px;color:var(--muted);letter-spacing:.04em;padding-top:3px}
.saved-text{font-family:var(--font-serif);font-size:14px;color:var(--body);line-height:1.8}
.saved-who{font-family:var(--font-serif);font-size:12px;color:var(--accent);margin-top:4px}
.saved-del{background:none;border:0;color:var(--muted);cursor:pointer;font-size:11px;padding:2px 6px}
.saved-del:hover{color:#b75a59}
.empty{font-family:var(--font-serif);color:var(--muted);font-style:italic;padding:24px 0}

.notes-head{display:flex;align-items:baseline;gap:14px;margin:48px 0 14px}
.notes-head h3{font-family:var(--font-serif);font-weight:500;font-size:19px;color:var(--ink);margin:0}
.note{width:100%;min-height:140px;background:var(--paper-2);border:1px solid var(--line-subtle);border-radius:3px;
  padding:18px;color:var(--body);font-family:var(--font-serif);font-size:14.5px;line-height:1.9;resize:vertical;outline:none}
.note:focus{border-color:var(--line)}

.feed{display:flex;flex-direction:column}
.msg{display:grid;grid-template-columns:112px 1fr auto;gap:18px;padding:12px 0;border-top:1px solid var(--line-subtle);align-items:start}
.msg:first-child{border-top:0}
.msg-when{font-family:var(--font-mono);font-size:10px;color:var(--muted);letter-spacing:.03em;padding-top:3px;line-height:1.6}
.msg-when b{display:block;color:var(--muted);font-weight:400}
.msg-body{font-family:var(--font-serif);font-size:14px;color:var(--body);line-height:1.8;word-break:break-word}
.msg-sender{font-size:12px;color:var(--accent);margin-bottom:3px}
.msg-save{background:none;border:1px solid transparent;color:var(--muted);font-family:var(--font-mono);font-size:10px;
  letter-spacing:.08em;padding:3px 8px;border-radius:2px;cursor:pointer;opacity:0;transition:.2s}
.msg:hover .msg-save{opacity:1}
.msg-save:hover{color:var(--accent);border-color:var(--line)}
.msg-save.done{opacity:1;color:var(--accent)}

.foot{max-width:1240px;margin:0 auto;padding:40px 40px 64px;border-top:1px solid var(--line-subtle);
  font-family:var(--font-mono);font-size:10.5px;color:var(--muted);letter-spacing:.04em}
.foot-dim{opacity:.7;margin-top:6px}

@media (max-width:820px){
  .mast,.tabs,main,.foot{padding-left:20px;padding-right:20px}
  .mast{padding-top:40px}
  .mast-inner{flex-direction:column;align-items:flex-start;gap:18px}
  .mast-right{text-align:left}
  .strip{gap:28px}
  .tab{padding:8px 12px;font-size:12px}
  .inspector{display:none}
  .msg,.saved-item{grid-template-columns:1fr;gap:4px}
  .msg-when,.saved-when{padding-top:0}
}
`

const JS = `
const DATA = JSON.parse(document.getElementById('d').textContent);
const LS_SAVED = 'qqarchive.saved.v1';
const LS_NOTES = 'qqarchive.notes.v1';

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

/* ---------- 工具 ---------- */
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function pad(n){return String(n).padStart(2,'0')}
function fmtTime(ts){const d=new Date(ts*1000);return {date:pad(d.getMonth()+1)+'-'+pad(d.getDate()), time:pad(d.getHours())+':'+pad(d.getMinutes())}}
/* 浏览端的大数字缩写（服务端模板里的同名函数只用于生成 HTML，进不到这里） */
function fmtNum(n){const v=Number(n)||0;return v>=10000?(v/10000).toFixed(1)+' 万':String(v)}
function load(key, fallback){try{const v=JSON.parse(localStorage.getItem(key));return v==null?fallback:v}catch{return fallback}}
function save(key, val){try{localStorage.setItem(key, JSON.stringify(val))}catch{}}

/* 只读接口：日历明细 / 词频 / 关系图切片。页面离线打开时这些会失败，界面自己会说明。 */
async function api(path){
  const res = await fetch('api/' + path, { headers: { accept: 'application/json' } });
  if(!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/* 写接口：目前只有推送开关（同源页面才能调，服务端会验 Origin）。 */
async function postJson(path, body){
  const res = await fetch('api/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body || {})
  });
  let data = null;
  try { data = await res.json() } catch {}
  if(!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

/* 极简 markdown：## 标题 / 段落 / **粗体** / \`代码\` / 链接 / 列表 */
function inline(s){
  return s
    .replace(/\`([^\`]+)\`/g, (_,c)=>'<code>'+c+'</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>')
    .replace(/(https?:\\/\\/[^\\s<，。！？、）)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
}
function md(text){
  if(!text) return ''
  return esc(text).trim().split(/\\n\\s*\\n/).map(block=>{
    if(/^### /.test(block)) return '<h2>'+inline(block.slice(4))+'</h2>'
    if(/^## /.test(block)) return '<h2>'+inline(block.slice(3))+'</h2>'
    if(/^[-*] /.test(block)) return '<p>'+block.split(/\\n/).map(l=>inline(l.replace(/^[-*] /,'— '))).join('<br>')+'</p>'
    return '<p>'+block.split(/\\n/).map(inline).join('<br>')+'</p>'
  }).join('')
}

/* ---------- 群总结：最近 7 天，按天翻 ---------- */
const NOTES = load(LS_NOTES, {});
const WEEKDAYS = ['周日','周一','周二','周三','周四','周五','周六'];
let summaryDay = DATA.reportDays.length ? DATA.reportDays[0].date : '';
function noteKey(chatKey){return summaryDay + '|' + chatKey}
function weekdayOf(date){
  const d = new Date(date + 'T00:00:00');
  return WEEKDAYS[d.getDay()] || '';
}
function currentDay(){ return DATA.reportDays.find(d=>d.date===summaryDay) || null }

function renderDayRail(){
  const rail = document.getElementById('day-rail');
  if(!DATA.reportDays.length){ rail.innerHTML = ''; return; }
  rail.innerHTML = DATA.reportDays.map(d=>{
    const md = d.date.slice(5).replace('-', '·');
    return '<button type="button" class="day'+(d.date===summaryDay?' active':'')+'" data-day="'+esc(d.date)+'">'
      + '<b>'+esc(md)+'</b>'
      + '<span>'+esc(weekdayOf(d.date))+' · '+d.cards.length+' 份</span>'
      + '</button>';
  }).join('');
  $$('.day').forEach(b=>b.addEventListener('click',()=>{
    summaryDay = b.dataset.day;
    renderDayRail();
    renderCards();
  }));
}

function renderCards(){
  const box = document.getElementById('cards');
  const day = currentDay();
  if(!day){
    box.innerHTML = '<p class="empty">最近 7 天还没有群总结。让 DSH 跑一次 <code>qq_archive action=report</code>，回来后刷新这一页。</p>';
    return;
  }
  box.innerHTML = day.cards.map((c,i)=>{
    const stats = c.stats || null;
    const words = stats && (stats.topWords||[]).length ? (stats.topWords||[]).slice(0,3).map(w=>esc(w.word)).join(' / ') : '';
    const meta = stats
      ? '消息 <b>'+stats.total+'</b> 条 · '+stats.members.length+' 人发言'+(words ? ' · 高频词 <b>'+words+'</b>' : '')
      : '';
    const note = NOTES[noteKey(c.chatKey)] || '';
    return '<article class="card" style="animation-delay:'+(i*60)+'ms">'
      + '<div class="card-head"><h3>'+esc(c.chatName)+'</h3></div>'
      + '<p class="card-meta">'+meta+'</p>'
      + '<div class="report">'+(c.text ? md(c.text) : '<p class="report-empty">这一天没有留下总结。</p>')+'</div>'
      + '<textarea class="card-note" data-chat="'+esc(c.chatKey)+'" placeholder="给这一天的这个群写一句批注……">'+esc(note)+'</textarea>'
      + '</article>';
  }).join('');

  $$('.card-note').forEach(el=>{
    el.addEventListener('input', ()=>{
      const k = noteKey(el.dataset.chat);
      if(el.value.trim()) NOTES[k] = el.value; else delete NOTES[k];
      save(LS_NOTES, NOTES);
    });
  });
}

/* ---------- 周报 / 月报 ---------- */
function renderPeriods(){
  const box = document.getElementById('periods');
  if(!box) return;
  const p = DATA.periods || {};
  const list = [].concat(p.weeks || [], p.months || []);
  if(!list.length){
    box.innerHTML = '<p class="empty">还没有周报 / 月报。让 DSH 跑 <code>qq_report kind=week</code>（或 <code>kind=month</code>）生成一篇，回来刷新这一页。</p>';
    return;
  }
  box.innerHTML = list.map(item=>{
    const st = item.stats || {};
    const kind = item.kind === 'month' ? '月报' : '周报';
    const meta = [];
    if(item.fromDate || item.toDate) meta.push(esc(item.fromDate || '') + ' ~ ' + esc(item.toDate || ''));
    if(st.total != null) meta.push('消息 <b>' + st.total + '</b> 条');
    if(st.members && st.members.length) meta.push(st.members.length + ' 人发言');
    if(st.topDays && st.topDays.length) meta.push('最吵的一天 <b>' + esc(st.topDays[0].date.slice(5)) + '</b>');
    return '<article class="period-card">'
      + '<div class="period-card-head"><h3>' + esc(item.chatName || '全部会话') + '</h3><span class="period-kind">' + kind + '</span></div>'
      + '<p class="period-meta">' + meta.join(' · ') + '</p>'
      + '<div class="report">' + (item.text ? md(item.text) : '<p class="report-empty">没有正文。</p>') + '</div>'
      + '</article>';
  }).join('');
}

/* ---------- 日报主动送达开关 ---------- */
let pushState = null;
let pushBound = false;

function pushSummary(s){
  if(!s) return '正在读推送设置……';
  if(s.offline) return '离线快照，开关要在 DSH 打开的页面里改';
  const scope = s.scope === 'all' ? '每群各一份' : '只推全群汇总';
  let out = (s.enabled ? '开' : '关') + ' · ' + scope;
  out += ' · 收件人 ' + (s.target || '未定');
  if(!s.tokenReady) out += ' · 令牌未就绪';
  if(s.lastAt){
    const t = fmtTime(s.lastAt);
    out += ' · 上次 ' + t.date + ' ' + t.time + (s.lastResult ? ' ' + s.lastResult : '');
  }
  return out;
}

function paintPush(){
  const tgl = document.getElementById('push-toggle');
  const scope = document.getElementById('push-scope');
  const test = document.getElementById('push-test');
  const state = document.getElementById('push-state');
  if(!tgl || !scope || !test || !state) return;
  const s = pushState;
  const off = !s || s.offline;
  tgl.setAttribute('aria-checked', s && s.enabled ? 'true' : 'false');
  tgl.disabled = off;
  scope.value = s && s.scope === 'all' ? 'all' : 'digest';
  scope.disabled = off;
  test.disabled = off;
  state.textContent = pushSummary(s);
  state.classList.toggle('on', !!(s && s.enabled && !s.offline));
}

function pushHint(text, bad){
  const el = document.getElementById('push-hint');
  if(!el) return;
  el.textContent = text || '';
  el.classList.toggle('bad', !!bad);
}

async function loadPush(){
  try{
    pushState = await api('push');
    pushHint('');
  }catch(err){
    pushState = { offline: true };
  }
  paintPush();
}

function renderPush(){
  const bar = document.getElementById('push-bar');
  if(!bar || pushBound) return;
  pushBound = true;
  const tgl = document.getElementById('push-toggle');
  const scope = document.getElementById('push-scope');
  const test = document.getElementById('push-test');
  paintPush();

  tgl.addEventListener('click', async ()=>{
    if(!pushState || pushState.offline) return;
    const next = !pushState.enabled;
    tgl.disabled = true;
    pushHint('正在保存……');
    try{
      const r = await postJson('push', { enabled: next });
      pushState = r.settings;
      pushHint(next ? '已打开：下次日报生成完会私聊你' : '已关闭', false);
    }catch(err){
      pushHint('保存失败：' + err.message, true);
    }
    paintPush();
  });

  scope.addEventListener('change', async ()=>{
    if(!pushState || pushState.offline) return;
    scope.disabled = true;
    pushHint('正在保存……');
    try{
      const r = await postJson('push', { scope: scope.value });
      pushState = r.settings;
      pushHint('范围已更新', false);
    }catch(err){
      pushHint('保存失败：' + err.message, true);
    }
    paintPush();
  });

  test.addEventListener('click', async ()=>{
    if(!pushState || pushState.offline) return;
    test.disabled = true;
    pushHint('正在发测试消息……');
    try{
      const r = await postJson('push', { test: true });
      if(r.settings) pushState = r.settings;
      pushHint(r.ok ? '测试消息已发出，去 QQ 看看' : ('测试失败：' + ((r.test && r.test.error) || '未知原因')), !r.ok);
    }catch(err){
      pushHint('测试失败：' + err.message, true);
    }
    paintPush();
  });

  loadPush();
}

/* ---------- 活跃日历 ---------- */
let calChat = '*';
let calRendered = false;
let dayActive = '';

function calDays(){
  const c = DATA.calendar || {};
  return (c.byChat && c.byChat[calChat]) || c.days || [];
}

function calMax(){
  const c = DATA.calendar || {};
  return c.maxDay || 1;
}

function levelOf(n, max){
  if(!n) return 0;
  const r = n / (max || 1);
  if(r > .8) return 5;
  if(r > .6) return 4;
  if(r > .4) return 3;
  if(r > .2) return 2;
  return 1;
}

function renderCalFiles(){
  const box = document.getElementById('cal-files');
  if(!box) return;
  const list = [{key:'*', name:'全部会话'}].concat(DATA.chats || []);
  box.innerHTML = list.map(c=>{
    const days = (DATA.calendar && DATA.calendar.byChat && DATA.calendar.byChat[c.key]) || (c.key === '*' ? calDays() : []);
    const total = days.reduce((s,d)=>s + d.total, 0);
    return '<button class="file' + (c.key === calChat ? ' active' : '') + '" data-key="' + esc(c.key) + '">'
      + '<b>' + esc(c.name) + '</b>' + fmtNum(total) + ' 条'
      + '</button>';
  }).join('');
  $$('#cal-files .file').forEach(b=>b.addEventListener('click', ()=>{
    if(b.dataset.key === calChat) return;
    calChat = b.dataset.key;
    dayActive = '';
    renderCalFiles();
    renderCalendars();
    renderDayDetail(null);
  }));
}

function renderCalendars(){
  const box = document.getElementById('calendars');
  if(!box) return;
  const days = calDays();
  if(!days.length){
    box.innerHTML = '<p class="empty">这段时间还没有存档。</p>';
    return;
  }
  const max = calMax();
  const months = new Map();
  for(const d of days){
    const key = d.date.slice(0, 7);
    if(!months.has(key)) months.set(key, []);
    months.get(key).push(d);
  }
  const DOW = ['一','二','三','四','五','六','日'];
  const out = [];
  for(const [key, list] of months){
    const [y, m] = key.split('-');
    const byDay = new Map(list.map(d=>[d.date, d]));
    const first = new Date(key + '-01T00:00:00');
    const daysInMonth = new Date(Number(y), Number(m), 0).getDate();
    // 周一开头：JS 的周日是 0，这里挪成周一=0
    const lead = (first.getDay() + 6) % 7;
    const cells = [];
    for(let i=0;i<lead;i++) cells.push('<span class="cal-cell empty"></span>');
    for(let day=1; day<=daysInMonth; day++){
      const date = key + '-' + pad(day);
      const cell = byDay.get(date) || { date, total: 0, speakers: 0, media: 0, links: 0 };
      const lv = levelOf(cell.total, max);
      cells.push('<button type="button" class="cal-cell' + (date === dayActive ? ' active' : '') + '" data-level="' + lv + '" data-date="' + esc(date) + '">'
        + '<span class="cal-num">' + day + '</span>'
        + (cell.total ? '<span class="cal-n">' + cell.total + '</span>' : '')
        + '</button>');
    }
    out.push('<div class="cal-month"><h3 class="cal-title">' + y + ' 年 ' + Number(m) + ' 月</h3>'
      + '<p class="cal-sub">' + list.reduce((s,d)=>s+d.total,0) + ' 条消息 · ' + list.filter(d=>d.total>0).length + ' 天有动静</p>'
      + '<div class="cal-grid">' + DOW.map(w=>'<span class="cal-dow">' + w + '</span>').join('') + cells.join('') + '</div></div>');
  }
  box.innerHTML = out.join('');
  $$('.cal-cell[data-date]').forEach(b=>b.addEventListener('click', ()=>{
    dayActive = b.dataset.date;
    $$('.cal-cell').forEach(x=>x.classList.toggle('active', x === b));
    renderDayDetail(dayActive);
  }));
}

function dayStat(d){
  return '<div class="dd-stat"><b>' + d.total + '</b><span>消息</span></div>'
    + '<div class="dd-stat"><b>' + d.speakers + '</b><span>人发言</span></div>'
    + '<div class="dd-stat"><b>' + (d.media || 0) + '</b><span>图片/语音</span></div>'
    + '<div class="dd-stat"><b>' + (d.links || 0) + '</b><span>带链接</span></div>';
}

function dayHours(d){
  const max = Math.max(1, ...(d.hourly || [0]));
  return (d.hourly || new Array(24).fill(0)).map((n,i)=>{
    const h = Math.max(2, Math.round(n / max * 100));
    return '<i class="' + (n === max && n > 0 ? 'hot' : '') + '" style="height:' + h + '%" title="' + i + ':00 · ' + n + ' 条"></i>';
  }).join('');
}

function renderDayDetail(date){
  const box = document.getElementById('day-detail');
  if(!box) return;
  if(!date){
    box.innerHTML = '<p class="empty">点日历上的某一天，看看那天发生了什么。</p>';
    return;
  }
  const hit = calDays().find(d=>d.date === date) || { date, total: 0, speakers: 0, media: 0, links: 0 };
  // 先用手上的日汇总画出来，明细再向服务要；离线打开时也不算空
  box.innerHTML = '<div class="dd-head"><h3>' + esc(date) + '</h3><span>'
    + (hit.total ? '这一天群里很热闹' : '这一天很安静') + '</span></div>'
    + '<div class="dd-grid">' + dayStat(hit) + '</div>'
    + '<div id="dd-extra"><p class="api-note">明细（时段、谁在说话）要从运行中的档案馆取。</p></div>';
  const params = 'day?date=' + encodeURIComponent(date) + '&chat=' + encodeURIComponent(calChat);
  api(params).then(d=>{
    const extra = document.getElementById('dd-extra');
    if(!extra) return;
    const topChats = (d.chats || []).map(c=>'<span class="chip">' + esc(c.name) + '<b>' + c.count + '</b></span>').join('');
    const topSenders = (d.topSenders || []).slice(0,8).map(p=>'<span class="chip">' + esc(p.name || p.userId) + '<b>' + p.count + '</b></span>').join('');
    extra.innerHTML = '<p class="mp-h">几点最吵</p><div class="dd-hours">' + dayHours(d) + '</div>'
      + (topChats ? '<p class="mp-h">这些群在说话</p><div class="mp-chips">' + topChats + '</div>' : '')
      + (topSenders ? '<p class="mp-h">谁在说</p><div class="mp-chips">' + topSenders + '</div>' : '');
  }).catch(()=>{
    const extra = document.getElementById('dd-extra');
    if(extra) extra.innerHTML = '<p class="api-note">这个页面是离线快照，拿不到当天明细。用 DSH 打开档案馆（<code>http://127.0.0.1:&lt;端口&gt;/qq-archive/</code>）就能看。</p>';
  });
}

/* ---------- 链接资源库 ---------- */
let linkDomain = '';
let linksRendered = false;

function renderLinkDomains(){
  const box = document.getElementById('link-domains');
  if(!box) return;
  const domains = (DATA.links && DATA.links.domains) || [];
  const all = '<button type="button" class="chip-btn' + (linkDomain === '' ? ' on' : '') + '" data-domain="">全部<b>' + (DATA.links ? DATA.links.total : 0) + '</b></button>';
  const rest = domains.slice(0, 14).map(d=>'<button type="button" class="chip-btn' + (linkDomain === d.domain ? ' on' : '') + '" data-domain="' + esc(d.domain) + '">' + esc(d.domain) + '<b>' + d.count + '</b></button>').join('');
  box.innerHTML = all + rest;
  $$('#link-domains .chip-btn').forEach(b=>b.addEventListener('click', ()=>{
    linkDomain = b.dataset.domain || '';
    renderLinkDomains();
    renderLinks();
  }));
}

function renderLinks(){
  const box = document.getElementById('link-list');
  if(!box) return;
  const q = (document.getElementById('link-search').value || '').trim().toLowerCase();
  const links = (DATA.links && DATA.links.links) || [];
  const hits = links.filter(l=>{
    if(linkDomain && l.domain !== linkDomain) return false;
    if(!q) return true;
    return (l.url + ' ' + (l.title || '') + ' ' + (l.chatName || '') + ' ' + (l.senderName || '')).toLowerCase().includes(q);
  });
  if(!hits.length){
    box.innerHTML = '<p class="empty">没有匹配的链接。' + (DATA.links && DATA.links.total ? '试试别的词或者换一个域名。' : '这个库还没有收进链接。') + '</p>';
    return;
  }
  box.innerHTML = hits.slice(0, 120).map(l=>{
    const t = fmtTime(l.ts);
    const title = l.title || l.url;
    return '<div class="link-item">'
      + '<div class="link-when">' + t.date + '<br>' + t.time + '</div>'
      + '<div><div class="link-title"><a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(title) + '</a></div>'
      + '<div class="link-meta"><span class="link-domain">' + esc(l.domain) + '</span> · ' + esc(l.senderName || l.senderId) + ' · ' + esc(l.chatName || l.chatKey) + '</div></div>'
      + '</div>';
  }).join('') + (hits.length > 120 ? '<p class="api-note">只显示前 120 条；完整列表用工具 <code>qq_links</code>。</p>' : '');
}

function initLinks(){
  if(linksRendered) return;
  linksRendered = true;
  renderLinkDomains();
  renderLinks();
  document.getElementById('link-search').addEventListener('input', ()=>renderLinks());
}

/* ---------- 群梗考古 ---------- */
let topicsRendered = false;

function renderTopicSuggest(){
  const box = document.getElementById('topic-suggest');
  if(!box) return;
  const words = (DATA.topics && DATA.topics.words) || [];
  box.innerHTML = words.slice(0, 18).map(w=>'<button type="button" class="chip-btn" data-word="' + esc(w.word) + '">' + esc(w.word) + '<b>' + w.count + '</b></button>').join('');
  $$('#topic-suggest .chip-btn').forEach(b=>b.addEventListener('click', ()=>{
    document.getElementById('topic-search').value = b.dataset.word;
    runTopic(b.dataset.word);
  }));
}

function renderTopic(d){
  const box = document.getElementById('topic-result');
  if(!d || !d.total){
    box.innerHTML = '<p class="empty">「' + esc((d && d.word) || '') + '」在存档里没出现过。换个词试试。</p>';
    return;
  }
  const byMonth = d.byMonth || [];
  const maxM = Math.max(1, ...byMonth.map(m=>m.count));
  const months = byMonth.map(m=>'<i class="' + (m.count === maxM ? 'hot' : '') + '" style="height:' + Math.max(4, Math.round(m.count / maxM * 100)) + '%" title="' + esc(m.month) + ' · ' + m.count + ' 次"></i>').join('');
  const chats = (d.byChat || []).slice(0, 8).map(c=>'<span class="chip">' + esc(c.name || c.chatKey) + '<b>' + c.count + '</b></span>').join('');
  const users = (d.topUsers || []).slice(0, 8).map(u=>'<span class="chip">' + esc(u.name || u.userId) + '<b>' + u.count + '</b></span>').join('');
  const samples = (d.samples || []).slice(0, 8).map(s=>{
    const t = fmtTime(s.ts);
    return '<div class="sample"><time>' + t.date + ' ' + t.time + ' · ' + esc(s.chatName || s.chatKey) + '</time>'
      + '<span class="who">' + esc(s.senderName || s.senderId) + '</span>'
      + '<span class="txt">' + esc(s.text) + '</span></div>';
  }).join('');
  box.innerHTML = '<p class="topic-big">' + esc(d.word) + '</p>'
    + '<p class="topic-body">第一次出现在 ' + esc(fmtTime(d.first && d.first.ts || 0).date) + ' · 最近一次 ' + esc(fmtTime(d.last && d.last.ts || 0).date) + '</p>'
    + '<div class="topic-grid">'
      + '<div class="topic-stat"><b>' + d.total + '</b><span>总出现次数</span></div>'
      + '<div class="topic-stat"><b>' + (d.byChat || []).length + '</b><span>出现在几个群</span></div>'
      + '<div class="topic-stat"><b>' + (d.topUsers || []).length + '</b><span>提过的人</span></div>'
    + '</div>'
    + '<p class="mp-h">按月的热度</p><div class="topic-months">' + months + '</div>'
    + (chats ? '<p class="mp-h">在哪些群</p><div class="mp-chips">' + chats + '</div>' : '')
    + (users ? '<p class="mp-h">谁最爱说</p><div class="mp-chips">' + users + '</div>' : '')
    + '<p class="mp-h">当时的语境</p>' + samples;
}

function runTopic(word){
  const box = document.getElementById('topic-result');
  word = String(word || '').trim();
  if(!word) return;
  box.innerHTML = '<p class="api-note">正在翻旧账……</p>';
  api('topic?word=' + encodeURIComponent(word) + '&chat=' + encodeURIComponent(calChat))
    .then(d=>renderTopic(d))
    .catch(()=>{
      box.innerHTML = '<p class="api-note">这个页面是离线快照，查不了实时词频。用 DSH 里的档案馆页面（<code>http://127.0.0.1:&lt;端口&gt;/qq-archive/</code>）来考古。</p>';
    });
}

function initTopics(){
  if(topicsRendered) return;
  topicsRendered = true;
  renderTopicSuggest();
  document.getElementById('topic-go').addEventListener('click', ()=>runTopic(document.getElementById('topic-search').value));
  document.getElementById('topic-search').addEventListener('keydown', e=>{
    if(e.key === 'Enter') runTopic(e.target.value);
  });
}

/* ---------- 名场面 ---------- */
let highlightsRendered = false;

function renderHighlights(){
  const box = document.getElementById('highlight-list');
  if(!box) return;
  const list = DATA.highlights || [];
  if(!list.length){
    box.innerHTML = '<p class="hl-empty">还没有抓过名场面。让 DSH 跑一次 <code>qq_highlights</code>，它会找出突然刷屏的时段并写摘要。</p>';
    return;
  }
  box.innerHTML = list.map(h=>{
    const st = h.stats || {};
    const from = fmtTime(h.fromTs || 0);
    const to = fmtTime(h.toTs || 0);
    const parts = (st.participants || []).slice(0, 6).map(p=>esc(p.name || p.userId) + ' ' + p.count).join(' / ');
    const samples = (st.samples || []).slice(0, 5).map(s=>{
      return '<div class="sample"><time>' + esc(fmtTime(s.ts || 0).time) + '</time>'
        + '<span class="who">' + esc(s.senderName || '') + '</span>'
        + '<span class="txt">' + esc(s.text || '') + '</span></div>';
    }).join('');
    return '<article class="hl-card">'
      + '<div class="hl-head"><h3>' + esc(h.chatName || h.chatKey) + '</h3><span class="hl-time">' + from.date + ' ' + from.time + ' ~ ' + to.time + '</span></div>'
      + '<p class="hl-meta">爆聊 <b>' + (h.count || st.newCount || 0) + '</b> 条' + (parts ? ' · ' + parts : '') + '</p>'
      + '<div class="hl-summary">' + (h.summary ? md(h.summary) : '<span class="hl-empty">还没有摘要。</span>') + '</div>'
      + (samples ? '<div class="hl-samples">' + samples + '</div>' : '')
      + '</article>';
  }).join('');
}

function initHighlights(){
  if(highlightsRendered) return;
  highlightsRendered = true;
  renderHighlights();
}

/* ---------- 榜单 ---------- */
let rankRendered = false;

function deltaText(d){
  if(d.status === 'new') return '<span class="rank-delta new">新面孔</span>';
  if(d.status === 'gone') return '<span class="rank-delta gone">失踪</span>';
  if(d.delta > 0) return '<span class="rank-delta up">+' + d.delta + '</span>';
  if(d.delta < 0) return '<span class="rank-delta down">' + d.delta + '</span>';
  return '<span class="rank-delta flat">±0</span>';
}

function renderRank(){
  const sum = document.getElementById('rank-summary');
  const peopleBox = document.getElementById('rank-people');
  const missBox = document.getElementById('rank-missing');
  if(!sum || !peopleBox || !missBox) return;
  const r = DATA.leaderboard;
  if(!r){
    sum.innerHTML = '';
    peopleBox.innerHTML = '<p class="empty">还没有周对比数据。</p>';
    missBox.innerHTML = '';
    return;
  }
  const t = r.totals || { cur: 0, prev: 0, delta: 0 };
  const partial = !!(r.week && r.week.partial);
  const curLabel = partial ? '本周至今' : '本周';
  const prevLabel = partial ? '上周同期' : '上周';
  const pct = t.prev ? Math.round(t.delta / t.prev * 100) : null;
  const active = (r.people || []).filter(p => p.cur > 0);
  sum.innerHTML = '<span>' + curLabel + ' <b>' + fmtNum(t.cur) + '</b>条</span>'
    + '<span>' + prevLabel + ' <b>' + fmtNum(t.prev) + '</b>条</span>'
    + '<span>环比 <b>' + (pct == null ? '—' : (pct > 0 ? '+' : '') + pct + '%') + '</b></span>'
    + '<span>' + curLabel + ' <b>' + active.length + '</b>人上榜</span>';
  const people = active.slice(0, 24);
  peopleBox.innerHTML = people.length ? people.map((p,i)=>{
    const name = p.name || p.userId;
    const where = (p.chats && p.chats[0] && p.chats[0].name) || '';
    return '<div class="rank-row">'
      + '<span class="rank-no">' + pad(i + 1) + '</span>'
      + '<span class="rank-name">' + esc(name)
      + '<small>QQ ' + esc(p.userId) + (where ? ' · ' + esc(where) : '') + '</small></span>'
      + '<span class="rank-cur">' + p.cur + '</span>'
      + deltaText(p) + '</div>';
  }).join('') : '<p class="empty">' + curLabel + '还没有人说话。</p>';
  const miss = (r.missing || []).slice(0, 14);
  missBox.innerHTML = miss.length ? miss.map(m=>{
    return '<div class="rank-row">'
      + '<span class="rank-no">—</span>'
      + '<span class="rank-name">' + esc(m.name || m.userId) + '<small>' + prevLabel + ' ' + m.prev + ' 条</small></span>'
      + '<span class="rank-cur">' + (m.lastTs ? fmtTime(m.lastTs).date : '') + '</span>'
      + '<span class="rank-delta gone">最后一次</span></div>';
  }).join('') : '<p class="empty">' + prevLabel + '说话的人都还在，没有人失踪。</p>';
}

function initRank(){
  if(rankRendered) return;
  rankRendered = true;
  renderRank();
}

/* ---------- 人事图时间切片 ---------- */
const GRAPH_RANGE_KEYS = [['all','全部时间'],['week','本周'],['lastweek','上周'],['month','本月']];
let graphRange = 'all';
let graphRangeRendered = false;
const graphCache = new Map();

function graphDataFor(chatKey){
  if(graphRange === 'all') return DATA.graphs[chatKey] || DATA.graph;
  return graphCache.get(chatKey + '|' + graphRange) || null;
}

function renderGraphRanges(){
  const box = document.getElementById('graph-ranges');
  if(!box) return;
  box.innerHTML = GRAPH_RANGE_KEYS.map(([key,label])=>{
    return '<button type="button" class="railtab' + (graphRange === key ? ' on' : '') + '" data-range="' + key + '">' + label + '</button>';
  }).join('');
  $$('#graph-ranges .railtab').forEach(b=>b.addEventListener('click', ()=>{
    graphRange = b.dataset.range;
    renderGraphRanges();
    mountBoard();
  }));
}

async function mountBoardAsync(){
  cancelAnimationFrame(boardRaf);
  const old = document.getElementById('net');
  old.replaceWith(old.cloneNode(false));
  const cached = graphDataFor(boardChat);
  if(cached){ renderGraph(boardChat, cached); return }
  const empty = document.getElementById('board-empty');
  empty.textContent = '正在按时间切片翻卷宗……';
  empty.classList.add('on');
  try {
    const payload = await api('graph?chat=' + encodeURIComponent(boardChat) + '&range=' + encodeURIComponent(graphRange));
    // 接口回的是 { range, label, fromTs, toTs, fromDate, toDate, graph }，板子只吃 graph
    const g = payload && payload.graph ? payload.graph : payload;
    graphCache.set(boardChat + '|' + graphRange, g);
    empty.classList.remove('on');
    renderGraph(boardChat, g);
  } catch (err) {
    empty.textContent = '这个时间切片取不到数据（离线快照只能看全部时间）。';
  }
}

/* ---------- 收藏 ---------- */
let SAVED = load(LS_SAVED, []);
function savedKey(m){return m.chatKey + ':' + m.id}

function renderSaved(){
  const list = document.getElementById('saved-list');
  document.getElementById('saved-count').textContent = SAVED.length ? SAVED.length + ' 条收藏' : '';
  if(!SAVED.length){
    list.innerHTML = '<p class="empty">还没有收藏。翻到「本月档案」，把值得留的那句捡进来。</p>';
    return;
  }
  list.innerHTML = SAVED.slice().reverse().map(m=>{
    const t = fmtTime(m.ts);
    return '<div class="saved-item">'
      + '<div class="saved-when">'+t.date+'<br>'+t.time+'</div>'
      + '<div><div class="saved-text">'+esc(m.text)+'</div><div class="saved-who">'+esc(m.sender)+' · '+esc(m.chatName)+'</div></div>'
      + '<button class="saved-del" data-del="'+esc(savedKey(m))+'">移出</button>'
      + '</div>';
  }).join('');
  $$('.saved-del').forEach(b=>b.addEventListener('click',()=>{
    SAVED = SAVED.filter(m=>savedKey(m)!==b.dataset.del);
    save(LS_SAVED,SAVED); renderSaved(); markSavedInFeed();
  }));
}

function markSavedInFeed(){
  const set = new Set(SAVED.map(savedKey));
  $$('.msg-save').forEach(b=>{
    const on = set.has(b.dataset.key);
    b.classList.toggle('done', on);
    b.textContent = on ? '已收藏' : '收藏';
  });
}

/* ---------- 消息流 ---------- */
function renderFeed(){
  const box = document.getElementById('feed');
  box.innerHTML = DATA.feed.map(m=>{
    const t = fmtTime(m.ts);
    return '<div class="msg">'
      + '<div class="msg-when"><b>'+t.date+'</b>'+t.time+'</div>'
      + '<div class="msg-body"><div class="msg-sender">'+esc(m.sender)+' · '+esc(m.chatName)+'</div>'+esc(m.text)+'</div>'
      + '<button class="msg-save" data-key="'+esc(savedKey(m))+'" data-id="'+m.id+'">收藏</button>'
      + '</div>';
  }).join('');
  $$('.msg-save').forEach(b=>b.addEventListener('click',()=>{
    const m = DATA.feed.find(x=>String(x.id)===String(b.dataset.id));
    if(!m) return;
    const k = savedKey(m);
    if(SAVED.some(x=>savedKey(x)===k)){ SAVED = SAVED.filter(x=>savedKey(x)!==k) }
    else { SAVED.push(m) }
    save(LS_SAVED,SAVED); renderSaved(); markSavedInFeed();
  }));
  markSavedInFeed();
}

/* ---------- 探案板 ---------- */
let boardChat = '*';
let boardRaf = 0;

function renderFiles(){
  const box = document.getElementById('case-files');
  const keys = ['*', ...DATA.chats.map(c=>c.key)];
  box.innerHTML = keys.map(k=>{
    const gd = graphDataFor(k) || DATA.graphs[k] || {nodes:[],edges:[]};
    const name = k==='*' ? '全部卷宗' : ((DATA.chats.find(c=>c.key===k)||{}).name || k);
    const shown = Math.min(gd.edges.length, Math.max(16, Math.round(gd.nodes.length * 1.05)));
    return '<button class="file'+(boardChat===k?' active':'')+'" data-key="'+esc(k)+'">'
      + '<b>'+esc(name)+'</b>'+gd.nodes.length+' 人上板 · '+shown+' 条红线</button>';
  }).join('');
  $$('.file').forEach(b=>b.addEventListener('click',()=>{
    if(boardChat===b.dataset.key) return;
    boardChat = b.dataset.key;
    $$('.file').forEach(x=>x.classList.toggle('active',x===b));
    mountBoard();
  }));
}

function mountBoard(){
  void mountBoardAsync();
}

function renderGraph(chatKey, graphData){
  const cv = document.getElementById('net');
  const box = cv.parentElement;
  const empty = document.getElementById('board-empty');
  const insp = document.getElementById('inspector');
  if(!graphData.nodes.length){
    empty.classList.add('on');
    cv.style.display = 'none';
    insp.innerHTML = '<p class="insp-empty">这块板子还空着。</p>';
    return;
  }
  empty.classList.remove('on');
  cv.style.display = '';
  const dpr = Math.min(window.devicePixelRatio||1, 2);
  const W = box.clientWidth || 900, H = box.clientHeight || 600;
  // 右侧留给线索卡，照片只钉在左边这块板面上
  const plotW = W - (W > 920 ? 300 : 0);
  cv.width = W*dpr; cv.height = H*dpr; cv.style.height = H+'px';
  const g = cv.getContext('2d'); g.scale(dpr,dpr);

  const total = graphData.nodes.length;
  const N = graphData.nodes.map((n,i)=>{
    const a = (i/total)*Math.PI*2;
    return {...n, x: plotW/2 + Math.cos(a)*Math.min(plotW,H)*0.32 + (Math.random()-.5)*40,
                  y: H/2 + Math.sin(a)*Math.min(W,H)*0.3 + (Math.random()-.5)*40, vx:0, vy:0,
                  r: 34};
  });
  const byId = new Map(N.map(n=>[n.id,n]));
  // 板子上只钉一部分红线：留最强的那些，剩下的当背景纹理，不然整块板子像一团毛线。
  // 每人最多挂两条，免得所有线都堆在同一个活跃的人身上。
  const allEdges = graphData.edges.filter(e=>byId.has(e.source)&&byId.has(e.target))
  const keep = Math.max(16, Math.round(total * 1.05))
  const perNode = new Map()
  const L = []
  for(const e of [...allEdges].sort((a,b)=>b.count-a.count)){
    if(L.length >= keep) break
    const da = perNode.get(e.source) || 0
    const tn = perNode.get(e.target) || 0
    if(da >= 2 || tn >= 2) continue
    perNode.set(e.source, da+1); perNode.set(e.target, tn+1)
    L.push({ ...e, a:byId.get(e.source), b:byId.get(e.target) })
  }
  const maxEdge = L.length ? L[0].count : 1

  let hover=null, pinned=null;
  const K=5200, LINK=168, DAMP=.86;

  function tick(){
    for(let i=0;i<N.length;i++){
      const a=N[i];
      for(let j=i+1;j<N.length;j++){
        const b=N[j];
        let dx=b.x-a.x, dy=b.y-a.y, d2=dx*dx+dy*dy||.01;
        if(d2>90000) continue;
        const f=K/d2, d=Math.sqrt(d2);
        const fx=dx/d*f, fy=dy/d*f;
        a.vx-=fx; a.vy-=fy; b.vx+=fx; b.vy+=fy;
      }
      a.vx += (plotW/2-a.x)*0.0019;
      a.vy += (H/2-a.y)*0.0019;
    }
    for(const l of L){
      let dx=l.b.x-l.a.x, dy=l.b.y-l.a.y, d=Math.hypot(dx,dy)||.01;
      const f=(d-LINK)*0.012*(1+Math.min(l.count,10)*0.12);
      const fx=dx/d*f, fy=dy/d*f;
      l.a.vx+=fx; l.a.vy+=fy; l.b.vx-=fx; l.b.vy-=fy;
    }
    for(const n of N){
      n.vx*=DAMP; n.vy*=DAMP;
      n.x+=n.vx; n.y+=n.vy;
      const pad=n.r+34;
      if(n.x<pad){n.x=pad;n.vx*=-.5} if(n.x>plotW-pad){n.x=plotW-pad;n.vx*=-.5}
      if(n.y<pad){n.y=pad;n.vy*=-.5} if(n.y>H-pad){n.y=H-pad;n.vy*=-.5}
    }
  }

  const related = new Set();
  function neighbors(n){
    related.clear();
    if(!n) return;
    related.add(n.id);
    for(const l of L){
      if(l.a.id===n.id) related.add(l.b.id);
      if(l.b.id===n.id) related.add(l.a.id);
    }
  }

  function drawCard(n, dim, focus){
    const w=44, h=50, x=n.x-w/2, y=n.y-h/2;
    g.save();
    g.globalAlpha = dim ? .26 : 1;
    g.shadowColor='rgba(0,0,0,.55)'; g.shadowBlur=12; g.shadowOffsetY=4;
    g.fillStyle = focus ? '#f6e9cd' : '#e3d5b9';
    g.beginPath();
    if(g.roundRect) g.roundRect(x,y,w,h,2); else g.rect(x,y,w,h);
    g.fill();
    g.shadowColor='transparent'; g.shadowBlur=0; g.shadowOffsetY=0;
    // 图钉
    g.beginPath(); g.arc(n.x, y+6, 3.2, 0, 7); g.fillStyle='#b03a2e'; g.fill();
    g.beginPath(); g.arc(n.x-1, y+5, 1.1, 0, 7); g.fillStyle='rgba(255,255,255,.6)'; g.fill();
    // 首字
    g.textAlign='center'; g.textBaseline='middle';
    g.fillStyle='#2b2119';
    g.font='600 18px "Noto Serif SC","Songti SC",serif';
    g.fillText(String(n.name||'?').slice(0,1), n.x, y+h/2+3);
    // 名字
    g.textBaseline='top';
    g.font='10px ui-monospace,monospace';
    g.fillStyle = focus ? '#f4e7cd' : 'rgba(232,220,196,.52)';
    g.fillText(n.name.length>7?n.name.slice(0,7)+'…':n.name, n.x, y+h+8);
    if(focus){
      g.strokeStyle='rgba(186,74,60,.85)'; g.lineWidth=1.5;
      g.beginPath();
      if(g.roundRect) g.roundRect(x-4,y-4,w+8,h+8,3); else g.rect(x-4,y-4,w+8,h+8);
      g.stroke();
    }
    g.restore();
  }

  function draw(){
    g.clearRect(0,0,W,H);
    const focus = pinned || hover;
    for(const l of L){
      const active = focus && (l.a.id===focus.id || l.b.id===focus.id);
      const dim = focus && !active;
      const mx=(l.a.x+l.b.x)/2, my=(l.a.y+l.b.y)/2 + 14;
      g.beginPath(); g.moveTo(l.a.x,l.a.y); g.quadraticCurveTo(mx,my,l.b.x,l.b.y);
      // 大部分线只是很淡的底纹，只有 @ 得多的那几根看得出来
      const rel = Math.min(1, l.count / maxEdge);
      const w = 0.55 + Math.log(1+l.count)*0.75;
      const a = 0.09 + 0.26 * Math.pow(rel, 0.55);
      g.strokeStyle = active ? 'rgba(198,64,50,.8)' : dim ? 'rgba(198,64,50,.04)' : 'rgba(190,78,62,'+a.toFixed(3)+')';
      g.lineWidth = active ? w*1.4 : w;
      g.stroke();
      if(active){
        g.beginPath(); g.arc(mx,my,2.2,0,7); g.fillStyle='rgba(230,120,100,.9)'; g.fill();
      }
    }
    for(const n of N){
      drawCard(n, focus && !related.has(n.id), n===focus);
    }
  }

  function loop(){ tick(); draw(); boardRaf = requestAnimationFrame(loop) }
  loop();

  function hit(x,y){
    let best=null,bd=1e9;
    for(const n of N){ const d=Math.hypot(n.x-x,n.y-y); if(d<30 && d<bd){bd=d;best=n} }
    return best;
  }
  cv.addEventListener('mousemove', e=>{
    const rect=cv.getBoundingClientRect();
    const n=hit(e.clientX-rect.left, e.clientY-rect.top);
    if(n!==hover){ hover=n; neighbors(hover) }
    cv.style.cursor = n ? 'pointer' : 'crosshair';
  });
  cv.addEventListener('mouseleave', ()=>{ hover=null; neighbors(null) });
  cv.addEventListener('click', e=>{
    const rect=cv.getBoundingClientRect();
    const n=hit(e.clientX-rect.left, e.clientY-rect.top);
    pinned = (pinned===n ? null : n);
    neighbors(pinned||hover);
    showInspector(pinned);
  });
  function showInspector(n){
    const box=document.getElementById('inspector');
    if(!n){ box.innerHTML='<p class="insp-empty">把光标放到一张照片上，看看这个人。</p>'; return }
    const imp = DATA.profiles[n.id];
    box.innerHTML = '<p class="insp-name">'+esc(n.name)+'</p>'
      + '<p class="insp-id">QQ '+esc(n.id)+'</p>'
      + '<div class="insp-row"><span>发言</span><span>'+n.count+' 条</span></div>'
      + '<div class="insp-row"><span>@ 过别人</span><span>'+n.out+' 次</span></div>'
      + '<div class="insp-row"><span>被 @</span><span>'+n.in+' 次</span></div>'
      + (imp ? '<p class="insp-quote">'+esc(imp)+'</p>' : '<p class="insp-quote">还没有人物印象。让 DSH 跑一次 qq_people who='+esc(n.id)+' impression=true。</p>')
      + '<button class="btn insp-more">看完整档案</button>';
    const more = box.querySelector('.insp-more');
    if(more) more.addEventListener('click', ()=>{
      const tab = $$('.tab').find(t=>t.dataset.tab==='people');
      if(tab) tab.click();
      openPerson(n.id);
    });
  }
}

/* ---------- 群友档案 ---------- */
let peopleRendered = false;

function hourBars(hours){
  const max = Math.max(1, ...hours);
  return hours.map((n,i)=>{
    const h = Math.max(2, Math.round(n/max*100));
    return '<i class="'+(n===max?'hot':'')+'" style="height:'+h+'%" title="'+i+':00 · '+n+' 条"></i>';
  }).join('');
}

let peopleChat = '*';

function peopleList(){
  const m = DATA.peopleByChat || {};
  return m[peopleChat] || m['*'] || [];
}

function renderPeopleFiles(){
  const box = document.getElementById('people-files');
  if(!box) return;
  const list = [{key:'*', name:'全部群友'}].concat(DATA.chats || []);
  box.innerHTML = list.map(c=>{
    const ps = (DATA.peopleByChat || {})[c.key] || [];
    const on = c.key === peopleChat ? ' on' : '';
    return '<button class="file'+on+'" data-key="'+esc(c.key)+'"><b>'+esc(c.name)+'</b>'
      + '<span>'+ps.length+' 人</span></button>';
  }).join('');
  $$('#people-files .file').forEach(b=>b.addEventListener('click', ()=>{
    peopleChat = b.dataset.key;
    const s = document.getElementById('people-search');
    if(s) s.value = '';
    renderPeopleFiles();
    renderPeople();
  }));
}

function renderPeople(){
  const grid = document.getElementById('people-grid');
  const list = peopleList();
  if(!list.length){
    grid.innerHTML = '<p class="empty">这个群里还没有群友档案。先同步一批消息，或者换一个群看看。</p>';
    return;
  }
  grid.innerHTML = list.map(p=>{
    const name = p.aliases[0] || p.userId;
    const initial = name.slice(0,1);
    const search = (p.aliases.join(' ') + ' ' + p.userId).toLowerCase();
    const imp = p.impression ? '<span class="person-quote">'+esc(p.impression)+'</span>' : '';
    const tags = (p.tags||[]).slice(0,4).map(t=>'<span class="tag">'+esc(t)+'</span>').join('');
    return '<button class="person" data-id="'+esc(p.userId)+'" data-search="'+esc(search)+'">'
      + '<span class="avatar">'+esc(initial)+'</span>'
      + '<span class="person-main">'
      + '<span class="person-name">'+esc(name)+'</span>'
      + '<span class="person-id">QQ '+esc(p.userId)+'</span>'
      + '<span class="person-line"><b>'+p.total+'</b> 条 · '+p.chats.length+' 个会话'
      + (p.mentionsOut.length ? ' · @ '+p.mentionsOut.length+' 人' : '')+'</span>'
      + imp
      + (tags ? '<span class="person-tags">'+tags+'</span>' : '')
      + '</span></button>';
  }).join('');
  $$('.person').forEach(b=>b.addEventListener('click', ()=>openPerson(b.dataset.id)));
}

function openPerson(id){
  const p = peopleList().find(x=>x.userId===id);
  if(!p) return;
  const name = p.aliases[0] || p.userId;
  const body = document.getElementById('person-body');
  const imp = p.impression
    ? '<p class="mp-quote">'+esc(p.impression)+'</p>'
    : '<p class="mp-empty">还没有人物印象。让 DSH 跑一次 qq_people who='+esc(p.userId)+' impression=true，或者等晚上的批量生成。</p>';
  const peak = p.peak && p.peak.length
    ? p.peak.map(x=>esc(x.label)+'（'+x.pct+'%）').join('、')
    : '还没有明显的高峰';
  const words = (p.topWords||[]).slice(0,12).map(w=>'<span class="chip">'+esc(w.word)+'<b>'+w.count+'</b></span>').join('');
  const out = (p.mentionsOut||[]).slice(0,8).map(m=>'<span class="chip">'+esc(m.name||m.userId)+'<b>'+m.count+'</b></span>').join('');
  const inn = (p.mentionedBy||[]).slice(0,8).map(m=>'<span class="chip">'+esc(m.name||m.userId)+'<b>'+m.count+'</b></span>').join('');
  const chats = (p.chats||[]).slice(0,8).map(c=>'<span class="chip">'+esc(c.name)+'<b>'+c.msgCount+'</b></span>').join('');
  const recent = (p.recent||[]).slice(0,8).map(r=>'<p class="mp-msg"><time>'+esc(r.time)+'</time>'+esc(r.text)+'</p>').join('');
  const tags = (p.tags||[]).map(t=>'<span class="tag">'+esc(t)+'</span>').join('');
  body.innerHTML =
    '<div class="mp-head"><span class="avatar">'+esc(name.slice(0,1))+'</span>'
    + '<div><p class="mp-name">'+esc(name)+'</p>'
    + '<p class="mp-id">QQ '+esc(p.userId)+(p.aliases.length>1?' · 也叫 '+esc(p.aliases.slice(1,4).join('、')):'')+'</p></div></div>'
    + '<div class="mp-grid">'
    + '<div class="mp-stat"><b>'+p.total+'</b><span>发言条数</span></div>'
    + '<div class="mp-stat"><b>'+p.chats.length+'</b><span>会话</span></div>'
    + '<div class="mp-stat"><b>'+p.links+'</b><span>带链接</span></div>'
    + '<div class="mp-stat"><b>'+esc(fmtTime(p.firstTs||0).date)+'</b><span>第一次说话</span></div>'
    + '<div class="mp-stat"><b>'+esc(fmtTime(p.lastTs||0).date)+'</b><span>最近一次</span></div>'
    + '</div>'
    + '<p class="mp-h">人物印象</p>' + imp
    + (tags ? '<div class="person-tags" style="margin-top:12px">'+tags+'</div>' : '')
    + '<p class="mp-h">一天里什么时候出现</p>'
    + '<div class="hours">'+hourBars(p.hours)+'</div>'
    + '<div class="hours-x"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>'
    + '<p class="mp-empty" style="margin-top:10px">常出没：'+peak+'</p>'
    + (words ? '<p class="mp-h">常说的话</p><div class="mp-chips">'+words+'</div>' : '')
    + (chats ? '<p class="mp-h">在哪些会话</p><div class="mp-chips">'+chats+'</div>' : '')
    + ((out || inn) ? '<p class="mp-h">@ 的关系</p>' : '')
    + (out ? '<div class="mp-chips" style="margin-bottom:10px"><span class="mp-empty" style="margin-right:6px">@ 过</span>'+out+'</div>' : '')
    + (inn ? '<div class="mp-chips"><span class="mp-empty" style="margin-right:6px">被</span>'+inn+'</div>' : '')
    + (recent ? '<p class="mp-h">最近说过</p><div class="mp-list">'+recent+'</div>' : '')
    + '<div class="mp-actions">'
    + (location.protocol === 'file:'
      ? '<span class="mp-empty">档案卡导出要从运行中的档案馆页面打开（不能直接双击 HTML 文件）。</span>'
      : '<a class="btn" download="qq-card-' + esc(p.userId) + '.png" href="card?chat=' + encodeURIComponent(peopleChat) + '&user=' + encodeURIComponent(p.userId) + '">导出档案卡 PNG</a>'
        + '<a class="btn" download="qq-card-' + esc(p.userId) + '.html" href="card?chat=' + encodeURIComponent(peopleChat) + '&user=' + encodeURIComponent(p.userId) + '&format=html">导出档案卡 HTML</a>')
    + '</div>';

  document.getElementById('person-modal').classList.add('on');
}

function closePerson(){
  document.getElementById('person-modal').classList.remove('on');
}

document.getElementById('person-close').addEventListener('click', closePerson);
document.getElementById('person-modal').addEventListener('click', e=>{
  if(e.target.id==='person-modal') closePerson();
});
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closePerson() });
document.getElementById('people-search').addEventListener('input', e=>{
  const q = e.target.value.trim().toLowerCase();
  $$('.person').forEach(el=>{
    el.style.display = !q || (el.dataset.search||'').includes(q) ? '' : 'none';
  });
});

/* ---------- tabs ---------- */
let graphInited = false;
$$('.tab').forEach(t=>t.addEventListener('click',()=>{
  const name = t.dataset.tab;
  $$('.tab').forEach(x=>x.classList.toggle('active',x===t));
  $$('.panel').forEach(p=>p.classList.toggle('active', p.id==='panel-'+name));
  if(name==='calendar' && !calRendered){ calRendered = true; renderCalFiles(); renderCalendars() }
  if(name==='links') initLinks();
  if(name==='topics') initTopics();
  if(name==='highlights') initHighlights();
  if(name==='rank') initRank();
  if(name==='graph' && !graphInited){ graphInited = true; renderGraphRanges(); renderFiles(); mountBoard() }
  if(name==='people' && !peopleRendered){ peopleRendered = true; renderPeopleFiles(); renderPeople() }
}));

/* ---------- 导出 ---------- */
function download(name, text, type){
  const blob=new Blob([text],{type:type||'text/plain;charset=utf-8'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}
document.getElementById('export-json').addEventListener('click',()=>{
  const pack = { archive:'qq', date:DATA.today, exportedAt:new Date().toISOString(),
    saved:SAVED, notes:NOTES, reportDays:DATA.reportDays };
  download('qq-archive-'+DATA.today+'.json', JSON.stringify(pack,null,2), 'application/json');
});
document.getElementById('export-md').addEventListener('click',()=>{
  const lines=['# 群聊档案馆 · '+DATA.today,'', '> 导出于 '+new Date().toLocaleString('zh-CN'),''];
  for(const d of DATA.reportDays){
    lines.push('## '+d.date,'');
    for(const c of d.cards){
      lines.push('### '+c.chatName,'');
      if(c.text) lines.push(c.text, ''); else lines.push('（这一天没有总结）','');
      const k=d.date+'|'+c.chatKey;
      if(NOTES[k]) lines.push('> 批注：'+NOTES[k], '');
    }
  }
  if(SAVED.length){
    lines.push('## 收藏','');
    for(const m of SAVED.slice().reverse()){
      const t=fmtTime(m.ts);
      lines.push('- '+t.date+' '+t.time+' · '+m.sender+'（'+m.chatName+'）：'+m.text);
    }
  }
  download('qq-archive-'+DATA.today+'.md', lines.join('\\n'), 'text/markdown;charset=utf-8');
});

/* ---------- 启动 ---------- */
renderDayRail();
renderCards();
renderPeriods();
renderPush();
renderSaved();
renderFeed();
window.addEventListener('resize', ()=>{ /* 力导向画布在首次打开人事图时按当时尺寸创建 */ });
`