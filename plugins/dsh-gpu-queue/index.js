/**
 * dsh-gpu-queue · 一张显卡的发牌员
 *
 * 为什么要有它：本机 8GB 的 3070 上，常驻着 GPT-SoVITS（约 2GB）和一个 SDXL worker
 * （offload 模式 1024² 一张要 reserved 约 7.9GB），唱歌的 UVR5 分离 + RVC 翻唱又要 2~3GB。
 * 两者撞上必炸。以前只有一个只被翻唱用的文件锁（<GSV>/rvc/gpulock.py），画画完全不参与；
 * 现在把「画一张 / 翻唱一段 / 合成一句」统一成领令牌，同一时刻只有一个重活占卡。
 *
 * 对外（全部 127.0.0.1）：
 *   POST /gpu/acquire   {kind,label,ownerPid}   领令牌（拿不到就排队）
 *   GET  /gpu/ticket?id=<id>                    轮询自己的位置
 *   POST /gpu/heartbeat {id}                    持有者心跳
 *   POST /gpu/release   {id}                    释放
 *   POST /gpu/cancel    {id}                    撤销排队项（holder 由业务端中止）
 *   GET  /gpu/state                             面板/调试用快照
 *   GET  /gpu/ping
 *
 * 写端点都要 `x-control-token`（读 `~/.dsh/dsh-services/gpu-queue.token`）。
 * 发 sing 令牌前先让 fish-paint 把常驻 SDXL worker 停掉（释放约 5~8GB），失败也照发，
 * 只把原因记进 holder.yieldWarning —— 宁可让歌先唱，也别让点歌静默失败。
 */
import { createServer } from 'node:http'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as core from './lib/queue-core.js'
import { ensureToken, expandHome, resolveServicesDir, tokensMatch, writeStatus } from './lib/services.js'

export const name = 'dsh-gpu-queue'

const ROOT = dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  port: 31879,
  bind: '127.0.0.1',
  dataDir: '',
  servicesDir: '',
  // holder 超过这么久没心跳就当它死了（正常客户端 15s 一次心跳）
  holderTtlMs: 60 * 1000,
  // 排队项超过这么久没人轮询就丢掉（正常客户端 1.5s 轮询一次）
  queueIdleDropMs: 90 * 1000,
  reapIntervalMs: 5000,
  // 让位总预算：发 sing 令牌前等 fish-paint 停 worker 的上限
  yieldTimeoutMs: 20 * 1000,
  // 谁需要为唱歌让出显存
  yieldTargets: {
    sing: [{ url: 'http://127.0.0.1:31878/paint/yield', tokenFile: '~/.dsh/dsh-services/fish-paint.token' }],
  },
}

function numberIn(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function mergeConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const pick = (key) => (raw[key] === undefined || raw[key] === null || raw[key] === '' ? undefined : raw[key])
  const targets = pick('yieldTargets')
  let singTargets = DEFAULTS.yieldTargets.sing
  if (targets && typeof targets === 'object' && Array.isArray(targets.sing)) {
    singTargets = targets.sing
      .map((item) => ({
        url: String(item?.url ?? '').trim(),
        tokenFile: String(item?.tokenFile ?? '').trim(),
        token: String(item?.token ?? '').trim(),
      }))
      .filter((item) => item.url)
  }
  return {
    port: numberIn(pick('port'), 1, 65535, DEFAULTS.port),
    bind: String(pick('bind') ?? DEFAULTS.bind),
    dataDir: String(pick('dataDir') ?? join(ROOT, 'data')),
    servicesDir: resolveServicesDir(pick('servicesDir')),
    holderTtlMs: numberIn(pick('holderTtlMs'), 1000, 30 * 60 * 1000, DEFAULTS.holderTtlMs),
    queueIdleDropMs: numberIn(pick('queueIdleDropMs'), 1000, 60 * 60 * 1000, DEFAULTS.queueIdleDropMs),
    reapIntervalMs: numberIn(pick('reapIntervalMs'), 100, 60 * 1000, DEFAULTS.reapIntervalMs),
    yieldTimeoutMs: numberIn(pick('yieldTimeoutMs'), 1000, 120 * 1000, DEFAULTS.yieldTimeoutMs),
    yieldTargets: { sing: singTargets },
  }
}

export function apply(ctx, config) {
  const cfg = mergeConfig(config)
  ctx.effect(() => startQueueService(cfg))
}

function defaultPidAlive(pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return true // 没报 pid 就当作活着，靠心跳兜底
  try {
    process.kill(n, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 起服务。返回 disposer（关服务、清定时器、落最后一次盘）。
 * deps 全是给测试用的注入点。
 */
export function startQueueService(cfg, deps = {}) {
  const clock = deps.now ?? Date.now
  const isPidAlive = deps.isPidAlive ?? defaultPidAlive
  const doFetch = deps.fetchImpl ?? globalThis.fetch
  const log = deps.log ?? ((message) => console.log(`[gpu-queue] ${message}`))
  const statePath = join(cfg.dataDir, 'state', 'queue.json')

  let state = core.createState()
  let token = ''
  let closed = false
  let pumping = null
  let saveTimer = null
  let saving = null
  let startedAt = clock()

  const ready = (async () => {
    await mkdir(dirname(statePath), { recursive: true }).catch(() => {})
    token = await ensureToken(cfg.servicesDir, 'gpu-queue').catch((error) => {
      log(`写令牌失败：${error.message}`)
      return ''
    })
    await load()
  })()

  async function load() {
    let raw = null
    try {
      raw = JSON.parse(String(await readFile(statePath, 'utf8')))
    } catch {
      return
    }
    if (!raw || typeof raw !== 'object') return
    state = {
      version: 1,
      seq: Number(raw.seq) || 0,
      holder: raw.holder ?? null,
      queue: Array.isArray(raw.queue) ? raw.queue : [],
      recent: Array.isArray(raw.recent) ? raw.recent : [],
    }
    const restored = core.restore(state, { now: clock(), isPidAlive })
    if (restored.length) log(`热重载恢复 ${restored.length} 个排队项`)
  }

  function scheduleSave() {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveNow().catch(() => {})
    }, 250)
    saveTimer.unref?.()
  }

  async function saveNow() {
    if (saving) return saving
    const task = (async () => {
      const payload = JSON.stringify({ ...state, savedAt: clock() }, null, 2)
      const tmp = `${statePath}.tmp-${process.pid}`
      try {
        await writeFile(tmp, payload, 'utf8')
        await rename(tmp, statePath)
      } catch (error) {
        log(`落盘失败：${error.message}`)
      }
    })()
    saving = task
    try {
      return await task
    } finally {
      if (saving === task) saving = null
    }
  }

  function reapOnce() {
    const outcome = core.reap(state, {
      now: clock(),
      isPidAlive,
      holderTtlMs: cfg.holderTtlMs,
      queueIdleDropMs: cfg.queueIdleDropMs,
    })
    const changed = Boolean(outcome.holderReleased) || outcome.dropped.length > 0
    if (outcome.holderReleased) {
      log(`回收 holder ${outcome.holderReleased.id}（${outcome.holderReleased.how}）`)
    }
    if (changed) {
      scheduleSave()
      pump().catch(() => {})
    }
    return changed
  }

  /**
   * 从排队项里挑一个发牌；该让位就先让位。串行化，避免两条 acquire 同时发两张牌。
   *
   * 注意 pumping 的赋值顺序：必须先把 promise 存下来、再让函数体开始跑（用 Promise.resolve().then
   * 把体推到微任务里），否则「函数体同步跑完 → finally 置空 → 外层才赋值」会把 pumping 永久
   * 停在一个已完成的 promise 上，之后所有 pump 都变成空转（发不出牌）。
   */
  function pump() {
    if (pumping) return pumping
    const task = Promise.resolve()
      .then(runPump)
      .finally(() => {
        if (pumping === task) pumping = null
      })
    pumping = task
    return task
  }

  async function runPump() {
    while (!closed) {
      if (state.holder) return
      const candidate = core.peek(state)
      if (!candidate) return
      let warning = null
      if (candidate.kind === 'sing' && cfg.yieldTargets.sing.length) {
        warning = await yieldForSing()
        if (state.holder) return // 让位期间别人拿到了，这一轮先不发
      }
      const granted = core.grant(state, candidate.id, clock(), { yieldWarning: warning })
      if (!granted) continue
      await saveNow()
      if (warning) log(`让位未完全成功：${warning}`)
      return
    }
  }

  async function yieldForSing() {
    const failures = []
    for (const target of cfg.yieldTargets.sing) {
      const outcome = await yieldOne(target)
      if (!outcome.ok) failures.push(`${target.url} ${outcome.reason}`)
    }
    return failures.length ? failures.join('; ').slice(0, 200) : null
  }

  async function yieldOne(target) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.yieldTimeoutMs)
    try {
      const fileToken = target.tokenFile ? await readFileToken(target.tokenFile) : ''
      const headers = {}
      const sendToken = fileToken || target.token
      if (sendToken) headers['x-control-token'] = sendToken
      const response = await doFetch(target.url, { method: 'POST', headers, signal: controller.signal })
      const body = await response.json().catch(() => null)
      if (response.ok && body?.ok !== false) return { ok: true }
      return { ok: false, reason: body?.reason ?? `http ${response.status}` }
    } catch (error) {
      const reason = error?.name === 'AbortError' ? `让位超时（${Math.round(cfg.yieldTimeoutMs / 1000)}s）` : String(error?.message ?? error)
      return { ok: false, reason }
    } finally {
      clearTimeout(timer)
    }
  }

  async function readFileToken(file) {
    const path = expandHome(file)
    if (!path) return ''
    try {
      return String(await readFile(path, 'utf8')).trim()
    } catch {
      return ''
    }
  }

  function publicState() {
    const snap = core.snapshot(state)
    return {
      ok: true,
      now: clock(),
      startedAt,
      holder: snap.holder,
      queue: snap.queue,
      recent: snap.recent,
      config: {
        holderTtlMs: cfg.holderTtlMs,
        queueIdleDropMs: cfg.queueIdleDropMs,
        yieldTimeoutMs: cfg.yieldTimeoutMs,
      },
    }
  }

  function authorized(req) {
    if (!token) return false
    const header = req.headers['x-control-token'] ?? req.headers['authorization'] ?? ''
    const given = String(header).startsWith('Bearer ') ? String(header).slice(7) : String(header)
    return tokensMatch(token, given.trim())
  }

  function send(req, res, status, body) {
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-control-token, authorization',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    }
    if (status === 204) {
      res.writeHead(204, headers)
      res.end()
      return
    }
    res.writeHead(status, headers)
    res.end(JSON.stringify(body))
  }

  async function readBody(req, limit = 8192) {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) throw new Error('body too large')
      chunks.push(chunk)
    }
    if (!chunks.length) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new Error('invalid json body')
    }
  }

  async function handle(req, res) {
    await ready
    const url = new URL(req.url ?? '/', `http://${cfg.bind}:${cfg.port}`)
    const route = `${req.method} ${url.pathname}`

    if (req.method === 'OPTIONS') {
      send(req, res, 204, {})
      return
    }

    if (route === 'GET /gpu/ping') {
      send(req, res, 200, { ok: true, name: 'dsh-gpu-queue', port: cfg.port })
      return
    }

    if (route === 'GET /gpu/state') {
      send(req, res, 200, publicState())
      return
    }

    if (route === 'GET /gpu/ticket') {
      const id = String(url.searchParams.get('id') ?? '').trim()
      if (!id) {
        send(req, res, 400, { ok: false, error: 'missing id' })
        return
      }
      core.markPoll(state, id, clock())
      const ticket = core.ticketOf(state, id)
      send(req, res, 200, { ok: true, now: clock(), ...ticket })
      return
    }

    if (req.method === 'POST') {
      if (!authorized(req)) {
        send(req, res, 403, { ok: false, error: '需要 x-control-token' })
        return
      }
      if (route === 'POST /gpu/acquire') {
        const body = await readBody(req)
        const kind = String(body?.kind ?? '').trim()
        if (!core.KINDS.includes(kind)) {
          send(req, res, 400, { ok: false, error: `kind 只能是 ${core.KINDS.join(' / ')}` })
          return
        }
        const entry = core.enqueue(state, { kind, label: body?.label, ownerPid: body?.ownerPid, now: clock() })
        scheduleSave()
        // pump 里可能要等让位（最多 yieldTimeoutMs），别把 acquire 挂那么久：
        // 先等 800ms，拿不到就回 queued，让客户端自己轮询。
        await Promise.race([pump(), new Promise((resolve) => setTimeout(resolve, 800))])
        send(req, res, 200, { ok: true, now: clock(), ...core.ticketOf(state, entry.id) })
        return
      }
      if (route === 'POST /gpu/heartbeat') {
        const body = await readBody(req)
        const id = String(body?.id ?? '').trim()
        const alive = core.heartbeat(state, id, clock())
        scheduleSave()
        send(req, res, alive ? 200 : 409, { ok: alive, state: alive ? 'granted' : 'lost' })
        return
      }
      if (route === 'POST /gpu/release') {
        const body = await readBody(req)
        const id = String(body?.id ?? '').trim()
        const released = core.release(state, id, clock(), 'released')
        scheduleSave()
        pump().catch(() => {})
        send(req, res, 200, { ok: true, released })
        return
      }
      if (route === 'POST /gpu/cancel') {
        const body = await readBody(req)
        const id = String(body?.id ?? '').trim()
        const cancelled = core.cancel(state, id, clock())
        scheduleSave()
        pump().catch(() => {})
        send(req, res, cancelled ? 200 : 404, { ok: cancelled, cancelled })
        return
      }
    }

    send(req, res, 404, { ok: false, error: `no route: ${route}` })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) send(req, res, 500, { ok: false, error: String(error?.message ?? error) })
      else res.end()
    })
  })

  server.on('error', (error) => {
    log(`监听 ${cfg.bind}:${cfg.port} 失败：${error.code ?? error.message}`)
    writeStatus(cfg.servicesDir, 'gpu-queue', {
      ok: false,
      port: cfg.port,
      error: error.code ?? String(error.message ?? error),
    }).catch(() => {})
  })

  server.listen(cfg.port, cfg.bind, () => {
    startedAt = clock()
    log(`在 http://${cfg.bind}:${cfg.port} 等活儿`)
    writeStatus(cfg.servicesDir, 'gpu-queue', { ok: true, port: cfg.port, startedAt, error: null }).catch(() => {})
  })

  const reaper = setInterval(() => reapOnce(), cfg.reapIntervalMs)
  reaper.unref?.()

  return () => {
    if (closed) return
    closed = true
    clearInterval(reaper)
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    saveNow().catch(() => {})
    writeStatus(cfg.servicesDir, 'gpu-queue', { ok: false, port: cfg.port, stoppedAt: clock() }).catch(() => {})
    server.close(() => {})
    server.unref?.()
  }
}
