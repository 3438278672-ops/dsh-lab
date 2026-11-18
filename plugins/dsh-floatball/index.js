/**
 * dsh-floatball —— 自己的悬浮球。
 *
 * 一个透明小窗，收起是颗球，展开是两栏面板：
 *   - 点歌：在唱 / 排单 / 冷却 / 暂停接新单 / 掐掉当前这首
 *   - 画画：暂停接新图 / 中止在画那张 / worker 与在飞状态
 *   - 顶部一条显卡队列（画画与唱歌共用同一块卡）
 *
 * 这里只负责把 Electron 运行时备好、把 helper 拉起来、崩了重拉，以及两个给模型用的工具。
 * 界面与数据读取全在 helper/ 里，直接打三个本机 HTTP 服务。
 */
import { mkdir, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { collectSnapshot, summarizeSnapshot } from './lib/snapshot.js'
import { readToken, resolveServicesDir, tokenPath } from './lib/services.js'
import { ensureRuntime, runtimeStatus } from './lib/runtime.js'
import { createSupervisor, statePathOf } from './lib/supervisor.js'

export const name = 'dsh-floatball'
export const inject = ['tools']

const ROOT = dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  version: '44.0.0',
  mirror: 'https://registry.npmmirror.com/-/binary/electron',
  electronPath: '',
  runtimeRoot: '',
  dataDir: join(ROOT, 'data'),
  servicesDir: '',
  autostart: true,
  restartLimit: 5,
  restartWindowMs: 600_000,
  qqsingUrl: 'http://127.0.0.1:31877',
  paintUrl: 'http://127.0.0.1:31878',
  queueUrl: 'http://127.0.0.1:31879',
}

export function mergeConfig(config = {}) {
  const raw = config && typeof config === 'object' ? config : {}
  const out = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    const value = raw[key]
    if (value === undefined || value === null || value === '') continue
    out[key] = value
  }
  out.dataDir = String(out.dataDir || DEFAULTS.dataDir)
  out.runtimeRoot = String(out.runtimeRoot || '')
  out.servicesDir = resolveServicesDir(out.servicesDir)
  out.version = String(out.version || DEFAULTS.version)
  out.autostart = out.autostart !== false
  out.restartLimit = Number.isFinite(Number(out.restartLimit)) ? Math.max(1, Number(out.restartLimit)) : DEFAULTS.restartLimit
  out.restartWindowMs = Number.isFinite(Number(out.restartWindowMs))
    ? Math.max(60_000, Number(out.restartWindowMs))
    : DEFAULTS.restartWindowMs
  return out
}

function makeLogger(file) {
  const stamp = () => new Date().toISOString().slice(11, 19)
  return (line) => {
    const text = `[${stamp()}] ${line}`
    // 日志写失败不该影响主流程
    appendFile(file, `${text}\n`, 'utf8').catch(() => {})
    void text
  }
}

/** 起球需要的环境变量：三个服务地址 + 令牌 + 父进程号 + 窗口位置文件。 */
function fillEnv(env, cfg, tokens) {
  env.BALL_STATE_PATH = join(cfg.dataDir, 'state', 'window.json')
  env.BALL_USER_DATA = join(cfg.dataDir, 'electron')
  env.BALL_HOST_PID = String(process.pid)
  env.BALL_QQSING_URL = String(cfg.qqsingUrl)
  env.BALL_PAINT_URL = String(cfg.paintUrl)
  env.BALL_QUEUE_URL = String(cfg.queueUrl)
  env.BALL_TOKEN_QQSING = tokens.qqsing
  env.BALL_TOKEN_PAINT = tokens.paint
  env.BALL_TOKEN_QUEUE = tokens.queue
  return env
}

async function readTokens(cfg) {
  const dir = cfg.servicesDir
  const [qqsing, paint, queue] = await Promise.all([
    readToken(dir, 'qq-sing'),
    readToken(dir, 'fish-paint'),
    readToken(dir, 'gpu-queue'),
  ])
  return { qqsing, paint, queue, dir, files: { qqsing: tokenPath(dir, 'qq-sing'), paint: tokenPath(dir, 'fish-paint'), queue: tokenPath(dir, 'gpu-queue') } }
}

export function createBall({ config = {}, log = () => {} } = {}) {
  const cfg = mergeConfig(config)
  const logFile = join(cfg.dataDir, 'state', 'ball.log')
  // 目录可能在第一次写日志前还没建好，这里不 await，写失败也不影响主流程
  mkdir(join(cfg.dataDir, 'state'), { recursive: true }).catch(() => {})
  const logger = (line) => {
    log(line)
    makeLogger(logFile)(line)
  }

  const env = {}
  let supervisorRef = null
  let prepareInFlight = null

  async function doPrepare({ install = true } = {}) {
    const status = await runtimeStatus({
      dataDir: cfg.dataDir,
      version: cfg.version,
      electronPath: cfg.electronPath,
      runtimeRoot: cfg.runtimeRoot,
    })
    if (status.ok) return status
    if (!install) return status
    const installed = await ensureRuntime({
      dataDir: cfg.dataDir,
      version: cfg.version,
      mirror: cfg.mirror,
      electronPath: cfg.electronPath,
      runtimeRoot: cfg.runtimeRoot,
      log: logger,
    })
    return installed
  }

  /**
   * 同一时刻只跑一份安装：自动启动和用户点「install」撞在一起时，
   * 两个任务会同时往同一个目录里 copy/download，Windows 上直接 EBUSY。
   */
  function prepare(options) {
    if (!prepareInFlight) {
      prepareInFlight = doPrepare(options).finally(() => {
        prepareInFlight = null
      })
    }
    return prepareInFlight
  }

  async function start() {
    const runtime = await prepare()
    if (!runtime.ok) {
      return { ok: false, code: 'RUNTIME_MISSING', message: 'Electron 运行时没装好，先跑 floatball_control action=install' }
    }
    const tokens = await readTokens(cfg)
    fillEnv(env, cfg, tokens)
    return startWithExe(runtime.exe)
  }

  function startWithExe(exe) {
    const fresh = createSupervisor({
      electronExe: exe,
      helperEntry: join(ROOT, 'helper', 'main.cjs'),
      env,
      dataDir: cfg.dataDir,
      log: logger,
      limit: cfg.restartLimit,
      windowMs: cfg.restartWindowMs,
    })
    const result = fresh.start()
    supervisorRef = fresh
    return { ...result, ok: true }
  }

  async function stop() {
    if (!supervisorRef) return { ok: true, alreadyStopped: true }
    return supervisorRef.stop({ reason: 'floatball_control' })
  }

  async function status() {
    const runtime = await runtimeStatus({
      dataDir: cfg.dataDir,
      version: cfg.version,
      electronPath: cfg.electronPath,
      runtimeRoot: cfg.runtimeRoot,
    })
    const supervisor = supervisorRef
      ? supervisorRef.status()
      : { running: false, pid: 0, startedAt: 0, crashes: 0, lastError: '', lastExit: null, statePath: statePathOf(cfg.dataDir) }
    const tokens = await readTokens(cfg)
    const snapshot = await collectSnapshot({
      endpoints: { qqsing: { url: cfg.qqsingUrl }, paint: { url: cfg.paintUrl }, queue: { url: cfg.queueUrl } },
      tokens: { qqsing: tokens.qqsing, paint: tokens.paint },
    })
    return {
      runtime: {
        ok: runtime.ok,
        exe: runtime.exe,
        dir: runtime.dir,
        root: runtime.root,
        ascii: runtime.ascii !== false,
        version: runtime.version,
        custom: Boolean(runtime.custom),
      },
      supervisor,
      servicesDir: tokens.dir,
      tokens: { qqsing: Boolean(tokens.qqsing), paint: Boolean(tokens.paint), queue: Boolean(tokens.queue) },
      tokenFiles: tokens.files,
      endpoints: { qqsing: cfg.qqsingUrl, paint: cfg.paintUrl, queue: cfg.queueUrl },
      snapshot,
      statePath: statePathOf(cfg.dataDir),
    }
  }

  return { cfg, env, start, stop, status, prepare, logger }
}

export function apply(ctx, config) {
  const ball = createBall({ config, log: () => {} })

  if (ball.cfg.autostart) {
    ctx.effect(() => {
      let disposed = false
      ball
        .start()
        .then((result) => {
          if (disposed && result?.ok) ball.stop().catch(() => {})
          if (!result?.ok) ball.logger(`[floatball] 自动启动跳过：${result?.message || '未知原因'}`)
        })
        .catch((error) => ball.logger(`[floatball] 自动启动失败：${error?.message || error}`))
      return () => {
        disposed = true
        ball.stop().catch(() => {})
      }
    })
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'floatball_status',
      description:
        '看悬浮球现在的状态：Electron 运行时装没装、球在不在跑（pid/崩溃次数）、三个本机服务（点歌 31877 / 画画 31878 / 显卡队列 31879）通不通、在唱什么、在画什么、显卡被谁占着。只读。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: 30_000,
      output: {
        schema: {
          type: 'object',
          properties: { summary: { type: 'string' }, running: { type: 'boolean' }, runtime: { type: 'object' } },
          required: ['summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.summary ?? '') }],
      },
      async execute() {
        const status = await ball.status()
        const lines = []
        lines.push(
          status.runtime.ok
            ? `运行时：Electron ${status.runtime.version}（${status.runtime.exe}）`
            : status.runtime.ascii === false
              ? `运行时：路径含中文，Electron 起不来（${status.runtime.dir}），跑 floatball_control action=install 换到 ASCII 目录`
              : `运行时：没装好（${status.runtime.dir}），跑 floatball_control action=install`,
        )
        lines.push(
          status.supervisor.running
            ? `球：在跑（pid ${status.supervisor.pid}）`
            : `球：没跑${status.supervisor.lastError ? `（上次错误：${status.supervisor.lastError}）` : ''}`,
        )
        lines.push(
          `令牌：点歌${status.tokens.qqsing ? '有' : '缺'} / 画画${status.tokens.paint ? '有' : '缺'} / 队列${status.tokens.queue ? '有' : '缺'}（${status.servicesDir}）`,
        )
        lines.push(summarizeSnapshot(status.snapshot))
        return { ...status, summary: lines.join('\n') }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'floatball_control',
      description:
        '控制悬浮球：action=install（下载 Electron 运行时并起球）、start（起）、stop（停）、restart（重启）、status（同 floatball_status 的摘要）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['install', 'start', 'stop', 'restart', 'status'], description: '要做什么' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      timeoutMs: 600_000,
      output: {
        schema: {
          type: 'object',
          properties: { summary: { type: 'string' }, action: { type: 'string' }, ok: { type: 'boolean' } },
          required: ['summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.summary ?? '') }],
      },
      async execute(args) {
        const action = String(args?.action || 'status')
        if (action === 'status') {
          const status = await ball.status()
          return {
            action,
            ok: true,
            ...status,
            summary: status.supervisor.running ? `球在跑（pid ${status.supervisor.pid}）` : '球没在跑',
          }
        }
        if (action === 'stop') {
          const result = await ball.stop()
          return { action, ok: true, ...result, summary: result.alreadyStopped ? '球本来就没跑' : '球已停' }
        }
        if (action === 'install') {
          const runtime = await ball.prepare({ install: true })
          if (!runtime.ok) return { action, ok: false, summary: `运行时装失败：${runtime.message || runtime.error || '未知'}` }
          const started = await ball.start()
          return {
            action,
            ok: Boolean(started.ok),
            runtime,
            summary: started.ok ? `运行时就绪，球起来了（pid ${started.pid}）` : `运行时就绪但球没起来：${started.message || ''}`,
          }
        }
        if (action === 'restart') {
          await ball.stop()
          const started = await ball.start()
          return { action, ok: Boolean(started.ok), ...started, summary: started.ok ? `球重启了（pid ${started.pid}）` : `重启失败：${started.message || ''}` }
        }
        const started = await ball.start()
        return { action, ok: Boolean(started.ok), ...started, summary: started.ok ? `球起来了（pid ${started.pid}）` : `起不来：${started.message || ''}` }
      },
    }),
  )
}
