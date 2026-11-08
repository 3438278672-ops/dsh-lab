// DSH 网页入口：侧栏点「群聊档案馆」直接在对话区打开看板。
// Host 这边挂一个只读的静态前缀 /qq-archive，把 home 目录下的 dashboard.html
// 和 media/ 缓存的图片发给页面。
//
// 什么时候重建不靠计时器：每次请求先让 board 比对数据库指纹（~3 ms），对得上
// 就直接发旧文件；对不上才在后台增量重建，这一屏仍然先给旧的，下次刷新就是新的。
// 只有 dashboard.html 还不存在时才给「正在生成」等待页。
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { estimateHeight, personCardHtml, htmlToPng } from './card.mjs'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.amr': 'audio/amr',
  '.silk': 'audio/silk',
  '.txt': 'text/plain; charset=utf-8',
}

const BASE = '/qq-archive'

const WAITING = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="3">
<title>群聊档案馆 · 正在整理</title>
<style>
  html,body{height:100%;margin:0;background:#0e0d0c;color:#ece2cf;
    font-family:"Noto Serif SC","Songti SC",serif;display:grid;place-items:center}
  .box{text-align:center;max-width:440px;padding:0 24px}
  .kicker{font:600 11px/1.4 ui-monospace,monospace;letter-spacing:.24em;color:#9a8c75;text-transform:uppercase}
  h1{font-size:30px;font-weight:600;letter-spacing:.06em;margin:18px 0 10px}
  p{font-size:13.5px;line-height:1.9;color:#9a8c75;margin:0}
  .dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:#d4a04a;margin-right:7px;
    animation:pulse 1.2s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}
</style></head><body><div class="box">
  <div class="kicker">QQ · ARCHIVE</div>
  <h1>正在整理档案</h1>
  <p><span class="dot"></span>第一次打开要把消息、日报和关系网装订成册，大约几秒。</p>
</div></body></html>`

function sendFile(req, res, file) {
  let st
  try {
    st = statSync(file)
  } catch {
    return notFound(res)
  }
  if (!st.isFile()) return notFound(res)
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': st.size,
    'cache-control': 'no-cache',
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

function sendHtml(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
}

// 只允许读 home 目录底下的文件
function safeFile(root, rel) {
  const base = normalize(root)
  const p = normalize(join(base, rel))
  if (p !== base && !p.startsWith(base + sep)) return null
  try {
    return statSync(p).isFile() ? p : null
  } catch {
    return null
  }
}

/**
 * 挂上 /qq-archive/ 网页入口。返回 disposer。
 * @param {object} ctx DSH 插件上下文（需要 webServer 服务）
 * @param {object} opts { home, log, board }
 *   board 由 index.js 创建并在同步 / 日报 / 印象写库后预热，网页这边只是问它
 *   「现在这份还算新吗」。
 */
export function registerArchiveWeb(ctx, { home, log = () => {}, board, profileFor, lookupInChat } = {}) {
  const dashboardFile = () => join(home, 'dashboard.html')

  if (!board) log('看板构建器没接进来：网页只读旧文件，不会重建')

  // 卡片渲染一次要 2~3 秒，同一个人短时间内重复查直接给上次的图
  const cardCache = new Map()
  const CARD_TTL = 5 * 60 * 1000

  // 每个请求问一次：库变了就后台补一份，这一屏先吃旧的
  const kick = () => {
    if (!board) return
    try {
      board.ensureFresh()
    } catch (e) {
      log(`看板检查失败（继续用旧文件）：${e?.message || e}`)
    }
  }

  // /card?chat=group:123&user=456 或 &who=昵称 → 一张 PNG 档案卡
  const serveCard = async (req, res) => {
    if (!profileFor) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('档案卡还没接上数据库')
    }
    let chat = ''
    let user = ''
    let who = ''
    try {
      const u = new URL(req.url || '/', 'http://x')
      chat = u.searchParams.get('chat') || ''
      user = (u.searchParams.get('user') || '').trim()
      who = (u.searchParams.get('who') || '').trim()
    } catch {
      return notFound(res)
    }
    // 会话 key 就是隔离边界：group/private + 数字，别的一律不认
    if (!/^(?:group|private):\d+$/.test(chat)) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('chat 不合法')
    }

    // 传的是昵称：只在这个会话里找人，找不到就 404，找到多个把候选带回去
    if (!user && who) {
      let list = []
      try {
        list = (lookupInChat ? lookupInChat(chat, who) : []) || []
      } catch (e) {
        log(`查人失败：${e?.message || e}`)
      }
      if (!list.length) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ error: '这个人在本群没有发言记录' }))
      }
      if (list.length > 1) {
        res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(
          JSON.stringify({
            ambiguity: true,
            candidates: list.slice(0, 8).map((c) => ({
              userId: c.userId,
              names: (c.names || []).slice(0, 2),
              msgCount: c.msgCount,
            })),
          }),
        )
      }
      user = String(list[0].userId)
    }

    if (!/^\d{4,12}$/.test(user)) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('user / who 至少给一个')
    }
    const key = `${chat}|${user}`
    const hit = cardCache.get(key)
    if (hit && Date.now() - hit.at < CARD_TTL) {
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': hit.png.length,
        'cache-control': 'no-cache',
      })
      return res.end(hit.png)
    }

    let data
    try {
      data = profileFor(chat, user)
    } catch (e) {
      log(`读档案失败：${e?.message || e}`)
      data = null
    }
    if (!data) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('这个人在这个会话里没有档案')
    }

    try {
      const html = personCardHtml(data.profile, data.meta || {})
      const png = htmlToPng(html, { height: estimateHeight(data.profile) })
      cardCache.set(key, { at: Date.now(), png })
      if (cardCache.size > 40) cardCache.delete(cardCache.keys().next().value)
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': png.length,
        'cache-control': 'no-cache',
      })
      res.end(png)
    } catch (e) {
      log(`档案卡渲染失败：${e?.message || e}`)
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`渲染失败：${e?.message || 'unknown'}`)
    }
  }

  // DSH 每次重启端口都可能变。把「现在从哪个地址能访问到这份档案」写到
  // home/endpoint.json，桥接那边（qq_person_card）读它就不会再拿过期端口去 fetch。
  // getOrigin() 在 listen 绑定之前会 throw，所以失败就隔一会儿再试。
  const publishEndpoint = (tries = 0) => {
    let origin = ''
    try {
      origin = ctx.webServer.getOrigin()
    } catch {
      if (tries < 20) setTimeout(() => publishEndpoint(tries + 1), 500).unref?.()
      return
    }
    try {
      writeFileSync(
        join(home, 'endpoint.json'),
        JSON.stringify({ origin, updatedAt: new Date().toISOString() }),
        'utf8',
      )
    } catch {
      // 写不进去也不影响网页本身，桥接那边会退回旧的 baseUrl
    }
  }
  publishEndpoint()

  return ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: BASE,
      handler(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res)
        // 只接受同源请求：别的网页不能拿这个前缀读群聊
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
        let rest = '/'
        try {
          const url = new URL(req.url || '/', 'http://x')
          rest = decodeURIComponent(url.pathname.slice(BASE.length)) || '/'
        } catch {
          return notFound(res)
        }

        // 看板首页
        if (rest === '/' || rest === '/index.html') {
          const file = dashboardFile()
          if (!existsSync(file)) {
            // 第一次：先给等待页，后台慢慢装订
            kick()
            return sendHtml(res, WAITING)
          }
          kick()
          return sendFile(req, res, file)
        }

        // 看板里引用的本地图片 / 语音
        const m = rest.match(/^\/media\/(.+)$/)
        if (m) {
          const f = safeFile(join(home, 'media'), m[1])
          return f ? sendFile(req, res, f) : notFound(res)
        }

        // 档案卡：/qq-archive/card?chat=group:123&user=456 → PNG
        if (rest === '/card') {
          return serveCard(req, res)
        }

        return notFound(res)
      },
    }),
  )
}
