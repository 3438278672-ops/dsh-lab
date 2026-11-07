/**
 * 人物关系网络：从 @ 互动里抽边。
 *
 * 关系不是「谁认识谁」，而是「谁在群里点过谁」——这是一个可观测、不会瞎编的信号。
 * 节点按发言量定大小，边按 @ 次数定粗细。
 */

const AT_RE = /"type"\s*:\s*"at"[\s\S]{0,120}?"qq"\s*:\s*"(\d+)"/g

function chatFilter(chatKey) {
  return chatKey ? { sql: ' and chat_key = ?', args: [chatKey] } : { sql: '', args: [] }
}

/**
 * @returns {{nodes: {id,name,count,out,in}[], edges: {source,target,count}[], totalAt}}
 */
export function buildGraph(db, { chatKey = null, sinceTs = 0, maxNodes = 80 } = {}) {
  const f = chatFilter(chatKey)
  const rows = db
    .prepare(
      `select sender_id, sender_name, raw from messages
        where raw like '%"at"%' and sender_id <> '' and ts >= ?${f.sql}`,
    )
    .all(sinceTs, ...f.args)

  const edgeCount = new Map()
  const outCount = new Map()
  const inCount = new Map()
  for (const r of rows) {
    const src = String(r.sender_id)
    const raw = String(r.raw || '')
    AT_RE.lastIndex = 0
    let m
    while ((m = AT_RE.exec(raw))) {
      const dst = m[1]
      if (!dst || dst === 'all' || dst === src) continue
      const key = `${src}|${dst}`
      edgeCount.set(key, (edgeCount.get(key) || 0) + 1)
      outCount.set(src, (outCount.get(src) || 0) + 1)
      inCount.set(dst, (inCount.get(dst) || 0) + 1)
    }
  }

  const msgCount = new Map()
  for (const r of db
    .prepare(`select sender_id as id, count(*) c from messages where sender_id <> '' and ts >= ?${f.sql} group by sender_id`)
    .all(sinceTs, ...f.args)) {
    msgCount.set(String(r.id), r.c)
  }

  const names = new Map()
  for (const r of db.prepare('select user_id, names from members').all()) {
    const arr = JSON.parse(r.names || '[]')
    if (arr.length) names.set(String(r.user_id), arr[arr.length - 1])
  }

  // 只保留互动最活跃的一批节点，图不至于糊成毛线
  const degree = new Map()
  for (const [key, c] of edgeCount) {
    const [a, b] = key.split('|')
    degree.set(a, (degree.get(a) || 0) + c)
    degree.set(b, (degree.get(b) || 0) + c)
  }
  const keep = new Set(
    [...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxNodes).map(([id]) => id),
  )

  const nodes = [...keep].map((id) => ({
    id,
    name: names.get(id) || messagesName(db, id) || id,
    count: msgCount.get(id) || 0,
    out: outCount.get(id) || 0,
    in: inCount.get(id) || 0,
  }))
  nodes.sort((a, b) => b.count - a.count)

  const edges = []
  for (const [key, count] of edgeCount) {
    const [a, b] = key.split('|')
    if (!keep.has(a) || !keep.has(b)) continue
    edges.push({ source: a, target: b, count })
  }
  edges.sort((a, b) => b.count - a.count)

  return { nodes, edges, totalAt: [...outCount.values()].reduce((s, n) => s + n, 0) }
}

function messagesName(db, id) {
  const row = db.prepare('select sender_name from messages where sender_id = ? order by ts desc limit 1').get(id)
  return row?.sender_name || ''
}
