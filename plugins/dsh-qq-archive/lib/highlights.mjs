/**
 * 名场面：滑窗找出群里「十来分钟刷了几十条」的爆聊窗口，取样交给模型写 120-220 字摘要，
 * 存 highlights 表；之后 list / read 直接读缓存，不重复调模型。
 *
 * 口径（findBursts）：
 * - 先按会话分组，绝不跨会话成段；
 * - 同一会话内相邻消息空档 >= gapSec 就切成独立的一段（一场爆聊被大段冷场分开就各算各的）；
 * - 段内用「跨度 <= windowSec」的滑动窗口找消息数 >= minMessages 的窗口；
 * - 重叠 / 相邻的窗口合并成一簇，只保留簇里消息最多的那个窗口作为锚点（否则一场爆聊会存出
 *   几十条几乎一样的窗口）。burst 的 fromTs/toTs/count/participants/topWords/samples 全部
 *   取自锚点窗口，所以每个名场面就是一段连续的十来分钟。
 *
 * 阈值一律不自动降低：数据量小的库传小参数（测试就是这么做的），别偷偷改变调用方语义。
 */
import { isoDate, stamp, truncate } from './util.mjs'
import { listRoutes, pickRoute, generateText } from './llm.mjs'
import { countWordsFromTexts } from './topics.mjs'

const BURST_PARTICIPANTS = 12
const BURST_WORDS = 10
const BURST_SAMPLES = 12
/** findBursts 一次最多扫多少条消息；超大范围截断而不是把内存吃满（已知限制，见 README/回报）。 */
const MAX_SCAN = 60000

const PLACEHOLDER_RE = /^\s*(\[[^\]\n]{1,12}\]\s*)+$/

export const HIGHLIGHT_SYSTEM = [
  '你是一个 QQ 群聊档案馆的编辑，要给一段「群聊名场面」写回顾。',
  '要求：',
  '1. 用中文写 120-220 字的一段话，不分小标题、不用 Markdown、不要 JSON；',
  '2. 写清这十来分钟群里在干什么、笑点/梗/冲突在哪、谁在带节奏，语气像群友自己回看，别写成公文；',
  '3. 只依据给出的统计和摘录，不编造摘录里没有的事实，人名照抄；',
  '4. 不要逐条复述消息，提炼那一刻的氛围。',
].join('\n')

function toInt(v, fallback, min = 1) {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) && n >= min ? n : fallback
}

function fmtClock(ts) {
  const d = new Date(ts * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 把一个窗口里的消息按发送者聚合（次数降序、同次数按 userId 升序）。 */
function summarizeParticipants(rows) {
  const map = new Map()
  for (const r of rows) {
    const userId = String(r.sender_id)
    const p = map.get(userId) || { userId, name: userId, count: 0 }
    p.count++
    if (r.sender_name) p.name = r.sender_name
    map.set(userId, p)
  }
  return [...map.values()].sort((a, b) => b.count - a.count || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
}

/**
 * 从窗口消息里均匀挑摘录：跳过纯占位消息、去重相似文本，最多 max 条，按时间正序。
 * 摘录截到 140 字，避免把整段长文塞进提示词。
 */
function pickBurstSamples(rows, max = BURST_SAMPLES) {
  const seen = new Set()
  const candidates = []
  for (const r of rows) {
    const text = String(r.text || '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text || PLACEHOLDER_RE.test(text)) continue
    const key = text.slice(0, 30)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ ts: r.ts, senderName: r.sender_name || String(r.sender_id), text: truncate(text, 140) })
  }
  if (candidates.length <= max) return candidates
  const picked = []
  for (let k = 0; k < max; k++) {
    picked.push(candidates[Math.round((k * (candidates.length - 1)) / (max - 1))])
  }
  return picked
}

/** 相邻消息空档 >= gapSec 就切段（切出来的每段内部再找滑窗）。 */
function splitByGap(rows, gapSec) {
  const segments = []
  let cur = []
  let prevTs = null
  for (const r of rows) {
    if (cur.length && prevTs !== null && r.ts - prevTs >= gapSec) {
      segments.push(cur)
      cur = []
    }
    cur.push(r)
    prevTs = r.ts
  }
  if (cur.length) segments.push(cur)
  return segments
}

/**
 * 段内滑窗：返回所有「跨度 <= windowSec 且消息数 >= minMessages」的窗口（下标闭区间）。
 * ts 已按时间升序，j 只增不减，整体 O(n)。
 */
function slidingWindows(rows, windowSec, minMessages) {
  const wins = []
  let j = -1
  for (let i = 0; i < rows.length; i++) {
    if (j < i) j = i - 1
    while (j + 1 < rows.length && rows[j + 1].ts - rows[i].ts <= windowSec) j++
    const count = j - i + 1
    if (count >= minMessages) wins.push({ i, j, count })
  }
  return wins
}

/**
 * 重叠 / 相邻窗口合并成簇，锚点取簇内消息最多的窗口；再按锚点生成 burst。
 */
function burstsInSegment(rows, { windowSec, minMessages }) {
  const wins = slidingWindows(rows, windowSec, minMessages)
  if (!wins.length) return []
  wins.sort((a, b) => a.i - b.i || a.j - b.j)
  const clusters = []
  for (const w of wins) {
    const last = clusters[clusters.length - 1]
    // 相邻窗口（w.i == last.j + 1）也算同一场，合并后只出一个名场面
    if (last && w.i <= last.j + 1) {
      last.j = Math.max(last.j, w.j)
      if (w.count > last.anchor.count) last.anchor = w
    } else {
      clusters.push({ i: w.i, j: w.j, anchor: { ...w } })
    }
  }
  return clusters.map((c) => {
    const slice = rows.slice(c.anchor.i, c.anchor.j + 1)
    return {
      fromTs: slice[0].ts,
      toTs: slice[slice.length - 1].ts,
      count: slice.length,
      participants: summarizeParticipants(slice).slice(0, BURST_PARTICIPANTS),
      topWords: countWordsFromTexts(
        slice.map((r) => r.text),
        BURST_WORDS,
      ),
      samples: pickBurstSamples(slice),
    }
  })
}

/**
 * 找爆聊窗口。
 *
 * @param {object} db archive.db
 * @param {object} opts
 * @param {string|null} opts.chatKey 只看某个会话
 * @param {number} opts.fromTs / opts.toTs unix 秒；0 = 不限
 * @param {number} opts.windowSec 单个窗口最大跨度（默认 600 秒）
 * @param {number} opts.minMessages 窗口内至少多少条才算爆聊（默认 40）
 * @param {number} opts.gapSec 多大空档切段（默认 600 秒）
 * @param {number} opts.limit 返回几个（按消息数降序取前 N）
 * @returns {Array<{chatKey,chatName,fromTs,toTs,count,participants,topWords,samples}>}
 */
export function findBursts(db, { chatKey = null, fromTs = 0, toTs = 0, windowSec = 600, minMessages = 40, gapSec = 600, limit = 12 } = {}) {
  const win = toInt(windowSec, 600)
  const minMsgs = toInt(minMessages, 40)
  const gap = toInt(gapSec, 600)
  const lim = toInt(limit, 12)

  const conds = ['m.ts >= ?']
  const args = [Number(fromTs) > 0 ? Math.floor(Number(fromTs)) : 0]
  if (Number(toTs) > 0) {
    conds.push('m.ts <= ?')
    args.push(Math.floor(Number(toTs)))
  }
  if (chatKey) {
    conds.push('m.chat_key = ?')
    args.push(String(chatKey))
  }
  const rows = db
    .prepare(
      `select m.chat_key, m.sender_id, m.sender_name, m.ts, m.text, coalesce(c.name, '') as chat_name
         from messages m
         left join chats c on c.chat_key = m.chat_key
        where ${conds.join(' and ')}
        order by m.chat_key asc, m.ts asc, m.id asc
        limit ?`,
    )
    .all(...args, MAX_SCAN)

  // 按会话分组，各自独立找爆聊段
  const byChat = new Map()
  for (const r of rows) {
    let list = byChat.get(r.chat_key)
    if (!list) {
      list = []
      byChat.set(r.chat_key, list)
    }
    list.push(r)
  }

  const bursts = []
  for (const [key, list] of byChat) {
    const chatName = list[0].chat_name || key
    for (const seg of splitByGap(list, gap)) {
      for (const b of burstsInSegment(seg, { windowSec: win, minMessages: minMsgs })) {
        bursts.push({ chatKey: key, chatName, ...b })
      }
    }
  }

  bursts.sort((a, b) => b.count - a.count || a.fromTs - b.fromTs || (a.chatKey < b.chatKey ? -1 : 1))
  return bursts.slice(0, lim)
}

/** 渲染给模型的提示词（导出是为了测试和排查，正常调用走 generateHighlightSummary）。 */
export function buildHighlightPrompt(burst) {
  const durMin = Math.max(1, Math.round((burst.toTs - burst.fromTs) / 60))
  const lines = [
    `# 群聊名场面 · ${burst.chatName || burst.chatKey}`,
    `时间：${stamp(burst.fromTs * 1000)} ~ ${stamp(burst.toTs * 1000)}（约 ${durMin} 分钟）`,
    `消息：${burst.count} 条，${burst.participants.length} 人参与`,
    `参与者：${burst.participants.map((p) => `${p.name}(${p.count})`).join('、') || '无'}`,
    `高频词：${burst.topWords.map((w) => `${w.word}(${w.count})`).join('、') || '无'}`,
  ]
  if (burst.samples?.length) {
    lines.push('', '## 摘录')
    for (const s of burst.samples) lines.push(`${fmtClock(s.ts)} ${s.senderName}：${s.text}`)
  }
  lines.push('', '请按要求写一段 120-220 字的中文摘要，只输出摘要正文。')
  return lines.join('\n')
}

/** 模型可能带 ``` 包裹或标题，清一下只留正文。 */
function cleanSummary(text) {
  return String(text || '')
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 为单个爆聊窗口生成摘要。
 *
 * 正常路径走 generateText（lib/llm.mjs，预算不够自动翻倍）；测试可传 `_generate` 回调注入假模型，
 * 回调收到 `{ prompt, system, burst }`，返回字符串或 `{ text }` 都行。
 *
 * @returns {Promise<{summary:string, model:string}>}
 */
export async function generateHighlightSummary({ db, llm, route, burst, signal, _generate } = {}) {
  const prompt = buildHighlightPrompt(burst)
  let text = ''
  if (typeof _generate === 'function') {
    const out = await _generate({ prompt, system: HIGHLIGHT_SYSTEM, burst })
    text = typeof out === 'string' ? out : String(out?.text ?? out?.summary ?? '')
  } else {
    if (!llm) throw new Error('DSH 的 llm 服务不可用（插件没拿到 ctx.get("llm")）')
    if (!route?.provider || !route?.model) throw new Error('没有可用的模型：请先配置 llm.provider / llm.model')
    const r = await generateText(llm, {
      provider: route.provider,
      model: route.model,
      system: HIGHLIGHT_SYSTEM,
      prompt,
      temperature: 0.7,
      maxTokens: 700,
      attempts: 3,
      signal,
    })
    text = r.text
  }
  const summary = cleanSummary(text)
  if (!summary) throw new Error('模型没有返回名场面摘要')
  const model = route ? `${route.provider}/${route.model}` : 'injected'
  return { summary, model }
}

function rowToHighlight(row) {
  let stats = null
  try {
    stats = row.stats ? JSON.parse(row.stats) : null
  } catch {
    stats = null
  }
  return {
    id: row.id,
    chatKey: row.chat_key,
    chatName: stats?.chatName || row.chat_key,
    fromTs: row.from_ts,
    toTs: row.to_ts,
    msgCount: row.msg_count,
    summary: row.summary || '',
    model: row.model || '',
    createdAt: row.created_at,
    stats,
  }
}

/**
 * 找爆聊窗口 → 已存过的（同 chatKey + fromTs + toTs）默认跳过 → 生成摘要 → upsert highlights。
 * force=true 时重写已有窗口。
 *
 * @returns {Promise<{found:number,built:number,skipped:number,results:Array}>}
 */
export async function runHighlights({
  db,
  llm,
  cfg,
  fromTs = 0,
  toTs = 0,
  limit = 12,
  force = false,
  chatKey = null,
  signal,
  onProgress,
  _generate,
  route: fixedRoute = null,
  windowSec,
  minMessages,
  gapSec,
} = {}) {
  let route = fixedRoute
  if (!route && typeof _generate !== 'function') {
    const routes = await listRoutes(llm)
    route = pickRoute(routes, cfg?.llm)
    if (!route) throw new Error('DSH 里没有可用的模型，无法生成名场面摘要（先在 DSH 里启用一个 provider）')
  }

  const bursts = findBursts(db, { chatKey, fromTs, toTs, limit, windowSec, minMessages, gapSec })
  const existsStmt = db.prepare('select id, summary from highlights where chat_key = ? and from_ts = ? and to_ts = ?')
  const upsert = db.prepare(
    `insert into highlights(chat_key, from_ts, to_ts, msg_count, stats, summary, model, created_at)
     values(?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(chat_key, from_ts, to_ts) do update set
       msg_count = excluded.msg_count, stats = excluded.stats, summary = excluded.summary,
       model = excluded.model, created_at = excluded.created_at`,
  )

  const results = []
  let built = 0
  let skipped = 0

  for (let i = 0; i < bursts.length; i++) {
    if (signal?.aborted) throw new Error('已取消')
    const b = bursts[i]
    const fromDate = isoDate(b.fromTs)
    const old = existsStmt.get(b.chatKey, b.fromTs, b.toTs)

    if (old && !force) {
      skipped++
      results.push({ chatKey: b.chatKey, fromTs: b.fromTs, fromDate, summary: old.summary || '', ok: true, skipped: true })
      onProgress?.({ done: i + 1, total: bursts.length, chatKey: b.chatKey, fromTs: b.fromTs, skipped: true })
      continue
    }

    try {
      const { summary, model } = await generateHighlightSummary({ db, llm, route, burst: b, signal, _generate })
      // stats 只存摘要页要展示的四个字段，不把整段原始消息塞进库
      const stats = JSON.stringify({
        chatName: b.chatName,
        participants: b.participants,
        topWords: b.topWords,
        samples: b.samples,
      })
      upsert.run(b.chatKey, b.fromTs, b.toTs, b.count, stats, summary, model, Math.floor(Date.now() / 1000))
      built++
      results.push({ chatKey: b.chatKey, fromTs: b.fromTs, fromDate, summary, ok: true })
    } catch (e) {
      results.push({ chatKey: b.chatKey, fromTs: b.fromTs, fromDate, ok: false, error: String(e?.message || e) })
    }
    onProgress?.({ done: i + 1, total: bursts.length, chatKey: b.chatKey, fromTs: b.fromTs })
  }

  return { found: bursts.length, built, skipped, results }
}

/** 已存名场面，新的在前；stats 解析成对象。 */
export function listHighlights(db, { limit = 20, chatKey = null } = {}) {
  const lim = Math.max(1, Math.min(500, Math.floor(Number(limit) || 20)))
  const rows = chatKey
    ? db.prepare('select * from highlights where chat_key = ? order by from_ts desc, id desc limit ?').all(String(chatKey), lim)
    : db.prepare('select * from highlights order by from_ts desc, id desc limit ?').all(lim)
  return rows.map(rowToHighlight)
}

/** 按 id 读单条，没有返回 null。 */
export function readHighlight(db, id) {
  const row = db.prepare('select * from highlights where id = ?').get(Number(id))
  return row ? rowToHighlight(row) : null
}
