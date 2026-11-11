/**
 * 群梗 / 话题考古：查一个词在归档里的来龙去脉，另外给「只看高频词」用的 topWords。
 *
 * 两个入口都只读 messages：
 * - investigateTopic 走 `text like ?`（归档里的中文子串没法用索引，LIKE 是最直接的），
 *   词先过 escapeLike，用户输入 `100%` / `a_b` / `\` 时不会变成 SQL 通配符；
 * - topWords 复用 segment.mjs 的 tokenize，按词频出结果，过滤虚词、单字、纯数字和
 *   `[图片]` 这类占位符。
 *
 * 本模块不写库、不联网。
 */
import { escapeLike, tokenize } from './segment.mjs'
import { STOP_WORDS } from './db.mjs'

/** samples 的硬上限（设计文档：按时间均匀取最多 30 条）。 */
const SAMPLE_MAX = 30
/** topUsers / byChat 这类「排个榜」的结果保留多少条，避免一个小词命中几千个会话导致返回体爆掉。 */
const TOP_USERS = 10
const TOP_CHATS = 20
/** topWords 一次最多扫多少条消息；很久以前的大库只取前 2 万条，词频可能偏低，属于已知取舍。 */
const SCAN_MAX = 20000

/** 纯占位消息：`[图片]`、`[表情]`、`[图片:xx] [表情]`，对话题/高频词没有信息量。 */
const PLACEHOLDER_RE = /^\s*(\[[^\]\n]{1,12}\]\s*)+$/
const PLACEHOLDER_INLINE_RE = /\[[^\]\n]{1,12}\]/g

/** 有的调用方手里是 archive，有的是 archive.db；两个都认。 */
function resolveDb(archiveOrDb) {
  return archiveOrDb?.db || archiveOrDb
}

function filterParts({ chatKey = null, fromTs = 0, toTs = 0 }, alias = '') {
  const prefix = alias ? `${alias}.` : ''
  const conds = []
  const args = []
  if (chatKey) {
    conds.push(`${prefix}chat_key = ?`)
    args.push(String(chatKey))
  }
  if (Number(fromTs) > 0) {
    conds.push(`${prefix}ts >= ?`)
    args.push(Math.floor(Number(fromTs)))
  }
  if (Number(toTs) > 0) {
    conds.push(`${prefix}ts <= ?`)
    args.push(Math.floor(Number(toTs)))
  }
  return { sql: conds.length ? ' and ' + conds.join(' and ') : '', args }
}

function topicWhere({ word, chatKey, fromTs, toTs }, alias = 'm') {
  const base = filterParts({ chatKey, fromTs, toTs }, alias)
  const sql = `${alias}.text like ? escape '\\'${base.sql}`
  return { sql, args: ['%' + escapeLike(word) + '%', ...base.args] }
}

function rowToSample(r) {
  const chatKey = r.chat_key
  return {
    id: r.id,
    ts: r.ts,
    chatKey,
    chatName: r.chat_name || chatKey,
    senderId: String(r.sender_id),
    senderName: r.sender_name || String(r.sender_id),
    text: r.text || '',
  }
}

/**
 * 群梗考古。
 *
 * @param {object} archive openArchive() 的返回值（也容忍直接传 archive.db）
 * @param {object} opts
 * @param {string} opts.word 必填，按原文子串匹配（不是分词）
 * @param {string|null} opts.chatKey 只查某个会话
 * @param {number} opts.fromTs / opts.toTs unix 秒；0 = 不限
 * @param {number} opts.limit 最多取多少条 samples（再被 30 硬上限截断）
 * @returns {{word:string,total:number,byMonth:Array,byChat:Array,topUsers:Array,first:object|null,last:object|null,samples:Array}}
 */
export function investigateTopic(archive, { word, chatKey = null, fromTs = 0, toTs = 0, limit = 80 } = {}) {
  const db = resolveDb(archive)
  const w = String(word ?? '').trim()
  if (!w) throw new Error('要考古的词不能为空（word）')

  const { sql, args } = topicWhere({ word: w, chatKey, fromTs, toTs })

  const total = db.prepare(`select count(*) as c from messages m where ${sql}`).get(...args).c

  const byMonth = db
    .prepare(
      `select strftime('%Y-%m', m.ts, 'unixepoch', 'localtime') as month, count(*) as count
         from messages m
        where ${sql}
        group by month
        order by month asc`,
    )
    .all(...args)
    .map((r) => ({ month: r.month, count: r.count }))

  const byChat = db
    .prepare(
      `select m.chat_key as chat_key, coalesce(c.name, '') as name, count(*) as count
         from messages m
         left join chats c on c.chat_key = m.chat_key
        where ${sql}
        group by m.chat_key
        order by count desc, m.chat_key asc
        limit ?`,
    )
    .all(...args, TOP_CHATS)
    .map((r) => ({ chatKey: r.chat_key, name: r.name || r.chat_key, count: r.count }))

  const topUsers = db
    .prepare(
      `select m.sender_id as user_id, max(m.sender_name) as name, count(*) as count
         from messages m
        where ${sql}
        group by m.sender_id
        order by count desc, m.sender_id asc
        limit ?`,
    )
    .all(...args, TOP_USERS)
    .map((r) => ({ userId: String(r.user_id), name: r.name || String(r.user_id), count: r.count }))

  const edgeSql = `select m.id, m.ts, m.chat_key, coalesce(c.name, '') as chat_name,
                          m.sender_id, m.sender_name, m.text
                     from messages m
                     left join chats c on c.chat_key = m.chat_key
                    where ${sql}`
  const firstRow = total ? db.prepare(`${edgeSql} order by m.ts asc, m.id asc limit 1`).get(...args) : null
  const lastRow = total ? db.prepare(`${edgeSql} order by m.ts desc, m.id desc limit 1`).get(...args) : null

  // samples 按时间均匀取，结果按时间正序（从早到晚）返回：
  // 首尾各锚一条，中间等距，这样既能看到最早的出处，也能看到最近一次玩这个梗。
  const n = Math.max(1, Math.min(SAMPLE_MAX, Number(limit) > 0 ? Math.floor(Number(limit)) : 80))
  const samples = []
  if (total > 0) {
    if (total <= n) {
      samples.push(...db.prepare(`${edgeSql} order by m.ts asc, m.id asc`).all(...args).map(rowToSample))
    } else {
      const picked = new Set()
      for (let k = 0; k < n; k++) {
        picked.add(n === 1 ? 0 : Math.round((k * (total - 1)) / (n - 1)))
      }
      for (const offset of [...picked].sort((a, b) => a - b)) {
        const row = db.prepare(`${edgeSql} order by m.ts asc, m.id asc limit 1 offset ?`).get(...args, offset)
        if (row) samples.push(rowToSample(row))
      }
    }
  }

  return {
    word: w,
    total,
    byMonth,
    byChat,
    topUsers,
    first: firstRow ? rowToSample(firstRow) : null,
    last: lastRow ? rowToSample(lastRow) : null,
    samples,
  }
}

/**
 * 从一组文本里数词频（topWords 与 highlights 的窗口统计共用）。
 * 过滤：占位符、单字、纯数字、STOP_WORDS；按次数降序、同次数按词升序保证结果稳定。
 *
 * @param {string[]} texts
 * @param {number} limit
 * @returns {{word:string,count:number}[]}
 */
export function countWordsFromTexts(texts, limit = 24) {
  const freq = new Map()
  for (const raw of Array.isArray(texts) ? texts : []) {
    // 先把 [图片]/[表情] 这类占位符剥掉，否则高频词全变成「图片/表情/动画」
    const clean = String(raw || '').replace(PLACEHOLDER_INLINE_RE, ' ')
    for (const w of tokenize(clean).split(/\s+/)) {
      if (!w) continue
      if (w.length < 2 || STOP_WORDS.has(w)) continue
      if (/^\d+$/.test(w)) continue // QQ 号、数字堆不算群梗
      if (PLACEHOLDER_RE.test(w)) continue
      freq.set(w, (freq.get(w) || 0) + 1)
    }
  }
  const max = Math.max(1, Number(limit) > 0 ? Math.floor(Number(limit)) : 24)
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, max)
    .map(([word, count]) => ({ word, count }))
}

/**
 * 某时间范围 / 会话里的高频词（qq_topic top=true）。
 *
 * @param {object} db archive.db（也容忍传 archive）
 * @returns {{word:string,count:number}[]}
 */
export function topWords(db, { chatKey = null, fromTs = 0, toTs = 0, limit = 24 } = {}) {
  const d = resolveDb(db)
  const f = filterParts({ chatKey, fromTs, toTs })
  const rows = d
    .prepare(`select text from messages where text <> ''${f.sql} limit ?`)
    .all(...f.args, SCAN_MAX)
  return countWordsFromTexts(
    rows.map((r) => r.text),
    limit,
  )
}
