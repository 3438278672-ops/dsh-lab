/**
 * 群聊日报：统计 + LLM 摘要，落到 reports 表。
 *
 * 日报不追求「全量复述」，而是给一眼能看的信息：今天聊了多少、谁最活跃、
 * 有什么值得回看的链接/话题。摘要由 DSH 的 llm 服务生成（可选，不开也能看统计）。
 */
import { ftsTerms } from './segment.mjs'
import { STOP_WORDS, getMeta, setMeta } from './db.mjs'

const LINK_RE = /https?:\/\/[^\s，。！？、）)】]+/g
const PLACEHOLDER_RE = /^\[[^\]]{1,6}\]$/

/** 'today' | 'yesterday' | 'YYYY-MM-DD' → { day, fromTs, toTs }（本地时区，秒） */
export function dayBounds(day = 'today', now = Date.now()) {
  const base = new Date(now)
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate())
  if (day === 'today') {
    return { day: fmtDay(start), fromTs: Math.floor(start.getTime() / 1000), toTs: Math.floor(now / 1000) }
  }
  if (day === 'yesterday') {
    const y = new Date(start.getTime() - 86400000)
    return { day: fmtDay(y), fromTs: Math.floor(y.getTime() / 1000), toTs: Math.floor(start.getTime() / 1000) - 1 }
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day))
  if (!m) throw new Error(`日期要写成 YYYY-MM-DD，或 today / yesterday（收到：${day}）`)
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return { day: fmtDay(d), fromTs: Math.floor(d.getTime() / 1000), toTs: Math.floor(d.getTime() / 1000) + 86400 - 1 }
}

function fmtDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function chatFilter(chatKey) {
  return chatKey ? { sql: ' and chat_key = ?', args: [chatKey] } : { sql: '', args: [] }
}

function cleanText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 给日报用的「有信息量」采样：链接、提问、长句优先，纯占位丢弃。 */
function pickSamples(db, { chatKey, fromTs, toTs, limit = 40 }) {
  const f = chatFilter(chatKey)
  const rows = db
    .prepare(
      `select ts, chat_key, sender_name, text from messages
        where ts between ? and ? and text <> ''${f.sql}
        order by ts limit 4000`,
    )
    .all(fromTs, toTs, ...f.args)
  const picked = []
  const seen = new Set()
  for (const r of rows) {
    const t = cleanText(r.text)
    if (!t || PLACEHOLDER_RE.test(t)) continue
    const key = t.slice(0, 24)
    if (seen.has(key)) continue
    const score = (LINK_RE.test(t) ? 3 : 0) + (/[?？]/.test(t) ? 1 : 0) + (t.length >= 30 ? 2 : 0) + (t.length >= 8 ? 1 : 0)
    if (score <= 0) continue
    seen.add(key)
    picked.push({ ts: r.ts, name: r.sender_name, text: t.slice(0, 200), score })
  }
  picked.sort((a, b) => b.score - a.score || a.ts - b.ts)
  return picked.slice(0, limit).sort((a, b) => a.ts - b.ts)
}

function countWords(db, { chatKey, fromTs, toTs }) {
  const f = chatFilter(chatKey)
  const rows = db
    .prepare(`select text from messages where ts between ? and ? and text <> ''${f.sql} limit 20000`)
    .all(fromTs, toTs, ...f.args)
  const freq = new Map()
  for (const r of rows) {
    // 先把 [图片] [表情] 这类占位符剥掉，否则高频词全变成「图片/表情/动画」
    const clean = String(r.text || '').replace(/\[[^\]]{1,8}\]/g, ' ')
    for (const w of ftsTerms(clean)) {
      if (w.length < 2 || STOP_WORDS.has(w)) continue
      if (/^\d+$/.test(w)) continue // QQ 号、数字堆不算高频词
      freq.set(w, (freq.get(w) || 0) + 1)
    }
  }
  return [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([word, count]) => ({ word, count }))
}

/**
 * 统计一天的群聊。
 * @returns {{day, chatKey, chatName, fromTs, toTs, total, members, hourly, kinds, topWords, links, media, samples}}
 */
export function buildReport(db, { chatKey = null, fromTs, toTs, sampleLimit = 40 } = {}) {
  const f = chatFilter(chatKey)
  const total = db
    .prepare(`select count(*) c from messages where ts between ? and ?${f.sql}`)
    .get(fromTs, toTs, ...f.args).c

  const members = db
    .prepare(
      `select sender_id as id, max(sender_name) as name, count(*) as count from messages
        where ts between ? and ? and sender_id <> ''${f.sql}
        group by sender_id order by count desc limit 12`,
    )
    .all(fromTs, toTs, ...f.args)

  const hourly = Array.from({ length: 24 }, () => 0)
  for (const r of db
    .prepare(
      `select cast(strftime('%H', ts, 'unixepoch', 'localtime') as integer) h, count(*) c
         from messages where ts between ? and ?${f.sql} group by h`,
    )
    .all(fromTs, toTs, ...f.args)) {
    if (r.h >= 0 && r.h < 24) hourly[r.h] = r.c
  }

  const kinds = {}
  for (const r of db
    .prepare(`select kind, count(*) c from messages where ts between ? and ?${f.sql} group by kind`)
    .all(fromTs, toTs, ...f.args)) {
    kinds[r.kind] = r.c
  }

  const links = []
  const seenLinks = new Set()
  for (const r of db
    .prepare(`select text from messages where ts between ? and ? and text like '%http%'${f.sql} limit 500`)
    .all(fromTs, toTs, ...f.args)) {
    for (const m of String(r.text).match(LINK_RE) || []) {
      if (seenLinks.has(m)) continue
      seenLinks.add(m)
      links.push(m)
      if (links.length >= 10) break
    }
    if (links.length >= 10) break
  }

  const chatName = chatKey
    ? db.prepare('select name from chats where chat_key = ?').get(chatKey)?.name || chatKey
    : '所有会话'

  return {
    day: null,
    chatKey: chatKey || '*',
    chatName,
    fromTs,
    toTs,
    total,
    members: members.map((m) => ({ id: String(m.id), name: m.name || String(m.id), count: m.count })),
    hourly,
    kinds,
    topWords: countWords(db, { chatKey, fromTs, toTs }),
    links,
    media: kinds.image || 0,
    samples: pickSamples(db, { chatKey, fromTs, toTs, limit: sampleLimit }),
  }
}

export const REPORT_SYSTEM = [
  '你是一个群聊日报编辑。给你某个 QQ 群一天的统计和若干条聊天摘录，写一份中文日报。',
  '要求：',
  '1. 用 Markdown，三个小标题固定为「## 今天聊了什么」「## 值得一看」「## 群友动态」；',
  '2. 不要逐条复述消息，提炼话题和梗；没有内容的标题写「今天没什么特别的」；',
  '3. 总长度 200-350 字，语气自然，像群友自己写的，不要写成公文；',
  '4. 不要编造摘录里没有的事实，不确定的就不写。',
].join('\n')

export function buildReportPrompt(report) {
  const lines = [
    `# ${report.day} · ${report.chatName}`,
    `消息 ${report.total} 条，${report.members.length} 人发言。`,
    `高频词：${report.topWords.map((w) => `${w.word}(${w.count})`).join('、') || '无'}`,
    `活跃成员：${report.members.slice(0, 6).map((m) => `${m.name}(${m.count})`).join('、') || '无'}`,
  ]
  if (report.links.length) lines.push(`链接：${report.links.slice(0, 5).join('\n')}`)
  if (report.samples.length) {
    lines.push('## 摘录')
    for (const s of report.samples) {
      const t = new Date(s.ts * 1000)
      const hh = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
      lines.push(`${hh} ${s.name}：${s.text}`)
    }
  }
  return lines.join('\n')
}

/** 存日报（覆盖同一天同一会话）。 */
export function saveReport(db, { date, chatKey = '*', text, stats = null, model = '' }) {
  db.prepare(
    `insert into reports(date, chat_key, text, stats, model, created_at) values(?, ?, ?, ?, ?, ?)
     on conflict(date, chat_key) do update set text = excluded.text, stats = excluded.stats,
       model = excluded.model, created_at = excluded.created_at`,
  ).run(date, chatKey, text, stats ? JSON.stringify(stats) : null, model, Math.floor(Date.now() / 1000))
}

export function readReport(db, { date, chatKey = '*' }) {
  const row = db.prepare('select date, chat_key, text, stats, model, created_at from reports where date = ? and chat_key = ?').get(date, chatKey)
  if (!row) return null
  return { ...row, stats: row.stats ? JSON.parse(row.stats) : null }
}

export function listReports(db, { limit = 30 } = {}) {
  return db
    .prepare('select date, chat_key, text, model, created_at from reports order by date desc limit ?')
    .all(limit)
}

/**
 * 到点该不该自动生成日报。
 *
 * 语义：每天 schedule 之后跑一次，内容是「昨天」的总结；
 * 跑过就把生成的日期记进 meta，当天不再重复。插件停过几天再启动，
 * 只补昨天那一天，不追更早的（那需要显式 action=report day=YYYY-MM-DD）。
 */
export function dueForReport(cfg, db, now = Date.now()) {
  const schedule = String(cfg?.report?.schedule || '').trim()
  if (!/^\d{1,2}:\d{2}$/.test(schedule)) return false
  const [hh, mm] = schedule.split(':').map(Number)
  if (hh > 23 || mm > 59) return false

  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const dueAt = start.getTime() + (hh * 60 + mm) * 60 * 1000
  if (now < dueAt) return false

  return getMeta(db, 'last_report_day') !== dayBounds('yesterday', now).day
}

export function markReportDay(db, day) {
  setMeta(db, 'last_report_day', day)
  setMeta(db, 'last_report_at', String(Math.floor(Date.now() / 1000)))
}
