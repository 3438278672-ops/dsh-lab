/**
 * 群聊日报生成循环（每个群一份 + 全群汇总一份）。
 *
 * 从 index.js 下沉：定时任务和 qq_report / qq_archive 工具共用同一份实现。
 * 只是「生成并写库」，推送和定时由调用方（runtime / 工具）负责。
 */
import { buildReport, buildReportPrompt, dayBounds, readReport, REPORT_SYSTEM, saveReport } from './report.mjs'
import { generateText, listRoutes, pickRoute } from './llm.mjs'

/**
 * 生成一天的群聊日报。已有同一天同一会话的日报就跳过，force=true 重刷。
 * @returns {{bounds: object, route: object|null, results: object[], done: number, skipped: number, failed: number}}
 */
export async function runReport({ llm, db, cfg, day, chatKey, force, maxChats = 12 }) {
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
