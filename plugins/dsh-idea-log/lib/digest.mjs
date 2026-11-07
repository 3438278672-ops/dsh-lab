import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { addIdea, recentTitles } from './db.mjs'

export function defaultSessionRoot() {
  return join(homedir(), '.dsh', 'sessions')
}

function walk(dir, out, depth = 0) {
  if (depth > 3) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out, depth + 1)
    else if (e.name === 'session.v4.jsonl.zstd') out.push(p)
  }
}

/** 最近一段时间改过的会话文件，最新的排前面 */
export function listSessionFiles({ root = defaultSessionRoot(), sinceMs = 0, limit = 40 } = {}) {
  const found = []
  walk(root, found)
  const rows = []
  for (const p of found) {
    try {
      const st = statSync(p)
      if (st.mtimeMs >= sinceMs) rows.push({ path: p, mtime: st.mtimeMs, size: st.size })
    } catch {}
  }
  rows.sort((a, b) => b.mtime - a.mtime)
  return rows.slice(0, limit)
}

/**
 * DSH 把会话存成多帧 zstd（一行一个 event 的 JSONL 被分帧压缩）。
 * zstdDecompressSync 只解第一帧，所以按魔数切开逐帧解。
 */
export function decodeSessionFile(file) {
  const buf = readFileSync(file)
  const isMagic = (i) => buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) if (isMagic(i)) starts.push(i)
  if (!starts.length) return []
  let text = ''
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k]
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      text += zstdDecompressSync(buf.subarray(s, e)).toString('utf8')
    } catch {}
  }
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {}
  }
  return events
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text.trim())
    .filter(Boolean)
    .join('\n')
}

const SKIP_USER_SOURCES = new Set(['user-approval', 'developer', 'system'])

/** 从一个会话的事件流里抽提炼素材 */
export function extractMaterial(events, { maxUsers = 24, maxAssistant = 16, maxTools = 24 } = {}) {
  const users = []
  const assistant = []
  const tools = []
  let title = ''
  for (const ev of events) {
    const d = ev?.data
    if (!d) continue
    if (ev.type === 'session/title' && d.title) title = d.title
    else if (ev.type === 'user/message') {
      const src = d.source?.kind
      if (SKIP_USER_SOURCES.has(src)) continue
      const t = textOf(d.content)
      if (t && !/^\[MNEMON\b|^MNEMON RUNTIME/.test(t)) users.push(t.slice(0, 600))
    } else if (ev.type === 'assistant/message') {
      const t = textOf(d.message?.content)
      if (t) assistant.push(t.slice(0, 300))
    } else if (ev.type === 'tool/call') {
      const args = String(d.arguments || '').slice(0, 160)
      tools.push(`${d.name} ${args}`.trim())
    }
  }
  return {
    title,
    users: users.slice(-maxUsers),
    assistant: assistant.slice(-maxAssistant),
    tools: tools.slice(-maxTools),
  }
}

export function materialToText(materials, { maxChars = 9000 } = {}) {
  const parts = []
  for (const m of materials) {
    const seg = []
    if (m.title) seg.push(`【会话】${m.title}`)
    if (m.users.length) seg.push('用户说：\n' + m.users.map((t) => '- ' + t.replace(/\s+/g, ' ')).join('\n'))
    if (m.assistant.length) seg.push('我的回答要点：\n' + m.assistant.map((t) => '- ' + t.replace(/\s+/g, ' ')).join('\n'))
    if (m.tools.length) seg.push('用过的工具：\n' + m.tools.map((t) => '- ' + t).join('\n'))
    if (seg.length) parts.push(seg.join('\n'))
  }
  const text = parts.join('\n\n')
  return text.length > maxChars ? text.slice(0, maxChars) + '\n…（后面截断了）' : text
}

export const DIGEST_SYSTEM = `你在帮一个重度使用 DeepSeek Harness 的人整理"灵感账本"。他的原话：想看到更多更有用的插件想法自己蹦出来。

从给的会话素材里提炼，只写三样：
1. idea —— 值得做成 DSH 插件的点子（要具体：解决谁的什么问题，工具大概长什么样）
2. pitfall —— 踩过的坑（环境、依赖、API 契约、编码、路径坑，要能被人复用）
3. improve —— 对现有插件/流程的改进点

硬要求：
- 只输出 JSON：{"items":[{"kind":"idea|pitfall|improve","title":"不超过 30 字","body":"两三句话，说清是什么、为什么有用","tags":["短标签"]}]}
- 最多 6 条，**其中至少 2 条要是插件点子（idea）**，除非素材里真的没有可做的
- 素材里已经明确写完、上线、修好的事，不要记成 improve；只有当它还有遗留问题、或这个做法值得搬到别处时才记
- 不要写空泛的"要重视 XX"
- 不要重复已有标题（会给你列表）
- 不要编造素材里没有的东西`

export function buildDigestPrompt(materialText, existingTitles, { today = '' } = {}) {
  const known = existingTitles.slice(0, 60).map((t) => '- ' + t).join('\n') || '（空）'
  return `今天的素材（${today}）：\n\n${materialText || '（今天没有可用的会话记录）'}\n\n已经记过的标题（别重复）：\n${known}\n\n按系统提示的 JSON 格式输出。`
}

export function parseDigest(raw) {
  const s = String(raw || '')
  const tryParse = (t) => {
    try {
      const v = JSON.parse(t)
      if (Array.isArray(v?.items)) return v.items
      if (Array.isArray(v)) return v
    } catch {}
    return null
  }
  let items = tryParse(s.trim())
  if (!items) {
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fence) items = tryParse(fence[1].trim())
  }
  if (!items) {
    const first = s.indexOf('{')
    const last = s.lastIndexOf('}')
    if (first >= 0 && last > first) items = tryParse(s.slice(first, last + 1))
  }
  if (!Array.isArray(items)) return []
  return items
    .filter((x) => x && typeof x.title === 'string' && x.title.trim())
    .map((x) => ({
      kind: ['idea', 'pitfall', 'improve'].includes(x.kind) ? x.kind : 'idea',
      title: x.title.trim().slice(0, 80),
      body: String(x.body || '').trim().slice(0, 600),
      tags: Array.isArray(x.tags) ? x.tags.filter((t) => typeof t === 'string').slice(0, 6) : [],
    }))
}

/** 扫最近 hours 小时的会话，提炼一轮，写进库 */
export async function runDigest({ streamText, llm, db, cfg, route = null, hours = 24, days = null, log = () => {} } = {}) {
  const root = cfg?.sessionsRoot || defaultSessionRoot()
  const windowMs = (days ? days * 24 : hours) * 3600 * 1000
  const sinceMs = Date.now() - windowMs
  const files = listSessionFiles({ root, sinceMs, limit: cfg?.digest?.maxSessions || 40 })
  log(`扫到 ${files.length} 个会话文件`)

  const materials = []
  for (const f of files) {
    try {
      const events = decodeSessionFile(f.path)
      const m = extractMaterial(events)
      if (m.users.length || m.assistant.length) materials.push(m)
    } catch (e) {
      log(`读不动 ${f.path}: ${e.message}`)
    }
  }
  const materialText = materialToText(materials)
  if (!materialText.trim()) {
    return { scanned: files.length, sessions: materials.length, created: 0, skipped: 0, items: [], empty: true }
  }

  const known = recentTitles(db, Date.now() - 30 * 24 * 3600 * 1000)
  const prompt = buildDigestPrompt(materialText, known, { today: new Date().toISOString().slice(0, 10) })
  // 模型会把不少预算花在思考上，第一次被截断就加预算再试一次
  const call = (maxTokens) =>
    streamText(llm, {
      provider: route?.provider || cfg?.llm?.provider || '',
      model: route?.model || cfg?.llm?.model || '',
      system: DIGEST_SYSTEM,
      prompt,
      temperature: 0.5,
      maxTokens,
    })
  let out
  try {
    out = await call(2400)
  } catch (e) {
    if (!/截断|max-tokens|没有内容/.test(e?.message || '')) throw e
    out = await call(3600)
  }
  const { text, usage } = out
  const items = parseDigest(text)
  let created = 0
  let skipped = 0
  for (const it of items) {
    const r = addIdea(db, { ...it, source: 'digest' })
    if (r.duplicate) skipped++
    else created++
  }
  return {
    scanned: files.length,
    sessions: materials.length,
    created,
    skipped,
    items: items.map((i) => ({ kind: i.kind, title: i.title })),
    usage,
  }
}
