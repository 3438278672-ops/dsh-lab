// DSH 网页入口：侧栏点「灵感账本」，直接在对话区打开灵感墙。
// Host 这边挂 /idea-log 前缀：首页给 HTML，底下 /api/* 是给页面用的 JSON 接口。
import { openIdeas, addIdea, listIdeas, updateIdea, ideaStats } from './db.mjs'
import { renderPage } from './page.mjs'
import { buildStartPrompt } from './start.mjs'

const BASE = '/idea-log'

function sendJson(res, value, code = 200) {
  const body = JSON.stringify(value)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
}

async function readJson(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const t = Buffer.concat(chunks).toString('utf8').trim()
  if (!t) return {}
  return JSON.parse(t)
}

/**
 * 挂上 /idea-log/ 网页入口。返回 disposer。
 * @param {object} ctx DSH 插件上下文（需要 webServer 服务）
 * @param {object} opts { home, log }
 */
export function registerIdeaWeb(ctx, { home, log = () => {} } = {}) {
  return ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: BASE,
      async handler(req, res) {
        // 只接受同源请求：别的网页不能拿这个前缀读/改灵感账本
        const origin = req.headers.origin
        if (origin) {
          let same = false
          try {
            same = new URL(origin).host === req.headers.host
          } catch {}
          if (!same) {
            res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
            return res.end('forbidden')
          }
        }

        let pathname = '/'
        let search = new URLSearchParams()
        try {
          const url = new URL(req.url || '/', 'http://x')
          pathname = decodeURIComponent(url.pathname.slice(BASE.length)) || '/'
          search = url.searchParams
        } catch {
          return notFound(res)
        }

        const isGet = req.method === 'GET' || req.method === 'HEAD'
        let archive = null
        try {
          archive = openIdeas(home)
          const db = archive.db

          if (isGet && (pathname === '/' || pathname === '/index.html')) {
            const html = renderPage({})
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            return res.end(html)
          }

          if (isGet && pathname === '/api/list') {
            const items = listIdeas(db, {
              kind: search.get('kind') || null,
              status: search.get('status') || null,
              q: search.get('q') || '',
              limit: Number(search.get('limit')) || 200,
            }).map((it) => ({ ...it, startPrompt: buildStartPrompt(it) }))
            return sendJson(res, { items, stats: ideaStats(db) })
          }

          if (isGet && pathname === '/api/stats') return sendJson(res, ideaStats(db))

          if (req.method === 'POST' && pathname === '/api/update') {
            const body = await readJson(req)
            const row = updateIdea(db, body)
            return sendJson(res, { ok: true, item: row })
          }

          if (req.method === 'POST' && pathname === '/api/add') {
            const body = await readJson(req)
            const r = addIdea(db, body)
            return sendJson(res, { ok: true, duplicate: r.duplicate, item: r.row })
          }

          return notFound(res)
        } catch (e) {
          log(`idea-log web: ${e?.message || e}`)
          return sendJson(res, { error: e?.message || String(e) }, 500)
        } finally {
          try {
            archive?.db.close()
          } catch {}
        }
      },
    }),
  )
}
