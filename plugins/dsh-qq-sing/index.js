/**
 * dsh-qq-sing — 「群友点歌，我来唱」。
 *
 * 链路（全部在本机跑，DSH 只负责点一下火）：
 *   song ──► python/fetch_song.py   （B 站搜索 + 挑人声版 + 下载 DASH 音频）
 *        ──► python/pipeline.py     （ffmpeg → UVR5 分离人声/伴奏 → 静音切段 → RVC 翻唱 → 分段混音）
 *        ──► worker.mjs             （逐条 POST /api/voice/send，钉死节奏，带落地校验）
 *        ──► QQ 语音条
 *
 * 为什么要独立 worker 进程：
 *   RVC 翻唱一首歌要 1-2 分钟，工具调用不能一直挂着；worker 是 detached 的，
 *   就算 DSH 关掉也会把这一首唱完。
 *
 * 全局锁：同一时间只接受一首歌。state.json + busy.lock 双重判定，
 *   后台在合成/发语音时，新的点歌直接返回 busy（不排队、不拒绝报错，方便模型直接回人）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { checkCooldown, clearCooldown, formatLeft, markCooldown, parseRequester, readAllowlist, readCooldowns } from './cooldown.mjs'
import { QUEUE_LIMIT, clearQueue, enqueue, readQueue, shiftQueue, unshiftQueue } from './queue.mjs'
import { resolveNames } from './names.mjs'

export const name = 'dsh-qq-sing'
export const inject = ['tools']

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const WORKER = join(PLUGIN_DIR, 'worker.mjs')

const DEFAULTS = {
  // QQ 桥控制台（操作者通道，和 dsh-qq-voice 同一条路）
  bridgeUrl: 'http://127.0.0.1:3100',
  bridgeDir: 'D:\\DPQQ\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1',
  // 留空则自动从 bridgeDir 读
  consoleToken: '',
  // 插件工作目录：state.json / busy.lock / jobs/<jobId>/
  home: join(homedir(), '.dsh', 'qq-sing'),
  // B 站下载用：bili-duty 的 venv + 已登录凭证
  pythonBili: 'C:\\Users\\Administrator\\.dsh\\bili-duty\\.venv\\Scripts\\python.exe',
  credentialFile: 'C:\\Users\\Administrator\\.dsh\\bili-duty\\bili_credential.json',
  // RVC 推理用 venv（里面有 torch 2.7.1+cu118、bilibili_api 不是它的事）
  pythonRvc: 'D:\\GSV\\rvc\\venv\\Scripts\\python.exe',
  // detached worker 用的 node（Electron 里跑不了 node 脚本，要真 node）
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  // 两条语音条之间的最小间隔：桥的语音限流是每分钟 2 条，31s 刚好贴着上限连续发
  minIntervalMs: 31000,
  // 一首歌最多发几条语音（超了就不唱，避免把 10 条/小时的额度吃光）
  maxSegments: 12,
  // 排单上限（再多就不接了）
  maxQueue: 5,
  // 看门狗：一首歌超过这么久没动静（state.updatedAt 不动）就强制收尾，别让队列永久堵死
  maxRunMs: 45 * 60 * 1000,
  // 超过这个时长的"歌"直接拒绝（防止点了个 40 分钟合集）
  maxSongMinutes: 9,
  // 唱完 / 失败时用桥的测试发送补一句人话（模型此时可能已经沉睡了）
  announce: true,
  // 是否把本地绝对路径放进工具返回值（QQ 里默认不给）
  exposePaths: false,
  // 不传 target 时的默认会话（如 "group:562437955"）
  defaultTarget: '',
  // 每个点歌人的内置 CD（默认 1 小时；给 0 = 关闭）
  cooldownMs: 60 * 60 * 1000,
  // 不受 CD 限制的 QQ 号（本人调试用，例如 ["100000002"]）
  cooldownBypassUids: [],
  // 悬浮球排队卡片读数据的本机端口（dsh-orb 的悬浮球页面轮询 /qqsing.json）
  queuePort: 31877,
}

function textResult(value) {
  return [{ type: 'text', text: value }]
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

async function readJson(path) {
  try {
    return JSON.parse(stripBom(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}

function parseTarget(raw) {
  const match = /^(group|private):([1-9]\d*)$/.exec(String(raw ?? '').trim())
  if (!match) return null
  return { kind: match[1], id: match[2] }
}

function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch {
    return false
  }
}

function mergeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const out = { ...DEFAULTS }
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = raw[key]
    if (value === undefined || value === null || value === '') continue
    out[key] = typeof fallback === 'number' ? Number(value) : value
  }
  if (raw.announce === false) out.announce = false
  if (raw.exposePaths === true) out.exposePaths = true
  return out
}

function statePath(cfg) {
  return join(cfg.home, 'state.json')
}

function lockPath(cfg) {
  return join(cfg.home, 'busy.lock')
}

/** 读当前任务状态；已结束的（有 finishedAt）不算忙。 */
async function readActiveJob(cfg) {
  const state = await readJson(statePath(cfg))
  if (!state || !state.jobId) return null
  if (state.finishedAt) return null
  return state
}

function isBusy(state) {
  if (!state) return false
  // pid 还活着才算真在忙；进程没了就是上次崩了，锁可以直接清
  return pidAlive(state.pid)
}

async function lockIsStale(lock) {
  if (!lock) return true
  const age = Date.now() - (Number(lock.at) || 0)
  if (lock.pid) return !pidAlive(lock.pid) && age > 15000
  // 刚创建、还没来得及写 pid 的窗口期不要抢
  return age > 120000
}

/**
 * 取进程命令行，用来确认这个 PID 真的是我们的 worker。
 * Windows 的 PID 会被复用，直接 taskkill 有可能杀掉无关进程树 —— 取消前必须核对。
 */
function pidCommandLine(pid) {
  return new Promise((resolve) => {
    if (!Number.isFinite(Number(pid))) return resolve('')
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    const ps = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let out = ''
    ps.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8')
    })
    ps.on('error', () => finish(''))
    ps.on('exit', () => finish(out.trim()))
    setTimeout(() => {
      try {
        ps.kill()
      } catch {
        /* ignore */
      }
      finish('')
    }, 8000).unref?.()
  })
}

/** 连子进程一起杀（worker 底下还挂着 python）。 */
function killProcessTree(pid) {
  return new Promise((resolve) => {
    if (!pidAlive(pid)) return resolve(true)
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    child.on('error', () => finish(false))
    child.on('exit', (code) => finish(code === 0))
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish(false)
    }, 15000).unref?.()
  })
}

async function acquireLock(cfg, jobId) {
  const path = lockPath(cfg)
  await mkdir(cfg.home, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx')
      try {
        await handle.writeFile(JSON.stringify({ jobId, at: Date.now() }), 'utf8')
      } finally {
        await handle.close()
      }
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const lock = await readJson(path)
      if (!(await lockIsStale(lock))) return false
      await unlink(path).catch(() => {})
    }
  }
  return false
}

async function releaseLock(cfg, jobId) {
  const lock = await readJson(lockPath(cfg))
  if (!lock || !lock.jobId || lock.jobId === jobId) await unlink(lockPath(cfg)).catch(() => {})
}

function busySummary(state) {
  const song = state?.song ? `《${state.song}》` : '上一首'
  const stage = state?.stageText ? String(state.stageText) : '正在准备'
  const sent = Number(state?.sent) || 0
  const total = Number(state?.total) || 0
  const progress = total ? `，已发 ${sent}/${total} 条` : ''
  return `🎤 后台还在唱${song}呢（${stage}${progress}）。这首唱完之前不接新歌，不然两个声音会打架——等一会儿再点哦。`
}

async function resolveToken(cfg) {
  const explicit = String(cfg.consoleToken ?? '').trim()
  if (explicit) return explicit
  if (cfg.bridgeDir) {
    const bridgeCfg = await readJson(join(cfg.bridgeDir, 'config.json'))
    const fromCfg = String(bridgeCfg?.consoleToken ?? '').trim()
    if (fromCfg) return fromCfg
    try {
      const fromState = stripBom(await readFile(join(cfg.bridgeDir, 'state', 'console-token'), 'utf8')).trim()
      if (fromState) return fromState
    } catch {
      /* fallthrough */
    }
  }
  throw new Error('拿不到 QQ 桥控制台令牌：在插件配置里填 consoleToken，或把 bridgeDir 指到 qq-bridge 安装目录')
}

async function bridgeGet(cfg, token, pathname) {
  const base = String(cfg.bridgeUrl || '').replace(/\/+$/, '')
  const response = await fetch(`${base}${pathname}`, {
    method: 'GET',
    headers: { 'x-console-token': token },
    signal: AbortSignal.timeout(15000),
  })
  const data = await response.json().catch(() => ({}))
  return { status: response.status, data }
}

async function bridgePost(cfg, token, pathname, body, timeoutMs = 30000) {
  const base = String(cfg.bridgeUrl || '').replace(/\/+$/, '')
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const data = await response.json().catch(() => ({}))
  return { status: response.status, data }
}

/** 用桥的测试发送补一句人话（尽力而为，失败就算了）。 */
async function announce(cfg, target, text) {
  if (!cfg.announce) return false
  const [kind, id] = String(target || '').split(':')
  if (!kind || !id) return false
  try {
    const token = await resolveToken(cfg)
    const { status, data } = await bridgePost(cfg, token, '/api/test-send', { kind, id: Number(id), message: String(text).slice(0, 400) })
    return status < 400 && data?.ok !== false
  } catch {
    return false
  }
}

/** 一段都没发出去才算「没点过」，退 CD；发过几段就不退，否则同一首会被从头重听。 */
async function refundCooldownIfUnsent(cfg, { requester, song, whitelisted, sent }) {
  if (Number(sent) > 0) return false
  if (!requester || whitelisted) return false
  try {
    const map = await readCooldowns(cfg.home)
    const entry = map?.[String(requester)]
    if (entry && String(entry.song ?? '') === String(song ?? '')) {
      await clearCooldown(cfg.home, String(requester))
      return true
    }
  } catch {
    /* CD 文件坏了不影响收尾 */
  }
  return false
}

/** 清空排单，并给排队的人退 CD（他们一首都没听到，不能白白烧掉一小时额度）。 */
async function dropQueueWithRefund(cfg) {
  const list = await readQueue(cfg.home).catch(() => [])
  if (!list.length) return { dropped: 0, refunded: 0 }
  await clearQueue(cfg.home).catch(() => {})
  let refunded = 0
  for (const item of list) {
    const ok = await refundCooldownIfUnsent(cfg, {
      requester: item?.requester,
      song: item?.song,
      whitelisted: Boolean(item?.whitelisted),
      sent: 0,
    })
    if (ok) refunded += 1
  }
  return { dropped: list.length, refunded }
}

const QUEUE_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

/**
 * 悬浮球排队卡片的数据源：本机只读 HTTP 端口。
 * dsh-orb 的悬浮球页面（file:// 页面）用 fetch 轮询 GET /qqsing.json。
 */
function startQueueServer(cfg) {
  const port = Number(cfg.queuePort)
  // 0 / 负数 = 不开这个端口（测试和「不装悬浮球」的人跑起来不会莫名占着 31877）
  if (!Number.isFinite(port) || port <= 0) return () => {}
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, QUEUE_CORS).end()
        return
      }
      const pathname = String(req.url || '/').split('?')[0]
      if (pathname !== '/qqsing.json') {
        res.writeHead(404, { ...QUEUE_CORS, 'content-type': 'text/plain; charset=utf-8' }).end('not found')
        return
      }
      const state = await readJson(statePath(cfg))
      const history = await readJson(join(cfg.home, 'history.json'))
      const active =
        state && state.jobId && !state.finishedAt && pidAlive(state.pid)
          ? {
              jobId: state.jobId,
              song: state.song || '',
              title: state.title || '',
              target: state.target || '',
              targetName: state.targetName || '',
              requester: state.requester || '',
              requesterName: state.requesterName || '',
              stage: state.stage || '',
              stageText: state.stageText || '',
              sent: Number(state.sent) || 0,
              total: Number(state.total) || 0,
              startedAt: Number(state.startedAt) || 0,
            }
          : null
      const recent = Array.isArray(history) ? history.slice(0, 6) : []
      const queue = (await readQueue(cfg.home).catch(() => [])).map((item) => ({
        song: item.song || '',
        target: item.target || '',
        targetName: item.targetName || '',
        requester: item.requester || '',
        requesterName: item.requesterName || '',
        whitelisted: Boolean(item.whitelisted),
        queuedAt: Number(item.queuedAt) || 0,
      }))
      res
        .writeHead(200, { ...QUEUE_CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        .end(JSON.stringify({ ok: true, now: Date.now(), active, queue, recent }))
    } catch {
      res.writeHead(500, QUEUE_CORS).end('{}')
    }
  })
  server.on('error', () => {})
  server.listen(port, '127.0.0.1')
  return () => {
    try {
      server.close()
    } catch {
      /* ignore */
    }
  }
}

/** 起一个 detached worker 去唱一首，返回 qq_sing 的返回体。 */
async function startJob(cfg, { song, target, requester, whitelisted, markCd = true }) {
  const jobId = `sing-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
  if (!(await acquireLock(cfg, jobId))) {
    const current = await readActiveJob(cfg)
    return { ok: false, busy: true, song: current?.song, target: current?.target, summary: busySummary(current) }
  }
  const jobDir = join(cfg.home, 'jobs', jobId)
  try {
    await mkdir(jobDir, { recursive: true })
    const jobFile = join(jobDir, 'job.json')
    const jobConfig = {
      jobId,
      home: cfg.home,
      jobDir,
      song,
      requester,
      whitelisted,
      target,
      bridgeUrl: cfg.bridgeUrl,
      bridgeDir: cfg.bridgeDir,
      consoleToken: cfg.consoleToken,
      pythonBili: cfg.pythonBili,
      pythonRvc: cfg.pythonRvc,
      fetchScript: join(PLUGIN_DIR, 'python', 'fetch_song.py'),
      pipelineScript: join(PLUGIN_DIR, 'python', 'pipeline.py'),
      credentialFile: cfg.credentialFile,
      minIntervalMs: cfg.minIntervalMs,
      maxSegments: cfg.maxSegments,
      maxSongMinutes: cfg.maxSongMinutes,
      announce: cfg.announce,
      exposePaths: cfg.exposePaths,
    }
    await writeFile(jobFile, JSON.stringify(jobConfig, null, 2), 'utf8')

    const nodeExe = existsSync(cfg.nodePath) ? cfg.nodePath : process.execPath
    const env = { ...process.env }
    if (nodeExe === process.execPath) env.ELECTRON_RUN_AS_NODE = '1'

    const child = spawn(nodeExe, [WORKER, jobFile], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: cfg.home,
      env,
    })
    child.unref()

    if (!child.pid) throw new Error('worker 没起来（spawn 没拿到 pid）')

    const now = Date.now()
    const state = {
      jobId,
      pid: child.pid,
      song,
      title: '',
      target,
      targetName: '',
      requester,
      requesterName: '',
      stage: 'queued',
      stageText: '排队准备中',
      total: 0,
      sent: 0,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      ok: null,
      error: '',
    }
    await writeFile(statePath(cfg), JSON.stringify(state, null, 2), 'utf8')
    await writeFile(lockPath(cfg), JSON.stringify({ jobId, pid: child.pid, at: now }), 'utf8')
    // 起唱成功才吃 CD；没唱成（worker 失败）会清掉，不算点过；白名单不计时。
    // 排队进来的那首在入队时已经记过 CD，这里不再重复记。
    if (markCd && !whitelisted) {
      await markCooldown(cfg.home, requester, song, target).catch(() => {})
    }

    return {
      ok: true,
      started: true,
      whitelisted,
      jobId,
      song,
      target,
      summary: `🎤 收到${/^BV[0-9A-Za-z]{10}$/.test(song) ? '这首歌' : `《${song}》`}～后台这就去 B 站找原曲、翻唱，唱好了一条条发出来（第一首大概 1-2 分钟，整首几分钟发完）。`,
    }
  } catch (error) {
    await releaseLock(cfg, jobId)
    throw error
  }
}

/**
 * 排单调度的一轮：空闲就把队头那首起起来；起不来就原样塞回队头。
 * 抽成函数是为了能被测试直接调用（以前逻辑埋在 setInterval 里，抢锁失败丢单这条测不到）。
 */
export async function runQueueTick(cfg, deps = {}) {
  const start = deps.startJob ?? startJob
  if (isBusy(await readActiveJob(cfg))) return { skipped: 'busy' }
  const list = await readQueue(cfg.home)
  if (!list.length) return { skipped: 'empty' }
  const item = await shiftQueue(cfg.home)
  if (!item) return { skipped: 'lost' }
  const result = await start(cfg, {
    song: item.song,
    target: item.target,
    requester: item.requester,
    whitelisted: Boolean(item.whitelisted),
    markCd: false,
  })
  // 抢锁失败/起不来：把这单塞回队头，不然它就从队列里彻底消失了（CD 也已经扣过）
  if (!result?.ok) {
    await unshiftQueue(cfg.home, item).catch(() => {})
    return { requeued: true, item, result }
  }
  return { started: true, item, result }
}

export function apply(ctx, config) {
  const cfg = mergeConfig(config)

  ctx.effect(() => {
    mkdir(cfg.home, { recursive: true }).catch(() => {})
    return () => {}
  })

  // 悬浮球（dsh-orb）的排队卡片从这里取数据
  ctx.effect(() => startQueueServer(cfg))

  // 排单调度：空闲且队列里有人，就自动起下一首（DSH 开着时每 20s 看一眼）
  ctx.effect(() => {
    const timer = setInterval(() => {
      runQueueTick(cfg).catch(() => {
        /* 调度失败就等下一轮 */
      })
    }, 20000)
    return () => clearInterval(timer)
  })

  // 看门狗：worker 卡在翻唱/发语音上时 busy 永远不消（isBusy 只看 pid 活着），排单就轮不到。
  // 超过 maxRunMs 没动静就强制收尾、清锁、退 CD，并告诉群里一声。
  ctx.effect(() => {
    const timer = setInterval(async () => {
      try {
        const state = await readActiveJob(cfg)
        if (!state || !pidAlive(state.pid)) return
        const maxRun = Number(cfg.maxRunMs) || 45 * 60 * 1000
        const last = Math.max(Number(state.updatedAt) || 0, Number(state.startedAt) || 0)
        if (!last || Date.now() - last < maxRun) return
        // Windows reuses PIDs. Before taskkill /T, make sure the PID is still our worker — the
        // cancel path already checks this (see below), the watchdog used to skip it.
        const cmdline = await pidCommandLine(state.pid)
        if (!cmdline || !/worker\.mjs/i.test(cmdline)) {
          const next = {
            ...state,
            stage: 'error',
            stageText: '进程对不上',
            ok: false,
            error: `PID ${state.pid} 现在不是点歌 worker（命令行：${cmdline.slice(0, 120) || '取不到'}），看门狗跳过强杀`,
            finishedAt: Date.now(),
            updatedAt: Date.now(),
          }
          await writeFile(statePath(cfg), JSON.stringify(next, null, 2), 'utf8').catch(() => {})
          await releaseLock(cfg, state.jobId)
          const staleJob = await readJson(join(cfg.home, 'jobs', state.jobId, 'job.json')).catch(() => null)
          await refundCooldownIfUnsent(cfg, {
            requester: staleJob?.requester ?? state.requester,
            song: state.song,
            whitelisted: staleJob?.whitelisted ?? Boolean(state.whitelisted),
            sent: state.sent,
          })
          await announce(
            cfg,
            state.target,
            `🎤 状态文件里那个进程号现在指的已经不是点歌进程了（系统把 PID 复用了），没敢动手杀它，只清了状态和锁。想听的话重新点一次。`,
          )
          return
        }
        await killProcessTree(state.pid)
        const next = {
          ...state,
          stage: 'timeout',
          stageText: '卡住了，已被强制收尾',
          ok: false,
          error: `超过 ${Math.round(maxRun / 60000)} 分钟没动静，被看门狗强制收尾`,
          finishedAt: Date.now(),
          updatedAt: Date.now(),
        }
        await writeFile(statePath(cfg), JSON.stringify(next, null, 2), 'utf8').catch(() => {})
        await releaseLock(cfg, state.jobId)
        const jobCfg = await readJson(join(cfg.home, 'jobs', state.jobId, 'job.json'))
        await refundCooldownIfUnsent(cfg, {
          // job.json 没了就退回 state.json 里的 requester，否则看门狗收尾时永远退不了 CD
          requester: jobCfg?.requester ?? state.requester,
          song: state.song,
          whitelisted: jobCfg?.whitelisted ?? Boolean(state.whitelisted),
          sent: state.sent,
        })
        await announce(
          cfg,
          state.target,
          `🎤 这首《${state.song ?? ''}》卡住了（超过 ${Math.round(maxRun / 60000)} 分钟没动静），已经强制收尾。想听的话过一会儿再点。`,
        )
      } catch {
        /* 看门狗自己出错不影响主流程 */
      }
    }, 60000)
    return () => clearInterval(timer)
  })

  ctx.effect(() =>
    ctx.tools.register({
      name: 'qq_sing',
      description:
        '调用名就是 qq_sing 本身（不带 mcp__snowluma__ 之类命名空间前缀；若报 unknown tool 说明名字写错了，请用不带前缀的 qq_sing 重试，不要放弃）。' +
        '群友想听你唱歌、点歌（"唱首 xxx"、"来一个 xxx"）时用：传一个歌名或 B 站 BV 号，再传点歌人的 QQ 号（requester，纯数字，从消息发送者取），' +
        '后台会去 B 站找原曲、用 RVC 把整首歌翻唱成本机音色，然后一条条语音发到这个会话（每 30 秒左右一条，一首歌大概 1-2 分钟起唱、几分钟发完）。' +
        '同一时间只唱一首，忙的时候会排单（最多 5 首）：如果返回 queued=true，说明已经排上了，把 position（前面还有几首、大概几分钟）告诉对方，不要说"唱完再点"；如果返回 queueFull=true，才是排满了，让对方等会儿。' +
        '每个点歌人一小时只能点一首：如果返回 cooldown=true，直接告诉对方还要等多久，不要换别人的 QQ 号绕过。' +
        '点歌白名单（~/.dsh/qq-sing/allowlist.txt）里的人不计时，随便点。' +
        '返回 started=true（马上开始唱）或 queued=true（排上了）都不用再管，也不用轮询。',
      parameters: {
        type: 'object',
        properties: {
          song: { type: 'string', description: '歌名，或者 B 站 BV 号（如 晴天 / BV1d4411N7zD）。80 字以内。' },
          requester: {
            type: 'string',
            description: '点歌人的 QQ 号（纯数字，从这条群消息的发送者取；不确定就先 qq_get_recent_messages 查 userId，不要瞎填）。',
          },
          target: { type: 'string', description: '会话 key：group:群号 或 private:QQ号，一般传当前会话的 key。' },
        },
        required: ['song'],
        additionalProperties: false,
      },
      timeoutMs: 30000,
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            started: { type: 'boolean' },
            busy: { type: 'boolean' },
            queued: { type: 'boolean' },
            position: { type: 'number' },
            queueFull: { type: 'boolean' },
            cooldown: { type: 'boolean' },
            whitelisted: { type: 'boolean' },
            requester: { type: 'string' },
            remainingMs: { type: 'number' },
            jobId: { type: 'string' },
            song: { type: 'string' },
            target: { type: 'string' },
            summary: { type: 'string' },
          },
          additionalProperties: true,
        },
        render: (_args, value) => textResult(value?.summary ?? JSON.stringify(value)),
      },
      async execute(args) {
        const song = String(args?.song ?? '')
          .replace(/\s+/g, ' ')
          .trim()
        if (!song) throw new Error('要唱哪首？把歌名或者 B 站 BV 号给我。')
        if (song.length > 80) throw new Error('歌名太长啦，给个短一点的（80 字以内），或者直接贴 BV 号。')

        const rawTarget = String(args?.target ?? cfg.defaultTarget ?? '').trim()
        const parsed = parseTarget(rawTarget)
        if (!parsed) {
          throw new Error(`target 要写成 group:群号 或 private:QQ号${rawTarget ? `，收到的是「${rawTarget}」` : '（没传 target，也没配置默认会话）'}`)
        }
        const targetKey = `${parsed.kind}:${parsed.id}`

        // —— 点歌人识别 + 内置 CD（每人 1 小时一首）——
        const requester = parseRequester(args?.requester) ?? (parsed.kind === 'private' ? parsed.id : null)
        if (!requester) {
          throw new Error('点歌人的 QQ 号没给我：把 requester 填上（群消息里发送者的 QQ 号，纯数字），不然没法算点歌 CD。')
        }
        const cooldownMs = Number(cfg.cooldownMs ?? 3600000)
        const bypass = new Set((cfg.cooldownBypassUids ?? []).map(String))
        const allowlist = await readAllowlist(cfg.home)
        const whitelisted = cooldownMs <= 0 || bypass.has(requester) || allowlist.has(requester)
        if (!whitelisted) {
          const cd = await checkCooldown(cfg.home, requester, Date.now(), cooldownMs)
          if (cd.blocked) {
            const who = cd.last?.song ? `《${cd.last.song}》` : '刚才那首'
            return {
              ok: false,
              cooldown: true,
              whitelisted: false,
              requester,
              remainingMs: cd.left,
              summary: `⏳ 你已经点过 ${who} 了，还要等 ${formatLeft(cd.left)} 才能再点。`,
            }
          }
        }

        // —— 排单：有歌在唱/在合成，就往后排（不再直接拒绝）——
        const active = await readActiveJob(cfg)
        const queued = await readQueue(cfg.home)
        if (isBusy(active) || queued.length > 0) {
          // 排队的人这会不会被 worker 补名字（还没起唱），入队时先查一次
          const names = await resolveNames({ bridgeDir: cfg.bridgeDir, target: targetKey, requester })
          const result = await enqueue(
            cfg.home,
            { song, target: targetKey, requester, whitelisted, ...names },
            Number(cfg.maxQueue) || QUEUE_LIMIT,
          )
          if (!result.ok) {
            return {
              ok: false,
              queueFull: true,
              whitelisted,
              summary: `🎤 排单已经 ${result.size} 首啦，这首先等等吧（等前面唱完再来点）。`,
            }
          }
          if (!whitelisted) await markCooldown(cfg.home, requester, song, targetKey).catch(() => {})
          const ahead = result.position - 1
          return {
            ok: true,
            queued: true,
            position: result.position,
            whitelisted,
            song,
            target: targetKey,
            summary: `🎤 排上了，前面还有 ${ahead} 首（大概 ${Math.max(1, ahead * 4 + 2)} 分钟轮到）。`,
          }
        }

        return startJob(cfg, { song, target: targetKey, requester, whitelisted })
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'qq_sing_status',
      description:
        '调用名就是 qq_sing_status 本身（不带 mcp__ 前缀）。' +
        '看后台点歌任务现在到哪一步了：空闲 / 找歌 / 分离人声 / RVC 翻唱 / 发语音（已发几条）。' +
        '有人问"唱完没有"、"刚才那首死了吗"时用；只读，不影响正在跑的任务。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      timeoutMs: 15000,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => textResult(value?.summary ?? JSON.stringify(value)),
      },
      async execute() {
        const state = await readJson(statePath(cfg))
        const queued = await readQueue(cfg.home).catch(() => [])
        const queueNote = queued.length ? `，排单还有 ${queued.length} 首在等` : ''
        const active = isBusy(state)
        if (!state) {
          return { ok: true, busy: false, summary: '🎤 后台没有点歌任务，空闲中。' }
        }
        const sent = Number(state.sent) || 0
        const total = Number(state.total) || 0
        const elapsed = state.startedAt ? Math.round((Date.now() - Number(state.startedAt)) / 1000) : 0
        if (state.finishedAt || !active) {
          const ok = state.ok === true
          // 已经发出去几段再断的，是「partial」不是「没唱成」——
          // 群里确实听到了那几段，说成「没唱成」会让点歌的人以为白点了。
          const partial = !ok && (state.stage === 'partial' || sent > 0)
          const headline = ok
            ? '上一首唱完了'
            : partial
              ? `上一首唱到 ${sent}/${total || '?'} 段断了`
              : '上一首没唱成'
          const reason = !ok && state.error ? `（${state.error}）` : ''
          return {
            ok: true,
            busy: false,
            jobId: state.jobId,
            song: state.song,
            partial,
            summary: `🎤 ${headline}${reason}${state.song ? `（${state.song}）` : ''}${total ? `，共 ${sent}/${total} 条语音` : ''}。现在空闲${queueNote}。`,
          }
        }
        return {
          ok: true,
          busy: true,
          jobId: state.jobId,
          song: state.song,
          target: state.target,
          stage: state.stage,
          sent,
          total,
          elapsedSec: elapsed,
          summary: `🎤 正在唱《${state.song}》：${state.stageText ?? state.stage}${total ? `，已发 ${sent}/${total} 条` : ''}，已经跑了 ${elapsed}s${queueNote}。`,
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'qq_sing_cancel',
      description:
        '调用名就是 qq_sing_cancel 本身（不带 mcp__ 前缀）。' +
        '把正在唱的那首掐掉：杀掉 worker 和它的翻唱/发送进程、清掉锁、没发出去的话退点歌 CD。' +
        '默认**只掐当前这一首**，排单里别人点的歌继续唱；要连排单一起清（并逐条退 CD）就传 alsoQueue=true。' +
        '只在真卡住（qq_sing_status 显示半天不动、或者 busy 一直不消）或者点错歌时才用；正常情况下让它自己唱完。',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: '可选：要取消的任务 id（qq_sing_status 里那个）。不填就取消当前那首。' },
          alsoQueue: {
            type: 'boolean',
            description: '可选：连排单一起清掉（默认 false——排队的人的歌会继续唱）。只有群主明确说"全停/清空排单"时才传 true。',
          },
        },
        additionalProperties: false,
      },
      timeoutMs: 40000,
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            cancelled: { type: 'boolean' },
            jobId: { type: 'string' },
            song: { type: 'string' },
            sent: { type: 'number' },
            total: { type: 'number' },
            cdRefunded: { type: 'boolean' },
            summary: { type: 'string' },
          },
          additionalProperties: true,
        },
        render: (_args, value) => textResult(value?.summary ?? JSON.stringify(value)),
      },
      async execute(args) {
        const alsoQueue = args?.alsoQueue === true
        const state = await readJson(statePath(cfg))
        if (!state?.jobId) {
          const left = (await readQueue(cfg.home).catch(() => [])).length
          return {
            ok: true,
            cancelled: false,
            summary: `🎤 现在没有正在唱的歌，不用取消。${left ? `排单里还有 ${left} 首在等。` : ''}`,
          }
        }
        if (args?.jobId && String(args.jobId) !== String(state.jobId)) {
          throw new Error(`当前任务是 ${state.jobId}，不是 ${args.jobId}；没动它，先用 qq_sing_status 看一眼。`)
        }
        const jobId = String(state.jobId)
        const song = state.song ? `《${state.song}》` : '这一首'
        const total = Number(state.total) || 0
        const sent = Number(state.sent) || 0
        const progress = total ? `，已发 ${sent}/${total} 段` : ''

        const patchState = async (patch) => {
          const next = { ...state, ...patch, updatedAt: Date.now() }
          await writeFile(statePath(cfg), JSON.stringify(next, null, 2), 'utf8').catch(() => {})
        }
        // 只有一段都没发出去才算「没点过」；发过几段就退 CD 会让同一首被从第 1 段重听一遍
        const refundCooldown = async () => {
          if (sent > 0) return false
          const jobCfg = await readJson(join(cfg.home, 'jobs', jobId, 'job.json'))
          // job.json 可能已经被清掉（job 目录被删/磁盘收拾过），state.json 里也存了 requester
          const requester = jobCfg?.requester ?? state.requester
          const isWhitelisted = jobCfg?.whitelisted ?? Boolean(state.whitelisted)
          if (!requester || isWhitelisted) return false
          try {
            const map = await readCooldowns(cfg.home)
            const entry = map?.[String(requester)]
            if (entry && String(entry.song ?? '') === String(state.song ?? '')) {
              await clearCooldown(cfg.home, String(requester))
              return true
            }
          } catch {
            /* CD 文件坏了不影响取消 */
          }
          return false
        }

        // 默认只掐当前这首，排队的人继续等（以前这里无条件清空全队，等于把别人点的歌一起弄丢）
        const dropInfo = alsoQueue ? await dropQueueWithRefund(cfg) : { dropped: 0, refunded: 0 }
        const left = (await readQueue(cfg.home).catch(() => [])).length
        const queueNote = dropInfo.dropped
          ? `，排单里 ${dropInfo.dropped} 首也清了${dropInfo.refunded ? `（退了 ${dropInfo.refunded} 人的 CD）` : ''}`
          : left
            ? `，排单里还有 ${left} 首，照常唱`
            : ''

        // 已经结束过：只可能残留锁
        if (state.finishedAt) {
          await releaseLock(cfg, jobId)
          return { ok: true, cancelled: false, jobId, song: state.song, sent, total, summary: `🎤 ${song}已经结束了${progress}，顺手清掉了残留的锁${queueNote}。` }
        }

        // 进程已经没了：上次崩掉，锁也快过期了，这里直接收尾
        if (!pidAlive(state.pid)) {
          await patchState({ stage: 'error', stageText: '进程已消失', ok: false, error: 'worker 进程不在了（可能崩了或被系统杀了）', finishedAt: Date.now() })
          await releaseLock(cfg, jobId)
          const cdRefunded = await refundCooldown()
          return {
            ok: true,
            cancelled: false,
            jobId,
            song: state.song,
            sent,
            total,
            cdRefunded,
            summary: `🎤 ${song}的 worker 已经不在了${progress}，已经清掉状态和锁${cdRefunded ? '，并退还了点歌 CD' : ''}。现在可以重新点歌${queueNote}。`,
          }
        }

        // PID 活着的未必是我们的 worker（Windows 会复用 PID），杀掉之前核对命令行
        const cmdline = await pidCommandLine(state.pid)
        if (!cmdline || !/worker\.mjs/i.test(cmdline)) {
          await patchState({
            stage: 'error',
            stageText: '进程对不上',
            ok: false,
            error: `PID ${state.pid} 现在不是点歌 worker（命令行：${cmdline.slice(0, 120) || '取不到'}）`,
            finishedAt: Date.now(),
          })
          await releaseLock(cfg, jobId)
          const cdRefunded = await refundCooldown()
          return {
            ok: true,
            cancelled: false,
            jobId,
            song: state.song,
            sent,
            total,
            cdRefunded,
            summary: `🎤 ${song}的 worker 进程看起来已经没了（PID ${state.pid} 已经被别的程序占了），所以没杀任何东西，只清掉了状态和锁${cdRefunded ? '，并退还了 CD' : ''}${queueNote}。`,
          }
        }

        const killed = await killProcessTree(state.pid)
        await patchState({
          stage: 'cancelled',
          stageText: '被取消了',
          ok: false,
          error: '手动取消',
          finishedAt: Date.now(),
        })
        await releaseLock(cfg, jobId)
        const cdRefunded = await refundCooldown()
        return {
          ok: true,
          cancelled: true,
          jobId,
          song: state.song,
          sent,
          total,
          cdRefunded,
          summary: killed
            ? `🛑 ${song}已取消${progress}${cdRefunded ? '，点歌 CD 也退回去了' : sent > 0 ? '，已经发出去的那几段就留着' : ''}。现在可以重新点歌${queueNote}。`
            : `🛑 状态已经清了，但 taskkill 没成功（PID ${state.pid} 可能已经先一步退出）。用 qq_sing_status 确认一下${queueNote}。`,
        }
      },
    }),
  )

  // 预留：手动重发最后一条（排查语音没收到时用）
  ctx.effect(() =>
    ctx.tools.register({
      name: 'qq_sing_selftest',
      description: '自检点歌链路：桥控制台是否可达、令牌是否读到、B 站/RVC 的 python 是否存在、当前锁状态。排查"点了歌没反应"时用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: 20000,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => textResult(value?.summary ?? JSON.stringify(value)),
      },
      async execute() {
        const report = {
          bridgeUrl: cfg.bridgeUrl,
          home: cfg.home,
          bridge: { ok: false },
          token: { ok: false },
          python: {
            bili: { path: cfg.pythonBili, exists: existsSync(cfg.pythonBili) },
            rvc: { path: cfg.pythonRvc, exists: existsSync(cfg.pythonRvc) },
            node: { path: cfg.nodePath, exists: existsSync(cfg.nodePath) },
            worker: { path: WORKER, exists: existsSync(WORKER) },
            credential: { path: cfg.credentialFile, exists: existsSync(cfg.credentialFile) },
          },
          lock: null,
          state: null,
        }
        try {
          const token = await resolveToken(cfg)
          report.token.ok = true
          const status = await bridgeGet(cfg, token, '/api/status')
          report.bridge.ok = status.data?.ok !== false
          report.bridge.mode = status.data?.mode ?? status.data?.currentMode ?? null
          report.bridge.error = status.data?.error ?? null
        } catch (error) {
          report.token.error = error?.message ?? String(error)
          report.bridge.error = error?.message ?? String(error)
        }
        report.state = await readJson(statePath(cfg))
        report.lock = await readJson(lockPath(cfg))
        const active = isBusy(report.state)
        const lines = [
          `QQ 桥 ${report.bridge.ok ? '正常' : '异常'}${report.bridge.mode ? `（${report.bridge.mode}）` : ''}`,
          `控制台令牌 ${report.token.ok ? '已拿到' : `拿不到：${report.token.error ?? ''}`}`,
          `B 站 python ${report.python.bili.exists ? '有' : '缺'} / RVC python ${report.python.rvc.exists ? '有' : '缺'} / node ${report.python.node.exists ? '有' : '缺'}`,
          `worker ${report.python.worker.exists ? '有' : '缺'} / 凭证 ${report.python.credential.exists ? '有' : '缺'}`,
          active ? `锁：正在唱《${report.state.song}》` : '锁：空闲',
        ]
        report.summary = lines.join('；')
        return report
      },
    }),
  )
}

// 供 node --check 之外的冒烟脚本引用
export { DEFAULTS, parseTarget, pidAlive }
