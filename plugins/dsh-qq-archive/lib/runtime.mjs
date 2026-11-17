/**
 * 插件运行时：把 archive/source/board 的生命周期、同步、定时任务、推送收在一处。
 *
 * 从 index.js 下沉：index.js 只负责插件元信息 + apply 装配，
 * 工具模块通过 `rt`（本函数的返回值）拿运行期依赖，不再各自闭包 apply。
 */
import { mergeConfig } from './config.mjs'
import { dbStats, listChats, openArchive, setMeta } from './db.mjs'
import { buildProfile, findCandidates } from './people.mjs'
import { dueForDaily, isImpressionsRunning, readImpression, runImpressions } from './impression.mjs'
import { getLlm } from './llm.mjs'
import { openSource } from './adapters/index.mjs'
import { syncOnce, isSyncing } from './ingest.mjs'
import { downloadPending } from './media.mjs'
import { createBoard } from './board.mjs'
import { exportPeopleCard } from './peoplecard.mjs'
import { registerArchiveWeb } from './web.mjs'
import { dayBounds, dueForReport, markReportDay } from './report.mjs'
import { effectivePushSettings, pushReport, recordPushResult } from './push.mjs'
import { isoDate } from './util.mjs'
import { chatNameMap } from './format.mjs'
import { runReport } from './report-run.mjs'

/**
 * 建一份运行时。构造是同步的：只做装配，不启动定时器；定时器在 start() 里开。
 * @param {{ctx: object, config: object}} options
 */
export function createArchiveRuntime({ ctx, config }) {
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
   * 关掉并忘掉当前归档库（qq_archive action=reset 用）。
   * 文件删除由工具自己做；下次 ensureArchive() 会重新打开一个新库。
   */
  function resetArchive() {
    try {
      archive?.db?.close?.()
    } catch {
      /* 已经关了 */
    }
    archive = null
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
    // 同步成功就顺手刷一遍熟人卡：QQ 桥接每次唤醒读的就是 home/people.json
    refreshPeopleCard(arch)
    return result
  }

  /**
   * 刷新熟人卡（people.json）。桥接读的是这份文件，所以每次同步完都刷一次，
   * 手动 sync、定时同步、启动同步都会走到 doSync，这里一处就全覆盖了。
   * 写文件失败只记日志——档案库同步本身是成功的，不能因为熟人卡把同步搞挂。
   */
  function refreshPeopleCard(arch) {
    try {
      const card = exportPeopleCard(arch.db, { home: cfg.home })
      log.info?.(`熟人卡已刷新：${card.chats} 个会话 / ${card.people} 人`)
    } catch (e) {
      log.warn?.(`熟人卡刷新失败：${e.message}`)
    }
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

  /** 启动后台任务：先挂清理逻辑，再开定时器 + 预热一次。 */
  function start() {
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
  }

  return {
    ctx,
    cfg,
    log,
    board,
    ensureArchive,
    ensureSource,
    resetArchive,
    doSync,
    ensureIndexed,
    maybeDownloadMedia,
    maybeImpressions,
    deliverReports,
    /** 工具里生成日报时用：llm / db / cfg 由运行时补齐，调用方只传业务参数。 */
    runReport: (args = {}) => runReport({ llm: getLlm(ctx), db: ensureArchive().db, cfg, ...args }),
    start,
  }
}
