/**
 * dsh-qq-archive —— 把 QQ 群聊历史变成可检索的记忆 + 群友档案。
 *
 * 核心零 npm 依赖：node:sqlite（FTS5）+ Intl.Segmenter 分词 + node:http。
 * 数据源默认自动探测本机 SnowLuma 网关的 messages.db（只读）。
 */
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mergeConfig } from './lib/config.mjs'
import { openArchive, searchMessages, contextAround, listChats, dbStats, getMeta, setMeta } from './lib/db.mjs'
import { findCandidates, buildProfile } from './lib/people.mjs'
import { estimateHeight, htmlToPng, personCardHtml } from './lib/card.mjs'
import { dueForDaily, generateImpression, isImpressionsRunning, readImpression, runImpressions } from './lib/impression.mjs'
import { getLlm, listRoutes, pickRoute, generateText } from './lib/llm.mjs'
import { openSource } from './lib/adapters/index.mjs'
import { syncOnce, isSyncing } from './lib/ingest.mjs'
import { downloadPending, mediaDir } from './lib/media.mjs'
import { exportViewer } from './lib/export.mjs'
import { buildReport, buildReportPrompt, dayBounds, dueForReport, markReportDay, readReport, REPORT_SYSTEM, saveReport } from './lib/report.mjs'
import { createBoard } from './lib/board.mjs'
import { exportPeopleCard } from './lib/peoplecard.mjs'
import { registerArchiveWeb } from './lib/web.mjs'
import { buildSemantic, messagesByIds, semanticReady, semanticSearch } from './lib/semantic.mjs'
import { pendingVoiceCount, transcribePending } from './lib/voice.mjs'
import { buildLinkIndex, filterLinks, linksMarkdown } from './lib/links.mjs'
import { investigateTopic, topWords } from './lib/topics.mjs'
import { listHighlights, readHighlight, runHighlights } from './lib/highlights.mjs'
import { askArchive } from './lib/ask.mjs'
import { exportFind } from './lib/findexport.mjs'
import { PERIOD_FLOOR, buildPeriod, listPeriodReports, periodBounds, readPeriodReport, runPeriodReport } from './lib/period.mjs'
import { effectivePushSettings, pushReport, recordPushResult, setPushSettings } from './lib/push.mjs'
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
      // 推理模型会把输出预算先花在思考上：交给 generateText 统一翻倍加预算
      const { text: generated } = await generateText(llm, {
        provider: route.provider,
        model: route.model,
        system: REPORT_SYSTEM,
        prompt: buildReportPrompt(rep),
        temperature: 0.6,
        maxTokens: 900,
        attempts: 3,
      })
      const text = String(generated || '').trim()
      if (!text) throw new Error('模型没有返回内容')
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
  // 看板构建器由插件持有：同步 / 日报 / 印象写完库都叫它预热一份，网页那边只负责发文件。
  const boardLog = (msg) => (log.info ? log.info(msg) : log.log?.(msg))
  const board = createBoard({
    home: cfg.home,
    getDb: () => ensureArchive().db,
    log: boardLog,
  })

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

  /**
   * 档案卡用：只在「这个会话」的视角里读一个人。
   * 会话 key 就是隔离边界——A 群查不到 B 群里的发言、时段和 @ 关系。
   */
  function profileFor(chatKey, userId) {
    const db = ensureArchive().db
    const chat = db.prepare('select name from chats where chat_key = ?').get(chatKey)
    if (!chat) return null
    const chatNames = new Map(listChats(db, 500).map((c) => [c.key, c.name]))
    const profile = buildProfile(db, chatNames, { userId, chatKey, topLimit: 500 })
    if (!profile || !profile.total) return null
    // 统一走 readImpression：老数据里可能存的是整段 JSON，读的时候已经拆回文字 + 标签
    const imp = readImpression(db, userId)
    profile.impression = imp?.impression || ''
    profile.tags = (imp?.tags || []).slice(0, 6)
    return {
      profile,
      meta: { chatName: chat.name, today: new Date().toISOString().slice(0, 10) },
    }
  }

  /** 在某个会话里按昵称找人：只返回在这个群说过话的人。 */
  function lookupInChat(chatKey, who) {
    const db = ensureArchive().db
    const list = findCandidates(db, who).filter((c) => (c.chats || []).some((x) => x.chatKey === chatKey))
    // 名字完全对上的优先；「drill_up」不该把「drill_up 邀请…」这种也算进来
    const exact = list.filter((c) => c.exact)
    return (exact.length ? exact : list).slice(0, 8)
  }

  if (ctx.webServer) {
    registerArchiveWeb(ctx, {
      home: cfg.home,
      board,
      log: boardLog,
      profileFor,
      lookupInChat,
      getDb: () => ensureArchive().db,
      getArchive: () => ensureArchive(),
      cfg,
    })
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
    // 库变了，看板该重算了（没变的话 build 自己会跳过，只花几毫秒比指纹）
    board.prewarm()
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
      // 印象写进了 profiles，看板的人物档案要跟着换
      board.prewarm()
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

  /**
   * 日报写完后按开关私聊推送：digest 只推「所有会话」的汇总，all 每群各一份。
   * 推送失败不影响日报本身——把错误带回给调用方，方便在 QQ 里看到原因。
   */
  async function deliverReports(db, result, { date }) {
    let eff
    try {
      eff = effectivePushSettings(db, cfg)
    } catch (e) {
      return { ok: false, pushed: 0, failed: 0, error: String(e?.message || e) }
    }
    if (!eff.enabled) return null
    const fresh = (result.results || []).filter((r) => r.text && !r.skipped && !r.error)
    const picked = eff.scope === 'all' ? fresh : fresh.filter((r) => r.chatKey === '*')
    if (!picked.length) {
      return { ok: false, pushed: 0, failed: 0, error: '这次没有可推送的新日报' }
    }
    const pushed = []
    const failed = []
    for (const rep of picked) {
      const pr = await pushReport(cfg, {
        date,
        chatKey: rep.chatKey,
        chatName: rep.chatName,
        text: rep.text,
        target: eff.target,
      })
      if (pr.ok) pushed.push(`${rep.chatName}→${pr.target}（${pr.parts} 条）`)
      else failed.push(`${rep.chatName}：${pr.error}`)
    }
    const ok = failed.length === 0
    recordPushResult(db, { ok, text: ok ? pushed.join('、') : failed.join('；') })
    return { ok, pushed: pushed.length, failed: failed.length, pushedList: pushed, failedList: failed, target: eff.target }
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
        board.prewarm()
        const pr = await deliverReports(arch.db, r, { date: targetDay })
        if (pr && pr.ok) log.info?.(`日报已私聊推送：${pr.pushed} 份 → ${pr.target}`)
        else if (pr) log.warn?.(`日报推送失败：${pr.error}`)
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
    doSync({ full: dbStats(ensureArchive().db).total === 0 })
      .catch((e) => log.warn?.(`启动同步失败：${e.message}`))
      // 同步完成后把看板预热好：下次打开就是现成的（已有快照时这里只是一次指纹比对）
      .finally(() => board.prewarm())
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
        export: { type: 'string', enum: ['md', 'html'], description: '把这次结果导出成文件（md / html）；默认写到归档目录 exports/' },
        out: { type: 'string', description: 'export 的输出路径（可选）' },
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

        const result = {
          ok: true,
          summary,
          mode,
          count: hits.length,
          hits: enriched,
          coverage,
          filters: {
            query: args.query || '',
            chat: args.chat || '',
            sender: args.sender || '',
            from: args.from || '',
            to: args.to || '',
            kind: args.kind || 'all',
            semantic: Boolean(args.semantic),
          },
        }
        if (args.export) {
          const format = args.export === 'html' ? 'html' : 'md'
          try {
            const ex = exportFind({ home: cfg.home, result, format, outPath: args.out || undefined })
            result.export = ex
            result.summary += `\n\n已导出（${format}）：${ex.path}（${Math.max(1, Math.round(ex.bytes / 1024))} KB）`
          } catch (e) {
            result.exportError = String(e?.message || e)
            result.summary += `\n\n导出失败：${result.exportError}`
          }
        }
        return result
      } catch (e) {
        return { ok: false, error: String(e?.message || e) }
      }
    },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
    name: 'qq_ask',
    description:
      '用一句话问归档里的聊天记录：「上周谁提过那个做视频的群？」「最近大家在聊什么游戏？」。' +
      '语义索引 + 关键词两路检索，再由模型组织成带 [n] 引用的回答；引用能对回具体消息。' +
      '适合回忆、找说法、概括某段时间的氛围；精确找原话还是用 qq_find。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '自然语言问题，中文直接写' },
        chat: { type: 'string', description: '只在这个会话里找：group:群号 / private:QQ号 / 纯群号 / 群名片段' },
        from: { type: 'string', description: '起始时间：7d / 2026-11-01 / ISO' },
        to: { type: 'string', description: '结束时间，同 from' },
        limit: { type: 'integer', minimum: 5, maximum: 200, description: '最多取多少条材料，默认 60' },
      },
      required: ['question'],
    },
    timeoutMs: 240000,
    output: TOOL_OUTPUT,
    async execute(args = {}) {
      try {
        const question = String(args.question || '').trim()
        if (!question) return { ok: false, error: 'question 不能为空' }
        const arch = await ensureIndexed()
        const llm = getLlm(ctx)
        if (!llm) return { ok: false, error: 'DSH 里没有可用模型，无法回答问题（先在 DSH 里启用一个 provider）' }
        let chatKey = null
        if (args.chat) {
          chatKey = resolveChatKey(arch.db, args.chat)
          if (!chatKey) return { ok: false, error: `没找到会话：${args.chat}` }
        }
        const fromTs = parseWhen(args.from) ?? 0
        const toTs = parseWhenEnd(args.to) ?? 0
        const r = await askArchive({
          archive: arch,
          db: arch.db,
          llm,
          cfg,
          question,
          chatKey,
          fromTs,
          toTs,
          k: clampInt(args.limit, 5, 200, 60),
          home: cfg.home,
        })
        const cites = (r.citations || []).map((c) => `[${c.n}] ${fmtTime(c.ts)} · ${c.chatName || c.chatKey} · ${c.senderName || '?'}：${truncate(c.text, 120)}`)
        const summary = [
          r.answer,
          cites.length ? `\n\n引用（${cites.length} 条，检索方式：${r.mode}）：` : '',
          ...cites,
          r.semanticError ? `\n语义检索降级：${r.semanticError}` : '',
        ]
          .filter(Boolean)
          .join('\n')
        return { ok: true, summary, ...r }
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
        format: { type: 'string', enum: ['html', 'png'], description: '导出档案卡：html=单文件网页，png=图片。需要同时指定 chat（档案按群隔离）' },
        out: { type: 'string', description: '导出路径（默认插件家目录 card-<QQ>-<群>.html/png）' },
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

        const format = String(args.format || '').toLowerCase()
        if (format === 'html' || format === 'png') {
          if (!chatKey) {
            return { ok: false, error: '导出档案卡要指定 chat：档案卡按群隔离，避免把别群的记录带出去' }
          }
          const meta = { chatName: names.get(chatKey) || chatKey, today: isoDate(Math.floor(Date.now() / 1000)) }
          const cardHtml = personCardHtml(profile, meta)
          const outPath = args.out
            ? String(args.out)
            : join(cfg.home, `card-${profile.userId}-${chatKey.replace(/[^\d]/g, '')}.${format === 'png' ? 'png' : 'html'}`)
          mkdirSync(dirname(outPath), { recursive: true })
          if (format === 'png') {
            writeFileSync(outPath, htmlToPng(cardHtml, { height: estimateHeight(profile) }))
          } else {
            writeFileSync(outPath, cardHtml, 'utf8')
          }
          return {
            ok: true,
            summary: `档案卡已导出：${outPath}\n分类：${format === 'png' ? 'PNG 图片' : 'HTML 单文件'}；范围：${meta.chatName}；${coverage}`,
            path: outPath,
            format,
            profile,
            impression: imp,
          }
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
      name: 'qq_links',
      description:
        '群链接资源库：把群里发过的 http(s) 链接和卡片（小程序/分享）里的地址收成一份带域名统计的清单。' +
        'action=list 按关键词/域名/会话/时间筛，action=export 导出 Markdown 存档。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'export'], description: '默认 list' },
          q: { type: 'string', description: '关键词：标题 / 地址 / 发送者 / 群名' },
          domain: { type: 'string', description: '精确域名，如 bilibili.com' },
          chat: { type: 'string', description: '只看某个会话：group:群号 / 群号 / 群名片段' },
          from: { type: 'string', description: '起始时间：7d / 2h / 2026-11-01' },
          to: { type: 'string', description: '结束时间，同 from 格式' },
          limit: { type: 'integer', minimum: 1, maximum: 2000, description: '最多返回几条，默认 200' },
          out: { type: 'string', description: 'export 的输出路径（默认插件家目录 links.md）' },
        },
      },
      timeoutMs: 120000,
      output: TOOL_OUTPUT,
      async execute(args = {}) {
        try {
          const arch = await ensureIndexed()
          const db = arch.db
          const names = chatNameMap(db)
          let chatKey = null
          if (args.chat) {
            chatKey = resolveChatKey(db, args.chat)
            if (!chatKey) return { ok: false, error: `没找到会话：${args.chat}` }
          }
          const fromTs = args.from ? parseWhen(args.from) || 0 : 0
          const toTs = args.to ? parseWhenEnd(args.to) || 0 : 0
          const limit = clampInt(args.limit, 1, 2000, 200)
          // 先全量聚合（域名统计才有意义），返回条数再截
          const index = buildLinkIndex(db, { chatKey, fromTs, toTs, limit: 4000 })

          if (args.action === 'export') {
            const md = linksMarkdown(index, { title: '群链接资源库', limit })
            const outPath = args.out ? String(args.out) : join(cfg.home, 'links.md')
            mkdirSync(dirname(outPath), { recursive: true })
            writeFileSync(outPath, md, 'utf8')
            return {
              ok: true,
              summary: `链接资源库已导出：${outPath}\n共 ${index.total} 条带链接的消息 / ${index.domains.length} 个域名，导出 ${Math.min(limit, index.links.length)} 条。`,
              path: outPath,
              total: index.total,
              domains: index.domains.length,
            }
          }

          const links = filterLinks(index, {
            q: String(args.q || '').trim(),
            domain: String(args.domain || '').trim(),
            chatKey: chatKey || '',
            limit,
          })
          const lines = links.map((l) => {
            const when = fmtTime(l.ts)
            const where = names.get(l.chatKey) ? `群「${names.get(l.chatKey)}」` : fmtChat({ chatKey: l.chatKey }, names)
            const who = l.senderName || l.senderId
            const title = l.title ? `${truncate(l.title, 60)} ` : ''
            return `- ${when} · ${where} · ${who}：${title}${l.url}`
          })
          const domainLine = index.domains
            .slice(0, 8)
            .map((d) => `${d.domain}(${d.count})`)
            .join('、')
          const summary = links.length
            ? `链接资源库：共 ${index.total} 条带链接的消息 / ${index.domains.length} 个域名（${domainLine}）。\n${lines.join('\n')}`
            : `没有匹配的链接。库里共 ${index.total} 条带链接的消息，试试放宽条件。`
          return {
            ok: true,
            summary,
            total: index.total,
            domains: index.domains,
            byChat: index.byChat,
            count: links.length,
            links,
          }
        } catch (e) {
          return { ok: false, error: String(e?.message || e) }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'qq_topic',
      description:
        '群梗/话题考古：一个词第一次出现是什么时候、后来被谁反复说、都出现在哪些群和什么语境里。' +
        'word 必填；top=true 时改看最近的高频词（不用给 word）。',
      parameters: {
        type: 'object',
        properties: {
          word: { type: 'string', description: '要考古的词，如「绑定」「大肥鱼」' },
          top: { type: 'boolean', description: 'true = 不看具体词，列出近期高频词' },
          chat: { type: 'string', description: '只看某个会话：group:群号 / 群号 / 群名片段' },
          from: { type: 'string', description: '起始时间：7d / 2h / 2026-11-01' },
          to: { type: 'string', description: '结束时间，同 from 格式' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: '样本条数，默认 20' },
        },
      },
      timeoutMs: 120000,
      output: TOOL_OUTPUT,
      async execute(args = {}) {
        try {
          const arch = await ensureIndexed()
          const db = arch.db
          const names = chatNameMap(db)
          let chatKey = null
          if (args.chat) {
            chatKey = resolveChatKey(db, args.chat)
            if (!chatKey) return { ok: false, error: `没找到会话：${args.chat}` }
          }
          const fromTs = args.from ? parseWhen(args.from) || 0 : 0
          const toTs = args.to ? parseWhenEnd(args.to) || 0 : 0
          const limit = clampInt(args.limit, 1, 200, 20)

          if (args.top) {
            const words = topWords(db, { chatKey, fromTs, toTs, limit: Math.max(limit, 24) })
            const summary = words.length
              ? `近期高频词：\n${words.map((w) => `- ${w.word}（${w.count} 次）`).join('\n')}`
              : '这段时间没有统计到高频词。'
            return { ok: true, summary, words }
          }

          const word = String(args.word || '').trim()
          if (!word) return { ok: false, error: 'word 不能为空：给一个要考古的词，或者传 top: true 看高频词' }
          const r = investigateTopic(arch, { word, chatKey, fromTs, toTs, limit })
          const scope = chatKey ? `（只看 ${names.get(chatKey) || chatKey}）` : ''
          const firstLine = r.first
            ? `${fmtTime(r.first.ts)} ${fmtChat(r.first, names)} ${r.first.senderName || r.first.senderId}：${truncate(r.first.text, 160)}`
            : '（没有）'
          const lines = [
            `「${word}」考古${scope}：共出现 ${r.total} 次${r.total ? '' : '（换个词或放宽时间试试）'}。`,
            `第一次：${firstLine}`,
            r.last ? `最近一次：${fmtTime(r.last.ts)} ${fmtChat(r.last, names)} ${r.last.senderName || r.last.senderId}` : '',
            r.byChat.length ? `常出现的群：${r.byChat.slice(0, 6).map((c) => `${c.name}(${c.count})`).join('、')}` : '',
            r.topUsers.length ? `最爱说的人：${r.topUsers.slice(0, 8).map((u) => `${u.name}(${u.count})`).join('、')}` : '',
            r.byMonth.length ? `按月：${r.byMonth.map((m) => `${m.month}:${m.count}`).join(' ')}` : '',
            r.samples.length ? `\n语境样本：\n${r.samples.slice(0, 8).map((s) => `- ${fmtTime(s.ts)} · ${fmtChat(s, names)} · ${s.senderName || s.senderId}：${truncate(s.text, 140)}`).join('\n')}` : '',
          ].filter(Boolean)
          return { ok: true, summary: lines.join('\n'), ...r }
        } catch (e) {
          return { ok: false, error: String(e?.message || e) }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'qq_highlights',
      description:
        '群里的名场面：找一段时间里突然刷屏的爆聊段，用 DSH 的模型写成摘要存库。' +
        'action=list 看已生成的（默认），show 看一条全文，build 扫描并生成新的（按时间、会话、数量、force 控制）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'build', 'show'], description: '默认 list' },
          id: { type: 'integer', minimum: 1, description: 'show 时的名场面 id' },
          chat: { type: 'string', description: '只看某个会话：group:群号 / 群号 / 群名片段' },
          from: { type: 'string', description: 'build 的起始时间：7d / 2026-11-01' },
          to: { type: 'string', description: 'build 的结束时间' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多处理 / 返回几条，默认 12 / 20' },
          force: { type: 'boolean', description: 'build 时已生成过的也重写' },
        },
      },
      timeoutMs: 600000,
      output: TOOL_OUTPUT,
      async execute(args = {}) {
        try {
          const arch = await ensureIndexed()
          const db = arch.db
          const names = chatNameMap(db)
          let chatKey = null
          if (args.chat) {
            chatKey = resolveChatKey(db, args.chat)
            if (!chatKey) return { ok: false, error: `没找到会话：${args.chat}` }
          }

          if (args.action === 'show') {
            const id = clampInt(args.id, 1, Number.MAX_SAFE_INTEGER, 0)
            if (!id) return { ok: false, error: 'show 要传 id（先 action=list 看有哪些）' }
            const h = readHighlight(db, id)
            if (!h) return { ok: false, error: `没有 id=${id} 的名场面` }
            const summary = [
              `名场面 #${h.id} · ${h.chatName || names.get(h.chatKey) || h.chatKey}`,
              `${fmtTime(h.fromTs)} ~ ${fmtTime(h.toTs)}，${h.msgCount} 条消息`,
              h.stats?.participants?.length ? `参与者：${h.stats.participants.slice(0, 8).map((p) => `${p.name}(${p.count})`).join('、')}` : '',
              '',
              h.summary || '（没有摘要）',
            ].filter(Boolean).join('\n')
            return { ok: true, summary, highlight: h }
          }

          if (args.action === 'build') {
            const llm = getLlm(ctx)
            if (!llm) return { ok: false, error: 'DSH 的 llm 服务不可用，没法生成名场面摘要' }
            const fromTs = args.from ? parseWhen(args.from) || 0 : 0
            const toTs = args.to ? parseWhenEnd(args.to) || 0 : 0
            const r = await runHighlights({
              db,
              llm,
              cfg,
              fromTs,
              toTs,
              limit: clampInt(args.limit, 1, 100, 12),
              force: Boolean(args.force),
              chatKey,
            })
            board.prewarm()
            const failed = r.results.filter((x) => x.ok === false && !x.skipped)
            const summary = [
              `名场面：扫到 ${r.found} 段爆聊，新生成 ${r.built} 条，跳过 ${r.skipped} 条（已写过，force=true 重写）${failed.length ? `，失败 ${failed.length} 条` : ''}。`,
              ...r.results.filter((x) => x.ok && !x.skipped).slice(0, 6).map((x) => `- ${x.fromDate} ${names.get(x.chatKey) || x.chatKey}：${truncate(x.summary, 80)}`),
              ...failed.slice(0, 4).map((x) => `- ${fmtTime(x.fromTs)} 失败：${x.error}`),
              '看板「名场面」标签里能看到全文。',
            ].join('\n')
            return { ok: true, summary, ...r }
          }

          const list = listHighlights(db, { limit: clampInt(args.limit, 1, 100, 20), chatKey })
          const summary = list.length
            ? `已生成 ${list.length} 条名场面：\n${list.map((h) => `- #${h.id} ${fmtTime(h.fromTs)} · ${h.chatName || names.get(h.chatKey) || h.chatKey}（${h.msgCount} 条）：${truncate(h.summary, 70)}`).join('\n')}`
            : '还没有生成过名场面。跑 qq_highlights action=build 扫一遍爆聊段。'
          return { ok: true, summary, highlights: list }
        } catch (e) {
          return { ok: false, error: String(e?.message || e) }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
    name: 'qq_report',
    description:
      '周报 / 月报：把一段时间的群聊聚合成报告（只覆盖 2026-11-06 之后，更早不补）。' +
      'status 看本周/本月周期，list 列已生成的，generate 调模型生成，show 读某一期全文。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'list', 'generate', 'show'], description: '默认 status' },
        kind: { type: 'string', enum: ['week', 'month'], description: '周期类型，默认 week' },
        chat: { type: 'string', description: '只对某个会话生成/查看（群号 / 群名片段 / group:群号）；不填=所有会话' },
        from: { type: 'string', description: '参考日期 YYYY-MM-DD（默认今天；用于定位是哪一周/哪个月）' },
        offset: { type: 'integer', minimum: -52, maximum: 52, description: '相对当前周期偏移：0=本期，-1=上一期（上个月），1=下一期（下个月）（最多 ±52）' },
        force: { type: 'boolean', description: 'generate 时已有同一期也重写' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'list 返回条数，默认 12' },
      },
    },
    timeoutMs: 300000,
    output: TOOL_OUTPUT,
    async execute(args = {}) {
      const action = args.action || 'status'
      const kind = args.kind === 'month' ? 'month' : 'week'
      try {
        const arch = ensureArchive()
        const db = arch.db
        const names = chatNameMap(db)
        let chatKey = null
        if (args.chat) {
          chatKey = resolveChatKey(db, args.chat)
          if (!chatKey) return { ok: false, error: `没找到会话：${args.chat}` }
        }
        const ref = args.from ? new Date(`${args.from}T12:00:00`) : new Date()
        if (Number.isNaN(ref.getTime())) return { ok: false, error: `from 不是合法日期：${args.from}` }
        const offset = clampInt(args.offset, -52, 52, 0)

        if (action === 'status') {
          const week = periodBounds('week', ref, offset)
          const wprev = periodBounds('week', ref, offset - 1)
          const month = periodBounds('month', ref, offset)
          const mprev = periodBounds('month', ref, offset - 1)
          const weeks = listPeriodReports(db, { kind: 'week', limit: 200 })
          const months = listPeriodReports(db, { kind: 'month', limit: 200 })
          const summary = [
            `周期报告（从 ${PERIOD_FLOOR} 起，更早不补）`,
            `本周：${week.fromDate} ~ ${week.toDate}（label ${week.label}）；上一周：${wprev.fromDate} ~ ${wprev.toDate}`,
            `本月：${month.fromDate} ~ ${month.toDate}；上一月：${mprev.fromDate} ~ ${mprev.toDate}`,
            `已生成：周报 ${weeks.length} 份 / 月报 ${months.length} 份`,
            weeks.length ? `最新周报：${weeks[0].fromDate} ~ ${weeks[0].toDate}（${weeks[0].chatName || '所有会话'}）` : '还没有周报：qq_report action=generate kind=week',
            months.length ? `最新月报：${months[0].fromDate} ~ ${months[0].toDate}（${months[0].chatName || '所有会话'}）` : '还没有月报：qq_report action=generate kind=month',
            '看板「群总结」标签顶部也会列出来。',
          ].join('\n')
          return { ok: true, summary, week, prevWeek: wprev, month, prevMonth: mprev, weeks: weeks.length, months: months.length }
        }

        if (action === 'list') {
          const list = listPeriodReports(db, { kind: args.kind ? kind : null, limit: clampInt(args.limit, 1, 100, 12) })
          const summary = list.length
            ? list.map((p) => `${p.kind === 'month' ? '月报' : '周报'} ${p.fromDate}~${p.toDate} · ${p.chatKey === '*' ? '所有会话' : names.get(p.chatKey) || p.chatName || p.chatKey} · ${p.stats?.total || 0} 条：${truncate(p.text, 60)}`).join('\n')
            : '还没有周期报告。qq_report action=generate kind=week 生成一份。'
          return { ok: true, summary, reports: list }
        }

        if (action === 'show') {
          const fromDate = args.from
          if (!fromDate) return { ok: false, error: 'show 需要 from=这一期开始的日期（YYYY-MM-DD），可以先 action=list 看' }
          const row = readPeriodReport(db, { kind, fromDate, chatKey: chatKey || '*' })
          if (!row) return { ok: false, error: `没有找到 ${fromDate} 开始的这一期${kind === 'month' ? '月报' : '周报'}（chat=${args.chat || '所有会话'}）` }
          const summary = `${row.fromDate} ~ ${row.toDate} · ${row.chatKey === '*' ? '所有会话' : names.get(row.chatKey) || row.chatName || row.chatKey}（模型 ${row.model || '未知'}）\n\n${row.text}`
          return { ok: true, summary, report: row }
        }

        // generate
        const llm = getLlm(ctx)
        if (!llm) return { ok: false, error: 'DSH 的 llm 服务不可用，没法生成周报/月报' }
        const r = await runPeriodReport({
          db,
          llm,
          cfg,
          kind,
          chatKey,
          ref,
          offset,
          force: Boolean(args.force),
        })
        if (r.saved) board.prewarm()
        const label = kind === 'month' ? '月报' : '周报'
        const summary = r.saved
          ? `${label}生成好了：${r.fromDate} ~ ${r.toDate}（${chatKey ? names.get(chatKey) || chatKey : '所有会话'}），模型 ${r.model}。\n\n${truncate(r.text, 600)}`
          : r.reason === 'exists'
            ? `这一期${label}（${r.fromDate} ~ ${r.toDate}）已经生成过，force=true 可以重写。`
            : r.reason === 'empty'
              ? `这一期${label}（${r.fromDate} ~ ${r.toDate}）没有消息，没生成。`
              : `${label}没有生成（${r.reason || '未知原因'}）。`
        return { ok: true, summary, ...r }
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
      'impressions 批量生成人物印象（增强层，调 DSH 的模型），report 生成日报，push 设置日报私聊送达，' +
      'reset 清空索引重建。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'sync', 'chats', 'media', 'voice', 'impressions', 'report', 'push', 'dashboard', 'export', 'semantic', 'reset'], description: '默认 status' },
        full: { type: 'boolean', description: 'sync/reset 时全量重读（reset 默认全量）' },
        day: { type: 'string', description: 'report 的日期：today（默认）/ yesterday / YYYY-MM-DD' },
        chat: { type: 'string', description: 'report 只生成这个会话（群号 / 群名片段 / group:群号）；不填 = 所有群 + 全群汇总' },
        enabled: { type: 'boolean', description: 'push 时设置开关：true 打开日报主动送达，false 关闭' },
        target: { type: 'string', description: 'push 的收件人：QQ号 / private:<QQ号>；不填=自动用本机 qq-bridge 白名单里的第一个私聊号' },
        scope: { type: 'string', enum: ['digest', 'all'], description: 'push 推送范围：digest 只推全群汇总（默认），all 每个群各推一份' },
        test: { type: 'boolean', description: 'push 时顺带发一条测试消息，确认桥接地址和令牌能用' },
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
            `日报推送：${(() => {
              const p = effectivePushSettings(arch.db, cfg)
              const last = getMeta(arch.db, 'push_last_at', '')
              return `${p.enabled ? '开' : '关'}（${p.scope === 'all' ? '每群一份' : '只推全群汇总'}，收件人 ${p.target || '未定'}，令牌${p.tokenReady ? '就绪' : '没找到'}）${last ? `，上次 ${fmtTime(Number(last))} ${getMeta(arch.db, 'push_last_result', '')}` : ''}`
            })()}`,
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
          const pushed = await deliverReports(arch.db, r, { date: r.bounds.day })
          const summary = [
            `群聊日报 · ${r.bounds.day}：生成 ${r.done} 份，跳过 ${r.skipped} 份（已有，force=true 重刷）${r.failed ? `，失败 ${r.failed} 份` : ''}。`,
            r.route ? `模型：${r.route.provider}/${r.route.model}` : '',
            ...ok.slice(0, 6).map((x) => `- ${x.chatName}（${x.total} 条消息）已写库`),
            ...bad.slice(0, 4).map((x) => `- ${x.chatName} 失败：${x.error}`),
            pushed ? (pushed.ok ? `已私聊推送：${pushed.pushed} 份 → ${pushed.target}` : `私聊推送没成功：${pushed.error || pushed.failedList?.join('；')}`) : '',
            '',
            ok.length ? `看板：qq_archive action=dashboard 导出 dashboard.html` : '没有新日报。',
          ]
            .filter(Boolean)
            .join('\n')
          return { ok: true, summary, ...r, pushed }
        }

        if (action === 'push') {
          if (args.enabled !== undefined || args.target !== undefined || args.scope !== undefined) {
            setPushSettings(arch.db, { enabled: args.enabled, target: args.target, scope: args.scope })
          }
          const eff = effectivePushSettings(arch.db, cfg)
          let testResult = null
          if (args.test) {
            testResult = await pushReport(cfg, {
              date: isoDate(Math.floor(Date.now() / 1000)),
              chatName: '测试',
              text: `这是一条测试推送（${stamp(Date.now())}）。\n收到说明：qq-bridge 地址、控制台令牌、白名单和收件人都没问题；以后日报生成完就会这样私聊发给你。`,
              target: eff.target,
            })
          }
          const last = getMeta(arch.db, 'push_last_at', '')
          const summary = [
            `日报主动送达：${eff.enabled ? '已打开' : '已关闭'}`,
            `推送范围：${eff.scope === 'all' ? '每个群各一份' : '只推「所有会话」的汇总日报'}（scope=digest/all）`,
            `收件人：${eff.target || '未定（可用 target 指定 QQ 号，或检查 qq-bridge 白名单）'}`,
            `qq-bridge：${eff.baseUrl} · 控制台令牌${eff.tokenReady ? '已找到' : '没找到（配 push.token / push.tokenFile，或确认桥接 state/console-token 存在）'}`,
            last ? `上次推送：${fmtTime(Number(last))} ${getMeta(arch.db, 'push_last_result', '')}` : '',
            testResult
              ? testResult.ok
                ? `测试消息已发出（${testResult.parts} 条）→ ${testResult.target}`
                : `测试消息没发出去：${testResult.error}`
              : '',
            eff.enabled && eff.tokenReady && eff.target ? '日报生成后会自动私聊推送；想先试试可以再带 test=true。' : '开关要真正生效，需要收件人和桥接令牌都就绪。',
          ]
            .filter(Boolean)
            .join('\n')
          return { ok: true, summary, push: eff, test: testResult }
        }

        if (action === 'dashboard') {
          // 手上要一份「现在就准」的：强制走一次增量构建（没变的东西照样复用快照）
          const r = await board.build({
            force: true,
            outPath: args.out || undefined,
            title: args.title || '群聊档案馆',
          })
          // 顺手把「熟人卡」也刷新一遍：QQ 桥接每次唤醒读的就是这份 people.json
          const card = exportPeopleCard(arch.db, { home: cfg.home })
          const st = r.stats || {}
          const summary = [
            `本地看板已生成：${r.path}`,
            `包含 ${r.chats} 个会话 / 最近 ${r.reportDays} 天共 ${r.reports} 份群日报${r.latestReportDay ? `（最新 ${r.latestReportDay}）` : '（最近 7 天还没有日报）'} / ${r.nodes} 个关系节点，${Math.max(1, Math.round(r.bytes / 1024))} KB。`,
            `新增栏目：链接 ${r.links} 条（${r.linkDomains} 个域名）、名场面 ${r.highlights} 条、周/月报 ${r.periods} 份。`,
            `这次增量：重算 ${st.rebuiltChats || 0} 个会话、${st.rebuiltProfiles || 0} 份档案，复用 ${st.reusedChats || 0} 个会话、${st.reusedProfiles || 0} 份档案，用时 ${st.ms || 0} ms。`,
            r.publish === 'inplace' ? '注意：dashboard.html 正被别的进程占用，这次是原地覆盖写入（内容是新的，只是少了原子替换）。' : '',
            `熟人卡已同步：${card.chats} 个会话 / ${card.people} 人（${card.path}），QQ 那边下次唤醒就会读到。`,
            '双击这个 HTML 就能打开：群总结（日报 + 周报/月报）、日历、资源库、群梗考古、名场面、探案板（@ 关系，可按周切时间）、榜单、群友档案、收藏夹、最近档案。',
            '日历点某天、群梗搜词、关系图切范围这类要现查的，需要在 DSH 里打开（走 /qq-archive/api）；离线打开时这些位置会提示。',
            '收藏和批注存在浏览器 localStorage，点「导出存档」才会落成文件——那才是永久档。',
          ].join('\n')
          return {
            ok: true,
            summary,
            path: r.path,
            bytes: r.bytes,
            chats: r.chats,
            reports: r.reports,
            reportDays: r.reportDays,
            latestReportDay: r.latestReportDay,
            nodes: r.nodes,
            people: r.people,
            peopleByChat: r.peopleByChat,
            links: r.links,
            linkDomains: r.linkDomains,
            highlights: r.highlights,
            periods: r.periods,
            date: r.date,
            stats: st,
            peopleCard: card,
          }
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
          // 旧库已经删了，快照里的人和群都不能再信
          board.invalidate()
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
