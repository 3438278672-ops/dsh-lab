import { chatNameMap, fmtChat, fmtTime, resolveChatKey } from '../lib/format.mjs'
import { investigateTopic, topWords } from '../lib/topics.mjs'
import { clampInt, parseWhen, parseWhenEnd, truncate } from '../lib/util.mjs'

/** qq_topic 工具：只放 schema 和 handler；运行时依赖由 rt 注入。 */
export default (rt) => ({
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
})
