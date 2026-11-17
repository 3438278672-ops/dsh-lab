import { chatNameMap, fmtChat, fmtTime, resolveChatKey } from '../lib/format.mjs'
import { buildLinkIndex, filterLinks, linksMarkdown } from '../lib/links.mjs'
import { clampInt, parseWhen, parseWhenEnd, truncate } from '../lib/util.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** qq_links 工具：只放 schema 和 handler；运行时依赖由 rt 注入。 */
export default (rt) => ({
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
          const limit = clampInt(args.limit, 1, 2000, 200)
          // 先全量聚合（域名统计才有意义），返回条数再截
          const index = buildLinkIndex(db, { chatKey, fromTs, toTs, limit: 4000 })

          if (args.action === 'export') {
            const md = linksMarkdown(index, { title: '群链接资源库', limit })
            const outPath = args.out ? String(args.out) : join(rt.cfg.home, 'links.md')
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
})
