/**
 * 链接 / 资源库：把群聊里出现过的 http(s) 链接挑出来，按域名和会话聚合成
 * 一份可以直接看的「资料库」。
 *
 * 数据只读 messages 表，两个来源：
 * - 正文里直接写的 URL（text like '%http%'，抽出时去掉尾部标点）；
 * - 卡片消息的 raw JSON：卡片正文只有「[卡片]」，真正的链接和标题藏在
 *   jumpUrl / qqdocurl / meta.detail_1.title / meta.news.title 这些字段里，
 *   抽不到就留空。
 *
 * 不联网、不写库；同一消息里重复出现的同一 URL 只记一次。`total` 是贡献了
 * 链接的消息数，不是链接条数（一条消息可能带多个链接）。
 */

import { clampInt, stamp, truncate } from './util.mjs'

/**
 * 抽 URL 的正文只认 ASCII 可见字符：碰到空白、中文或非 ASCII 字符就截断
 * （群聊里 URL 后面经常紧跟中文，没有空格）。
 * 嵌套的 `https://` 用 lookahead 断开，避免把两条粘在一起的链接吞成一条。
 */
const URL_RE = /https?:\/\/[!-~]+?(?=\s|[^\x00-\x7f]|https?:\/\/|$)/gi

/** 从尾部剥掉的标点：中英文标点、引号、成对括号。 */
const TAIL_PUNCT = new Set([
  ...'.,;:!?\'"*|',
  ...'。，、；：！？…—～·',
  ...'“”‘’「」『』（）【】〔〕《》〈〉',
  ...')]}>',
])

function countChar(s, ch) {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++
  return n
}

/**
 * 去掉 URL 尾部的标点。成对括号单独处理：维基词条那种 `Foo_(bar)` 的收尾
 * 括号是 URL 的一部分，不能剥；`(https://x)` 外面那个才是多余的一半。
 */
function trimUrlTail(raw) {
  let s = raw
  while (s.length) {
    const ch = s[s.length - 1]
    if (!TAIL_PUNCT.has(ch)) break
    if (ch === ')' && countChar(s, '(') >= countChar(s, ')')) break
    if (ch === ']' && countChar(s, '[') >= countChar(s, ']')) break
    if (ch === '}' && countChar(s, '{') >= countChar(s, '}')) break
    s = s.slice(0, -1)
  }
  return s
}

/**
 * 从一段文本里抽 http(s) URL。按出现顺序返回，同一段文本里的重复 URL 只留一次。
 * @param {string} text
 * @returns {string[]}
 */
export function extractUrls(text) {
  const src = String(text ?? '')
  if (!src) return []
  const out = []
  const seen = new Set()
  for (const match of src.matchAll(URL_RE)) {
    const url = trimUrlTail(match[0])
    // 至少要像 `http(s)://host`：`http://?x` 这种残片直接丢掉
    if (!/^https?:\/\/[^/?#]+/i.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/** 聚合用的域名：小写主机名，www 不合并（精确过滤时按看到的域名匹配）。 */
function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    const m = /^https?:\/\/([^/?#]+)/i.exec(String(url || ''))
    return m ? m[1].toLowerCase() : ''
  }
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 卡片 JSON 里带链接的字段（大小写无关）。preview / icon 这类图片字段故意不收。 */
const CARD_URL_KEYS = new Set([
  'jumpurl',
  'jump_url',
  'url',
  'qqdocurl',
  'qq_doc_url',
  'content_url',
  'targeturl',
  'target_url',
  'href',
  'link',
])

/** 标题优先从这两个 meta 子节点取，其余 meta 子节点按原顺序兜底。 */
const CARD_TITLE_ORDER = ['detail_1', 'news']

function parseJsonObject(value) {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (s.length < 2 || (s[0] !== '{' && s[0] !== '[')) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/** 腾讯的卡片 JSON 一般长这样：{ app, config, meta: { detail_1|news: {...} } }。 */
function looksLikeCard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (value.meta && typeof value.meta === 'object' && !Array.isArray(value.meta)) return true
  return typeof value.app === 'string' && value.config && typeof value.config === 'object'
}

/**
 * 从 raw（完整 OneBot 事件 JSON）里找出卡片 payload。
 * 卡片通常挂在 `message[]` 里 `{ type: 'json', data: { data: '<卡片 JSON 字符串>' } }`，
 * 所以这里递归找「字符串里再套 JSON」的节点，并认领长得像卡片的对象。
 */
function findCardPayloads(raw) {
  const event = parseJsonObject(raw)
  if (!event || typeof event !== 'object') return []
  const payloads = []
  if (looksLikeCard(event)) payloads.push(event)

  const visit = (node, depth) => {
    if (depth > 6 || !node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    for (const value of Object.values(node)) {
      if (typeof value === 'string') {
        const inner = parseJsonObject(value)
        if (inner && typeof inner === 'object') {
          if (looksLikeCard(inner)) payloads.push(inner)
          visit(inner, depth + 1)
        }
      } else if (value && typeof value === 'object') {
        visit(value, depth + 1)
      }
    }
  }
  visit(event, 0)
  return payloads
}

/** 卡片里所有像链接的字符串（按出现顺序，标题字段不会被当成链接）。 */
function collectCardUrls(node, out, depth = 0) {
  if (depth > 8 || !node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectCardUrls(item, out, depth + 1)
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      if (CARD_URL_KEYS.has(key.toLowerCase()) && /^https?:\/\//i.test(value.trim())) {
        const url = trimUrlTail(value.trim())
        if (url) out.push(url)
      } else {
        const inner = parseJsonObject(value)
        if (inner) collectCardUrls(inner, out, depth + 1)
      }
    } else if (value && typeof value === 'object') {
      collectCardUrls(value, out, depth + 1)
    }
  }
}

function cleanTitle(value) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim()
  return s ? truncate(s, 120) : ''
}

/** 卡片标题：meta.detail_1.title → meta.news.title → 其它 meta.*.title → 顶层 title。 */
function cardTitleOf(payload) {
  if (!payload || typeof payload !== 'object') return ''
  let meta = payload.meta
  if (typeof meta === 'string') meta = parseJsonObject(meta)
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const keys = [
      ...CARD_TITLE_ORDER.filter((k) => k in meta),
      ...Object.keys(meta).filter((k) => !CARD_TITLE_ORDER.includes(k)),
    ]
    for (const key of keys) {
      const item = meta[key]
      if (typeof item === 'string') {
        const parsed = parseJsonObject(item)
        const title = cleanTitle(parsed && typeof parsed === 'object' ? parsed.title : '')
        if (title) return title
      } else if (item && typeof item === 'object' && !Array.isArray(item)) {
        const title = cleanTitle(item.title)
        if (title) return title
      }
    }
  }
  return cleanTitle(payload.title)
}

/** 一条卡片消息的 raw → { urls, title }；raw 坏了就返回空，不抛错。 */
function cardInfoFromRaw(raw) {
  const payloads = findCardPayloads(raw)
  const urls = []
  let title = ''
  for (const payload of payloads) {
    collectCardUrls(payload, urls)
    if (!title) title = cardTitleOf(payload)
  }
  return { urls, title }
}

/**
 * 建一份链接索引。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{chatKey?: string|null, fromTs?: number, toTs?: number, limit?: number}} [opts]
 *   limit 是「最多扫多少条命中消息」的保险丝（不是链接条数上限，一条消息可能
 *   带多个链接），默认 4000。
 * @returns {{
 *   total: number,
 *   domains: {domain: string, count: number, lastTs: number}[],
 *   links: {id: number, url: string, domain: string, title: string, chatKey: string,
 *           chatName: string, senderId: string, senderName: string, ts: number, kind: string}[],
 *   byChat: {chatKey: string, chatName: string, count: number}[],
 * }}
 */
export function buildLinkIndex(db, opts = {}) {
  const chatKey = opts.chatKey ? String(opts.chatKey).trim() : ''
  const fromTs = Number(opts.fromTs) || 0
  const toTs = Number(opts.toTs) || 0
  const limit = clampInt(opts.limit || 4000, 1, 20000, 4000)

  // 卡片消息的正文是「[卡片]」，URL 在 raw 里，所以 WHERE 额外放行 kind='card'
  const conditions = ["(m.text like '%http%' or m.kind = 'card')"]
  const params = []
  if (chatKey) {
    conditions.push('m.chat_key = ?')
    params.push(chatKey)
  }
  if (fromTs > 0) {
    conditions.push('m.ts >= ?')
    params.push(fromTs)
  }
  if (toTs > 0) {
    conditions.push('m.ts <= ?')
    params.push(toTs)
  }
  params.push(limit)

  const rows = db
    .prepare(
      `select m.id, m.chat_key, m.sender_id, m.sender_name, m.ts, m.kind, m.text, m.raw,
              c.name as chat_name
         from messages m
         left join chats c on c.chat_key = m.chat_key
        where ${conditions.join(' and ')}
        order by m.ts desc, m.id desc
        limit ?`,
    )
    .all(...params)

  const links = []
  let total = 0
  for (const row of rows) {
    const urls = new Set(extractUrls(row.text))
    let title = ''
    if (row.kind === 'card') {
      const card = cardInfoFromRaw(row.raw)
      for (const url of card.urls) urls.add(url)
      title = card.title
    }
    if (!urls.size) continue
    total++
    const chatName = String(row.chat_name || '').trim() || row.chat_key
    const senderName = String(row.sender_name || '').trim() || String(row.sender_id || '')
    for (const url of urls) {
      links.push({
        id: row.id,
        url,
        domain: domainOf(url),
        title,
        chatKey: row.chat_key,
        chatName,
        senderId: row.sender_id,
        senderName,
        ts: row.ts,
        kind: row.kind,
      })
    }
  }

  // 新链接在前；同一时刻的消息按 id 倒序，同一条消息里的多个链接按 URL 排，保证结果稳定
  links.sort((a, b) => b.ts - a.ts || b.id - a.id || compareText(a.url, b.url))

  const domainMap = new Map()
  for (const link of links) {
    const entry = domainMap.get(link.domain)
    if (!entry) domainMap.set(link.domain, { domain: link.domain, count: 1, lastTs: link.ts })
    else {
      entry.count++
      entry.lastTs = Math.max(entry.lastTs, link.ts)
    }
  }

  const chatMap = new Map()
  for (const link of links) {
    const entry = chatMap.get(link.chatKey)
    if (!entry) chatMap.set(link.chatKey, { chatKey: link.chatKey, chatName: link.chatName, count: 1 })
    else entry.count++
  }

  return {
    total,
    domains: [...domainMap.values()].sort((a, b) => b.count - a.count || compareText(a.domain, b.domain)),
    links,
    byChat: [...chatMap.values()].sort((a, b) => b.count - a.count || compareText(a.chatKey, b.chatKey)),
  }
}

/**
 * 在索引上筛链接。q 大小写无关，匹配 URL / 标题 / 群名 / 发送者（名字或 QQ 号）；
 * domain、chatKey 是精确过滤。结果保持 buildLinkIndex 的时间倒序。
 *
 * @param {ReturnType<typeof buildLinkIndex>} index
 * @param {{q?: string, domain?: string, chatKey?: string, limit?: number}} [opts]
 * @returns {ReturnType<typeof buildLinkIndex>['links']}
 */
export function filterLinks(index, opts = {}) {
  const links = Array.isArray(index?.links) ? index.links : []
  const q = String(opts.q ?? '').trim().toLowerCase()
  const domain = String(opts.domain ?? '').trim().toLowerCase()
  const chatKey = String(opts.chatKey ?? '').trim()
  const limit = clampInt(opts.limit, 1, 10000, 200)

  const out = []
  for (const link of links) {
    if (domain && String(link.domain || '').toLowerCase() !== domain) continue
    if (chatKey && link.chatKey !== chatKey) continue
    if (q) {
      const haystack = [link.url, link.title, link.chatName, link.senderName, link.senderId]
        .map((v) => String(v ?? '').toLowerCase())
        .join('\n')
      if (!haystack.includes(q)) continue
    }
    out.push(link)
    if (out.length >= limit) break
  }
  return out
}

/** Markdown 链接文字里的方括号/反斜杠要转义，否则会把结构弄坏。 */
function markdownLabel(raw) {
  return String(raw ?? '').replace(/([\\[\]])/g, '\\$1')
}

/** Markdown 链接目标：括号不平衡或带空白时用尖括号包起来，保证任何渲染器都认。 */
function markdownHref(url) {
  const s = String(url ?? '').trim()
  const balanced = countChar(s, '(') === countChar(s, ')') && countChar(s, '[') === countChar(s, ']')
  if (balanced && !/[\s<>]/.test(s)) return s
  return '<' + s.replace(/[<>]/g, (ch) => encodeURIComponent(ch)) + '>'
}

/**
 * 把索引渲染成 Markdown：按域名分组（域名顺序跟 index.domains 一致），
 * 每条 `- 时间 · 群 · 发送者：[标题或 URL](URL)`。
 *
 * @param {ReturnType<typeof buildLinkIndex>} index
 * @param {{title?: string, limit?: number}} [opts]
 * @returns {string}
 */
export function linksMarkdown(index, opts = {}) {
  const title = String(opts.title ?? '').trim() || '群链接资源库'
  const limit = clampInt(opts.limit, 1, 10000, 200)
  const all = Array.isArray(index?.links) ? index.links : []
  const links = all.slice(0, limit)

  const head = [`# ${title}`, '']
  if (!links.length) return [...head, '（暂无链接）'].join('\n')

  const groups = new Map()
  for (const link of links) {
    const domain = String(link.domain || '').trim()
    if (!groups.has(domain)) groups.set(domain, [])
    groups.get(domain).push(link)
  }

  const rank = new Map()
  const rankedDomains = Array.isArray(index?.domains) ? index.domains : []
  rankedDomains.forEach((item, i) => {
    const domain = String(item?.domain || '').trim()
    if (domain && !rank.has(domain)) rank.set(domain, i)
  })
  const ordered = [...groups.keys()].sort((a, b) => {
    const ra = rank.has(a) ? rank.get(a) : Number.MAX_SAFE_INTEGER
    const rb = rank.has(b) ? rank.get(b) : Number.MAX_SAFE_INTEGER
    return ra - rb || compareText(a, b)
  })

  const lines = [...head, `共 ${links.length} 条链接 · ${groups.size} 个域名`, '']
  for (const domain of ordered) {
    const items = groups.get(domain)
    lines.push(`## ${domain || '（无域名）'}（${items.length} 条）`, '')
    for (const link of items) {
      const when = stamp(Number(link.ts) * 1000)
      const chat = String(link.chatName || link.chatKey || '').trim()
      const who = String(link.senderName || link.senderId || '').trim()
      const label = markdownLabel(String(link.title || '').trim() || link.url)
      lines.push(`- ${when} · ${chat} · ${who}：[${label}](${markdownHref(link.url)})`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
