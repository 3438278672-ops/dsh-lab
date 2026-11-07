import { join } from 'node:path'
import { homedir } from 'node:os'
import { addIdea, getMeta, ideaStats, listIdeas, openIdeas, setMeta, updateIdea, KIND_LABEL, STATUS_LABEL } from './lib/db.mjs'
import { runDigest, listSessionFiles, defaultSessionRoot } from './lib/digest.mjs'
import { getLlm, listRoutes, pickRoute, streamText } from './lib/llm.mjs'
import { registerIdeaWeb } from './lib/web.mjs'
import { createCompletionWatcher } from './lib/watch.mjs'

export const name = 'dsh-idea-log'
export const inject = ['tools', 'webServer']

const DEFAULTS = {
  home: '',
  sessionsRoot: '',
  digest: { schedule: '23:30', hours: 24, maxSessions: 40 },
  llm: { provider: '', model: '' },
}

function mergeConfig(config = {}) {
  const out = {}
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = { ...v }
      for (const [k2, v2] of Object.entries(config[k] || {})) out[k][k2] = v2
    } else {
      out[k] = config[k] !== undefined ? config[k] : v
    }
  }
  for (const k of Object.keys(config || {})) if (!(k in out)) out[k] = config[k]
  return out
}

function homeOf(cfg) {
  return cfg.home || join(homedir(), '.dsh', 'idea-log')
}

const textResult = (value) => [{ type: 'text', text: value }]

const TOOL_OUTPUT = {
  schema: { type: 'object' },
  render: (_args, value) => textResult(value?.summary ?? JSON.stringify(value, null, 2)),
}

function withDb(cfg, fn) {
  const archive = openIdeas(homeOf(cfg))
  try {
    return fn(archive.db)
  } finally {
    archive.db.close()
  }
}

function fmtDate(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 到点了没：每天 schedule 之后跑一次，当天跑过就跳过 */
export function dueForDigest(cfg, db, now = Date.now()) {
  if (!cfg?.digest?.schedule) return false
  const m = String(cfg.digest.schedule).match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return false
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (hh > 23 || mm > 59) return false
  const d = new Date(now)
  const dueAt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0).getTime()
  if (now < dueAt) return false
  const today = fmtDate(now)
  return getMeta(db, 'last_digest_day') !== today
}

export function markDigestDay(db, now = Date.now()) {
  setMeta(db, 'last_digest_day', fmtDate(now))
  setMeta(db, 'last_digest_at', new Date(now).toISOString())
}

export function apply(ctx, config = {}) {
  let cfg = mergeConfig(config)
  let digestTimer = null
  let digestRunning = false

  const log = (msg) => {
    try {
      ctx.logger?.info?.(`[idea-log] ${msg}`)
    } catch {}
  }

  // ---------- 孵化完成反馈 ----------
  // 盯住开工开出的对话：绑定 idea ↔ session，跑完一轮就在条目上等确认。
  let watcher = null
  try {
    watcher = createCompletionWatcher(ctx, { home: homeOf(cfg), log })
    ctx.effect(() => () => watcher.dispose())
  } catch (e) {
    log(`完成反馈监听没挂上：${e?.message || e}`)
  }

  // ---------- 网页入口 ----------
  if (ctx.webServer) registerIdeaWeb(ctx, { home: homeOf(cfg), log, watcher })

  // ---------- 工具 ----------
  ctx.effect(() =>
    ctx.tools.register({
      name: 'idea_add',
      description:
        '记一条灵感账本：干活时冒出的插件点子（idea）、绕不过去的坑（pitfall）、对现有插件或流程的改进点（improve）。24 小时内同名不会重复记。标题写具体，正文两三句说清是什么、为什么。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['idea', 'pitfall', 'improve'], description: '默认 idea' },
          title: { type: 'string', description: '一句话标题，不超过 30 字' },
          body: { type: 'string', description: '两三句说清是什么、为什么有用／怎么复现' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选短标签，最多 6 个' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      timeoutMs: 15000,
      output: TOOL_OUTPUT,
      async execute(args) {
        return withDb(cfg, (db) => {
          const r = addIdea(db, {
            kind: args.kind || 'idea',
            title: args.title,
            body: args.body || '',
            tags: args.tags || [],
          })
          const t = r.row
          const summary = r.duplicate
            ? `已经记过了：「${t.title}」（第 ${t.id} 条，${KIND_LABEL[t.kind]}）`
            : `记下了：「${t.title}」· ${KIND_LABEL[t.kind]} · 状态 ${STATUS_LABEL[t.status]}（第 ${t.id} 条）`
          return { summary, id: r.id, duplicate: r.duplicate, item: t }
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'idea_list',
      description: '翻灵感账本：按类型（idea/pitfall/improve）、状态、关键词筛选，看看之前记过什么、哪些还没做。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['idea', 'pitfall', 'improve'] },
          status: { type: 'string', enum: ['new', 'incubating', 'done', 'parked', 'dropped'] },
          q: { type: 'string', description: '关键词，搜标题/正文/标签' },
          limit: { type: 'integer', description: '最多几条，默认 20' },
        },
        additionalProperties: false,
      },
      timeoutMs: 15000,
      output: TOOL_OUTPUT,
      async execute(args) {
        return withDb(cfg, (db) => {
          const items = listIdeas(db, {
            kind: args.kind || null,
            status: args.status || null,
            q: args.q || '',
            limit: args.limit || 20,
          })
          const stats = ideaStats(db)
          const lines = items.map(
            (it) => `#${it.id} [${KIND_LABEL[it.kind]} · ${STATUS_LABEL[it.status]}] ${it.title}${it.body ? ' — ' + it.body.slice(0, 60) : ''}`,
          )
          const summary = items.length
            ? `灵感账本（共 ${stats.total} 条，待看 ${stats.fresh}）：\n${lines.join('\n')}`
            : `没有符合的条目。账本里共 ${stats.total} 条。`
          return { summary, items, stats }
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'idea_digest',
      description:
        '手动跑一轮提炼：扫最近 N 小时的 DSH 会话（session.v4.jsonl.zstd），让模型从中提炼插件点子／踩坑／改进点，写进灵感账本。日常每天定时跑一次，这里是临时加跑。',
      parameters: {
        type: 'object',
        properties: {
          hours: { type: 'integer', description: '往回扫几小时，默认 24' },
          days: { type: 'integer', description: '按天算（优先于 hours）' },
        },
        additionalProperties: false,
      },
      timeoutMs: 180000,
      output: TOOL_OUTPUT,
      async execute(args) {
        if (digestRunning) return { summary: '上一轮提炼还没跑完，稍等。', running: true }
        digestRunning = true
        try {
          const llm = getLlm(ctx)
          if (!llm) return { summary: '拿不到 DSH 的 llm 服务，没法提炼。' }
          const routes = await listRoutes(llm)
          const route = pickRoute(routes, cfg.llm)
          if (!route) return { summary: '没有可用的模型，没法提炼。' }
          const archive = openIdeas(homeOf(cfg))
          try {
            const out = await runDigest({
              streamText,
              llm,
              db: archive.db,
              cfg,
              route,
              hours: args.hours || 24,
              days: args.days || null,
              log,
            })
            markDigestDay(archive.db)
            const head = out.empty
              ? `扫了 ${out.scanned} 个会话，最近没有值得记的新东西。`
              : `提炼了 ${out.sessions} 个会话，新记 ${out.created} 条，跳重 ${out.skipped} 条。`
            const lines = (out.items || []).map((i) => `· [${KIND_LABEL[i.kind]}] ${i.title}`)
            return { summary: lines.length ? `${head}\n${lines.join('\n')}` : head, ...out, model: route.model }
          } finally {
            archive.db.close()
          }
        } finally {
          digestRunning = false
        }
      },
    }),
  )

  // ---------- 每天定时提炼 ----------
  const tick = async () => {
    if (digestRunning) return
    let archive = null
    try {
      archive = openIdeas(homeOf(cfg))
      if (!dueForDigest(cfg, archive.db)) return
      const llm = getLlm(ctx)
      if (!llm) return log('到点该提炼了，但拿不到 llm 服务')
      const routes = await listRoutes(llm)
      const route = pickRoute(routes, cfg.llm)
      if (!route) return log('到点该提炼了，但没有可用模型')
      digestRunning = true
      try {
        const out = await runDigest({ streamText, llm, db: archive.db, cfg, route, hours: cfg.digest.hours || 24, log })
        markDigestDay(archive.db)
        log(`每日提炼完成：${out.created} 条新增（模型 ${route.model}）`)
      } finally {
        digestRunning = false
      }
    } catch (e) {
      log(`提炼失败：${e?.message || e}`)
    } finally {
      try {
        archive?.db.close()
      } catch {}
    }
  }

  const schedule = () => {
    if (digestTimer) clearInterval(digestTimer)
    digestTimer = setInterval(() => tick(), 60_000)
    setTimeout(() => tick(), 10_000)
  }
  schedule()
  ctx.effect(() => () => {
    if (digestTimer) clearInterval(digestTimer)
  })
}
