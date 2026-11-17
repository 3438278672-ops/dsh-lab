import { estimateHeight, htmlToPng, personCardHtml } from '../lib/card.mjs'
import { dbStats, listChats } from '../lib/db.mjs'
import { chatNameMap, fmtImpression, fmtTime, resolveChatKey } from '../lib/format.mjs'
import { generateImpression, readImpression } from '../lib/impression.mjs'
import { getLlm, listRoutes, pickRoute } from '../lib/llm.mjs'
import { buildProfile, findCandidates } from '../lib/people.mjs'
import { isoDate } from '../lib/util.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** qq_people 工具：只放 schema 和 handler；运行时依赖由 rt 注入。 */
export default (rt) => ({
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
    output: 'TEXT_SUMMARY',
    async execute(args = {}) {
      try {
        const who = String(args.who || '').trim()
        if (!who) return { ok: false, error: 'who 不能为空：填 QQ 号或昵称片段' }

        const arch = await rt.ensureIndexed()
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
          const llm = getLlm(rt.ctx)
          if (!llm) return { ok: false, error: 'DSH 的 llm 服务不可用，没法生成人物印象' }
          const route = pickRoute(await listRoutes(llm), rt.cfg.llm)
          if (!route) return { ok: false, error: 'DSH 里没有可用的模型，先在设置里启用一个 provider 再生成印象' }
          const r = await generateImpression({
            db,
            chatNames: names,
            userId: candidates[0].userId,
            chatKey,
            llm,
            route,
            sample: rt.cfg.impression.sample,
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
            : join(rt.cfg.home, `card-${profile.userId}-${chatKey.replace(/[^\d]/g, '')}.${format === 'png' ? 'png' : 'html'}`)
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
})
