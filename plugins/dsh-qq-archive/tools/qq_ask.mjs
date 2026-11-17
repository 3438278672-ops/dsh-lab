import { askArchive } from '../lib/ask.mjs'
import { fmtTime, resolveChatKey } from '../lib/format.mjs'
import { getLlm } from '../lib/llm.mjs'
import { clampInt, parseWhen, parseWhenEnd, truncate } from '../lib/util.mjs'

/** qq_ask 工具：只放 schema 和 handler；运行时依赖由 rt 注入。 */
export default (rt) => ({
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
    output: 'TEXT_SUMMARY',
    async execute(args = {}) {
      try {
        const question = String(args.question || '').trim()
        if (!question) return { ok: false, error: 'question 不能为空' }
        const arch = await rt.ensureIndexed()
        const llm = getLlm(rt.ctx)
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
          cfg: rt.cfg,
          question,
          chatKey,
          fromTs,
          toTs,
          k: clampInt(args.limit, 5, 200, 60),
          home: rt.cfg.home,
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
})
