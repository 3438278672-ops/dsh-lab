/**
 * 群友档案：把一个人在归档库里的痕迹聚合出来。
 *
 * 纯统计，不调模型：身份/别名、在哪些群、消息量、活跃时段、
 * 高频词、@ 与被 @、最近发言、媒体构成。
 */
import { tokenize } from './segment.mjs'
import { STOP_WORDS } from './db.mjs'
import { stamp } from './util.mjs'

const MENTION_RE = /@(\d{5,12})/g
const NOISE = new Set([
  '图片', '语音', '视频', '表情', '合并', '转发', '文件', '卡片', '按钮', '全体', '成员',
  '哈哈', '哈哈哈', '哈哈哈笑死', '笑死', '草',
  '自己', '出来', '这边', '这儿', '现在', '不过', '感觉', '觉得', '知道', '时候', '东西',
  '应该', '可能', '真的', '反正', '其实', '然后', '一个', '这个', '那个', '什么', '怎么',
  '可以', '没有', '就是', '还是', '不是', '已经', '所以', '因为', '如果', '但是', '而且',
  '一张', '不了', '的是', '我不', '我们', '你们', '他们', '起来', '下来', '上去', '进去',
])

function parseNames(json) {
  try {
    const arr = JSON.parse(json || '[]')
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function nameOf(row) {
  return row?.sender_name || row?.sender_id || ''
}

/** 按 QQ 号或昵称片段找人；返回候选列表（同名可能是多个号）。 */
export function findCandidates(db, who) {
  const s = String(who || '').trim()
  if (!s) return []
  if (/^\d{4,12}$/.test(s)) {
    const rows = db
      .prepare('select chat_key, names, msg_count from members where user_id = ? order by msg_count desc')
      .all(s)
    const names = new Set()
    const chats = []
    for (const r of rows) {
      for (const n of parseNames(r.names)) names.add(n)
      chats.push({ chatKey: r.chat_key, msgCount: r.msg_count })
    }
    return [{ userId: s, names: [...names], chats, msgCount: chats.reduce((n, c) => n + c.msgCount, 0) }]
  }

  const rows = db
    // 昵称里的 _ 和 % 要当普通字符：转义了就得配 ESCAPE，否则 LIKE 会把 \_ 当字面量
    .prepare("select user_id, chat_key, names, msg_count from members where names like ? escape '\\' order by msg_count desc")
    .all('%' + s.replace(/[%_]/g, (c) => '\\' + c) + '%')
  const byUser = new Map()
  for (const r of rows) {
    let c = byUser.get(r.user_id)
    if (!c) {
      c = { userId: r.user_id, names: new Set(), chats: [], msgCount: 0 }
      byUser.set(r.user_id, c)
    }
    for (const n of parseNames(r.names)) c.names.add(n)
    c.chats.push({ chatKey: r.chat_key, msgCount: r.msg_count })
    c.msgCount += r.msg_count
  }
  const needle = s.toLowerCase()
  return [...byUser.values()]
    .map((c) => {
      const names = [...c.names].filter((n) => !SYSTEM_NAME_RE.test(n))
      return { ...c, names, exact: names.some((n) => n.toLowerCase() === needle) }
    })
    // 只在系统消息里出现过的号（「XX 邀请 YY 加入…」）不是真人，别当候选
    .filter((c) => c.names.length > 0)
    .sort((a, b) => b.msgCount - a.msgCount)
}

function pct(n, total) {
  return total > 0 ? Math.round((n / total) * 100) : 0
}

function peakHours(hours, total) {
  // 连续的活跃小时合并成区间，取占比最高的两段
  const hot = hours.map((n, h) => ({ h, n })).filter((x) => x.n > 0)
  if (!hot.length) return []
  const spans = []
  let cur = null
  for (const x of hot) {
    if (cur && x.h === cur.to + 1) {
      cur.to = x.h
      cur.n += x.n
    } else {
      cur = { from: x.h, to: x.h, n: x.n }
      spans.push(cur)
    }
  }
  // 全天在线（机器人 / 挂机）就别列区间了
  const widest = spans.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a), spans[0])
  if (widest.to - widest.from >= 20) {
    return [{ from: widest.from, to: widest.to, pct: 100, label: '全天在线' }]
  }
  return spans
    .sort((a, b) => b.n - a.n)
    .slice(0, 2)
    .map((s) => ({
      from: s.from,
      to: s.to,
      pct: pct(s.n, total),
      label: s.from === s.to ? `${String(s.from).padStart(2, '0')}:00` : `${String(s.from).padStart(2, '0')}:00-${String(s.to + 1).padStart(2, '0')}:00`,
    }))
}

function topWords(db, userId, chatKey, limit = 3000) {
  const rows = chatKey
    ? db.prepare('select text from messages where sender_id = ? and chat_key = ? order by ts desc limit ?').all(userId, chatKey, limit)
    : db.prepare('select text from messages where sender_id = ? order by ts desc limit ?').all(userId, limit)
  const freq = new Map()
  for (const { text } of rows) {
    const body = String(text || '')
    if (!body || body.startsWith('[')) continue
    for (const w of tokenize(body).split(' ')) {
      if (!w || w.length < 2) continue
      if (/^\d+$/.test(w)) continue
      if (STOP_WORDS.has(w) || NOISE.has(w)) continue
      freq.set(w, (freq.get(w) || 0) + 1)
    }
  }
  return [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([word, count]) => ({ word, count }))
}

function mentionStats(db, userId, chatKey) {
  const rows = chatKey
    ? db.prepare('select text from messages where sender_id = ? and chat_key = ? limit 3000').all(userId, chatKey)
    : db.prepare('select text from messages where sender_id = ? limit 3000').all(userId)
  const out = new Map()
  for (const { text } of rows) {
    MENTION_RE.lastIndex = 0
    let m
    while ((m = MENTION_RE.exec(String(text || '')))) {
      if (m[1] === userId) continue
      out.set(m[1], (out.get(m[1]) || 0) + 1)
    }
  }
  return [...out.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id, n]) => ({ userId: id, count: n, name: latestName(db, id) }))
}

// 系统消息的 sender 也会被记成某个真人，取最近名字时要跳过它们，
// 否则 @ 关系里会冒出「XX 邀请 YY 加入了群聊」这种假名字。
const SYSTEM_NAME_RE = /加入|邀请|撤回|禁言|红包|群公告|改名为|退群|踢出|移出/

function latestName(db, userId) {
  const rows = db.prepare('select sender_name from messages where sender_id = ? order by ts desc limit 30').all(userId)
  for (const row of rows) {
    const name = nameOf(row)
    if (name && !SYSTEM_NAME_RE.test(name)) return name
  }
  return ''
}

function mentionedBy(db, userId, chatKey) {
  const rows = chatKey
    ? db.prepare(
        'select sender_id, count(*) as n from messages where chat_key = ? and text like ? and sender_id <> ? group by sender_id order by n desc limit 8',
      ).all(chatKey, '%@' + userId + '%', userId)
    : db.prepare(
        'select sender_id, count(*) as n from messages where text like ? and sender_id <> ? group by sender_id order by n desc limit 8',
      ).all('%@' + userId + '%', userId)
  return rows
    .map((r) => ({ userId: r.sender_id, name: latestName(db, r.sender_id), count: r.n }))
    // 群系统消息的 sender_name 常被写成「XX 邀请 YY 加入了群聊」，不是真人
    .filter((r) => !SYSTEM_NAME_RE.test(r.name))
}

/**
 * 生成人物档案。
 * @param {object} [opts.mentions] 预先算好的 @ 关系 { mentionsOut, mentionedBy }（构建看板时由索引批量给出，
 *   省掉每人一条全表 LIKE）
 * @returns {object} { candidate, stats, chats, hours, peak, kinds, media, topWords, mentionsOut, mentionedBy, recent, summary }
 */
export function buildProfile(db, chatNames, { userId, chatKey = null, topLimit = 3000, mentions = null } = {}) {
  const scope = chatKey ? ' and chat_key = ?' : ''
  const scopeArgs = chatKey ? [chatKey] : []

  const aliases = [
    ...new Set(
      db
        .prepare(`select sender_name from messages where sender_id = ?${scope} group by sender_name order by count(*) desc limit 10`)
        .all(userId, ...scopeArgs)
        .map((r) => r.sender_name)
        .filter(Boolean),
    ),
  ]

  const chats = db
    .prepare(
      `select chat_key, count(*) as n, min(ts) as first_ts, max(ts) as last_ts
         from messages where sender_id = ?${scope}
        group by chat_key order by n desc`,
    )
    .all(userId, ...scopeArgs)
    .map((r) => ({
      chatKey: r.chat_key,
      name: chatNames.get(r.chat_key) || r.chat_key,
      msgCount: r.n,
      firstTs: r.first_ts,
      lastTs: r.last_ts,
    }))

  const tsRows = db
    .prepare(`select ts from messages where sender_id = ?${scope}`)
    .all(userId, ...scopeArgs)
  const hours = Array(24).fill(0)
  const weekdays = Array(7).fill(0)
  for (const { ts } of tsRows) {
    const d = new Date(ts * 1000)
    hours[d.getHours()]++
    weekdays[d.getDay()]++
  }
  const total = tsRows.length
  const peak = peakHours(hours, total)

  const kinds = db
    .prepare(`select kind, count(*) as n from messages where sender_id = ?${scope} group by kind order by n desc`)
    .all(userId, ...scopeArgs)
    .map((r) => ({ kind: r.kind, count: r.n }))

  const media = db
    .prepare(`select kind, count(*) as n from media where sender_id = ?${chatKey ? ' and chat_key = ?' : ''} group by kind`)
    .all(userId, ...scopeArgs)
    .map((r) => ({ kind: r.kind, count: r.n }))

  const links = db
    .prepare(`select count(*) as n from messages where sender_id = ?${scope} and text like '%http%'`)
    .get(userId, ...scopeArgs).n

  const recent = db
    .prepare(
      `select ts, chat_key, sender_name, kind, text from messages where sender_id = ?${scope} order by ts desc limit 8`,
    )
    .all(userId, ...scopeArgs)
    .map((r) => ({
      ts: r.ts,
      time: stamp(r.ts * 1000),
      chatKey: r.chat_key,
      chat: chatNames.get(r.chat_key) || r.chat_key,
      kind: r.kind,
      text: r.text,
    }))

  const top = topWords(db, userId, chatKey, topLimit)
  const mentionsOut = mentions ? mentions.mentionsOut || [] : mentionStats(db, userId, chatKey)
  const byWhom = mentions ? mentions.mentionedBy || [] : mentionedBy(db, userId, chatKey)
  const firstTs = chats.length ? Math.min(...chats.map((c) => c.firstTs)) : 0
  const lastTs = chats.length ? Math.max(...chats.map((c) => c.lastTs)) : 0

  const lines = []
  const label = aliases[0] || userId
  lines.push(`【${label}】QQ ${userId}${aliases.length > 1 ? `（也叫 ${aliases.slice(1, 4).join('、')}）` : ''}`)
  lines.push(
    chats.length
      ? `在 ${chats.length} 个会话里出现，共 ${total} 条消息${firstTs ? `（${stamp(firstTs * 1000)} ~ ${stamp(lastTs * 1000)}）` : ''}`
      : '归档里没有这个人的消息',
  )
  if (chats.length) {
    lines.push(
      `最活跃：${chats
        .slice(0, 3)
        .map((c) => `「${c.name}」${c.msgCount} 条`)
        .join('、')}`,
    )
  }
  if (peak.length) {
    lines.push(`常出没：${peak.map((p) => `${p.label}（${p.pct}%）`).join('、')}`)
  }
  const activeDays = weekdays.map((n, d) => ({ d, n })).sort((a, b) => b.n - a.n)[0]
  if (activeDays && activeDays.n > 0) {
    lines.push(`最活跃的日子：周${'日一二三四五六'[activeDays.d]}（${activeDays.n} 条）`)
  }
  if (top.length) lines.push(`高频词：${top.slice(0, 12).map((w) => w.word).join('、')}`)
  if (mentionsOut.length) {
    lines.push(`@ 最多：${mentionsOut.map((m) => `${m.name || m.userId}(${m.count})`).join('、')}`)
  }
  if (byWhom.length) {
    lines.push(`被谁 @ 最多：${byWhom.map((m) => `${m.name || m.userId}(${m.count})`).join('、')}`)
  }
  const kindText = kinds.map((k) => `${k.kind === 'text' ? '文字' : k.kind === 'image' ? '图片' : k.kind === 'voice' ? '语音' : k.kind} ${k.count}`).join('、')
  if (kindText) lines.push(`消息构成：${kindText}`)
  if (media.length) lines.push(`媒体：${media.map((m) => `${m.kind} ${m.count}`).join('、')}`)
  if (links) lines.push(`发过 ${links} 条带链接的消息`)
  if (recent.length) {
    lines.push('最近：')
    for (const r of recent.slice(0, 5)) {
      lines.push(`- ${r.time} · ${r.chat}：${r.text}`)
    }
  }

  return {
    userId,
    aliases,
    chats,
    total,
    firstTs,
    lastTs,
    hours,
    weekdays,
    peak,
    kinds,
    media,
    links,
    topWords: top,
    mentionsOut,
    mentionedBy: byWhom,
    recent,
    summary: lines.join('\n'),
  }
}
