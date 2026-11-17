import { contextAround, dbStats, listChats, searchMessages } from '../lib/db.mjs'
import { exportFind } from '../lib/findexport.mjs'
import { MODE_LABEL, chatNameMap, fmtChat, fmtLine, fmtTime, resolveChatKey, resolveSender } from '../lib/format.mjs'
import { messagesByIds, semanticSearch } from '../lib/semantic.mjs'
import { clampInt, parseWhen, parseWhenEnd } from '../lib/util.mjs'

/** qq_find 工具：只放 schema 和 handler；运行时依赖由 rt 注入。 */
export default (rt) => ({
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
    output: 'TEXT_SUMMARY',
    async execute(args = {}) {
      try {
        const arch = await rt.ensureIndexed()
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

        const limit = clampInt(args.limit, 1, rt.cfg.maxHits, 20)
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
            const ex = exportFind({ home: rt.cfg.home, result, format, outPath: args.out || undefined })
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
})
