/**
 * 本地看板：单文件 HTML，深色「档案馆」风格。
 *
 * 数据在导出时快照进 HTML；收藏与批注存在浏览器 localStorage，
 * 「导出存档」把这两样和当天日报一起落成文件——这才算永久档。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildGraph } from './graph.mjs'
import { buildProfile } from './people.mjs'
import { dayBounds } from './report.mjs'

const PLACEHOLDER_RE = /^\[[^\]]{1,6}\]$/

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
 * 导出看板用的全部数据。
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function buildDashboardData(db, { home = '', feedLimit = 300, peopleLimit = 60, peoplePerChat = 40 } = {}) {
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

  const reportRows = db.prepare('select date, chat_key, text, stats, model from reports').all()
  const reportMap = new Map(reportRows.map((r) => [`${r.date}|${r.chat_key}`, r]))

  const reportCards = []
  const keys = ['*', ...chats.map((c) => c.key)]
  for (const key of keys) {
    const t = reportMap.get(`${today.day}|${key}`)
    const y = reportMap.get(`${yesterday.day}|${key}`)
    if (!t && !y && key !== '*') continue
    reportCards.push({
      chatKey: key,
      chatName: chatNameOf(db, key),
      today: t ? { text: t.text, model: t.model, stats: safeJson(t.stats) } : null,
      yesterday: y ? { text: y.text, model: y.model, stats: safeJson(y.stats) } : null,
    })
  }

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

  const graph = buildGraph(db, { sinceTs: 0, maxNodes: 70 })

  // 一个群一块探案板：每个会话单独算一份 @ 关系，外加一块「全部」（只画最活跃的 50 人，免得板子挤成一团）
  const graphs = { '*': buildGraph(db, { sinceTs: 0, maxNodes: 50 }) }
  for (const c of chats) {
    graphs[c.key] = buildGraph(db, { chatKey: c.key, sinceTs: 0, maxNodes: 45 })
  }

  const profiles = {}
  const profileRows = db.prepare("select user_id, impression, tags from profiles where chat_key = '*'").all()
  for (const r of profileRows) {
    if (r.impression) profiles[String(r.user_id)] = String(r.impression)
  }

  // 群友档案：先选群，再看这个群里的人。
  // 「全部」跨群汇总取前 peopleLimit 人；每个群各取该群发言最多的 peoplePerChat 人。
  const chatNames = new Map(chats.map((c) => [c.key, c.name]))
  const tagOf = new Map()
  for (const r of profileRows) {
    let tags = []
    try {
      const v = r.tags ? JSON.parse(r.tags) : []
      if (Array.isArray(v)) tags = v
    } catch {}
    tagOf.set(String(r.user_id), tags)
  }
  const buildPeople = (chatKey, limit) => {
    const rows = chatKey
      ? db
          .prepare(
            "select sender_id as user_id, count(*) as n from messages where chat_key = ? and sender_id <> '' group by sender_id order by n desc limit ?",
          )
          .all(chatKey, limit)
      : db
          .prepare('select user_id, sum(msg_count) as n from members group by user_id order by n desc limit ?')
          .all(limit)
    return rows.map((row) => {
      const userId = String(row.user_id)
      const p = buildProfile(db, chatNames, { userId, chatKey, topLimit: 500 })
      const { summary, ...rest } = p
      return { ...rest, impression: profiles[userId] || '', tags: tagOf.get(userId) || [] }
    })
  }
  const peopleByChat = { '*': buildPeople(null, peopleLimit) }
  for (const c of chats) peopleByChat[c.key] = buildPeople(c.key, peoplePerChat)

  const totalMsgs = db.prepare('select count(*) c from messages').get().c
  return {
    generatedAt: Date.now(),
    today: today.day,
    yesterday: yesterday.day,
    totalMsgs,
    chats,
    reportCards,
    feed,
    graph,
    graphs,
    profiles,
    peopleByChat,
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
  <button class="tab active" data-tab="today">今日总结</button>
  <button class="tab" data-tab="graph">人事图</button>
  <button class="tab" data-tab="people">群友</button>
  <button class="tab" data-tab="saved">收藏夹</button>
  <button class="tab" data-tab="feed">本月档案</button>
</nav>

<main>
  <!-- 今日 -->
  <section class="panel active" id="panel-today">
    <div class="section-head"><span class="num">01</span><h2>各群的今天</h2><span class="hint">没有总结的群，去让 DSH 跑一次 qq_archive action=report</span></div>
    <div class="cards" id="cards"></div>
  </section>

  <!-- 人事图 -->
  <section class="panel" id="panel-graph">
    <div class="section-head"><span class="num">02</span><h2>探案板</h2><span class="hint">一个群一块板子 · 红线是互相 @ · 点一张照片看卷宗</span></div>
    <div class="files" id="case-files"></div>
    <div class="board-wrap">
      <canvas id="net"></canvas>
      <p class="board-empty" id="board-empty">这块板子上还没有红线——这个群里没人互相 @ 过。</p>
      <aside class="inspector" id="inspector">
        <p class="insp-empty">把光标放到一张照片上，看看这个人。</p>
      </aside>
    </div>
  </section>

  <!-- 群友 -->
  <section class="panel" id="panel-people">
    <div class="section-head"><span class="num">03</span><h2>群友档案</h2><span class="hint">先选一个群，再看这个群里的人 · 点头像看完整档案</span></div>
    <div id="people-files" class="files people-files"></div>
    <input id="people-search" class="people-search" type="search" placeholder="搜这个群里的昵称或 QQ……">
    <div id="people-grid" class="people"></div>
  </section>

  <!-- 收藏 -->
  <section class="panel" id="panel-saved">
    <div class="section-head"><span class="num">04</span><h2>值得留下的话</h2><span class="hint">收藏和批注只存在这台浏览器 · 导出后才算永久档</span></div>
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
    <div class="section-head"><span class="num">05</span><h2>最近的档案</h2><span class="hint">点「收藏」把它放进第四格</span></div>
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
 * @returns {{path, bytes, chats, reports, nodes}}
 */
export function exportDashboard(db, { home = '', outPath, title = '群聊档案馆', feedLimit = 300 } = {}) {
  const data = buildDashboardData(db, { home, feedLimit })
  const html = renderDashboard(data, { title })
  const path = outPath || join(home, 'dashboard.html')
  writeFileSync(path, html, 'utf8')
  return {
    path,
    bytes: Buffer.byteLength(html, 'utf8'),
    chats: data.chats.length,
    reports: data.reportCards.filter((c) => c.today).length,
    nodes: data.graph.nodes.length,
    people: (data.peopleByChat['*'] || []).length,
    peopleByChat: Object.keys(data.peopleByChat).length,
    date: data.today,
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
  display:flex;gap:8px;background:linear-gradient(180deg,var(--paper) 72%,transparent);}
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
function load(key, fallback){try{const v=JSON.parse(localStorage.getItem(key));return v==null?fallback:v}catch{return fallback}}
function save(key, val){try{localStorage.setItem(key, JSON.stringify(val))}catch{}}

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

/* ---------- 今日卡片 ---------- */
const NOTES = load(LS_NOTES, {});
function noteKey(chatKey){return DATA.today + '|' + chatKey}

function renderCards(){
  const box = document.getElementById('cards');
  if(!DATA.reportCards.length){
    box.innerHTML = '<p class="empty">今天还没有总结。让 DSH 跑一次 <code>qq_archive action=report</code>，回来后刷新这一页。</p>';
    return;
  }
  box.innerHTML = DATA.reportCards.map((c,i)=>{
    const rep = c.today;
    const stats = rep && rep.stats ? rep.stats : null;
    const words = stats && (stats.topWords||[]).length ? (stats.topWords||[]).slice(0,3).map(w=>esc(w.word)).join(' / ') : '';
    const meta = stats
      ? '消息 <b>'+stats.total+'</b> 条 · '+stats.members.length+' 人发言'+(words ? ' · 高频词 <b>'+words+'</b>' : '')
      : '';
    const note = NOTES[noteKey(c.chatKey)] || '';
    return '<article class="card" style="animation-delay:'+(i*60)+'ms">'
      + '<div class="card-head"><h3>'+esc(c.chatName)+'</h3></div>'
      + '<p class="card-meta">'+meta+'</p>'
      + '<div class="report">'+(rep ? md(rep.text) : '<p class="report-empty">这个群今天没有留下总结。</p>')+'</div>'
      + '<textarea class="card-note" data-chat="'+esc(c.chatKey)+'" placeholder="给这个群写一句今日批注……">'+esc(note)+'</textarea>'
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
    const gd = DATA.graphs[k] || {nodes:[],edges:[]};
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
  cancelAnimationFrame(boardRaf);
  const old = document.getElementById('net');
  old.replaceWith(old.cloneNode(false));
  renderGraph(boardChat);
}

function renderGraph(chatKey){
  const graphData = DATA.graphs[chatKey] || DATA.graph;
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
    + (recent ? '<p class="mp-h">最近说过</p><div class="mp-list">'+recent+'</div>' : '');

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
  $$('.tab').forEach(x=>x.classList.toggle('active',x===t));
  $$('.panel').forEach(p=>p.classList.toggle('active', p.id==='panel-'+t.dataset.tab));
  if(t.dataset.tab==='graph' && !graphInited){ graphInited = true; renderFiles(); mountBoard() }
  if(t.dataset.tab==='people' && !peopleRendered){ peopleRendered = true; renderPeopleFiles(); renderPeople() }
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
    saved:SAVED, notes:NOTES, reports:DATA.reportCards };
  download('qq-archive-'+DATA.today+'.json', JSON.stringify(pack,null,2), 'application/json');
});
document.getElementById('export-md').addEventListener('click',()=>{
  const lines=['# 群聊档案馆 · '+DATA.today,'', '> 导出于 '+new Date().toLocaleString('zh-CN'),''];
  for(const c of DATA.reportCards){
    lines.push('## '+c.chatName,'');
    if(c.today) lines.push(c.today.text, ''); else lines.push('（今天没有总结）','');
    const k=noteKey(c.chatKey);
    if(NOTES[k]) lines.push('> 批注：'+NOTES[k], '');
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
renderCards();
renderSaved();
renderFeed();
window.addEventListener('resize', ()=>{ /* 力导向画布在首次打开人事图时按当时尺寸创建 */ });
`