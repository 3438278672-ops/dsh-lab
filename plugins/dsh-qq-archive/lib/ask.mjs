/**
 * 自然语言问答（qq_ask）：先在归档里检索材料，再让模型只依据材料回答。
 *
 * 检索两路：
 *   1. 语义索引（可选增强层，lib/semantic.mjs）：索引存在时取相似度最高的 k 条；
 *   2. 关键词（lib/db.mjs 的 searchMessages）：字符精确 / 分词 / 模糊，取 top-20。
 * 两路按消息 id 去重合并，语义分高的排前面；先取前 k 条保证语义结果不被关键词挤掉，
 * 再按时间排、每条截断 200 字、编号 [n] 交给模型。回答里的 [n] 与 citations 的 n 一一对应。
 * 语义索引没建 / Python 不可用 / 检索报错时都静默降级成纯关键词，不中断问答。
 *
 * 测试钩子（生产调用不要传）：_generate / _semanticReady / _semanticSearch。
 */
import { dirname } from 'node:path'
import { listChats, searchMessages } from './db.mjs'
import { listRoutes, pickRoute, generateText } from './llm.mjs'
import { messagesByIds, semanticReady, semanticSearch } from './semantic.mjs'
import { clampInt, stamp, truncate } from './util.mjs'

const MAX_TEXT = 200
const KEYWORD_LIMIT = 20
const MAX_K = 200

const MODE_SEMANTIC = 'semantic+keyword'
const MODE_KEYWORD = 'keyword'

const KIND_LABEL = {
  text: '文字',
  image: '图片',
  voice: '语音',
  video: '视频',
  forward: '合并转发',
  file: '文件',
  card: '卡片',
}

const SYSTEM_PROMPT = [
  '你是一个 QQ 群聊档案员，要根据检索到的聊天记录材料回答用户的问题。',
  '规则：',
  '1. 只依据给出的材料回答，不要用材料之外的知识补充；材料里没有的人和事，一律不要编造。',
  '2. 每条结论后面用 [n] 标注依据的材料编号，可以同时标多个，如 [1][3]。',
  '3. 材料不足或找不到相关信息时，直接说「归档里没找到……」，并说明可以换个什么说法或条件；不要硬编。',
  '4. 用中文回答，先给结论，再展开细节；能引用群友原话就用原话。',
  '5. 不要逐条复述材料，只讲和问题相关的部分；人名用材料里的昵称。',
].join('\n')

/** 消息正文；没有正文的媒体消息给一个中文占位。 */
function messageText(row) {
  const text = String(row?.text ?? '').trim()
  if (text) return text
  const kind = row?.kind || 'text'
  return `[${KIND_LABEL[kind] || kind}]`
}

/** db 原始行（snake_case）和 searchMessages 命中（camelCase）都能吃。 */
function rowToMaterial(row) {
  return {
    id: Number(row.id),
    ts: Number(row.ts) || 0,
    chatKey: String(row.chatKey || row.chat_key || ''),
    senderId: String(row.senderId || row.sender_id || ''),
    senderName: String(row.senderName || row.sender_name || row.senderId || row.sender_id || ''),
    kind: row.kind || 'text',
    text: messageText(row),
  }
}

function inScope(hit, scope) {
  if (scope.chatKey && hit.chatKey !== scope.chatKey) return false
  if (scope.fromTs && hit.ts < scope.fromTs) return false
  if (scope.toTs && hit.ts > scope.toTs) return false
  return true
}

function chatNameMap(db) {
  const map = new Map()
  for (const chat of listChats(db, 5000)) map.set(chat.key, chat.name || chat.key)
  return map
}

function renderScope(scope) {
  const parts = [scope.chatKey ? `会话 ${scope.chatKey}` : '全部会话']
  if (scope.fromTs) parts.push(`从 ${stamp(scope.fromTs * 1000)}`)
  if (scope.toTs) parts.push(`到 ${stamp(scope.toTs * 1000)}`)
  return parts.join(' · ')
}

function renderPrompt({ question, materials, scope }) {
  const lines = [`【检索范围】${renderScope(scope)}`, '', `【材料】共 ${materials.length} 条，按时间先后编号：`]
  for (const m of materials) {
    lines.push(`[${m.n}] ${stamp(m.ts * 1000)} · ${m.chatName} · ${m.senderName}：${m.text}`)
  }
  lines.push('', `【问题】${question}`, '', '请只依据上面的材料回答，并在每条结论后标注依据材料的编号。')
  return lines.join('\n')
}

/**
 * 问归档：检索材料 → 让模型据材料回答。
 *
 * @param {object} opts
 * @param {object} opts.archive  openArchive 的返回值（需要 db/path；home 缺失时从 path 推）
 * @param {object} [opts.db]     与 archive.db 相同的库（兼容只传 db 的调用）
 * @param {object} [opts.llm]    DSH 的 llm 服务
 * @param {object} [opts.cfg]    插件配置（只读 cfg.llm 选路由）
 * @param {string} opts.question 问题
 * @param {string|null} [opts.chatKey] 只看某个会话
 * @param {number} [opts.fromTs] 起始时间（unix 秒，0 = 不限）
 * @param {number} [opts.toTs]   结束时间（unix 秒，0 = 不限）
 * @param {number} [opts.k]      最多给模型多少条材料（1-200，默认 60）
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.onProgress] ({ phase, ... }) 进度回调
 * @returns {Promise<{question:string, mode:string, answer:string, citations:object[], used:object[]}>}
 */
export async function askArchive({
  archive,
  db,
  llm,
  cfg,
  question,
  chatKey = null,
  fromTs = 0,
  toTs = 0,
  k = 60,
  signal,
  onProgress,
  home,
  _generate,
  _semanticReady,
  _semanticSearch,
} = {}) {
  const q = String(question ?? '').trim()
  if (!q) throw new Error('问题不能为空（question 必填）')

  const database = archive?.db || db
  if (!database) throw new Error('askArchive 需要 archive（openArchive 的返回值）或 db')

  const limit = clampInt(k, 1, MAX_K, 60)
  const scope = {
    chatKey: chatKey ? String(chatKey) : null,
    fromTs: Number(fromTs) > 0 ? Math.trunc(Number(fromTs)) : 0,
    toTs: Number(toTs) > 0 ? Math.trunc(Number(toTs)) : 0,
  }
  const emit = (event) => {
    try {
      onProgress?.(event)
    } catch {
      /* 进度回调出错不影响问答本身 */
    }
  }

  // 先确认有模型可用：检索（尤其语义）可能要跑一会儿，没模型就别白跑
  let route = null
  if (typeof _generate !== 'function') {
    const routes = await listRoutes(llm)
    route = pickRoute(routes, cfg?.llm)
    if (!route) {
      throw new Error(
        'DSH 里没有可用模型，无法回答问题（先在 DSH 里启用一个 provider，或在插件配置里指定 llm.provider / llm.model）',
      )
    }
  }

  emit({ phase: 'retrieving', question: q })

  const root = home || archive?.home || (archive?.path ? dirname(archive.path) : null)
  const searchArchive = archive?.db ? archive : { ...(archive || {}), db: database }
  const isSemanticReady = typeof _semanticReady === 'function' ? _semanticReady : semanticReady
  const runSemantic = typeof _semanticSearch === 'function' ? _semanticSearch : semanticSearch

  // 1) 语义检索（可选）：只负责给候选 id + 分数，正文统一从库里取，避免两边字段不一致
  let semanticHits = []
  let semanticError = null
  if (root && isSemanticReady(root)) {
    try {
      const found = await runSemantic({ ...searchArchive, home: root }, q, { k: limit, signal })
      if (Array.isArray(found) && found.length) {
        const scoreById = new Map()
        for (const hit of found) {
          const score = Number(hit?.score)
          scoreById.set(hit?.id, Number.isFinite(score) ? score : null)
        }
        semanticHits = messagesByIds(database, found.map((h) => h.id))
          .map((row) => ({ ...rowToMaterial(row), score: scoreById.get(row.id) ?? null }))
          .filter((hit) => inScope(hit, scope))
        semanticHits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      }
    } catch (e) {
      semanticError = String(e?.message || e)
      semanticHits = []
    }
  }

  // 2) 关键词检索：按查询语义取 top-20（limit 是最终材料上限，不限制检索条数）
  const keyword = searchMessages(searchArchive, {
    query: q,
    chatKey: scope.chatKey || undefined,
    fromTs: scope.fromTs || undefined,
    toTs: scope.toTs || undefined,
    limit: KEYWORD_LIMIT,
  })
  const keywordHits = keyword.hits.map((hit) => ({ ...rowToMaterial(hit), score: null }))

  // 3) 去重合并：语义结果优先（同一条消息语义分比 bm25 更有参考价值），再取前 k、按时间排
  const merged = []
  const seen = new Set()
  for (const hit of semanticHits) {
    if (seen.has(hit.id)) continue
    seen.add(hit.id)
    merged.push({ ...hit, source: 'semantic' })
  }
  for (const hit of keywordHits) {
    if (seen.has(hit.id)) continue
    seen.add(hit.id)
    merged.push({ ...hit, source: 'keyword' })
  }
  const selected = merged.slice(0, limit).sort((a, b) => a.ts - b.ts || a.id - b.id)

  const mode = semanticHits.length ? MODE_SEMANTIC : MODE_KEYWORD
  const names = chatNameMap(database)
  const citations = selected.map((hit, i) => ({
    n: i + 1,
    id: hit.id,
    ts: hit.ts,
    chatKey: hit.chatKey,
    chatName: names.get(hit.chatKey) || hit.chatKey,
    senderName: hit.senderName || hit.senderId || '匿名',
    // 材料在提示词里已截断，citation 用同一份文本，回答里的 [n] 才能对上
    text: truncate(hit.text, MAX_TEXT),
  }))
  const used = selected.map((hit) => ({
    id: hit.id,
    score: hit.source === 'semantic' ? hit.score : null,
    source: hit.source,
  }))

  // 一条材料都没有就不调模型：既省 token，也避免模型没材料硬编
  if (!citations.length) {
    emit({ phase: 'empty', materials: 0 })
    return {
      question: q,
      mode,
      answer: `没在归档里找到和「${q}」相关的消息。可以换个说法、去掉会话/时间限制，或先确认归档已经同步。`,
      citations: [],
      used: [],
      ...(semanticError ? { semanticError } : {}),
    }
  }

  const prompt = renderPrompt({ question: q, materials: citations, scope })
  emit({ phase: 'calling', materials: citations.length, promptChars: prompt.length })

  let answer = ''
  if (typeof _generate === 'function') {
    const text = await _generate({ system: SYSTEM_PROMPT, prompt, signal })
    answer = String(text ?? '').trim()
  } else {
    const { text } = await generateText(llm, {
      provider: route.provider,
      model: route.model,
      system: SYSTEM_PROMPT,
      prompt,
      temperature: 0.3,
      maxTokens: 1200,
      attempts: 3,
      signal,
    })
    answer = String(text || '').trim()
  }
  if (!answer) throw new Error('模型没有返回内容')

  emit({ phase: 'done', materials: citations.length })
  return {
    question: q,
    mode,
    answer,
    citations,
    used,
    ...(semanticError ? { semanticError } : {}),
  }
}
