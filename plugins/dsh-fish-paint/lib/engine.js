// dsh-fish-paint · 常驻出图 worker 管理
//
// 按 CONTRACT.md §3 的 JSONL 协议跟 engine/worker.py 说话：
//   spawn python worker.py → stdout 逐行 JSON → 按 id 分发到 pending Promise
// 负责的事：懒启动、串行排队、崩溃自动重启（同一请求最多重试 1 次）、
// 连续崩溃冷却、空闲自动退出、pid 文件、worker.log、可读的错误信息。
//
// 这里不依赖任何 npm 包，只用 node: 内置模块。
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

const WORKER_LOG_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_READY_TIMEOUT_MS = 240_000
const DEFAULT_GENERATE_TIMEOUT_MS = 600_000
const DEFAULT_STATUS_TIMEOUT_MS = 8_000
const DEFAULT_COOLDOWN_MS = 60_000
const DEFAULT_MAX_CRASHES = 3

/** 带 code 的引擎错误：index.js / 模型侧可以直接按 code 分支。 */
export class EngineError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'EngineError'
    this.code = code
    Object.assign(this, extra)
  }
}

export function engineError(code, message, extra) {
  return new EngineError(code, message, extra)
}

/** 判断 pid 还活着（Windows 上 process.kill(pid, 0) 够用，EPERM 也算活着）。 */
export function isPidAlive(pid) {
  const num = Number(pid)
  if (!Number.isFinite(num) || num <= 0) return false
  try {
    process.kill(num, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 创建一个引擎实例（懒启动，不 spawn 任何进程；第一次 generate 才起 worker）。
 *
 * @param {object} [options]
 * @param {string} [options.root]              插件根目录（默认 cwd）
 * @param {string} [options.dataDir]           data 目录
 * @param {string} [options.pythonPath]        venv 里的 python
 * @param {string} [options.modelPath]         safetensors 模型（默认模型，base）
 * @param {string} [options.nsfwModelPath]     可选，NSFW 特化模型；generate 传 model:'nsfw' 时切换加载
 * @param {string} [options.workerScript]      engine/worker.py（测试可换成 fake worker）
 * @param {number} [options.idleMinutes]       空闲多少分钟后退出，<=0 关闭
 * @param {string} [options.vramMode]          auto|full|offload
 * @param {Function} [options.onProgress]      progress 行回调
 * @param {Function} [options.onLog]           内部日志回调
 * @param {string} [options.pidFile]           覆盖 pid 文件路径（测试用）
 * @param {object} [options.env]               额外环境变量（测试用）
 * @param {number} [options.readyTimeoutMs]
 * @param {number} [options.generateTimeoutMs]
 * @param {number} [options.statusTimeoutMs]
 * @param {number} [options.cooldownMs]
 * @param {number} [options.maxCrashes]
 */
export function createEngine(options = {}) {
  const root = options.root ? path.resolve(options.root) : process.cwd()
  const dataDir = resolveOption(options.dataDir, path.join(root, 'data'))
  const stateDir = path.join(dataDir, 'state')
  const pythonPath = resolveOption(options.pythonPath, path.join(dataDir, '.venv', 'Scripts', 'python.exe'))
  const baseModelPath = resolveOption(options.modelPath, path.join(dataDir, 'models', 'Illustrious-XL-v2.0.safetensors'))
  // 可选的第二个模型（NSFW 特化）。空字符串 = 没配，选 nsfw 时给出可读的错误。
  const nsfwModelPath = optionalPathOption(options.nsfwModelPath)
  // 当前 worker 实际加载的模型：generate 传 model:'nsfw' 时自动切换（杀掉旧 worker 再起新的）。
  let activeModelPath = baseModelPath
  let activeModelKey = 'base'
  const workerScript = resolveOption(options.workerScript, path.join(root, 'engine', 'worker.py'))
  const pidFile = options.pidFile ? path.resolve(options.pidFile) : path.join(stateDir, 'worker.json')
  const logFile = path.join(stateDir, 'worker.log')

  const idleMinutes = Number.isFinite(Number(options.idleMinutes)) ? Number(options.idleMinutes) : 30
  const vramMode = typeof options.vramMode === 'string' && options.vramMode ? options.vramMode : 'auto'
  const readyTimeoutMs = positive(options.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS)
  const generateTimeoutMs = positive(options.generateTimeoutMs, DEFAULT_GENERATE_TIMEOUT_MS)
  const statusTimeoutMs = positive(options.statusTimeoutMs, DEFAULT_STATUS_TIMEOUT_MS)
  const cooldownMs = positive(options.cooldownMs, DEFAULT_COOLDOWN_MS)
  const maxCrashes = positive(options.maxCrashes, DEFAULT_MAX_CRASHES)
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {}
  const extraEnv = options.env && typeof options.env === 'object' ? options.env : {}

  // ── 可变状态 ──────────────────────────────────────────────────────────
  let proc = null
  let ready = false
  let readyInfo = null
  let readyWaiter = null
  let starting = null
  let stopping = false
  let disposed = false
  let crashStreak = 0
  let cooldownUntil = 0
  let idleTimer = null
  let opSeq = 0
  let queueDepth = 0
  let chain = Promise.resolve()
  const pending = new Map() // id -> { resolve, reject, timer, op }
  const lastStderr = [] // 崩溃时把最后几行塞进错误信息里，用户/模型能直接看到原因

  function resolveOption(value, fallback) {
    if (typeof value !== 'string' || !value.trim()) return path.normalize(fallback)
    const trimmed = value.trim()
    return path.normalize(path.isAbsolute(trimmed) ? trimmed : path.resolve(root, trimmed))
  }

  /** 可选路径：没配就是空字符串（不像 resolveOption 那样补默认值）。 */
  function optionalPathOption(value) {
    if (typeof value !== 'string' || !value.trim()) return ''
    const trimmed = value.trim()
    return path.normalize(path.isAbsolute(trimmed) ? trimmed : path.resolve(root, trimmed))
  }

  function positive(value, fallback) {
    const num = Number(value)
    return Number.isFinite(num) && num > 0 ? num : fallback
  }

  function log(message) {
    appendWorkerLog(`[node] ${message}`)
    try {
      onLog(message)
    } catch {
      /* onLog 自己炸了不能影响引擎 */
    }
  }

  function appendWorkerLog(text) {
    try {
      fs.mkdirSync(stateDir, { recursive: true })
      let size = 0
      try {
        size = fs.statSync(logFile).size
      } catch {
        size = 0
      }
      if (size > WORKER_LOG_MAX_BYTES) {
        try {
          fs.renameSync(logFile, `${logFile}.1`)
        } catch {
          /* 轮转失败就继续追加，不能因为日志写不进去把引擎搞挂 */
        }
      }
      const line = String(text ?? '')
      fs.appendFileSync(logFile, line.endsWith('\n') ? line : `${line}\n`, 'utf8')
    } catch {
      /* 日志目录不可写时静默，出图优先 */
    }
  }

  function installState() {
    const missing = []
    if (!fs.existsSync(pythonPath)) missing.push(pythonPath)
    if (!fs.existsSync(workerScript)) missing.push(workerScript)
    const modelExists = fs.existsSync(activeModelPath)
    if (!modelExists) missing.push(activeModelPath)
    return {
      ok: missing.length === 0,
      pythonPath,
      pythonExists: fs.existsSync(pythonPath),
      workerScript,
      workerScriptExists: fs.existsSync(workerScript),
      modelPath: activeModelPath,
      modelKey: activeModelKey,
      models: modelPathsInfo(),
      modelExists,
      modelBytes: fileSize(activeModelPath),
      missing,
      message: missing.length ? `引擎未安装，先 draw_setup install（或跑 node engine/setup.mjs）。缺：${missing.join('、')}` : '',
    }
  }

  /** 两个模型各自的状态，status 里给模型看（nsfw 没配时 path 为空）。 */
  function modelPathsInfo() {
    const describe = (file) => ({ path: file, exists: file ? fs.existsSync(file) : false, bytes: file ? fileSize(file) : 0 })
    return { base: describe(baseModelPath), nsfw: describe(nsfwModelPath) }
  }

  async function setActiveModel(key) {
    const nextKey = key === 'nsfw' ? 'nsfw' : 'base'
    if (nextKey === activeModelKey) return
    const nextPath = nextKey === 'nsfw' ? nsfwModelPath : baseModelPath
    if (!nextPath) {
      throw engineError(
        'MODEL_MISSING',
        '没有配置 NSFW 模型：在插件 config 里填 nsfwModelPath（或把 waiNSFWIllustrious_v150.safetensors 放进 data/models/）后重载插件。',
      )
    }
    if (!fs.existsSync(nextPath)) {
      throw engineError(
        'MODEL_MISSING',
        `NSFW 模型文件缺失：${nextPath}。先下载模型（见 README「换模型」），再重试。`,
        { modelPath: nextPath },
      )
    }
    if (proc) {
      log(`切换模型 ${activeModelKey} → ${nextKey}（${path.basename(nextPath)}）`)
      await killProc('切换模型')
    }
    activeModelKey = nextKey
    activeModelPath = nextPath
    log(`当前模型：${activeModelKey} = ${path.basename(activeModelPath)}`)
  }

  function assertInstalled() {
    const state = installState()
    if (!state.pythonExists || !state.workerScriptExists) {
      throw engineError('NOT_INSTALLED', state.message, { missing: state.missing })
    }
    if (!state.modelExists) {
      throw engineError(
        'MODEL_MISSING',
        `模型文件缺失：${activeModelPath}。先 draw_setup install（或跑 node engine/setup.mjs --install）下载模型。`,
        { modelPath: activeModelPath, modelKey: activeModelKey },
      )
    }
  }

  function cooldownError() {
    const left = Math.max(0, cooldownUntil - Date.now())
    return engineError(
      'COOLDOWN',
      `画图引擎连续崩溃 ${crashStreak} 次，进入冷却（还剩约 ${Math.ceil(left / 1000)} 秒）。原因一般在 data/state/worker.log，可以用 draw_status 看详情。`,
      { retryAfterMs: left },
    )
  }

  // ── pid 文件 ─────────────────────────────────────────────────────────
  function writePidFile(pid) {
    try {
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(
        pidFile,
        `${JSON.stringify({ pid, startedAt: new Date().toISOString(), modelPath: activeModelPath, modelKey: activeModelKey, pythonPath, workerScript }, null, 2)}\n`,
        'utf8',
      )
    } catch {
      /* pid 文件只是排障辅助，写不进去不影响出图 */
    }
  }

  function clearPidFile() {
    try {
      fs.unlinkSync(pidFile)
    } catch {
      /* 不存在就算了 */
    }
  }

  /** 上次留下的 pid：进程还活着且命令行确实是 worker.py 才杀，否则只清记录。 */
  function cleanStalePid() {
    let record = null
    try {
      record = JSON.parse(fs.readFileSync(pidFile, 'utf8'))
    } catch {
      record = null
    }
    if (!record) {
      clearPidFile()
      return
    }
    const pid = Number(record.pid)
    if (Number.isFinite(pid) && pid > 0 && pid !== process.pid && isPidAlive(pid) && pidLooksLikeWorker(pid)) {
      log(`清理上次残留的 worker 进程 pid=${pid}`)
      try {
        process.kill(pid)
      } catch {
        /* 可能刚好自己退了 */
      }
    }
    clearPidFile()
  }

  function pidLooksLikeWorker(pid) {
    try {
      if (process.platform === 'win32') {
        const out = execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue).CommandLine`,
          ],
          { encoding: 'utf8', timeout: 4000, windowsHide: true },
        )
        return /worker\.py/i.test(out)
      }
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 4000 })
      return /worker\.py/i.test(out)
    } catch {
      return false
    }
  }

  // ── 串行队列 ─────────────────────────────────────────────────────────
  function serial(task) {
    queueDepth += 1
    const run = chain.then(() => task())
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run.finally(() => {
      queueDepth -= 1
      scheduleIdle()
    })
  }

  // ── 启动 / 退出 ──────────────────────────────────────────────────────
  function ensureStarted() {
    if (disposed) return Promise.reject(engineError('DISPOSED', '插件正在卸载，画图引擎已关闭'))
    if (cooldownUntil > Date.now()) return Promise.reject(cooldownError())
    if (proc && ready) return Promise.resolve(readyInfo)
    if (starting) return starting
    starting = startWorker().finally(() => {
      starting = null
    })
    return starting
  }

  async function startWorker() {
    assertInstalled()
    stopIdleTimer()
    cleanStalePid()
    lastStderr.length = 0

    const env = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      FISH_PAINT_VRAM: vramMode,
      ...extraEnv,
    }
    const child = spawn(pythonPath, [workerScript, '--model', activeModelPath, '--data-dir', dataDir], {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    proc = child
    ready = false
    readyInfo = null
    if (child.pid) writePidFile(child.pid)
    log(`启动 worker pid=${child.pid ?? '?'} model=${activeModelKey}:${path.basename(activeModelPath)} vram=${vramMode}`)
    attach(child)

    const readyPromise = new Promise((resolve, reject) => {
      readyWaiter = { resolve, reject }
    })
    const timer = setTimeout(() => {
      const waiter = readyWaiter
      readyWaiter = null
      if (waiter) {
        waiter.reject(
          engineError(
            'START_TIMEOUT',
            `画图引擎启动超时（${Math.round(readyTimeoutMs / 1000)} 秒内没等到 ready）。看 data/state/worker.log，或用 draw_status 检查环境。`,
          ),
        )
      }
      try {
        child.kill()
      } catch {
        /* 已经死了 */
      }
    }, readyTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    try {
      const info = await readyPromise
      clearTimeout(timer)
      if (proc !== child) throw engineError('CRASH', '画图引擎启动过程中退出了')
      ready = true
      readyInfo = info
      log(`worker 就绪 pid=${child.pid} device=${info?.deviceName ?? '?'} torch=${info?.torch ?? '?'}`)
      scheduleIdle()
      return info
    } catch (error) {
      clearTimeout(timer)
      if (proc === child) {
        proc = null
        ready = false
      }
      throw error
    }
  }

  function attach(child) {
    if (child.stdin) {
      child.stdin.on('error', () => {
        /* worker 已经死了，写失败由 pending 超时/exit 分支处理 */
      })
    }
    if (child.stdout) {
      const out = createInterface({ input: child.stdout, crlfDelay: Infinity })
      out.on('line', (line) => {
        if (proc === child) handleLine(line)
      })
    }
    if (child.stderr) {
      const err = createInterface({ input: child.stderr, crlfDelay: Infinity })
      err.on('line', (line) => {
        lastStderr.push(line)
        if (lastStderr.length > 20) lastStderr.shift()
        appendWorkerLog(line)
      })
    }
    child.on('error', (error) => {
      log(`worker 进程错误：${error.message}`)
      const waiter = readyWaiter
      readyWaiter = null
      if (waiter) {
        waiter.reject(
          engineError('START_FAILED', `画图引擎启动失败：${error.message}。检查 python 路径和 engine/worker.py。`, {
            cause: error.message,
          }),
        )
      }
      if (proc === child) {
        proc = null
        ready = false
      }
    })
    child.on('exit', (code, signal) => {
      if (proc === child) onWorkerExit(code, signal)
    })
  }

  function onWorkerExit(code, signal) {
    const wasStopping = stopping
    ready = false
    readyInfo = null
    proc = null
    clearPidFile()
    const tail = lastStderr.length ? ` 最近日志：${lastStderr.slice(-5).join(' | ')}` : ''
    const message = `画图引擎意外退出（code=${code ?? 'null'}${signal ? `，signal=${signal}` : ''}）。${tail}`
    const error = engineError(wasStopping ? 'WORKER_EXIT' : 'CRASH', wasStopping ? '画图引擎已退出' : message)
    const waiter = readyWaiter
    readyWaiter = null
    if (waiter) waiter.reject(error)
    rejectAll(error)
    if (!wasStopping && !disposed) {
      crashStreak += 1
      if (crashStreak >= maxCrashes) {
        cooldownUntil = Date.now() + cooldownMs
        log(`连续 ${crashStreak} 次崩溃，冷却 ${Math.round(cooldownMs / 1000)} 秒`)
      }
    }
    stopping = false
    log(`worker 退出 code=${code ?? 'null'}${wasStopping ? '（主动停止）' : '（意外）'}`)
  }

  async function killProc(reason) {
    const child = proc
    stopIdleTimer()
    if (!child) {
      proc = null
      ready = false
      clearPidFile()
      return
    }
    log(`结束 worker（${reason}）pid=${child.pid}`)
    stopping = true
    try {
      child.kill()
    } catch {
      /* 已经没了 */
    }
    await waitExit(child, 3000)
    if (proc === child) {
      proc = null
      ready = false
    }
    stopping = false
    clearPidFile()
  }

  function waitExit(child, timeoutMs) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
    return new Promise((resolve) => {
      let timer = null
      const done = (ok) => {
        if (timer) clearTimeout(timer)
        child.removeListener('exit', onExit)
        resolve(ok)
      }
      const onExit = () => done(true)
      child.once('exit', onExit)
      timer = setTimeout(() => done(false), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  // ── stdout JSONL 分发 ────────────────────────────────────────────────
  function handleLine(line) {
    const text = line.trim()
    if (!text) return
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      appendWorkerLog(`[node] stdout 非 JSON 行（已忽略）：${text.slice(0, 300)}`)
      return
    }
    if (!msg || typeof msg !== 'object') return

    if (msg.type === 'progress') {
      try {
        onProgress(msg)
      } catch {
        /* progress 回调炸了不影响主体 */
      }
      return
    }
    if (msg.type === 'ready') {
      readyInfo = msg
      const waiter = readyWaiter
      readyWaiter = null
      if (waiter) waiter.resolve(msg)
      return
    }

    const id = msg.id === undefined || msg.id === null ? null : String(msg.id)
    if (msg.type === 'pong' || msg.type === 'bye') {
      if (id) settle(id, null, msg)
      return
    }
    if (!id) return
    const entry = pending.get(id)
    if (!entry) return // 迟到的行（超时后）直接忽略
    pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    if (msg.type === 'error') {
      const hint = typeof msg.hint === 'string' && msg.hint.trim() ? msg.hint.trim() : msg.message || '引擎返回未知错误'
      const error = engineError(msg.code || 'INTERNAL', hint, {
        workerCode: msg.code,
        detail: msg.message,
      })
      entry.reject(error)
      return
    }
    entry.resolve(msg)
    scheduleIdle()
  }

  function settle(id, error, value) {
    const entry = pending.get(String(id))
    if (!entry) return
    pending.delete(String(id))
    if (entry.timer) clearTimeout(entry.timer)
    if (error) entry.reject(error)
    else entry.resolve(value)
  }

  function rejectAll(error) {
    for (const [id, entry] of pending) {
      pending.delete(id)
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  function requestOp(op, fields, timeoutMs) {
    const child = proc
    if (!child) return Promise.reject(engineError('CRASH', '画图引擎没有在运行'))
    const id = `op${++opSeq}`
    const message = { id, op, ...fields }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(
          engineError(
            'OP_TIMEOUT',
            `画图引擎 ${op} 超时（${Math.round(timeoutMs / 1000)} 秒没回应）。可以调低 steps/尺寸重试，或用 draw_status 看引擎状态。`,
          ),
        )
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      pending.set(id, { resolve, reject, timer, op })
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8')
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(engineError('CRASH', `向画图引擎写入请求失败：${error.message}`))
      }
    })
  }

  // ── 空闲退出 ─────────────────────────────────────────────────────────
  function stopIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function scheduleIdle() {
    stopIdleTimer()
    if (disposed || !(idleMinutes > 0)) return
    if (!proc || !ready || stopping || pending.size > 0 || queueDepth > 0) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (!proc || pending.size > 0 || queueDepth > 0) return
      shutdown('空闲自动退出').catch((error) => log(`空闲退出失败：${error.message}`))
    }, idleMinutes * 60 * 1000)
    if (typeof idleTimer.unref === 'function') idleTimer.unref()
  }

  // ── 对外 API ─────────────────────────────────────────────────────────
  function buildGeneratePayload(request = {}) {
    const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : ''
    if (!prompt) throw engineError('BAD_REQUEST', 'generate 需要 prompt（正向 tag）')
    const outDir = typeof request.outDir === 'string' && request.outDir ? path.resolve(request.outDir) : ''
    if (!outDir) throw engineError('BAD_REQUEST', 'generate 需要 outDir')
    const width = snapDimension(request.width, 1024)
    const height = snapDimension(request.height, 1024)
    const payload = {
      prompt,
      negative: typeof request.negative === 'string' ? request.negative : '',
      width,
      height,
      steps: intOr(request.steps, 28),
      cfg: numOr(request.cfg, 5.5),
      seed: intOr(request.seed, -1),
      count: Math.min(4, Math.max(1, intOr(request.count, 1))),
      clipSkip: Math.min(12, Math.max(1, intOr(request.clipSkip, 2))),
      outDir,
    }
    if (request.resize && Number.isFinite(Number(request.resize.width)) && Number.isFinite(Number(request.resize.height))) {
      // worker 要求 resize 宽高是 8 的倍数，这里先按 8 取整，避免因为它报 BAD_REQUEST
      payload.resize = {
        width: snapDimension(request.resize.width, payload.width),
        height: snapDimension(request.resize.height, payload.height),
      }
    }
    return payload
  }

  async function generate(request = {}) {
    const payload = buildGeneratePayload(request)
    const requestedModel = request.model === 'nsfw' ? 'nsfw' : 'base'
    return serial(async () => {
      // 换模型要重起 worker（worker.py 用 --model 加载），所以放在串行区里做。
      await setActiveModel(requestedModel)
      let attempt = 0
      let lastError = null
      while (attempt < 2) {
        attempt += 1
        try {
          await ensureStarted()
          const done = await requestOp('generate', payload, generateTimeoutMs)
          if (!done || !Array.isArray(done.images) || done.images.length === 0) {
            throw engineError('BAD_RESPONSE', '引擎返回的 done 行里没有图片')
          }
          crashStreak = 0
          cooldownUntil = 0
          done.modelKey = activeModelKey
          done.modelPath = activeModelPath
          return done
        } catch (error) {
          lastError = error
          if (error?.code !== 'CRASH' || attempt >= 2) throw error
          log('generate 遇到崩溃，重启引擎后重试一次')
          await killProc('崩溃重启')
        }
      }
      throw lastError || engineError('CRASH', '画图引擎失败')
    })
  }

  async function status() {
    const state = installState()
    const info = {
      installed: state.ok,
      pythonPath: state.pythonPath,
      pythonExists: state.pythonExists,
      modelPath: state.modelPath,
      modelKey: activeModelKey,
      models: state.models,
      modelExists: state.modelExists,
      modelBytes: state.modelBytes,
      workerScript: state.workerScript,
      workerScriptExists: state.workerScriptExists,
      running: Boolean(proc),
      ready: Boolean(proc && ready),
      pid: proc?.pid ?? null,
      pendingOps: pending.size,
      queueDepth,
      crashStreak,
      cooldownMsLeft: Math.max(0, cooldownUntil - Date.now()),
      idleMinutes,
      vramMode,
      pidFile,
      logFile,
      readyInfo: readyInfo || null,
      worker: null,
      note: '',
      error: null,
    }
    if (!state.pythonExists || !state.workerScriptExists) {
      info.note = '引擎还没装：先 draw_setup install（或跑 node engine/setup.mjs）'
    } else if (!state.modelExists) {
      info.note = `模型文件缺失：${activeModelPath}，先 draw_setup install 下载模型`
    } else if (info.cooldownMsLeft > 0) {
      info.note = `引擎连续崩溃，冷却中（还剩约 ${Math.ceil(info.cooldownMsLeft / 1000)} 秒）`
    } else if (!proc) {
      info.note = '引擎没在跑（第一次 draw_image 会自动启动）'
    } else if (!info.ready) {
      info.note = '引擎正在启动'
    } else if (pending.size > 0 || queueDepth > 0) {
      info.note = '引擎正在出图，跳过状态查询'
    } else {
      try {
        info.worker = await requestOp('status', {}, statusTimeoutMs)
        scheduleIdle()
      } catch (error) {
        info.error = { code: error.code || 'STATUS_FAILED', message: error.message }
      }
    }
    return info
  }

  async function shutdown(reason = '手动关闭') {
    stopIdleTimer()
    const child = proc
    if (!child) {
      clearPidFile()
      return { ok: true, alreadyStopped: true }
    }
    log(`shutdown（${reason}）pid=${child.pid}`)
    stopping = true
    try {
      if (ready) {
        try {
          await requestOp('shutdown', {}, 5000)
        } catch {
          /* worker 可能已经卡住/退出，下面 kill 兜底 */
        }
      }
    } finally {
      await waitExit(child, 3000)
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill()
        } catch {
          /* 已经没了 */
        }
        await waitExit(child, 2000)
      }
      if (proc === child) {
        proc = null
        ready = false
      }
      stopping = false
      clearPidFile()
    }
    return { ok: true, alreadyStopped: false }
  }

  /** 插件卸载时调用：不等优雅退出，直接杀 + 拒绝所有 pending。 */
  function dispose() {
    disposed = true
    stopIdleTimer()
    const child = proc
    proc = null
    ready = false
    readyInfo = null
    const waiter = readyWaiter
    readyWaiter = null
    if (waiter) waiter.reject(engineError('DISPOSED', '插件正在卸载，画图引擎已关闭'))
    rejectAll(engineError('DISPOSED', '插件正在卸载，画图引擎已关闭'))
    if (child) {
      try {
        child.kill()
      } catch {
        /* 已经没了 */
      }
    }
    clearPidFile()
  }

  function isRunning() {
    return Boolean(proc && ready)
  }

  return {
    generate,
    status,
    shutdown,
    dispose,
    isRunning,
    installState,
    paths: { root, dataDir, stateDir, pythonPath, modelPath: activeModelPath, baseModelPath, nsfwModelPath, workerScript, pidFile, logFile },
  }
}

// ── 小工具 ────────────────────────────────────────────────────────────

function fileSize(file) {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() ? stat.size : 0
  } catch {
    return 0
  }
}

function intOr(value, fallback) {
  const num = Math.trunc(Number(value))
  return Number.isFinite(num) ? num : fallback
}

function numOr(value, fallback) {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function snapDimension(value, fallback) {
  const num = Math.round(Number(value) / 8) * 8
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.min(2048, Math.max(256, num))
}
