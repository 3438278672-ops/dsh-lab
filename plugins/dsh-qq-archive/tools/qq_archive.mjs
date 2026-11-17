import { dbStats, getMeta, listChats, setMeta } from '../lib/db.mjs'
import { exportViewer } from '../lib/export.mjs'
import { chatNameMap, fmtTime, resolveChatKey } from '../lib/format.mjs'
import { runImpressions } from '../lib/impression.mjs'
import { getLlm } from '../lib/llm.mjs'
import { downloadPending, mediaDir } from '../lib/media.mjs'
import { exportPeopleCard } from '../lib/peoplecard.mjs'
import { effectivePushSettings, pushReport, setPushSettings } from '../lib/push.mjs'
import { buildSemantic, semanticReady } from '../lib/semantic.mjs'
import { clampInt, isoDate, stamp } from '../lib/util.mjs'
import { pendingVoiceCount, transcribePending } from '../lib/voice.mjs'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** qq_archive 工具：只放 schema 和 handler；运行时依赖由 rt 注入。 */
export default (rt) => ({
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
    output: 'TEXT_SUMMARY',
    async execute(args = {}) {
      const action = args.action || 'status'
      try {
        const arch = rt.ensureArchive()
        if (action === 'status') {
          const stats = dbStats(arch.db)
          let src = null
          let srcError = null
          try {
            src = rt.ensureSource()
          } catch (e) {
            srcError = String(e?.message || e)
          }
          const lastSync = Number(getMeta(arch.db, 'last_sync_at', '0')) || 0
          const took = Number(getMeta(arch.db, 'last_sync_took_ms', '0')) || 0
          const mediaCached = arch.db.prepare("select count(*) as n from media where status = 'cached'").get().n
          const summary = [
            `数据源：${src ? `${src.kind} ${src.path || src.baseUrl || ''}` : `不可用（${srcError}）`}`,
            `索引：${stats.total} 条消息 / ${stats.chats} 个会话 / ${stats.members} 个成员 / ${stats.media} 个媒体`,
            `媒体缓存：${mediaCached} 个（${mediaDir(rt.cfg.home)}），待转写语音 ${pendingVoiceCount(arch.db)} 条`,
            `语义索引：${semanticReady(rt.cfg.home) ? '已建' : '未建（qq_archive action=semantic）'}`,
            `时间范围：${stats.total ? `${fmtTime(stats.fromTs)} ~ ${fmtTime(stats.toTs)}` : '空'}`,
            `上次同步：${lastSync ? `${fmtTime(lastSync)}（${Math.round(took / 1000)} 秒）` : '从未'}`,
            `日报定时：${rt.cfg.report?.schedule ? `${rt.cfg.report.schedule}（生成前一天的）` : '关（qq_archive action=report 手动生成）'}`,
            `上次日报：${getMeta(arch.db, 'last_report_day') || '从未'}`,
            `日报推送：${(() => {
              const p = effectivePushSettings(arch.db, rt.cfg)
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
          const llm = getLlm(rt.ctx)
          if (!llm) return { ok: false, error: 'DSH 的 llm 服务不可用，没法生成人物印象' }
          const users = args.users ? String(args.users).split(/[,，\s]+/).filter(Boolean) : null
          const result = await runImpressions({
            db: arch.db,
            chatNames: chatNameMap(arch.db),
            llm,
            cfg: rt.cfg,
            userIds: users,
            minMsgs: clampInt(args.minMsgs, 1, 100000, rt.cfg.impression.minMsgs),
            limit: clampInt(args.limit, 1, 200, rt.cfg.impression.limit),
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
          const r = await downloadPending(rt.ensureArchive(), {
            kinds,
            limit: clampInt(args.limit, 1, 500, 50),
            maxCount: rt.cfg.media?.maxCount ?? 2000,
          })
          const summary = [
            `媒体缓存：新增 ${r.cached} 个，失效 ${r.dead} 个${r.reason ? `（${r.reason}）` : ''}，合计 ${(r.bytes / 1024 / 1024).toFixed(1)} MB。`,
            `目录：${mediaDir(rt.cfg.home)}`,
            '（QQ 的图片/语音链接带时效，只有同步之后新到的能下；历史媒体会标记失效，不反复重试。）',
            ...r.failed.slice(0, 5).map((f) => `- ${f.kind} ${f.sourceKey}：${f.error}`),
          ].join('\n')
          return { ok: true, summary, ...r, dir: mediaDir(rt.cfg.home) }
        }

        if (action === 'report') {
          const llm = getLlm(rt.ctx)
          if (!llm) return { ok: false, error: 'DSH 的 llm 服务不可用，没法生成日报' }
          let chatKey = null
          if (args.chat) {
            chatKey = resolveChatKey(arch.db, args.chat)
            if (!chatKey) return { ok: false, error: `没找到会话：${args.chat}（可以先 qq_archive action=chats 看看有哪些）` }
          }
          const r = await rt.runReport({
            llm,
            db: arch.db,
            cfg: rt.cfg,
            day: args.day || 'today',
            chatKey,
            force: Boolean(args.force),
            maxChats: clampInt(args.limit, 1, 50, 12),
          })
          const ok = r.results.filter((x) => x.text)
          const bad = r.results.filter((x) => x.error)
          const pushed = await rt.deliverReports(arch.db, r, { date: r.bounds.day })
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
          const eff = effectivePushSettings(arch.db, rt.cfg)
          let testResult = null
          if (args.test) {
            testResult = await pushReport(rt.cfg, {
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
          const r = await rt.board.build({
            force: true,
            outPath: args.out || undefined,
            title: args.title || '群聊档案馆',
          })
          // 顺手把「熟人卡」也刷新一遍：QQ 桥接每次唤醒读的就是这份 people.json
          const card = exportPeopleCard(arch.db, { home: rt.cfg.home })
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
          const r = exportViewer(arch.db, { home: rt.cfg.home, title: args.title, outPath: args.out || undefined })
          const summary = [
            `已生成浏览页：${r.path}`,
            `包含 ${r.chats} 个会话 / ${r.messages} 条消息 / ${r.profiles} 份人物印象，${(r.bytes / 1024 / 1024).toFixed(1)} MB。`,
            '双击这个 HTML 就能看（图片走同目录 media/，没缓存的图显示占位）。',
          ].join('\n')
          return { ok: true, summary, ...r }
        }

        if (action === 'voice') {
          const arch2 = rt.ensureArchive()
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
          const ready = semanticReady(rt.cfg.home)
          if (ready && !args.rebuild) {
            return {
              ok: true,
              summary: `语义索引已存在：${join(rt.cfg.home, 'semantic')}\n要重建就传 rebuild: true（CPU 上 3 万条约几分钟）。\n用 qq_find semantic: true 走语义检索。`,
              ready: true,
              dir: join(rt.cfg.home, 'semantic'),
            }
          }
          const r = await buildSemantic(rt.ensureArchive(), { onProgress: (line) => rt.log.info?.(`语义索引：${line}`) })
          return {
            ok: true,
            summary: `语义索引建好了：${r.count} 条，${r.dim} 维。\n目录：${join(rt.cfg.home, 'semantic')}\n用 qq_find semantic: true 走语义检索。`,
            ...r,
          }
        }

        if (action === 'sync') {
          const full = Boolean(args.full) || dbStats(arch.db).total === 0
          const result = await rt.doSync({ full })
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
          rt.resetArchive()
          for (const suffix of ['', '-wal', '-shm']) {
            try {
              unlinkSync(join(rt.cfg.home, 'archive.db' + suffix))
            } catch {
              /* 文件不存在就算了 */
            }
          }
          const fresh = rt.ensureArchive()
          // 旧库已经删了，快照里的人和群都不能再信
          rt.board.invalidate()
          const result = await rt.doSync({ full: true })
          const stats = dbStats(fresh.db)
          return { ok: true, summary: `已重建索引：${stats.total} 条消息 / ${stats.chats} 个会话，用时 ${Math.round(result.tookMs / 1000)} 秒。`, result, stats }
        }

        return { ok: false, error: `未知 action：${action}` }
      } catch (e) {
        return { ok: false, error: String(e?.message || e) }
      }
    },
})
