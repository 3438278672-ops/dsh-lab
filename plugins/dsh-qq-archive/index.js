/**
 * dsh-qq-archive —— 把 QQ 群聊历史变成可检索的记忆 + 群友档案。
 *
 * 核心零 npm 依赖：node:sqlite（FTS5）+ Intl.Segmenter 分词 + node:http。
 * 数据源默认自动探测本机 SnowLuma 网关的 messages.db（只读）。
 */
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { mergeConfig } from './lib/config.mjs'
import { openArchive, searchMessages, contextAround, listChats, dbStats, getMeta, setMeta } from './lib/db.mjs'
import { findCandidates, buildProfile } from './lib/people.mjs'
import { dueForDaily, generateImpression, isImpressionsRunning, readImpression, runImpressions } from './lib/impression.mjs'
import { getLlm, listRoutes, pickRoute, streamText } from './lib/llm.mjs'
import { openSource } from './lib/adapters/index.mjs'
import { syncOnce, isSyncing } from './lib/ingest.mjs'
import { downloadPending, mediaDir } from './lib/media.mjs'
import { exportViewer } from './lib/export.mjs'
import { buildReport, buildReportPrompt, dayBounds, dueForReport, markReportDay, readReport, REPORT_SYSTEM, saveReport } from './lib/report.mjs'
import { exportDashboard } from './lib/dashboard.mjs'
import { exportPeopleCard } from './lib/peoplecard.mjs'
import { registerArchiveWeb } from './lib/web.mjs'
import { buildSemantic, messagesByIds, semanticReady, semanticSearch } from './lib/semantic.mjs'
import { pendingVoiceCount, transcribePending } from './lib/voice.mjs'
import { clampInt, isoDate, parseWhen, parseWhenEnd, stamp, truncate } from './lib/util.mjs'

function textResult(value) {
  return [{ type: 'text', text: String(value ?? '') }]
}

const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => textResult(value?.summary ?? JSON.stringify(value)),
}

export const name = 'qq-archive'
export const inject = ['tools', 'webServer']

const MODE_LABEL = { chars: '精确', fts: '分词', 'fts-or': '相关', like: '模糊', scan: '扫描', semantic: '语义', none: '无' }

const KIND_LABEL = {
  text: '文字',
  image: '图片',
  voice: '语音',
  video: '视频',
  forward: '合并转发',
  file: '文件',
  card: '卡片',
}

function fmtTime(ts) {
  return Number.isFinite(ts) && ts > 0 ? stamp(ts * 1000) : '时间未知'
}

function fmtChat(hit, names) {
  const key = hit.chatKey || ''
  const [type, id] = key.split(':')
  const name = names.get(key) || ''
  if (type === 'group') return name ? `群「${name}」` : `群 ${id}`
  return name ? `私聊「${name}」` : `私聊 ${id}`
}

function fmtLine(hit, names) {
  const who = hit.senderName || hit.senderId
  return `${fmtTime(hit.ts)} · ${fmtChat(hit, names)} · ${who}：${truncate(hit.text || `[${KIND_LABEL[hit.kind] || hit.kind}]`, 300)}`
}

function resolveChatKey(db, raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  if (/^(group|private):\d+$/.test(s)) return s
  if (/^\d{4,12}$/.test(s)) {
    // 群号和 QQ 号长得一样，先按库里真实存在的形态来，别默认成群
    for (const key of ['group:' + s, 'private:' + s]) {
      if (db.prepare('select 1 from chats where chat_key = ?').get(key)) return key
    }
    return 'group:' + s
  }
  const row = db.prepare('select chat_key from chats where name like ? order by msg_count desc limit 1').get('%' + s + '%')
  return row ? row.chat_key : null
}

function resolveSender(raw) {
  const s = String(raw || '').trim()
  if (!s) return {}
  if (/^\d{4,12}$/.test(s)) return { senderId: s }
  return { senderName: s }
}

function chatNameMap(db) {
  const map = new Map()
  for (const row of db.prepare('select chat_key, name from chats').all()) {
    map.set(row.chat_key, row.name || '')
  }
  return map
}

function fmtImpression(imp) {
  if (!imp?.impression) return ''
  const tags = imp.tags?.length ? `\n标签：${imp.tags.join(' / ')}` : ''
  const meta = `${fmtTime(imp.at)}${imp.model ? ` · ${imp.model}` : ''}`
  return `\n\n【人物印象】（${meta}）\n${imp.impression}${tags}`
}

/**
 * 生成一天的群聊日报（每个群一份 + 全群汇总一份）。
 * 已有同一天同一会话的日报就跳过，force=true 重刷。
 */
async function runReport({ llm, db, cfg, day, chatKey, force, maxChats = 12 }) {
  const bounds = dayBounds(day)
  const targets = []
  if (!chatKey) targets.push({ key: '*', name: '全部会话' })
  for (const r of db
    .prepare('select chat_key, name from chats where msg_count > 0 order by msg_count desc limit ?')
    .all(maxChats)) {
    if (chatKey && r.chat_key !== chatKey) continue
    targets.push({ key: r.chat_key, name: r.name || r.chat_key })
  }
  if (!targets.length) return { bounds, route: null, results: [], done: 0, skipped: 0, failed: 0 }

  const routes = await listRoutes(llm)
  if (!routes.length) throw new Error('没有可用的模型路由，没法生成日报')
  const route = pickRoute(routes, { provider: cfg.llm.provider, model: cfg.llm.model })

  const results = []
  let done = 0
  let skipped = 0
  let failed = 0
  for (const t of targets) {
    const existing = readReport(db, { date: bounds.day, chatKey: t.key })
    if (existing && !force) {
      skipped++
      results.push({ chatKey: t.key, chatName: t.name, skipped: true })
      continue
    }
    const rep = buildReport(db, { chatKey: t.key === '*' ? null : t.key, fromTs: bounds.fromTs, toTs: bounds.toTs })
    rep.day = bounds.day
    if (!rep.total) {
      skipped++
      continue
    }
    try {
      // 群一大，模型容易先把 token 花在思考上、正文被截断；给两次机会，第二次放宽预算
      let text = ''
      let lastErr = null
      for (const maxTokens of [900, 1800]) {
        try {
          const r = await streamText(llm, {
            provider: route.provider,
            model: route.model,
            system: REPORT_SYSTEM,
            prompt: buildReportPrompt(rep),
            temperature: 0.6,
            maxTokens,
          })
          text = String(r.text || '').trim()
          if (text) break
        } catch (e) {
          lastErr = e
          if (!/截断|max-tokens|没有内容/i.test(String(e?.message || e))) throw e
        }
      }
      if (!text) throw lastErr || new Error('模型没有返回内容')
      saveReport(db, {
        date: bounds.day,
        chatKey: t.key,
        text,
        stats: {
          total: rep.total,
          members: rep.members.slice(0, 8),
          topWords: rep.topWords,
          links: rep.links.slice(0, 5),
        },
        model: `${route.provider}/${route.model}`,
      })
      done++
      results.push({ chatKey: t.key, chatName: rep.chatName, text, total: rep.total })
    } catch (e) {
      failed++
      results.push({ chatKey: t.key, chatName: t.name, error: String(e?.message || e) })
    }
  }
  return { bounds, route, results, done, skipped, failed }
}

export function apply(ctx, config) {
  const cfg = mergeConfig(config)
  const log = ctx.logger ? ctx.logger('qq-archive') : console

  // DSH 网页里的侧栏入口：点一下就能看看板（Host 静态前缀 /qq-archive）
  if (ctx.webServer) {
    registerArchiveWeb(ctx, {
      home: cfg.home,
      log: (msg) => (log.info ? log.info(msg) : log.log?.(msg)),
    })
  }

  let archive = null
  let source = null
  let openError = null
  let timer = null
  let impressionTimer = null
  let reportTimer = null
  let reportNextRetry = 0
  let mediaRunning = false

  function ensureArchive() {
    if (!archive) archive = { ...openArchive(cfg.home), home: cfg.home }
    return archive
  }

  function ensureSource() {
    if (source) return source
    if (openError) throw openError
    try {
      source = openSource(cfg)
      log.info?.(`数据源：${source.kind} ${source.path || source.baseUrl || ''}`)
    } catch (e) {
      openError = e
      throw e
    }
    return source
  }

  async function doSync({ full = false, onProgress } = {}) {
    const arch = ensureArchive()
    const src = ensureSource()
    const result = await syncOnce({ archive: arch, adapter: src.adapter, cfg, onProgress, full })
    if (result.inserted > 0) maybeDownloadMedia()
    return result
  }

  /** 顺手把新消息里的图片/语音缓存下来；失败不打扰，下次同步再试。 */
  function maybeDownloadMedia() {
    if (mediaRunning) return
    const kinds = []
    if (cfg.enhance.image) kinds.push('image')
    if (cfg.enhance.voice) kinds.push('voice')
    if (!kinds.length) return
    mediaRunning = true
    downloadPending(ensureArchive(), { kinds, limit: 30, maxCount: cfg.media?.maxCount ?? 2000 })
      .then((r) => {
        if (r.cached || r.dead) log.info?.(`媒体缓存：新增 ${r.cached}，失效 ${r.dead}`)
      })
      .catch((e) => log.warn?.(`媒体缓存失败：${e.message}`))
      .finally(() => {
        mediaRunning = false
      })
  }

  /** 库为空时自动全量同步；否则只补增量。 */
  async function ensureIndexed() {
    const arch = ensureArchive()
    const stats = dbStats(arch.db)
    if (stats.total === 0) {
      await doSync({ full: true })
    } else if (!isSyncing()) {
      // 有库但可能很久没同步：查询前顺手补一次增量（失败不影响查询）
      doSync({}).catch((e) => log.warn?.(`增量同步失败：${e.message}`))
    }
    return ensureArchive()
  }

  function schedule() {
    if (!(cfg.syncIntervalMin > 0)) return
    timer = setInterval(() => {
      doSync({}).catch((e) => log.warn?.(`定时同步失败：${e.message}`))
    }, cfg.syncIntervalMin * 60 * 1000)
    timer.unref?.()
  }

  /** 到点（或当天错过）就跑一批人物印象；失败不写日期，下一个 tick 会重试。 */
  async function maybeImpressions() {
    let arch
    try {
      arch = ensureArchive()
      if (!dueForDaily(cfg, arch.db) || isImpressionsRunning()) return
      const result = await runImpressions({
        db: arch.db,
        chatNames: chatNameMap(arch.db),
        llm: getLlm(ctx),
        cfg,
        minMsgs: cfg.impression.minMsgs,
        limit: cfg.impression.limit,
      })
      const done = result.results.filter((r) => r.ok).length
      setMeta(arch.db, 'last_impression_date', isoDate(Math.floor(Date.now() / 1000)))
      setMeta(arch.db, 'last_impression_at', String(Math.floor(Date.now() / 1000)))
      log.info?.(`人物印象批量完成：生成 ${done} 个，跳过 ${result.skipped} 个`)
    } catch (e) {
      log.warn?.(`人物印象批量失败：${e.message}`)
    }
  }

  function scheduleImpressions() {
    if (!cfg.enhance.impression || !cfg.impression.schedule) return
    impressionTimer = setInterval(() => {
      maybeImpressions()
    }, 60 * 1000)
    impressionTimer.unref?.()
    // 启动后补一次当天错过的（schedule 之后才开插件也不落下）
    setTimeout(maybeImpressions, 5000).unref?.()
  }

  /** 每天到点生成「昨天」的群聊日报；全失败时隔 30 分钟再试，避免每分钟打一次模型。 */
  async function maybeReports() {
    if (Date.now() < reportNextRetry) return
    let arch
    try {
      arch = ensureArchive()
      if (!dueForReport(cfg, arch.db)) return
      const llm = getLlm(ctx)
      if (!llm) {
        log.warn?.('日报定时到点了，但 DSH 的 llm 服务不可用，跳过')
        return
      }
      const targetDay = dayBounds('yesterday').day
      const r = await runReport({ llm, db: arch.db, cfg, day: 'yesterday', force: false, maxChats: cfg.report.maxChats })
      if (r.done > 0) {
        markReportDay(arch.db, targetDay)
        log.info?.(`日报定时完成：${targetDay} 生成 ${r.done} 份，跳过 ${r.skipped} 份，失败 ${r.failed} 份`)
      } else if (r.failed > 0) {
        reportNextRetry = Date.now() + 30 * 60 * 1000
        log.warn?.(`日报定时失败 ${r.failed} 份，30 分钟后再试`)
      } else {
        // 那天所有会话都没消息：也算跑过，别每分钟重来
        markReportDay(arch.db, targetDay)
      }
    } catch (e) {
      reportNextRetry = Date.now() + 30 * 60 * 1000
      log.warn?.(`日报定时失败：${e.message}`)
    }
  }

  function scheduleReports() {
    if (!cfg.report?.schedule) return
    reportTimer = setInterval(() => {
      maybeReports()
    }, 60 * 1000)
    reportTimer.unref?.()
    setTimeout(maybeReports, 8000).unref?.()
  }

  ctx.effect(() => () => {
    if (timer) clearInterval(timer)
    if (impressionTimer) clearInterval(impressionTimer)
    if (reportTimer) clearInterval(reportTimer)
    timer = null
    impressionTimer = null
    reportTimer = null
    try {
      source?.adapter?.close?.()
    } catch {
      /* ignore */
    }
    try {
      archive?.db?.close?.()
    } catch {
      /* ignore */
    }
  })

  // 启动后后台预热一次，别阻塞插件加载
  setTimeout(() => {
    doSync({ full: dbStats(ensureArchive().db).total === 0 }).catch((e) => log.warn?.(`启动同步失败：${e.message}`))
    schedule()
    scheduleImpressions()
    scheduleReports()
  }, 1500).unref?.()

  ctx.effect(() =>
    ctx.tools.register({
    name: 'qq_find',
    description:
      '在已归档的 QQ 群聊/私聊历史里全文搜索（中文按词切，2 字词也能搜）。' +
      '返回命中的消息、时间、群、发送者，可选带上下文。' +
      '适合「上次谁说过 XX」「帮我找那条链接」「某人在群里提过什么」这类回溯。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词/短语，中文直接写；空 = 按其它条件列出最近消息' },
        chat: { type: 'string', description: '会话：group:群号 / private:QQ号 / 纯群号 / 群名片段；不填=全部会话' },
        sender: { type: 'string', description: '发送者 QQ 号或昵称片段' },
        from: { type: 'string', description: '起始时间：7d / 2h / 2026-10-01 / 2026-10（含）/ ISO' },
        to: { type: 'string', description: '结束时间，同 from 格式' },
        kind: { type: 'string', enum: ['all', 'text', 'image', 'voice', 'video', 'forward', 'file', 'card', 'link'] },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '返回条数，默认 20' },
        offset: { type: 'integer', minimum: 0, description: '分页偏移' },
        context: { type: 'integer', minimum: 0, maximum: 5, description: '每条命中带前后几条上下文，默认 0' },
        semantic: { type: 'boolean', description: 'true = 走语义检索（要先 qq_archive action=semantic 建好索引；适合「上次那个做视频的群」这种说不清关键词的找法）' },
      },
    },
    timeoutMs: 180000,
    output: TOOL_OUTPUT,
    async execute(args = {}) {
      try {
        const arch = await ensureIndexed()
        const db = arch.db
        const names = chatNameMap(db)
        const stats = dbStats(db)

        let chatKey = null
        if (args.chat) {
          chatKey = resolveChatKey(db, args.chat)
          if (!chatKey) {
            return {
              ok: false,
              error: `没找到会话「${args.chat}」。已知会话：${listChats(db, 20)
                .map((c) => `${c.key}${c.name ? `(${c.name})` : ''}`)
                .join('、')}`,
            }
          }
        }

        const limit = clampInt(args.limit, 1, cfg.maxHits, 20)
        const offset = clampInt(args.offset, 0, 100000, 0)
        const nContext = clampInt(args.context, 0, 5, 0)
        const sender = resolveSender(args.sender)
        const fromTs = parseWhen(args.from)
        const toTs = parseWhenEnd(args.to)

        let hits = []
        let mode = 'none'
        let semanticError = null
        if (args.semantic && args.query) {
          try {
            const sem = await semanticSearch(arch, args.query, { k: Math.max(limit * 5, 50) + offset })
            if (sem && sem.length) {
              const scoreById = new Map(sem.map((s) => [s.id, s.score]))
              hits = messagesByIds(db, sem.map((s) => s.id))
                .map((r) => ({
                  id: r.id,
                  ts: r.ts,
                  chatKey: r.chat_key,
                  senderId: r.sender_id,
                  senderName: r.sender_name,
                  kind: r.kind,
                  text: r.text,
                  replyTo: r.reply_to,
                  score: scoreById.get(r.id),
                }))
                .filter((h) => {
                  if (chatKey && h.chatKey !== chatKey) return false
                  if (sender.senderId && h.senderId !== sender.senderId) return false
                  if (!sender.senderId && sender.senderName && !String(h.senderName || '').includes(sender.senderName)) return false
                  if (Number.isFinite(fromTs) && h.ts < fromTs) return false
                  if (Number.isFinite(toTs) && h.ts > toTs) return false
                  if (args.kind && args.kind !== 'all') {
                    if (args.kind === 'link') return String(h.text || '').includes('http')
                    return h.kind === args.kind
                  }
                  return true
                })
                .slice(offset, offset + limit)
              mode = 'semantic'
            } else {
              semanticError = '语义索引还没建（qq_archive action=semantic）'
            }
          } catch (e) {
            semanticError = String(e?.message || e)
          }
        }
        if (mode !== 'semantic') {
          const r = searchMessages(arch, {
            query: args.query || '',
            chatKey,
            ...sender,
            fromTs: fromTs ?? undefined,
            toTs: toTs ?? undefined,
            kind: args.kind || 'all',
            limit,
            offset,
          })
          hits = r.hits
          mode = r.mode
        }

        const enriched = hits.map((hit) => {
          const row = {
            time: fmtTime(hit.ts),
            ts: hit.ts,
            chat: fmtChat(hit, names),
            chatKey: hit.chatKey,
            sender: hit.senderName || hit.senderId,
            senderId: hit.senderId,
            kind: hit.kind,
            text: hit.text,
            replyTo: hit.replyTo,
          }
          if (hit.score != null) row.score = hit.score
          if (nContext > 0) row.context = contextAround(db, hit, nContext).map((c) => ({
            time: fmtTime(c.ts),
            sender: c.senderName || c.senderId,
            text: c.text,
          }))
          return row
        })

        const lines = enriched.map((h, i) => `${i + 1}. ${fmtLine({ ...h, ts: h.ts, senderName: h.sender, senderId: h.senderId, kind: h.kind, text: h.text }, names)}`)
        const coverage = stats.total
          ? `索引覆盖 ${stats.total} 条消息（${fmtTime(stats.fromTs)} ~ ${fmtTime(stats.toTs)}）`
          : '索引为空'
        const summary = hits.length
          ? `找到 ${hits.length} 条（${MODE_LABEL[mode] || mode}）。\n` +
            lines.join('\n') +
            `\n\n${coverage}`
          : `没搜到。${coverage}。换个词、去掉时间限制，或确认数据源已同步。` +
            (semanticError ? `\n语义检索不可用：${semanticError}` : '')

        return { ok: true, summary, mode, count: hits.length, hits: enriched, coverage }
      } catch (e) {
        return { ok: false, error: String(e?.message || e) }
      }
    },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
    name: 'qq_people',
    description:
      '查群友档案：这个人叫什么、在哪些群、说了多少话、常出没的时段、常聊的词、@ 过谁/被谁 @、最近说了什么。' +
      '适合「XX 是谁」「XX 在哪个群活跃」「这个人最近在聊什么」。' +
      'who 可以填 QQ 号，也可以填昵称片段；同名多号时会列出候选让你确认。',
    parameters: {
      type: 'object',
      properties: {
        who: { type: 'string', description: 'QQ 号或昵称/群名片片段' },
        chat: { type: 'string', description: '只看某个会话：group:群号 / private:QQ号 / 群号 / 群名片段；不填=全部' },
        impression: { type: 'boolean', description: 'true = 当场用模型生成/刷新人物印象（默认只读已生成的缓存；批量生成用 qq_archive action=impressions）' },
      },
      required: ['who'],
    },
    timeoutMs: 300000,
    output: TOOL_OUTPUT,
    async execute(args = {}) {
      try {
        const who = String(args.who || '').trim()
        if (!who) return { ok: false, error: 'who 不能为空：填 QQ 号或昵称片段' }

        const arch = await ensureIndexed()
        const db = arch.db
        const names = chatNameMap(db)
        const stats = dbStats(db)
        const coverage = `索引覆盖 ${stats.total} 条消息（${fmtTime(stats.fromTs)} ~ ${fmtTime(stats.toTs)}）`

        const candidates = findCandidates(db, who)
        if (!candidates.length) {
          return { ok: false, error: `归档里找不到「${who}」。换个昵称片段或直接给 QQ 号。${coverage}` }
        }
        if (candidates.length > 1) {
          const list = candidates
            .slice(0, 10)
            .map((c) => `${c.userId}（${c.names.slice(0, 3).join(' / ') || '无名'}，${c.msgCount} 条）`)
            .join('\n')
          return {
            ok: true,
            ambiguous: true,
            summary: `「${who}」能对上 ${candidates.length} 个人，指定 QQ 号再查：\n${list}`,
            candidates: candidates.map((c) => ({ userId: c.userId, names: c.names, msgCount: c.msgCount })),
          }
        }

        let chatKey = null
        if (args.chat) {
          chatKey = resolveChatKey(db, args.chat)
          if (!chatKey) {
            return {
              ok: false,
              error: `没找到会话「${args.chat}」。已知会话：${listChats(db, 20)
                .map((c) => `${c.key}${c.name ? `(${c.name})` : ''}`)
                .join('、')}`,
            }
          }
        }

        const profile = buildProfile(db, names, { userId: candidates[0].userId, chatKey })
        const scopeText = chatKey ? `（只看 ${names.get(chatKey) || chatKey}）` : ''

        let imp = readImpression(db, candidates[0].userId)
        if (args.impression) {
          const llm = getLlm(ctx)
          if (!llm) return { ok: false, error: 'DSH 的 llm 服务不可用，没法生成人物印象' }
          const route = pickRoute(await listRoutes(llm), cfg.llm)
          if (!route) return { ok: false, error: 'DSH 里没有可用的模型，先在设置里启用一个 provider 再生成印象' }
          const r = await generateImpression({
            db,
            chatNames: names,
            userId: candidates[0].userId,
            chatKey,
            llm,
            route,
            sample: cfg.impression.sample,
          })
          imp = { impression: r.impression, tags: r.tags, at: r.at, model: `${route.provider}/${route.model}` }
        }

        return {
          ok: true,
          summary: profile.summary + fmtImpression(imp) + `\n\n${scopeText}${coverage}`,
          profile,
          impression: imp,
          coverage,
        }
      } catch (e) {
        return { ok: false, error: String(e?.message || e) }
      }
    },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
    name: 'qq_archive',
    description:
      'QQ 归档库的管理工具：status 看数据源/索引状态，sync 立即同步（可全量重建），chats 列会话，' +
      'impressions 批量生成人物印象（增强层，调 DSH 的模型），reset 清空索引重建。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'sync', 'chats', 'media', 'voice', 'impressions', 'report', 'dashboard', 'export', 'semantic', 'reset'], description: '默认 status' },
        full: { type: 'boolean', description: 'sync/reset 时全量重读（reset 默认全量）' },
        day: { type: 'string', description: 'report 的日期：today（默认）/ yesterday / YYYY-MM-DD' },
        chat: { type: 'string', description: 'report 只生成这个会话（群号 / 群名片段 / group:群号）；不填 = 所有群 + 全群汇总' },
        users: { type: 'string', description: 'impressions 时只生成这些 QQ 号（逗号/空格分隔）；不填=按发言量自动挑' },
        minMsgs: { type: 'integer', minimum: 1, maximum: 100000, description: 'impressions 的最低发言条数，默认 20' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'impressions 最多生成几个人 / media 最多下几个 / voice 最多转几条，默认 30 / 50 / 20' },
        kinds: { type: 'string', description: 'media 时只下这些类型：image / voice（逗号分隔），默认两种都下' },
        title: { type: 'string', description: 'export 时页面标题，默认「QQ 归档」' },
        out: { type: 'string', description: 'export 时的输出路径（默认插件家目录下的 viewer.html）' },
        rebuild: { type: 'boolean', description: 'semantic 时 true = 已有索引也重建（CPU 上 3 万条约几分钟）' },
        force: { type: 'boolean', description: 'impressions 时 7 天内已生成的也重刷' },
      },
    },
    timeoutMs: 600000,
    output: TOOL_OUTPUT,
    async execute(args = {}) {
      const action = args.action || 'status'
      try {
        const arch = ensureArchive()
        if (action === 'status') {
          const stats = dbStats(arch.db)
          let src = null
          let srcError = null
          try {
            src = ensureSource()
          } catch (e) {
            srcError = String(e?.message || e)
          }
          const lastSync = Number(getMeta(arch.db, 'last_sync_at', '0')) || 0
          const took = Number(getMeta(arch.db, 'last_sync_took_ms', '0')) || 0
          const mediaCached = arch.db.prepare("select count(*) as n from media where status = 'cached'").get().n
          const summary = [
            `数据源：${src ? `${src.kind} ${src.path || src.baseUrl || ''}` : `不可用（${srcError}）`}`,
            `索引：${stats.total} 条消息 / ${stats.chats} 个会话 / ${stats.members} 个成员 / ${stats.media} 个媒体`,
            `媒体缓存：${mediaCached} 个（${mediaDir(cfg.home)}），待转写语音 ${pendingVoiceCount(arch.db)} 条`,
            `语义索引：${semanticReady(cfg.home) ? '已建' : '未建（qq_archive action=semantic）'}`,
            `时间范围：${stats.total ? `${fmtTime(stats.fromTs)} ~ ${fmtTime(stats.toTs)}` : '空'}`,
            `上次同步：${lastSync ? `${fmtTime(lastSync)}（${Math.round(took / 1000)} 秒）` : '从未'}`,
            `日报定时：${cfg.report?.schedule ? `${cfg.report.schedule}（生成前一天的）` : '关（qq_archive action=report 手动生成）'}`,
            `上次日报：${getMeta(arch.db, 'last_report_day') || '从未'}`,
            `FTS5：${arch.fts ? '可用' : '不可用（退化为 LIKE）'}`,
            `库文件：${arch.path}`,
          ].join('\n')
          return { ok: true, summary, source: src ? { kind: src.kind, path: src.path || src.baseUrl } : null, sourceError: srcError, stats, lastSyncAt: lastSync, fts: arch.fts, path: arch.path }
        }

        if (action === 'chats') {
          const chats = listChats(arch.db, 200)
          const summary = chats.length
            ? chats.map((c) => `${c.key}  ${c.name || '(无名)'}  ${c.msgCount} 条，最后 ${fmtTime(c.lastTs)}`).join('\n')
            : '还没有会话（先 qq_archive action=sync 同步一次）'
          return { ok: true, summary, chats }
        }

        if (action === 'impressions') {
          const llm = getLlm(ctx)
          if (!llm) return { ok: false, error: 'DSH 的 llm 服务不可用，没法生成人物印象' }
          const users = args.users ? String(args.users).split(/[,，\s]+/).filter(Boolean) : null
          const result = await runImpressions({
            db: arch.db,
            chatNames: chatNameMap(arch.db),
            llm,
            cfg,
            userIds: users,
            minMsgs: clampInt(args.minMsgs, 1, 100000, cfg.impression.minMsgs),
            limit: clampInt(args.limit, 1, 200, cfg.impression.limit),
            force: Boolean(args.force),
          })
          const done = result.results.filter((r) => r.ok).length
          const failed = result.results.filter((r) => r.ok === false)
          const today = isoDate(Math.floor(Date.now() / 1000))
          setMeta(arch.db, 'last_impression_date', today)
          setMeta(arch.db, 'last_impression_at', String(Math.floor(Date.now() / 1000)))
          const summary = [
            `人物印象：生成 ${done} 个，跳过 ${result.skipped} 个（7 天内已生成，force=true 可重刷），失败 ${failed.length} 个。`,
            `模型：${result.route.provider}/${result.route.model}`,
            ...failed.slice(0, 5).map((f) => `- ${f.userId}：${f.error}`),
          ].join('\n')
          return { ok: true, summary, ...result }
        }

        if (action === 'media') {
          const kinds = args.kinds ? String(args.kinds).split(/[,，\s]+/).filter(Boolean) : ['image', 'voice']
          const r = await downloadPending(ensureArchive(), {
            kinds,
            limit: clampInt(args.limit, 1, 500, 50),
            maxCount: cfg.media?.maxCount ?? 2000,
          })
          const summary = [
            `媒体缓存：新增 ${r.cached} 个，失效 ${r.dead} 个${r.reason ? `（${r.reason}）` : ''}，合计 ${(r.bytes / 1024 / 1024).toFixed(1)} MB。`,
            `目录：${mediaDir(cfg.home)}`,
            '（QQ 的图片/语音链接带时效，只有同步之后新到的能下；历史媒体会标记失效，不反复重试。）',
            ...r.failed.slice(0, 5).map((f) => `- ${f.kind} ${f.sourceKey}：${f.error}`),
          ].join('\n')
          return { ok: true, summary, ...r, dir: mediaDir(cfg.home) }
        }

        if (action === 'report') {
          const llm = getLlm(ctx)
          if (!llm) return { ok: false, error: 'DSH 的 llm 服务不可用，没法生成日报' }
          let chatKey = null
          if (args.chat) {
            chatKey = resolveChatKey(arch.db, args.chat)
            if (!chatKey) return { ok: false, error: `没找到会话：${args.chat}（可以先 qq_archive action=chats 看看有哪些）` }
          }
          const r = await runReport({
            llm,
            db: arch.db,
            cfg,
            day: args.day || 'today',
            chatKey,
            force: Boolean(args.force),
            maxChats: clampInt(args.limit, 1, 50, 12),
          })
          const ok = r.results.filter((x) => x.text)
          const bad = r.results.filter((x) => x.error)
          const summary = [
            `群聊日报 · ${r.bounds.day}：生成 ${r.done} 份，跳过 ${r.skipped} 份（已有，force=true 重刷）${r.failed ? `，失败 ${r.failed} 份` : ''}。`,
            r.route ? `模型：${r.route.provider}/${r.route.model}` : '',
            ...ok.slice(0, 6).map((x) => `- ${x.chatName}（${x.total} 条消息）已写库`),
            ...bad.slice(0, 4).map((x) => `- ${x.chatName} 失败：${x.error}`),
            '',
            ok.length ? `看板：qq_archive action=dashboard 导出 dashboard.html` : '没有新日报。',
          ]
            .filter(Boolean)
            .join('\n')
          return { ok: true, summary, ...r }
        }

        if (action === 'dashboard') {
          const r = exportDashboard(arch.db, {
            home: cfg.home,
            outPath: args.out || undefined,
            title: args.title || '群聊档案馆',
          })
          // 顺手把「熟人卡」也刷新一遍：QQ 桥接每次唤醒读的就是这份 people.json
          const card = exportPeopleCard(arch.db, { home: cfg.home })
          const summary = [
            `本地看板已生成：${r.path}`,
            `包含 ${r.chats} 个会话 / ${r.reports} 份 ${r.date} 的日报 / ${r.nodes} 个关系节点，${Math.max(1, Math.round(r.bytes / 1024))} KB。`,
            `熟人卡已同步：${card.chats} 个会话 / ${card.people} 人（${card.path}），QQ 那边下次唤醒就会读到。`,
            '双击这个 HTML 就能打开：今日总结、探案板（一个群一块板子，红线是 @ 关系）、群友档案（点开看人物印象和活跃分布）、收藏夹、最近档案。',
            '收藏和批注存在浏览器 localStorage，点「导出存档」才会落成文件——那才是永久档。',
          ].join('\n')
          return { ok: true, summary, ...r, peopleCard: card }
        }

        if (action === 'export') {
          const r = exportViewer(arch.db, { home: cfg.home, title: args.title, outPath: args.out || undefined })
          const summary = [
            `已生成浏览页：${r.path}`,
            `包含 ${r.chats} 个会话 / ${r.messages} 条消息 / ${r.profiles} 份人物印象，${(r.bytes / 1024 / 1024).toFixed(1)} MB。`,
            '双击这个 HTML 就能看（图片走同目录 media/，没缓存的图显示占位）。',
          ].join('\n')
          return { ok: true, summary, ...r }
        }

        if (action === 'voice') {
          const arch2 = ensureArchive()
          const pending = pendingVoiceCount(arch2.db)
          if (!pending) {
            return {
              ok: true,
              summary:
                '没有待转写的语音。\n说明：语音链接过期很快，只有同步之后下载到本地的语音才能转写（enhance.voice 打开时同步会自动下 30 条）。',
              pending: 0,
            }
          }
          const r = await transcribePending(arch2, { limit: clampInt(args.limit, 1, 200, 20) })
          const summary = [
            `语音转写：成功 ${r.done} 条，失败 ${r.failed} 条，空音频 ${r.skipped} 条（还有 ${pending - r.done - r.failed - r.skipped} 条待转写）。`,
            `Python：${r.python}`,
            '（转写文本已写回正文，qq_find 现在能搜到这些语音说的话。）',
          ].join('\n')
          return { ok: true, summary, ...r }
        }

        if (action === 'semantic') {
          const ready = semanticReady(cfg.home)
          if (ready && !args.rebuild) {
            return {
              ok: true,
              summary: `语义索引已存在：${join(cfg.home, 'semantic')}\n要重建就传 rebuild: true（CPU 上 3 万条约几分钟）。\n用 qq_find semantic: true 走语义检索。`,
              ready: true,
              dir: join(cfg.home, 'semantic'),
            }
          }
          const r = await buildSemantic(ensureArchive(), { onProgress: (line) => log.info?.(`语义索引：${line}`) })
          return {
            ok: true,
            summary: `语义索引建好了：${r.count} 条，${r.dim} 维。\n目录：${join(cfg.home, 'semantic')}\n用 qq_find semantic: true 走语义检索。`,
            ...r,
          }
        }

        if (action === 'sync') {
          const full = Boolean(args.full) || dbStats(arch.db).total === 0
          const result = await doSync({ full })
          const stats = dbStats(arch.db)
          return {
            ok: true,
            summary:
              `${full ? '全量' : '增量'}同步完成：扫描 ${result.scanned} 条，新增 ${result.inserted} 条消息` +
              `${result.mediaAdded ? `、${result.mediaAdded} 个媒体` : ''}，用时 ${Math.round(result.tookMs / 1000)} 秒。` +
              `\n索引现有 ${stats.total} 条 / ${stats.chats} 个会话。`,
            result,
            stats,
          }
        }

        if (action === 'reset') {
          try {
            archive.db.close()
          } catch {
            /* ignore */
          }
          archive = null
          for (const suffix of ['', '-wal', '-shm']) {
            try {
              unlinkSync(join(cfg.home, 'archive.db' + suffix))
            } catch {
              /* 文件不存在就算了 */
            }
          }
          const fresh = ensureArchive()
          const result = await doSync({ full: true })
          const stats = dbStats(fresh.db)
          return { ok: true, summary: `已重建索引：${stats.total} 条消息 / ${stats.chats} 个会话，用时 ${Math.round(result.tookMs / 1000)} 秒。`, result, stats }
        }

        return { ok: false, error: `未知 action：${action}` }
      } catch (e) {
        return { ok: false, error: String(e?.message || e) }
      }
    },
    }),
  )
}
