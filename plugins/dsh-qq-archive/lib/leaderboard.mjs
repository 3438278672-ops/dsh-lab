/**
 * 活跃榜 / 失踪人口：按本地时区的自然周（周一 00:00 起算）对比本周和上周。
 *
 * 本周通常还在进行中，所以「上周」取的是**上周同一时段**（从上周一 00:00 起、
 * 长度和本周至今完全相同），这样周二早上看到的环比不会被「上周还有五天没算」
 * 这种口径问题拉成 -70%。只有两段时间长度一致，delta 才有意义。
 *
 * 只读数据库。周窗口用时间戳算，能走 messages 的 (chat_key, ts) 索引；
 * 日期字符串用本地时区，和 report.mjs / calendar.mjs 同一口径。
 */
import { fmtDay } from './report.mjs'

const DEFAULT_TOP = 30
const MAX_TOP = 500

function asDate(value) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) throw new Error(`ref 需要一个合法的 Date（收到：${value}）`)
  return d
}

function normalizeOffset(offset) {
  const n = Math.trunc(Number(offset))
  return Number.isFinite(n) ? n : 0
}

function normalizeTop(top) {
  const n = Number(top)
  if (!Number.isFinite(n)) return DEFAULT_TOP
  return Math.min(MAX_TOP, Math.max(1, Math.trunc(n)))
}

/** 本地时区排序用，保证同分时输出稳定。 */
function compareText(a, b) {
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

/**
 * 本地时区的「周一 00:00 ~ 周日 23:59:59」窗口。
 *
 * @param {Date} [ref] 参照时间（默认现在）
 * @param {number} [offset] 0=本周，-1=上周，+1=下周
 * @returns {{fromTs: number, toTs: number, fromDate: string, toDate: string}}
 */
export function weekBounds(ref = new Date(), offset = 0) {
  const base = asDate(ref)
  const local = new Date(base.getFullYear(), base.getMonth(), base.getDate())
  const mondayIndex = (local.getDay() + 6) % 7 // 周一=0，周日=6
  const y = local.getFullYear()
  const m = local.getMonth()
  const d = local.getDate() - mondayIndex + normalizeOffset(offset) * 7
  const monday = new Date(y, m, d)
  const sunday = new Date(y, m, d + 6)
  const nextMonday = new Date(y, m, d + 7)
  return {
    fromTs: Math.floor(monday.getTime() / 1000),
    // 用「下周一 00:00 - 1 秒」而不是 +7*86400，跨夏令时也不会切错边界
    toTs: Math.floor(nextMonday.getTime() / 1000) - 1,
    fromDate: fmtDay(monday),
    toDate: fmtDay(sunday),
  }
}

function statusOf(cur, prev) {
  if (prev === 0 && cur > 0) return 'new'
  if (cur === 0 && prev > 0) return 'gone'
  if (cur > prev) return 'up'
  if (cur < prev) return 'down'
  return 'flat'
}

/**
 * 本周活跃榜 + 上周对比 + 失踪人口。
 *
 * people 的口径：
 * 1. 本周有发言的人按本周条数降序取前 top 名；
 * 2. 再补上 top 之外、但状态是 new（上周没说话）或 gone（本周没说话）的人，
 *    保证「新面孔 / 失踪人口」不会因为截断被隐藏；整体仍按本周条数降序。
 * people[].chats 是「本周」在哪些群说的（gone 的人本周 0 条，这里就是空数组，
 * 失踪人口去 missing 里看上周条数和最后发言时间）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{chatKey?: string|null, now?: Date, top?: number}} [opts]
 * @returns {{week: {fromDate: string, toDate: string, partial: boolean},
 *   prev: {fromDate: string, toDate: string},
 *   totals: {cur: number, prev: number, delta: number},
 *   people: Array<{userId: string, name: string, cur: number, prev: number, delta: number,
 *     status: 'up'|'down'|'flat'|'new'|'gone',
 *     chats: Array<{chatKey: string, name: string, count: number}>}>,
 *   chats: Array<{chatKey: string, name: string, cur: number, prev: number, delta: number}>,
 *   missing: Array<{userId: string, name: string, prev: number, lastTs: number}>}}
 */
export function buildLeaderboard(db, { chatKey = null, now = new Date(), top = DEFAULT_TOP } = {}) {
  const ref = asDate(now)
  const week = weekBounds(ref, 0)
  // 本周进行到哪一秒（正常是「现在」，周日 23:59:59 之后就是整周末尾）
  const curTo = Math.min(week.toTs, Math.floor(ref.getTime() / 1000))
  const curSpan = Math.max(0, curTo - week.fromTs + 1)
  // 上周取同一时段：上周一 00:00 起、和本周至今一样长。两段等长，环比才有意义。
  const prevWeek = weekBounds(ref, -1)
  const prevFrom = prevWeek.fromTs
  const prevTo = Math.min(prevWeek.toTs, prevFrom + curSpan - 1)
  const limit = normalizeTop(top)
  const filter = chatKey ? ' and chat_key = ?' : ''
  const filterArgs = chatKey ? [chatKey] : []

  const countMessages = db.prepare(`select count(*) as count from messages where ts between ? and ?${filter}`)
  const curTotal = Number(countMessages.get(week.fromTs, curTo, ...filterArgs).count) || 0
  const prevTotal = Number(countMessages.get(prevFrom, prevTo, ...filterArgs).count) || 0

  const userCount = db.prepare(
    `select sender_id as userId, count(*) as count
       from messages
      where ts between ? and ?${filter} and sender_id <> ''
      group by sender_id`,
  )
  const curRows = userCount.all(week.fromTs, curTo, ...filterArgs)
  const prevRows = userCount.all(prevFrom, prevTo, ...filterArgs)

  // 群名（统计 chats 和人物的 chats[] 用）
  const chatNames = new Map(db.prepare('select chat_key, name from chats').all().map((r) => [r.chat_key, r.name || r.chat_key]))

  // 本周每个人在各群的条数：一次查完，最后只挂到入榜的人身上
  const curChatRows = db
    .prepare(
      `select sender_id as userId, chat_key as chatKey, count(*) as count
         from messages
        where ts between ? and ?${filter} and sender_id <> ''
        group by sender_id, chat_key
        order by count desc, chat_key`,
    )
    .all(week.fromTs, curTo, ...filterArgs)
  const chatsByUser = new Map()
  for (const r of curChatRows) {
    const uid = String(r.userId)
    if (!chatsByUser.has(uid)) chatsByUser.set(uid, [])
    const key = r.chatKey
    chatsByUser.get(uid).push({ chatKey: key, name: chatNames.get(key) || key, count: Number(r.count) || 0 })
  }

  // 同一个人可能改过名：名字取最近一条（最新一条是空名就往前找，再没有就用 QQ 号）；
  // lastTs 则用真正的最新一条，不能因为名字是空的把「最后发言时间」往前挪。
  const latestStmt = db.prepare(
    `select sender_name as name, ts
       from messages
      where sender_id = ?${filter}
      order by ts desc, id desc limit 1`,
  )
  const latestNameStmt = db.prepare(
    `select sender_name as name
       from messages
      where sender_id = ?${filter} and sender_name <> ''
      order by ts desc, id desc limit 1`,
  )
  const latestCache = new Map()
  const latestOf = (uid) => {
    if (!latestCache.has(uid)) latestCache.set(uid, latestStmt.get(uid, ...filterArgs) || null)
    return latestCache.get(uid)
  }
  const nameOf = (uid) => latestOf(uid)?.name || latestNameStmt.get(uid, ...filterArgs)?.name || String(uid)

  // 合并两周的人：prev=0 是本周新面孔，cur=0 是失踪人口
  const peopleMap = new Map()
  const ensurePerson = (uid) => {
    if (!peopleMap.has(uid)) peopleMap.set(uid, { userId: uid, cur: 0, prev: 0 })
    return peopleMap.get(uid)
  }
  for (const r of prevRows) ensurePerson(String(r.userId)).prev = Number(r.count) || 0
  for (const r of curRows) ensurePerson(String(r.userId)).cur = Number(r.count) || 0

  const allPeople = [...peopleMap.values()].map((p) => ({
    ...p,
    delta: p.cur - p.prev,
    status: statusOf(p.cur, p.prev),
  }))
  const byCur = (a, b) => b.cur - a.cur || b.prev - a.prev || compareText(a.userId, b.userId)

  const leaders = allPeople.filter((p) => p.cur > 0).sort(byCur).slice(0, limit)
  const leaderIds = new Set(leaders.map((p) => p.userId))
  // top 之外的新面孔：本周有发言、上周没有；gone 的人统一排最后（cur=0）
  const newRest = allPeople.filter((p) => p.cur > 0 && !leaderIds.has(p.userId) && p.status === 'new').sort(byCur)
  const gone = allPeople.filter((p) => p.cur === 0 && p.prev > 0).sort((a, b) => b.prev - a.prev || compareText(a.userId, b.userId))

  const people = [...leaders, ...newRest, ...gone].map((p) => ({
    userId: p.userId,
    name: nameOf(p.userId),
    cur: p.cur,
    prev: p.prev,
    delta: p.delta,
    status: p.status,
    chats: chatsByUser.get(p.userId) || [],
  }))

  // 会话维度：两周都算，只在其中一周出现的群也要带上（另一周为 0）
  const chatMap = new Map()
  const ensureChat = (key) => {
    if (!chatMap.has(key)) chatMap.set(key, { chatKey: key, name: chatNames.get(key) || key, cur: 0, prev: 0 })
    return chatMap.get(key)
  }
  const chatCount = db.prepare(
    `select chat_key as chatKey, count(*) as count
       from messages
      where ts between ? and ?${filter}
      group by chat_key`,
  )
  for (const r of chatCount.all(prevFrom, prevTo, ...filterArgs)) ensureChat(r.chatKey).prev = Number(r.count) || 0
  for (const r of chatCount.all(week.fromTs, curTo, ...filterArgs)) ensureChat(r.chatKey).cur = Number(r.count) || 0
  // 按群过滤时即使两周都没消息，也返回这唯一的群，前端不用再判空
  if (chatKey && !chatMap.has(chatKey)) ensureChat(chatKey)
  const chats = [...chatMap.values()]
    .map((c) => ({ ...c, delta: c.cur - c.prev }))
    .sort((a, b) => b.cur - a.cur || compareText(a.chatKey, b.chatKey))

  const missing = gone.map((p) => ({
    userId: p.userId,
    name: nameOf(p.userId),
    prev: p.prev,
    lastTs: Number(latestOf(p.userId)?.ts) || 0,
  }))

  return {
    week: {
      fromDate: week.fromDate,
      toDate: fmtDay(new Date(curTo * 1000)),
      // 本周还没走完时 true：前端可以据此提示「至今」
      partial: curTo < week.toTs,
    },
    prev: { fromDate: prevWeek.fromDate, toDate: fmtDay(new Date(prevTo * 1000)) },
    totals: { cur: curTotal, prev: prevTotal, delta: curTotal - prevTotal },
    people,
    chats,
    missing,
  }
}
