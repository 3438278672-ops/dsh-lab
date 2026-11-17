import { chatNameMap, fmtTime, resolveChatKey } from '../lib/format.mjs'
import { listHighlights, readHighlight, runHighlights } from '../lib/highlights.mjs'
import { getLlm } from '../lib/llm.mjs'
import { clampInt, parseWhen, parseWhenEnd, truncate } from '../lib/util.mjs'

/** qq_highlights 工具：只放 schema 和 handler；运行时依赖由 rt 注入。 */
export default (rt) => ({
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
      output: 'TEXT_SUMMARY',
      async execute(args = {}) {
        try {
          const arch = await rt.ensureIndexed()
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
            const llm = getLlm(rt.ctx)
            if (!llm) return { ok: false, error: 'DSH 的 llm 服务不可用，没法生成名场面摘要' }
            const fromTs = args.from ? parseWhen(args.from) || 0 : 0
            const toTs = args.to ? parseWhenEnd(args.to) || 0 : 0
            const r = await runHighlights({
              db,
              llm,
              cfg: rt.cfg,
              fromTs,
              toTs,
              limit: clampInt(args.limit, 1, 100, 12),
              force: Boolean(args.force),
              chatKey,
            })
            rt.board.prewarm()
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
})
