/**
 * 活跃日历：按本地时区把消息分到天，给看板「日历」标签和 /api/day 明细用。
 *
 * 只读数据库，不落任何数据。日期口径和 report.mjs 的 dayBounds / fmtDay 保持一致
 * （本地时区），否则看板会出现「明明晚上发的，日历算到前一天」这种错位。
 *
 * 分日统一交给 SQLite 的 date(ts, 'unixepoch', 'localtime')，和 JS 的本地时区同源；
 * 窗口边界则用时间戳算，能走 idx_messages_ts / idx_messages_chat_ts 索引。
 */
import { fmtDay } from './report.mjs'

const DEFAULT_MONTHS = 3
const MAX_MONTHS = 24
/** 某天明细里最多列多少个发言者（看板弹窗一屏放得下）。 */
const TOP_SENDERS = 12

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function asDate(value) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) throw new Error(`now 需要一个合法的 Date（收到：${value}）`)
  return d
}

function normalizeMonths(months) {
  const n = Number(months)
  if (!Number.isFinite(n)) return DEFAULT_MONTHS
  return Math.min(MAX_MONTHS, Math.max(1, Math.trunc(n)))
}

/**
 * 解析 'YYYY-MM-DD'。格式不对、或 2026-02-30 这种「格式对但日期不存在」都抛错，
 * 避免日历里出现被 Date 悄悄进位的日子。
 */
function parseDay(date) {
  const m = DATE_RE.exec(String(date ?? ''))
  if (!m) throw new Error(`日期要写成 YYYY-MM-DD（收到：${date}）`)
  const p = { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) }
  const probe = new Date(p.y, p.m, p.d)
  if (fmtDay(probe) !== String(date)) throw new Error(`日期不存在：${date}`)
  return p
}

/** 本地时区某天 00:00 的 unix 秒。用年月日分量构造，跨夏令时不会偏一小时。 */
function localDayStart(y, m, d) {
  return Math.floor(new Date(y, m, d, 0, 0, 0, 0).getTime() / 1000)
}

function round1(n) {
  return Math.round(n * 10) / 10
}

/** chatKey 过滤的 SQL 片段 + 参数，messages / media 两张表都能直接用。 */
function scope(chatKey) {
  return chatKey ? { sql: ' and chat_key = ?', args: [chatKey] } : { sql: '', args: [] }
}

/**
 * 生成最近 N 个月的活跃日历。
 *
 * months=3 表示「含当前月在内，往前数 3 个自然月」：比如 now=2026-11-11，
 * 窗口就是 2026-09-01 ~ 2026-11-11。日期从旧到新连续补齐，没消息的日子也留格子
 * （total=0），前端按周排布时不用自己补洞。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{months?: number, chatKey?: string|null, now?: Date}} [opts]
 * @returns {{fromDate: string, toDate: string, maxDay: number,
 *   totals: {messages: number, activeDays: number, avgPerDay: number},
 *   days: Array<{date: string, total: number, speakers: number, media: number, links: number,
 *     chats: Array<[string, number]>}>}}
 */
export function buildCalendar(db, { months = DEFAULT_MONTHS, chatKey = null, now = new Date() } = {}) {
  const ref = asDate(now)
  const n = normalizeMonths(months)

  const to = { y: ref.getFullYear(), m: ref.getMonth(), d: ref.getDate() }
  const fromProbe = new Date(to.y, to.m - (n - 1), 1)
  const from = { y: fromProbe.getFullYear(), m: fromProbe.getMonth(), d: 1 }
  const fromDate = fmtDay(fromProbe)
  const toDate = fmtDay(new Date(to.y, to.m, to.d))
  const fromTs = localDayStart(from.y, from.m, from.d)
  const toTs = localDayStart(to.y, to.m, to.d + 1) - 1

  const f = scope(chatKey)

  // 一天的骨架：消息数 / 发言人数 / 链接消息数
  const dayRows = db
    .prepare(
      `select date(ts, 'unixepoch', 'localtime') as day,
              count(*) as total,
              count(distinct sender_id) as speakers,
              sum(case when text like '%http%' then 1 else 0 end) as links
         from messages
        where ts between ? and ?${f.sql}
        group by day`,
    )
    .all(fromTs, toTs, ...f.args)
  const dayMap = new Map(dayRows.map((r) => [r.day, r]))

  // 媒体按 media 表算；一条消息带多个附件只算一次「媒体消息」
  const mediaRows = db
    .prepare(
      `select date(ts, 'unixepoch', 'localtime') as day, count(distinct message_key) as media
         from media
        where ts between ? and ?${f.sql}
        group by day`,
    )
    .all(fromTs, toTs, ...f.args)
  const mediaMap = new Map(mediaRows.map((r) => [r.day, r.media]))

  // 每天各群贡献多少条，用元组数组给前端（体量小，比对象数组省）
  const chatRows = db
    .prepare(
      `select date(ts, 'unixepoch', 'localtime') as day, chat_key, count(*) as count
         from messages
        where ts between ? and ?${f.sql}
        group by day, chat_key
        order by count desc, chat_key`,
    )
    .all(fromTs, toTs, ...f.args)
  const chatsMap = new Map()
  for (const r of chatRows) {
    if (!chatsMap.has(r.day)) chatsMap.set(r.day, [])
    chatsMap.get(r.day).push([r.chat_key, r.count])
  }

  const days = []
  let maxDay = 0
  let messages = 0
  let activeDays = 0
  const endTime = localDayStart(to.y, to.m, to.d) * 1000
  for (let i = 0; ; i++) {
    if (i > MAX_MONTHS * 32) throw new Error('日历窗口异常：日期没有正常推进')
    const cursor = new Date(from.y, from.m, from.d + i)
    if (cursor.getTime() > endTime) break
    const date = fmtDay(cursor)
    const row = dayMap.get(date)
    const total = row ? Number(row.total) || 0 : 0
    const speakers = row ? Number(row.speakers) || 0 : 0
    const links = row ? Number(row.links) || 0 : 0
    const media = mediaMap.get(date) || 0
    const chats = chatsMap.get(date) || []
    days.push({ date, total, speakers, media, links, chats })
    messages += total
    if (total > 0) activeDays++
    if (total > maxDay) maxDay = total
  }

  return {
    fromDate,
    toDate,
    maxDay,
    totals: {
      messages,
      activeDays,
      // 按窗口内的自然日平均（含没聊天的日子），和日历格子的「密度」一致
      avgPerDay: days.length ? round1(messages / days.length) : 0,
    },
    days,
  }
}

/**
 * 某一天的明细：给看板点日历格子弹出的面板（web.mjs 的 /api/day）。
 *
 * 名字统一取「最近一条消息的 sender_name」：同一个人改过群名片也能显示最新的。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{date: string, chatKey?: string|null}} opts
 * @returns {{date: string, total: number, speakers: number, media: number, links: number,
 *   hourly: number[], chats: Array<{chatKey: string, name: string, count: number}>,
 *   topSenders: Array<{userId: string, name: string, count: number}>}}
 */
export function dayBreakdown(db, { date, chatKey = null } = {}) {
  const p = parseDay(date)
  const day = fmtDay(new Date(p.y, p.m, p.d))
  const fromTs = localDayStart(p.y, p.m, p.d)
  const toTs = localDayStart(p.y, p.m, p.d + 1) - 1
  const f = scope(chatKey)
  const args = [fromTs, toTs, ...f.args]

  const summary = db
    .prepare(
      `select count(*) as total,
              count(distinct sender_id) as speakers,
              sum(case when text like '%http%' then 1 else 0 end) as links
         from messages
        where ts between ? and ?${f.sql}`,
    )
    .get(...args)

  const media = db
    .prepare(`select count(distinct message_key) as media from media where ts between ? and ?${f.sql}`)
    .get(...args).media

  const hourly = Array.from({ length: 24 }, () => 0)
  const hourRows = db
    .prepare(
      `select cast(strftime('%H', ts, 'unixepoch', 'localtime') as integer) as h, count(*) as count
         from messages
        where ts between ? and ?${f.sql}
        group by h`,
    )
    .all(...args)
  for (const r of hourRows) {
    if (r.h >= 0 && r.h < 24) hourly[r.h] = Number(r.count) || 0
  }

  const chats = db
    .prepare(
      `select m.chat_key as chatKey, c.name as name, count(*) as count
         from messages m
         left join chats c on c.chat_key = m.chat_key
        where m.ts between ? and ?${chatKey ? ' and m.chat_key = ?' : ''}
        group by m.chat_key
        order by count desc, m.chat_key`,
    )
    .all(...args)
    .map((r) => ({ chatKey: r.chatKey, name: r.name || r.chatKey, count: Number(r.count) || 0 }))

  const topRows = db
    .prepare(
      `select sender_id as userId, count(*) as count
         from messages
        where ts between ? and ?${f.sql} and sender_id <> ''
        group by sender_id
        order by count desc, sender_id
        limit ${TOP_SENDERS}`,
    )
    .all(...args)

  // 最近一条非空 sender_name（最新一条是空名就退回更早的；都没有就用 QQ 号）
  const latestName = db.prepare(
    `select sender_name from messages
      where sender_id = ?${chatKey ? ' and chat_key = ?' : ''} and sender_name <> ''
      order by ts desc, id desc limit 1`,
  )
  const topSenders = topRows.map((r) => ({
    userId: String(r.userId),
    name: latestName.get(String(r.userId), ...f.args)?.sender_name || String(r.userId),
    count: Number(r.count) || 0,
  }))

  return {
    date: day,
    total: Number(summary.total) || 0,
    speakers: Number(summary.speakers) || 0,
    media: Number(media) || 0,
    links: Number(summary.links) || 0,
    hourly,
    chats,
    topSenders,
  }
}
