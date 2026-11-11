/**
 * 周报 / 月报：按自然周（周一起算）或自然月，统计一段时间的群聊并交给模型写总结。
 *
 * 统计部分复用 report.buildReport（和日报同一套口径），这里只多算
 * 「每天多少条」的 topDays 和周期字段。周期只覆盖 2026-11-06 起：
 * 用户确认更早的历史不补；落在边界上的周期裁到 11-06，整段早于 11-06 的周期直接拒绝。
 *
 * 结果落到 period_reports（主键 kind + from_date + chat_key，force 时覆盖）。
 */
import { buildReport, fmtDay } from './report.mjs'
import { listRoutes, pickRoute, generateText } from './llm.mjs'

/** 周报/月报的最早起点（2026-11-11 用户确认：更早的不补）。 */
export const PERIOD_FLOOR = '2026-11-06'

/** Date | 'YYYY-MM-DD' | unix 秒/毫秒 → Date（本地时区）。 */
function normalizeRef(ref) {
  if (ref === undefined || ref === null || ref === '') return new Date()
  if (ref instanceof Date) return new Date(Number.isFinite(ref.getTime()) ? ref.getTime() : Date.now())
  if (typeof ref === 'number') return new Date(ref < 1e12 ? ref * 1000 : ref)
  const text = String(ref).trim()
  if (/^\d{9,11}$/.test(text)) return new Date(Number(text) * 1000)
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const parsed = Date.parse(text)
  if (Number.isFinite(parsed)) return new Date(parsed)
  throw new Error(`看不懂 ref 的日期写法：${ref}（用 Date 或 YYYY-MM-DD）`)
}

function normalizeOffset(offset) {
  const n = Math.trunc(Number(offset))
  return Number.isFinite(n) ? n : 0
}

/** 'YYYY-MM-DD' → 当天 00:00 的 unix 秒（本地时区）。 */
function dayStartTs(dateText) {
  const [y, m, d] = String(dateText).split('-').map(Number)
  return Math.floor(new Date(y, m - 1, d, 0, 0, 0).getTime() / 1000)
}

/**
 * 周期边界（本地时区，toTs 含最后一天 23:59:59）。
 * week = 周一起算的 7 天；month = 自然月；offset 前后平移周期个数。
 * @returns {{kind:string, fromTs:number, toTs:number, fromDate:string, toDate:string, label:string}}
 */
export function periodBounds(kind = 'week', ref = new Date(), offset = 0) {
  if (kind !== 'week' && kind !== 'month') throw new Error(`kind 只能是 week 或 month（收到：${kind}）`)
  const base = normalizeRef(ref)
  const off = normalizeOffset(offset)

  let start
  if (kind === 'week') {
    start = new Date(base.getFullYear(), base.getMonth(), base.getDate())
    const mondayOffset = (start.getDay() + 6) % 7 // 周一 = 0，周日 = 6
    start.setDate(start.getDate() - mondayOffset + off * 7)
  } else {
    start = new Date(base.getFullYear(), base.getMonth() + off, 1)
  }

  // 下一个周期的起点；toTs 取它前一秒
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  if (kind === 'week') end.setDate(end.getDate() + 7)
  else end.setMonth(end.getMonth() + 1)

  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  last.setDate(last.getDate() - 1)

  const fromDate = fmtDay(start)
  const toDate = fmtDay(last)
  return {
    kind,
    fromTs: Math.floor(start.getTime() / 1000),
    toTs: Math.floor(end.getTime() / 1000) - 1,
    fromDate,
    toDate,
    label: `${fromDate} ~ ${toDate}`,
  }
}

/**
 * 统计一个周期（复用日报的 buildReport）。
 *
 * 早于 PERIOD_FLOOR 的部分不算：fromDate 裁到 11-06、fromTs 跟着改；
 * 整个周期都早于 11-06 则抛错。
 */
export function buildPeriod(db, { chatKey = null, kind = 'week', ref = new Date(), offset = 0, sampleLimit = 60 } = {}) {
  const bounds = periodBounds(kind, ref, offset)
  const { toTs, toDate } = bounds
  let { fromTs, fromDate } = bounds

  if (toDate < PERIOD_FLOOR) {
    throw new Error(
      `周报/月报只覆盖 ${PERIOD_FLOOR} 起的聊天：${bounds.fromDate} ~ ${bounds.toDate} 整段早于该日期，不补历史`,
    )
  }
  let clipped = false
  if (fromDate < PERIOD_FLOOR) {
    fromDate = PERIOD_FLOOR
    fromTs = dayStartTs(PERIOD_FLOOR)
    clipped = true
  }

  const report = buildReport(db, { chatKey, fromTs, toTs, sampleLimit })
  const filter = chatKey ? ' and chat_key = ?' : ''
  const args = chatKey ? [chatKey] : []

  const topDays = db
    .prepare(
      `select date(ts, 'unixepoch', 'localtime') as d, count(*) as c
         from messages where ts between ? and ?${filter}
        group by d order by c desc, d asc limit 5`,
    )
    .all(fromTs, toTs, ...args)
    .map((r) => ({ date: String(r.d), count: Number(r.c) }))

  const activeDays = db
    .prepare(
      `select count(distinct date(ts, 'unixepoch', 'localtime')) as c
         from messages where ts between ? and ?${filter}`,
    )
    .get(fromTs, toTs, ...args).c

  return {
    ...report,
    kind,
    fromDate,
    toDate,
    fromTs,
    toTs,
    label: `${fromDate} ~ ${toDate}`,
    clipped,
    activeDays: Number(activeDays) || 0,
    topDays,
  }
}

export const PERIOD_SYSTEM = [
  '你是一个群聊周报编辑。给你某个 QQ 群一段时间的统计和若干条聊天摘录，写一份中文总结。',
  '要求：',
  '1. 用 Markdown，四个小标题固定为「## 这段时间聊了什么」「## 值得回看的」「## 人物与关系」「## 下周期待」；',
  '2. 不要逐条复述消息，提炼话题、梗和关系变化；某个标题确实没内容就写「这段时间没什么特别的」；',
  '3. 总长度 400-600 字，语气自然，像群友自己写的，不要写成公文；',
  '4. 不要编造摘录里没有的事实，不确定的就不写。',
].join('\n')

/** 把周期统计 + 采样拼成给模型的 prompt（格式和日报的 buildReportPrompt 一致，换了周期口径）。 */
export function buildPeriodPrompt(period) {
  const kindLabel = period.kind === 'month' ? '月报' : '周报'
  const lines = [
    `# ${period.fromDate} ~ ${period.toDate} · ${period.chatName}`,
    `周期：${period.fromDate} ~ ${period.toDate}（${kindLabel}）`,
    `消息 ${period.total} 条，${period.members.length} 人发言，活跃 ${period.activeDays ?? 0} 天。`,
    `高频词：${period.topWords.map((w) => `${w.word}(${w.count})`).join('、') || '无'}`,
    `活跃成员：${period.members.slice(0, 8).map((m) => `${m.name}(${m.count})`).join('、') || '无'}`,
    `最热闹的日子：${period.topDays.map((d) => `${d.date}(${d.count})`).join('、') || '无'}`,
  ]
  if (period.links.length) lines.push(`链接：\n${period.links.slice(0, 5).join('\n')}`)
  if (period.samples.length) {
    lines.push('## 摘录')
    for (const s of period.samples) {
      const t = new Date(s.ts * 1000)
      const md = `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
      const hh = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
      lines.push(`${md} ${hh} ${s.name}：${s.text}`)
    }
  }
  return lines.join('\n')
}

function savePeriodReport(db, { kind, fromDate, toDate, chatKey, text, stats = null, model = '' }) {
  db.prepare(
    `insert into period_reports(kind, from_date, to_date, chat_key, text, stats, model, created_at)
     values(?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(kind, from_date, chat_key) do update set
       to_date = excluded.to_date,
       text = excluded.text,
       stats = excluded.stats,
       model = excluded.model,
       created_at = excluded.created_at`,
  ).run(kind, fromDate, toDate, chatKey, text, stats ? JSON.stringify(stats) : null, model, Math.floor(Date.now() / 1000))
}

function parseStats(raw) {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function rowToPeriod(row) {
  return {
    kind: row.kind,
    fromDate: row.from_date,
    toDate: row.to_date,
    chatKey: row.chat_key,
    chatName: row.chat_name || (row.chat_key === '*' ? '所有会话' : row.chat_key),
    text: row.text || '',
    stats: parseStats(row.stats),
    model: row.model || '',
    createdAt: row.created_at,
    label: `${row.from_date} ~ ${row.to_date}`,
  }
}

/**
 * 生成（或跳过）一份周报/月报。
 *
 * 同 (kind, from_date, chat_key) 已存在且非 force 时直接跳过；周期内一条消息都没有也跳过。
 * 测试可以注入 `_generate({system,prompt,period,signal}) -> {text,model}` 绕过真模型。
 * @returns {{saved:boolean, skipped:boolean, text:string, model:string, kind:string, fromDate:string, toDate:string}}
 */
export async function runPeriodReport({
  db,
  llm = null,
  cfg = null,
  kind = 'week',
  chatKey = null,
  ref = new Date(),
  offset = 0,
  force = false,
  signal,
  onProgress,
  _generate = null,
} = {}) {
  const period = buildPeriod(db, { chatKey, kind, ref, offset })
  const key = chatKey || '*'
  onProgress?.({ step: 'stats', kind: period.kind, fromDate: period.fromDate, toDate: period.toDate, total: period.total })

  const existing = readPeriodReport(db, { kind: period.kind, fromDate: period.fromDate, chatKey: key })
  if (existing && !force) {
    return {
      saved: false,
      skipped: true,
      reason: 'exists',
      text: existing.text,
      model: existing.model,
      kind: period.kind,
      fromDate: period.fromDate,
      toDate: period.toDate,
    }
  }
  if (!period.total) {
    return {
      saved: false,
      skipped: true,
      reason: 'empty',
      text: '',
      model: '',
      kind: period.kind,
      fromDate: period.fromDate,
      toDate: period.toDate,
    }
  }

  const prompt = buildPeriodPrompt(period)
  let text = ''
  let model = ''

  if (typeof _generate === 'function') {
    const out = (await _generate({ system: PERIOD_SYSTEM, prompt, period, signal })) || {}
    text = String(out.text || '').trim()
    model = String(out.model || 'injected')
  } else {
    const routes = await listRoutes(llm)
    const route = pickRoute(routes, cfg?.llm)
    if (!route) throw new Error('DSH 里没有可用的模型，无法生成周报/月报（先在 DSH 里启用一个 provider）')
    onProgress?.({ step: 'llm', provider: route.provider, model: route.model })
    const result = await generateText(llm, {
      provider: route.provider,
      model: route.model,
      system: PERIOD_SYSTEM,
      prompt,
      temperature: 0.4,
      maxTokens: 1200,
      attempts: 4,
      signal,
    })
    text = String(result.text || '').trim()
    model = `${route.provider}/${route.model}`
  }
  if (!text) throw new Error('模型没有返回内容，周报/月报没有生成')

  const stats = {
    total: period.total,
    members: period.members,
    topWords: period.topWords,
    links: period.links,
    topDays: period.topDays,
    activeDays: period.activeDays,
  }
  savePeriodReport(db, {
    kind: period.kind,
    fromDate: period.fromDate,
    toDate: period.toDate,
    chatKey: key,
    text,
    stats,
    model,
  })
  onProgress?.({ step: 'saved', kind: period.kind, fromDate: period.fromDate })
  return {
    saved: true,
    skipped: false,
    reason: '',
    text,
    model,
    kind: period.kind,
    fromDate: period.fromDate,
    toDate: period.toDate,
  }
}

/** 已生成的周期报告，from_date 新的在前。kind 不传 = 不分周/月。 */
export function listPeriodReports(db, { kind = null, limit = 12 } = {}) {
  const args = []
  let where = ''
  if (kind) {
    where = 'where p.kind = ?'
    args.push(kind)
  }
  args.push(Math.max(1, Math.min(200, Number(limit) || 12)))
  return db
    .prepare(
      `select p.*, c.name as chat_name
         from period_reports p left join chats c on c.chat_key = p.chat_key
         ${where}
        order by p.from_date desc, p.created_at desc
        limit ?`,
    )
    .all(...args)
    .map(rowToPeriod)
}

/** 读一份周期报告；chatKey 不传 = 所有会话（'*'）。找不到返回 null。 */
export function readPeriodReport(db, { kind = 'week', fromDate, chatKey = null } = {}) {
  const key = chatKey || '*'
  const row = db
    .prepare(
      `select p.*, c.name as chat_name
         from period_reports p left join chats c on c.chat_key = p.chat_key
        where p.kind = ? and p.from_date = ? and p.chat_key = ?`,
    )
    .get(kind, fromDate, key)
  return row ? rowToPeriod(row) : null
}
