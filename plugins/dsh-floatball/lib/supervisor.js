/**
 * 悬浮球子进程的看护：起步、崩了重拉（有上限）、停的时候连子进程一起收。
 *
 * Electron 自己会 fork renderer/gpu 子进程，所以停只能用 taskkill /T /F，
 * 单 kill 主进程会留下一堆僵尸 renderer 继续占窗口。
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 崩溃重拉策略：windowMs 内最多 limit 次，超了就别再折腾（大概率是装坏了）。 */
export function restartPlan({ crashes = [], now = Date.now(), limit = 5, windowMs = 600_000 } = {}) {
  const recent = crashes.filter((at) => Number.isFinite(at) && now - at < windowMs)
  return {
    recent,
    allowed: recent.length < limit,
    attempt: recent.length + 1,
    limit,
    windowMs,
  }
}

export function statePathOf(dataDir) {
  return join(dataDir, 'state', 'ball.json')
}

export function createSupervisor({
  electronExe,
  helperEntry,
  env = {},
  dataDir,
  log = () => {},
  limit = 5,
  windowMs = 600_000,
  restartDelayMs = 1500,
  platform = process.platform,
} = {}) {
  let child = null
  let startedAt = 0
  let crashes = []
  let restartTimer = null
  let stopping = false
  let lastError = ''
  let lastExit = null
  const statePath = statePathOf(dataDir)

  async function persist(extra = {}) {
    const payload = {
      pid: child?.pid ?? 0,
      startedAt,
      electronExe,
      helperEntry,
      crashes: crashes.length,
      stopping,
      lastError,
      lastExit,
      updatedAt: Date.now(),
      ...extra,
    }
    await mkdir(dirname(statePath), { recursive: true }).catch(() => {})
    await writeFile(statePath, JSON.stringify(payload, null, 2), 'utf8').catch(() => {})
    return payload
  }

  function running() {
    return Boolean(child && child.exitCode === null && child.signalCode === null)
  }

  /** 从 DSH 继承来的环境里有两个会把 Electron 变成裸 Node 的变量，必须摘掉。 */
  function childEnv() {
    const merged = { ...process.env, ...env }
    delete merged.ELECTRON_RUN_AS_NODE
    delete merged.ELECTRON_NO_ATTACH_CONSOLE
    return merged
  }

  /** Electron 的报错都走 stderr，不接进日志就只剩「code=1」没法查。 */
  function pipeOutput(stream, prefix) {
    if (!stream) return
    stream.setEncoding('utf8')
    let buffer = ''
    stream.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const text = line.trim()
        if (text) log(`[electron ${prefix}] ${text.slice(0, 500)}`)
      }
    })
  }

  function start() {
    if (running()) return { ok: true, already: true, pid: child.pid }
    stopping = false
    startedAt = Date.now()
    child = spawn(electronExe, [`--user-data-dir=${join(dataDir, 'electron')}`, helperEntry], {
      env: childEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    pipeOutput(child.stdout, 'out')
    pipeOutput(child.stderr, 'err')
    child.on('error', (error) => {
      lastError = String(error?.message || error)
      log(`[floatball] Electron 起不来：${lastError}`)
      persist().catch(() => {})
    })
    child.on('exit', (code, signal) => {
      const pid = child?.pid
      const crash = !stopping && code !== 0
      lastExit = { code, signal, at: Date.now(), pid }
      child = null
      if (crash) {
        crashes.push(Date.now())
        log(`[floatball] 球掉了（code=${code} signal=${signal}），看要不要重拉`)
        const plan = restartPlan({ crashes, limit, windowMs })
        if (plan.allowed) {
          restartTimer = setTimeout(() => {
            restartTimer = null
            log(`[floatball] 第 ${plan.attempt} 次重拉`)
            start()
          }, restartDelayMs)
          restartTimer.unref?.()
        } else {
          lastError = `${Math.round(windowMs / 60_000)} 分钟内掉了 ${plan.recent.length} 次，不再自动重拉`
          log(`[floatball] ${lastError}`)
        }
      }
      persist().catch(() => {})
    })
    log(`[floatball] 球起来了（pid=${child.pid}）`)
    persist().catch(() => {})
    return { ok: true, pid: child.pid }
  }

  function killTree(pid) {
    if (!pid) return Promise.resolve(false)
    if (platform !== 'win32') {
      try {
        process.kill(pid, 'SIGTERM')
        return Promise.resolve(true)
      } catch {
        return Promise.resolve(false)
      }
    }
    return new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      killer.on('error', () => resolve(false))
      killer.on('exit', (code) => resolve(code === 0))
    })
  }

  async function stop({ reason = 'stop' } = {}) {
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    stopping = true
    const pid = child?.pid
    if (!pid) {
      await persist({ stoppedAt: Date.now(), reason })
      return { ok: true, alreadyStopped: true }
    }
    const killed = await killTree(pid)
    // 等 exit 事件落地，最多 3 秒
    const deadline = Date.now() + 3000
    while (running() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 60))
    }
    lastExit = { code: null, signal: 'stopped', at: Date.now(), pid, reason }
    child = null
    await persist({ stoppedAt: Date.now(), reason })
    return { ok: true, killed, pid }
  }

  async function restart(params = {}) {
    await stop({ reason: 'restart' })
    return start(params)
  }

  async function readState() {
    try {
      return JSON.parse(await readFile(statePath, 'utf8'))
    } catch {
      return null
    }
  }

  return {
    start,
    stop,
    restart,
    running,
    pid: () => child?.pid ?? 0,
    startedAt: () => startedAt,
    status: () => ({
      running: running(),
      pid: child?.pid ?? 0,
      startedAt,
      electronExe,
      crashes: crashes.length,
      lastError,
      lastExit,
      statePath,
    }),
    persist,
    readState,
  }
}
