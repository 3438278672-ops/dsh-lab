// dsh-fish-paint · 本机控制口（悬浮球面板用）
//
// 端口默认 31878，只听 127.0.0.1。读端点随便看；写端点必须带 X-Control-Token
// （令牌在 ~/.dsh/dsh-services/fish-paint.token，和 dsh-gpu-queue 的约定一致）。
//
// 端点：
//   GET  /paint/ping           存活探测
//   GET  /paint.json           面板快照（暂停 / 限流 / worker / 在飞 / GPU 队列）
//   POST /paint/pause?on=1|0   暂停接新点图（已经在画的那张照常画完）
//   POST /paint/yield          让位给唱歌：没在画就停掉常驻 worker 释放显存
//   POST /paint/abort          中止：杀掉 worker（连带 serial 链上排队的图）
import { createServer } from 'node:http'
import path from 'node:path'
import { listCooldowns } from './ratelimit.js'
import { ensureToken, statusPath, tokensMatch, writeStatus } from './services.js'

const SERVICE = 'fish-paint'

export function startControlServer(cfg, deps) {
  const { engine, pauseStore, activity, gpu, abortState, log } = deps
  const now = deps.now ?? Date.now
  const startedAt = now()
  const servicesDir = cfg.servicesDir
  const tokenFile = path.join(servicesDir, `${SERVICE}.token`)
  let token = ''

  try {
    token = ensureToken(servicesDir, SERVICE)
  } catch (error) {
    log(`控制口令牌写不进去（${tokenFile}）：${error.message}`)
  }

  const cooldownFile = path.join(cfg.dataDir, 'state', 'draw-cooldown.json')
  const windowMs = Number(cfg.drawCooldownMinutes) > 0 ? Number(cfg.drawCooldownMinutes) * 60_000 : 0

  function status(extra = {}) {
    writeStatus(servicesDir, SERVICE, {
      service: SERVICE,
      port: server.address()?.port ?? cfg.controlPort,
      pid: process.pid,
      startedAt,
      updatedAt: now(),
      tokenFile,
      ...extra,
    })
  }

  async function safeStatus() {
    try {
      return await engine.status()
    } catch (error) {
      return { error: { code: error?.code || 'STATUS_FAILED', message: String(error?.message || error) } }
    }
  }

  async function snapshot() {
    const pause = pauseStore.read()
    const workerStatus = await safeStatus()
    const queue = await gpu.snapshot()
    return {
      ok: true,
      now: now(),
      startedAt,
      service: SERVICE,
      port: server.address()?.port ?? cfg.controlPort,
      paused: pause.paused,
      pausedAt: pause.updatedAt,
      pausedBy: pause.updatedBy,
      limits: {
        cooldownMinutes: cfg.drawCooldownMinutes,
        cooldownMax: cfg.drawCooldownMax,
        vipList: cfg.vipList,
        stateFile: cooldownFile,
      },
      cooldowns: safeCooldowns(),
      inFlight: activity.list(),
      worker: {
        running: Boolean(workerStatus?.running),
        ready: Boolean(workerStatus?.ready),
        pid: workerStatus?.pid ?? null,
        modelKey: workerStatus?.modelKey ?? null,
        vramMode: workerStatus?.vramMode ?? cfg.vramMode,
        note: workerStatus?.note ?? '',
        error: workerStatus?.error ?? null,
        vram: workerStatus?.worker?.gpu ?? null,
      },
      queue: {
        ok: queue?.ok !== false,
        holder: queue?.holder ?? null,
        queue: Array.isArray(queue?.queue) ? queue.queue : [],
        recent: Array.isArray(queue?.recent) ? queue.recent : [],
        error: queue?.ok === false ? queue.error ?? null : null,
      },
    }
  }

  function safeCooldowns() {
    try {
      return listCooldowns({
        file: cooldownFile,
        windowMs,
        max: cfg.drawCooldownMax,
        now: now(),
      })
    } catch (error) {
      log(`读限流状态失败：${error.message}`)
      return []
    }
  }

  async function pauseTo(on, by) {
    const value = pauseStore.write(on, by)
    return { ok: true, paused: value.paused, updatedAt: value.updatedAt, updatedBy: value.updatedBy, now: now() }
  }

  async function yieldWorker() {
    const drawing = activity.list().filter((item) => item.phase === 'drawing')
    if (drawing.length > 0) {
      return {
        status: 409,
        body: {
          ok: false,
          reason: 'drawing',
          message: `正在画 ${drawing.length} 张，等这张画完再让位`,
          inFlight: drawing,
          now: now(),
        },
      }
    }
    let result = { alreadyStopped: true }
    try {
      result = await engine.shutdown('让位给唱歌')
    } catch (error) {
      return { status: 500, body: { ok: false, reason: 'shutdown-failed', message: String(error?.message || error), now: now() } }
    }
    const stopped = result?.alreadyStopped === false
    if (stopped) log('为唱歌让位：已停掉 SDXL worker 释放显存')
    return {
      status: 200,
      body: { ok: true, yielded: stopped, workerStopped: stopped, reason: stopped ? 'stopped' : 'already-idle', now: now() },
    }
  }

  async function abortAll() {
    const targets = activity.list()
    if (abortState) abortState.at = now()
    let result = { alreadyStopped: true }
    try {
      result = await engine.shutdown('面板中止')
    } catch (error) {
      return {
        status: 500,
        body: { ok: false, reason: 'shutdown-failed', message: String(error?.message || error), now: now() },
      }
    }
    const stopped = result?.alreadyStopped === false
    if (stopped) log(`面板中止：杀掉 worker（在飞 ${targets.length} 个请求会回 ABORTED）`)
    return {
      status: 200,
      body: {
        ok: true,
        aborted: targets.map((item) => item.jobId),
        workerStopped: stopped,
        reason: stopped ? 'stopped' : 'already-idle',
        now: now(),
      },
    }
  }

  function send(response, statusCode, body) {
    const text = `${JSON.stringify(body)}\n`
    response.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-control-token, x-control-by',
    })
    response.end(text)
  }

  function checkToken(request) {
    const provided = request.headers['x-control-token']
    if (!token) return { ok: false, message: '控制口没有令牌文件，先看插件日志' }
    if (!tokensMatch(token, Array.isArray(provided) ? provided[0] : provided)) {
      return { ok: false, message: '令牌不对' }
    }
    return { ok: true }
  }

  // HTTP 头只能是 latin1，中文名字必须 encodeURIComponent 传过来；实在没有就用「悬浮球」。
  function readBy(request, url) {
    const raw = request.headers['x-control-by'] ?? url.searchParams.get('by') ?? ''
    const text = String(Array.isArray(raw) ? raw[0] : raw)
    let decoded = text
    try {
      decoded = decodeURIComponent(text)
    } catch {
      decoded = text
    }
    return decoded.replace(/[\r\n\t]/g, ' ').trim().slice(0, 40) || '悬浮球'
  }

  const server = createServer(async (request, response) => {
    let url
    try {
      url = new URL(request.url ?? '/', `http://127.0.0.1:${cfg.controlPort}`)
    } catch {
      send(response, 400, { ok: false, error: { code: 'BAD_URL', message: '请求地址看不懂' } })
      return
    }
    const route = url.pathname.replace(/\/+$/, '') || '/'

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-control-token, x-control-by',
        'access-control-max-age': '600',
      })
      response.end()
      return
    }

    try {
      if (request.method === 'GET' && (route === '/paint/ping' || route === '/paint/ping/')) {
        send(response, 200, { ok: true, service: SERVICE, now: now() })
        return
      }

      if (request.method === 'GET' && (route === '/paint.json' || route === '/paint')) {
        send(response, 200, await snapshot())
        return
      }

      if (request.method !== 'POST') {
        send(response, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '只支持 GET / POST' } })
        return
      }

      const auth = checkToken(request)
      if (!auth.ok) {
        send(response, 403, { ok: false, error: { code: 'FORBIDDEN', message: auth.message } })
        return
      }

      const by = readBy(request, url)

      if (route === '/paint/pause') {
        const raw = String(url.searchParams.get('on') ?? '').trim().toLowerCase()
        const on = ['1', 'true', 'on', 'yes'].includes(raw)
        send(response, 200, await pauseTo(on, by))
        return
      }

      if (route === '/paint/yield') {
        const result = await yieldWorker()
        send(response, result.status, result.body)
        return
      }

      if (route === '/paint/abort') {
        const result = await abortAll()
        send(response, result.status, result.body)
        return
      }

      send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: `没有这个端点：${route}` } })
    } catch (error) {
      log(`控制口处理 ${route} 出错：${error?.message || error}`)
      send(response, 500, {
        ok: false,
        error: { code: error?.code || 'INTERNAL', message: String(error?.message || error) },
      })
    }
  })

  server.on('error', (error) => {
    log(`控制口起不来（127.0.0.1:${cfg.controlPort}）：${error.code || error.message}`)
    status({ error: { code: error.code || 'LISTEN_FAILED', message: String(error.message || error) } })
  })

  server.listen(cfg.controlPort, cfg.controlBind, () => {
    const port = server.address()?.port ?? cfg.controlPort
    log(`控制口在 http://127.0.0.1:${port} 等活儿（令牌 ${tokenFile}）`)
    status()
  })

  function dispose() {
    return new Promise((resolve) => {
      try {
        status({ stoppedAt: now() })
      } catch {
        // 忽略
      }
      try {
        server.close(() => resolve(true))
      } catch {
        resolve(false)
      }
      setTimeout(() => resolve(false), 1000).unref?.()
    })
  }

  return {
    server,
    token,
    tokenFile,
    statusFile: statusPath(servicesDir, SERVICE),
    port: () => server.address()?.port ?? null,
    snapshot,
    dispose,
  }
}
