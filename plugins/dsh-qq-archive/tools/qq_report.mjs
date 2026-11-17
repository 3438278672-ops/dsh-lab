import { chatNameMap, resolveChatKey } from '../lib/format.mjs'
import { getLlm } from '../lib/llm.mjs'
import { PERIOD_FLOOR, listPeriodReports, periodBounds, readPeriodReport, runPeriodReport } from '../lib/period.mjs'
import { clampInt, truncate } from '../lib/util.mjs'

/** qq_report 工具：只放 schema 和 handler；运行时依赖由 rt 注入。 */
export default (rt) => ({
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
    output: 'TEXT_SUMMARY',
    async execute(args = {}) {
      const action = args.action || 'status'
      const kind = args.kind === 'month' ? 'month' : 'week'
      try {
        const arch = rt.ensureArchive()
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
        const llm = getLlm(rt.ctx)
        if (!llm) return { ok: false, error: 'DSH 的 llm 服务不可用，没法生成周报/月报' }
        const r = await runPeriodReport({
          db,
          llm,
          cfg: rt.cfg,
          kind,
          chatKey,
          ref,
          offset,
          force: Boolean(args.force),
        })
        if (r.saved) rt.board.prewarm()
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
})
