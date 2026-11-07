/**
 * @ 关系索引：一次扫描算出「谁 @ 了谁」。
 *
 * 旧做法是每份人物档案各跑一条 `text like '%@uid%'` 的全表查询——人越多越慢
 * （实测每人 ~15 ms，540 份档案就是 8 秒）。这里改成构建时扫一遍所有带 @ 的
 * 消息，按「全局 + 每个会话」两个维度记账，档案组装时直接取。
 *
 * 展示名取每个人最近一条消息里的名字；旧 SQL 取的是分组里任意一条（往往是
 * 很早以前的旧昵称）。
 */

const MENTION_RE = /@(\d{5,12})(?!\d)/g
// 群系统消息的 sender_name 常被写成「XX 邀请 YY 加入了群聊」，不是真人
const SYSTEM_NAME_RE = /加入|邀请|撤回|禁言|红包/

/**
 * 每个人最近一次露面的名字（按入库顺序取最后一条）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Map<string, string>}
 */
export function resolveNames(db) {
  const names = new Map()
  const rows = db
    .prepare('select sender_id, sender_name from messages where id in (select max(id) from messages group by sender_id)')
    .all()
  for (const r of rows) {
    const id = String(r.sender_id || '')
    const name = String(r.sender_name || '').trim()
    if (id && name) names.set(id, name)
  }
  return names
}

/**
 * 扫一遍所有带 @ 的消息，返回 { names, scopes }。
 * scopes: Map(scope → { out: Map(from → Map(to → n)), in: Map(to → Map(from → n)) })，
 * scope 为 '*'（全局）或会话 key。
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function buildMentionIndex(db) {
  const names = resolveNames(db)
  const scopes = new Map()

  const scopeOf = (key) => {
    let s = scopes.get(key)
    if (!s) {
      s = { out: new Map(), in: new Map() }
      scopes.set(key, s)
    }
    return s
  }
  const bump = (scope, from, to) => {
    const s = scopeOf(scope)
    let o = s.out.get(from)
    if (!o) {
      o = new Map()
      s.out.set(from, o)
    }
    o.set(to, (o.get(to) || 0) + 1)
    let i = s.in.get(to)
    if (!i) {
      i = new Map()
      s.in.set(to, i)
    }
    i.set(from, (i.get(from) || 0) + 1)
  }

  const rows = db.prepare("select chat_key, sender_id, text from messages where text like '%@%'").all()
  for (const r of rows) {
    const from = String(r.sender_id || '')
    const text = r.text
    if (!from || !text) continue
    MENTION_RE.lastIndex = 0
    const targets = new Set()
    let m
    while ((m = MENTION_RE.exec(text))) {
      if (m[1] !== from) targets.add(m[1])
    }
    if (!targets.size) continue
    for (const to of targets) {
      bump('*', from, to)
      bump(r.chat_key, from, to)
    }
  }
  return { names, scopes }
}

const byCount = (a, b) => b.count - a.count || Number(a.userId) - Number(b.userId)

function rank(index, map, limit) {
  if (!map) return []
  return [...map.entries()]
    .map(([userId, count]) => ({ userId, count, name: index.names.get(userId) || userId }))
    .sort(byCount)
    .slice(0, limit)
}

/**
 * 某个 scope 下这个人的 @ 关系（展示用）。
 * @returns {{ mentionsOut: object[], mentionedBy: object[] }}
 */
export function mentionsFor(index, userId, scope = '*') {
  const s = index.scopes.get(scope)
  const out = rank(index, s?.out.get(userId), 8)
  const inbound = rank(index, s?.in.get(userId), 24)
    .filter((r) => !SYSTEM_NAME_RE.test(r.name))
    .slice(0, 8)
  return { mentionsOut: out, mentionedBy: inbound }
}
