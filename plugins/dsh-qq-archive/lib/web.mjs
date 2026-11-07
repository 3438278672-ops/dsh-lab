// DSH 网页入口：侧栏点「群聊档案馆」直接在对话区打开看板。
// Host 这边挂一个只读的静态前缀 /qq-archive，把 home 目录下的 dashboard.html
// 和 media/ 缓存的图片发给页面；看板不存在时先给一张「正在生成」的等待页，
// 后台建好再刷新，避免第一次打开白屏十几秒。
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { openArchive } from './db.mjs'
import { exportDashboard } from './dashboard.mjs'

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
// 看板超过这个时间就在后台重建一份，下次打开就是新的
const STALE_MS = 5 * 60 * 1000

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
 * @param {object} opts { home, log }
 */
export function registerArchiveWeb(ctx, { home, log = () => {} } = {}) {
  let building = null
  let lastBuild = 0

  const dashboardFile = () => join(home, 'dashboard.html')

  const build = () => {
    if (building) return building
    building = (async () => {
      const archive = openArchive(home)
      try {
        const out = exportDashboard(archive.db, { home })
        lastBuild = Date.now()
        log(`看板已重建：${out.path}（${Math.round(out.bytes / 1024)} KB）`)
        return out
      } finally {
        archive.db.close()
      }
    })()
      .catch((e) => {
        log(`看板重建失败：${e?.message || e}`)
        throw e
      })
      .finally(() => {
        building = null
      })
    return building
  }

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
            build().catch(() => {})
            return sendHtml(res, WAITING)
          }
          if (Date.now() - lastBuild > STALE_MS) build().catch(() => {})
          return sendFile(req, res, file)
        }

        // 看板里引用的本地图片 / 语音
        const m = rest.match(/^\/media\/(.+)$/)
        if (m) {
          const f = safeFile(join(home, 'media'), m[1])
          return f ? sendFile(req, res, f) : notFound(res)
        }

        return notFound(res)
      },
    }),
  )
}
