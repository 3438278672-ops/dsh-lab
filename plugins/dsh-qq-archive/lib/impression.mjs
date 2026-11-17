/**
 * 人物印象（增强层，默认关）。
 *
 * 把 buildProfile 的统计 + 采样发言交给 DSH 的 llm 服务，写一段「像老群友
 * 向新人介绍这个人」的小传。印象存 profiles 表里 chat_key='*' 那一行，
 * qq_people 查询时顺带读出来，不需要每次重跑模型。
 *
 * 采样是等距的：只取最近 N 条会全是梗图接龙，只取早期又不像现在的人。
 */
import { isoDate, stamp, truncate } from './util.mjs'
import { buildProfile, findCandidates } from './people.mjs'
import { listRoutes, pickRoute, generateText } from './llm.mjs'
import { getMeta } from './db.mjs'

export const IMPRESSION_KEY = '*'
const REFRESH_DAYS = 7

const SYSTEM_PROMPT = [
  '你是一个 QQ 群聊档案员，要根据聊天记录给一个群友写「人物小传」。',
  '规则：',
  '1. 只依据给出的统计和发言，绝不编造现实身份、职业、年龄、学校、住址、性别。',
  '2. 写具体：说话风格（句子长短、口头禅、语气、爱用的表情/梗）、常聊的话题、在群里扮演的角色。',
  '3. 语气像老群友向新人介绍这个人，轻松、具体、有一点点调侃，但不要贬低。',
  '4. 不要写成简历、测评或 AI 总结体；不要出现「根据聊天记录」「从数据来看」这类话。',
  '5. 篇幅 120-220 字。',
  '6. 只输出 JSON，不要 markdown 代码块：{"impression":"……","tags":["3-6 个短标签"]}',
].join('\n')

const KIND_CN = { text: '文字', image: '图片', voice: '语音', video: '视频', forward: '合并转发', file: '文件', card: '卡片' }

const PLACEHOLDER_RE = /^\s*(\[[^\]\n]{1,12}\]\s*)+$/

export function collectSamples(db, userId, chatKey, limit) {
  const scope = chatKey ? ' and chat_key = ?' : ''
  const args = chatKey ? [userId, chatKey] : [userId]
  const cols = 'ts, chat_key, sender_name, text'
  const where = `sender_id = ?${scope} and text <> ''`
  // 最近的一段 + 全时段随机的一段：只看最近会全是梗图接龙，只随机又不像现在的人
  const recent = db.prepare(`select ${cols} from messages where ${where} order by ts desc limit ?`).all(...args, limit)
  const random = db.prepare(`select ${cols} from messages where ${where} order by random() limit ?`).all(...args, Math.max(4, Math.ceil(limit / 2)))
  const seen = new Set()
  const merged = []
  for (const row of [...recent, ...random]) {
    if (PLACEHOLDER_RE.test(row.text)) continue // [图片]/[语音] 对人物小传没信息量
    const key = `${row.ts}|${row.chat_key}|${row.text.slice(0, 40)}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(row)
  }
  merged.sort((a, b) => a.ts - b.ts)
  if (merged.length <= limit) return merged
  // 超出预算就等距降采样；首尾各锚一条，保证「最早」和「最近」都在
  const picked = [merged[0]]
  const inner = merged.slice(1, merged.length - 1)
  const need = limit - 2
  if (need > 0 && inner.length) {
    const step = inner.length / need
    for (let i = 0; i < need; i++) picked.push(inner[Math.min(inner.length - 1, Math.floor(i * step + step / 2))])
  }
  picked.push(merged[merged.length - 1])
  picked.sort((a, b) => a.ts - b.ts)
  return picked
}

/** 别人 @ TA 的话：补一点「他在群里跟谁互动」的线索。 */
function collectMentions(db, userId, chatKey, limit = 12) {
  const scope = chatKey ? ' and chat_key = ?' : ''
  const args = chatKey ? [`%@${userId}%`, userId, chatKey] : [`%@${userId}%`, userId]
  return db
    .prepare(`select ts, chat_key, sender_name, text from messages where text like ? and sender_id <> ?${scope} order by ts desc limit ?`)
    .all(...args, limit)
    .reverse()
}

function compactStats(profile) {
  return {
    total: profile.total,
    chats: profile.chats.slice(0, 8).map((c) => ({ chatKey: c.chatKey, name: c.name, msgCount: c.msgCount })),
    peak: profile.peak,
    topWords: profile.topWords.slice(0, 15),
    mentionsOut: profile.mentionsOut.slice(0, 8),
    mentionedBy: profile.mentionedBy.slice(0, 8),
    kinds: profile.kinds,
    firstTs: profile.firstTs,
    lastTs: profile.lastTs,
  }
}

/** 去掉 buildProfile summary 里「最近：」那段（和采样重复）。 */
function statsText(profile) {
  return String(profile.summary || '').split('\n最近：')[0]
}

function renderPrompt(profile, samples, mentions, chatNames) {
  const lines = ['【档案】', statsText(profile), '', `【TA 自己的发言采样】${samples.length} 条（按时间先后）`]
  for (const s of samples) {
    lines.push(`- ${stamp(s.ts * 1000)} · ${chatNames.get(s.chat_key) || s.chat_key}：${truncate(s.text, 140)}`)
  }
  if (mentions.length) {
    lines.push('', '【别人提到 TA 的话】')
    for (const m of mentions) {
      lines.push(`- ${stamp(m.ts * 1000)} · ${m.sender_name || '某人'}：${truncate(m.text, 120)}`)
    }
  }
  lines.push('', '请按要求输出 JSON。')
  return lines.join('\n')
}

/** 模型返回的 JSON 可能带 ``` 包裹或前后废话，尽量捞出来。 */
export function parseImpression(text) {
  const raw = String(text || '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(raw.slice(start, end + 1))
      const impression = String(obj.impression || obj.text || '').trim()
      const tags = Array.isArray(obj.tags) ? obj.tags.map(String).filter(Boolean).slice(0, 8) : []
      if (impression) return { impression, tags }
    } catch {
      /* 不是合法 JSON，当纯文本处理 */
    }
  }
  return { impression: raw.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim(), tags: [] }
}

export function saveImpression(db, userId, { impression, tags, model, stats }) {
  const at = Math.floor(Date.now() / 1000)
  db.prepare(
    `insert into profiles(chat_key, user_id, stats, impression, impression_at, tags, model)
     values(?, ?, ?, ?, ?, ?, ?)
     on conflict(chat_key, user_id) do update set
       stats = excluded.stats, impression = excluded.impression,
       impression_at = excluded.impression_at, tags = excluded.tags, model = excluded.model`,
  ).run(IMPRESSION_KEY, String(userId), JSON.stringify(stats || null), impression, at, JSON.stringify(tags || []), model || '')
  return at
}

/**
 * 老版本可能把模型返回的整段 JSON（{"impression":"...","tags":[...]}）直接写进了
 * impression 列。读的时候一律拆回「文字 + 标签」，不然看板和档案卡会把 JSON 原样显示出来。
 */
export function splitStoredImpression(raw, tagsRaw) {
  const s = String(raw ?? '').trim()
  let text = s
  let tags = []
  if (s.startsWith('{')) {
    let parsed = null
    try {
      parsed = JSON.parse(s)
    } catch {
      /* 落到下面的正则兜底 */
    }
    if (parsed && typeof parsed.impression === 'string') {
      text = parsed.impression
      if (Array.isArray(parsed.tags)) tags = parsed.tags.filter((t) => typeof t === 'string')
    } else {
      const m = s.match(/"impression"\s*:\s*"([\s\S]*?)"\s*,\s*"tags"\s*:\s*(\[[\s\S]*?\])/)
      if (m) {
        text = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n')
        try {
          const arr = JSON.parse(m[2])
          if (Array.isArray(arr)) tags = arr.filter((t) => typeof t === 'string')
        } catch {}
      }
    }
  }
  if (!tags.length && tagsRaw) {
    try {
      const arr = JSON.parse(tagsRaw)
      if (Array.isArray(arr)) tags = arr.filter((t) => typeof t === 'string')
    } catch {}
  }
  return { text, tags }
}

export function readImpression(db, userId) {
  const row = db.prepare('select impression, tags, impression_at, model from profiles where chat_key = ? and user_id = ?').get(IMPRESSION_KEY, String(userId))
  if (!row || !row.impression) return null
  const { text, tags } = splitStoredImpression(row.impression, row.tags)
  return { impression: text, tags, at: row.impression_at, model: row.model || '' }
}

/**
 * 只读的「人物印象卡」：qq_impression 工具的实现，把缓存的印象 + 一点人物上下文组好。
 *
 * 三条硬规矩（工具描述里也是这么承诺的）：
 * - 绝不调模型：本函数是同步函数，只读 profiles 缓存，不会当场生成；
 * - 绝不写库：只有 select；
 * - 绝不把聊天原文带出去：buildProfile 读到的原文只用来算高频词和活跃时段，不进返回值。
 *
 * 印象是全局的（profiles.chat_key='*'）；传了 chatKey 只是把「这人是谁」的范围缩小到该会话，
 * 不会去读会话级的另一份印象——印象本来就只有一份。
 *
 * @returns {{
 *   ok: boolean,
 *   found: boolean,
 *   ambiguous?: boolean,
 *   impression?: string,
 *   tags?: string[],
 *   at?: number,
 *   model?: string,
 *   person?: { userId: string, names: string[], chatKey: string|null, chatMsgs: number, topWords: string[], hours: string[] },
 *   candidates?: Array<{ userId: string, names: string[], msgCount: number }>,
 *   summary: string,
 * }}
 */
export function readImpressionCard(db, { user, chatKey = null } = {}) {
  const who = String(user || '').trim()
  const chatNames = new Map()
  for (const row of db.prepare('select chat_key, name from chats').all()) chatNames.set(row.chat_key, row.name || '')
  const chatLabel = chatKey ? chatNames.get(chatKey) || chatKey : ''
  const scopeText = chatKey ? `在「${chatLabel}」` : ''

  const all = findCandidates(db, who)
  // 限定会话时只考虑「在该会话说过话」的人，别把别群的同名者算进来
  const candidates = chatKey ? all.filter((c) => (c.chats || []).some((x) => x.chatKey === chatKey)) : all

  if (!candidates.length) {
    const known = all.filter((c) => c.msgCount > 0)
    const reason = !known.length
      ? `归档里找不到「${who}」这个人。`
      : chatKey
        ? `「${who}」能对上 ${all.length} 个人，但没人在「${chatLabel}」说过话。`
        : `「${who}」能对上 ${all.length} 个人，但都没有可用的发言记录。`
    const hint = !known.length ? '换个昵称片段，或直接给 QQ 号再查。' : chatKey ? '换个会话，或直接给 QQ 号再查。' : '直接给 QQ 号再查。'
    return {
      ok: true,
      found: false,
      summary: `档案馆里还没攒够这个人的印象，照实说，别编。\n（${reason}${hint}）`,
    }
  }

  if (candidates.length > 1) {
    const list = candidates
      .slice(0, 10)
      .map((c) => `${c.userId}（${c.names.slice(0, 3).join(' / ') || '无名'}，${c.msgCount} 条）`)
      .join('\n')
    return {
      ok: true,
      found: false,
      ambiguous: true,
      summary: `「${who}」${scopeText}能对上 ${candidates.length} 个人，指定 QQ 号再查：\n${list}`,
      candidates: candidates.map((c) => ({ userId: c.userId, names: c.names, msgCount: c.msgCount })),
    }
  }

  const candidate = candidates[0]
  const person = buildPersonBrief(db, chatNames, candidate, chatKey)

  // 纯数字的 user 即使库里没这个人也会被当成单候选，这里单独说清楚是「查无此人」
  if (!person.chatMsgs && !person.names.length) {
    return {
      ok: true,
      found: false,
      person,
      summary:
        `档案馆里还没攒够这个人的印象，照实说，别编。\n` +
        `（归档里找不到 QQ ${candidate.userId} 这个人，还没有 TA 的任何发言；确认下 QQ 号，或换个昵称片段。）`,
    }
  }

  const imp = readImpression(db, candidate.userId)
  // 有别名就用“名字（QQ 号）”，没有就只写 QQ 号，别拼成“QQ 999（QQ 999）”
  const whoLabel = person.names[0] ? `${person.names[0]}（QQ ${candidate.userId}）` : `QQ ${candidate.userId}`

  if (!imp) {
    const where = person.chatMsgs
      ? chatKey
        ? `TA 在「${chatLabel}」里有 ${person.chatMsgs} 条消息`
        : `TA 在归档里有 ${person.chatMsgs} 条消息`
      : '归档里没有 TA 的消息'
    return {
      ok: true,
      found: false,
      person,
      summary:
        `档案馆里还没攒够${whoLabel}的人物印象，照实说，别编。\n` +
        `（${where}，但 profiles 里还没有缓存的小传。想攒的话可以手动跑 qq_archive action=impressions（需要先开 enhance.impression），或者等每日定时任务。）`,
    }
  }

  const scopeNote = chatKey ? `（印象是全档的；这次只在「${chatLabel}」里看了 TA 的 ${person.chatMsgs} 条发言）` : ''
  const when = imp.at ? stamp(imp.at * 1000) : '时间未知'
  return {
    ok: true,
    found: true,
    impression: imp.impression,
    tags: imp.tags,
    at: imp.at,
    model: imp.model,
    person,
    summary: [
      `档案馆里记着${whoLabel}的人物印象${scopeNote}：`,
      imp.impression,
      imp.tags?.length ? `标签：${imp.tags.join(' / ')}` : '',
      `（生成于 ${when}${imp.model ? ` · ${imp.model}` : ''}；这是只读的缓存，这次没有重新生成。）`,
      '可以当画 TA / 按 TA 的性格和口吻说话的风格素材；细节拿不准就别硬编。',
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

/** 印象卡里那点人物上下文：只取词频和活跃时段，聊天原文一概不返回。 */
function buildPersonBrief(db, chatNames, candidate, chatKey) {
  const profile = buildProfile(db, chatNames, {
    userId: candidate.userId,
    chatKey,
    // 只读工具不需要 @ 关系：那两条全表 LIKE 查询对这里没有用
    mentions: { mentionsOut: [], mentionedBy: [] },
  })
  return {
    userId: candidate.userId,
    names: [...new Set([...candidate.names, ...profile.aliases])].slice(0, 6),
    chatKey: chatKey || null,
    chatMsgs: profile.total,
    topWords: profile.topWords.slice(0, 8).map((w) => w.word),
    hours: profile.peak.slice(0, 3).map((p) => `${p.label}（${p.pct}%）`),
  }
}

export async function generateImpression({ db, chatNames, userId, chatKey = null, llm, route, sample = 60, signal, onProgress }) {
  const profile = buildProfile(db, chatNames, { userId, chatKey })
  if (!profile.total) throw new Error(`QQ ${userId} 在归档里没有消息`)
  const samples = collectSamples(db, userId, chatKey, sample)
  const mentions = collectMentions(db, userId, chatKey, 12)
  const prompt = renderPrompt(profile, samples, mentions, chatNames)
  onProgress?.({ phase: 'calling', userId, promptChars: prompt.length })
  const { text, usage } = await generateText(llm, {
    provider: route.provider,
    model: route.model,
    system: SYSTEM_PROMPT,
    prompt,
    temperature: 0.6,
    maxTokens: 900,
    attempts: 3,
    signal,
  })
  const parsed = parseImpression(text)
  if (!parsed.impression) throw new Error('模型没有返回印象内容')
  const at = saveImpression(db, userId, {
    impression: parsed.impression,
    tags: parsed.tags,
    model: `${route.provider}/${route.model}`,
    stats: compactStats(profile),
  })
  return { userId, impression: parsed.impression, tags: parsed.tags, at, usage, promptChars: prompt.length }
}

let running = null

export function isImpressionsRunning() {
  return running !== null
}

/** 同一时间只跑一批，避免「每晚定时」和「手动触发」撞在一起。 */
export async function runImpressions(opts) {
  if (running) throw new Error('已经有一批人物印象在生成了，等它跑完再来')
  running = runImpressionsInner(opts).finally(() => {
    running = null
  })
  return running
}

async function runImpressionsInner({ db, chatNames, llm, cfg, userIds = null, minMsgs = 20, limit = 30, force = false, signal, onProgress }) {
  const routes = await listRoutes(llm)
  const route = pickRoute(routes, cfg?.llm)
  if (!route) throw new Error('DSH 里没有可用的模型，无法生成人物印象（先在 DSH 里启用一个 provider）')

  let targets = (userIds || []).map((x) => String(x)).filter(Boolean)
  if (!targets.length) {
    targets = db
      .prepare('select user_id, sum(msg_count) as n from members group by user_id having n >= ? order by n desc limit ?')
      .all(minMsgs, limit)
      .map((r) => r.user_id)
  }
  const sample = Math.max(10, Number(cfg?.impression?.sample) || 60)
  const results = []
  let skipped = 0
  for (let i = 0; i < targets.length; i++) {
    const userId = targets[i]
    if (!force) {
      const old = readImpression(db, userId)
      if (old && old.at && Math.floor(Date.now() / 1000) - old.at < REFRESH_DAYS * 86400) {
        skipped++
        results.push({ userId, skipped: true, impression: old.impression, tags: old.tags })
        continue
      }
    }
    try {
      const r = await generateImpression({ db, chatNames, userId, llm, route, sample, signal })
      results.push({ userId, ok: true, impression: r.impression, tags: r.tags, usage: r.usage })
    } catch (e) {
      results.push({ userId, ok: false, error: String(e?.message || e) })
    }
    onProgress?.({ done: i + 1, total: targets.length, userId })
  }
  return { route, total: targets.length, skipped, results }
}

/** 每天到点跑一次：只有配了 schedule 才生效，且当天没跑过（错过会补）。 */
export function dueForDaily(cfg, db, now = new Date()) {
  const hhmm = cfg?.impression?.schedule
  if (!/^\d{1,2}:\d{2}$/.test(String(hhmm || ''))) return false
  if (!cfg?.enhance?.impression) return false
  const [h, m] = String(hhmm).split(':').map(Number)
  const due = new Date(now)
  due.setHours(h, m, 0, 0)
  if (now.getTime() < due.getTime()) return false
  return getMeta(db, 'last_impression_date', '') !== isoDate(Math.floor(now.getTime() / 1000))
}
