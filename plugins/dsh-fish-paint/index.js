// dsh-fish-paint · 鱼鱼画画
//
// 宿主插件入口：注册 draw_image / draw_status / draw_setup / draw_recent 四个工具，
// 并提供一段 systemPrompt，告诉模型怎么把自然语言要求组织成 danbooru tags。
//
// 架构（详见 PLAN.md / CONTRACT.md）：
//   index.js → lib/engine.js（常驻 diffusers worker，JSONL 协议）
//            → lib/presets.js（画风预设/质量词/参数归一）
//            → lib/store.js（PNG 落盘 + 元数据 + rating sidecar + index.jsonl）
//            → lib/qq.js（QQ 投递 + bridge r18-guard 硬闸）
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createEngine } from './lib/engine.js'
import { PRESET_NAMES, buildArgs, presetSummary } from './lib/presets.js'
import { ensureDirs, listRecent, recordImage, todayDir } from './lib/store.js'
import { bridgeStatus, resolveBridgeDir, resolveFfmpeg, sendImages } from './lib/qq.js'
import {
  DEFAULT_COOLDOWN_MAX,
  DEFAULT_COOLDOWN_MINUTES,
  DEFAULT_VIP_LIST,
  isVip,
  normalizeRequester,
  parseVipList,
  releaseDraw,
  reserveDraw,
} from './lib/ratelimit.js'

export const name = 'dsh-fish-paint'
export const inject = ['tools', 'systemPrompt']

const ROOT = path.dirname(fileURLToPath(import.meta.url))

/** 配置默认值（patch 里是 {}，全部字段都可覆盖）。 */
const DEFAULTS = {
  idleMinutes: 30,
  maxVariants: 4,
  steps: 28,
  cfg: 5.5,
  vramMode: 'auto',
  // 限流：一个人 60 分钟只能请求画一次；vip 名单里的号不限。
  drawCooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
  drawCooldownMax: DEFAULT_COOLDOWN_MAX,
  vipList: DEFAULT_VIP_LIST,
}

/** 工具统一输出：execute 返回 payload，render 把 payload 变成 JSON 文本给模型看。 */
const JSON_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

export function apply(ctx, config) {
  const cfg = mergeConfig(config)
  try {
    ensureDirs(cfg.dataDir)
  } catch (error) {
    console.warn(`[fish-paint] 初始化数据目录失败（${cfg.dataDir}）：${error.message}`)
  }

  const engine = createEngine({
    root: ROOT,
    dataDir: cfg.dataDir,
    pythonPath: cfg.pythonPath,
    modelPath: cfg.modelPath,
    nsfwModelPath: cfg.nsfwModelPath,
    idleMinutes: cfg.idleMinutes,
    vramMode: cfg.vramMode,
  })

  // 插件卸载 / DSH 退出时杀掉 worker，别留孤儿进程。
  ctx.effect(() => () => engine.dispose())

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'fish-paint',
      order: 900,
      text: systemPromptText(cfg),
    }),
  )

  registerDrawImage(ctx, cfg, engine)
  registerDrawStatus(ctx, cfg, engine)
  registerDrawSetup(ctx, cfg, engine)
  registerDrawRecent(ctx, cfg)
}

// ── 配置 ───────────────────────────────────────────────────────────────

function mergeConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const pick = (key) => {
    const value = raw[key]
    return value === undefined || value === null || value === '' ? undefined : value
  }
  const dataDir = resolveFromRoot(pick('dataDir'), path.join(ROOT, 'data'))
  return {
    dataDir,
    pythonPath: resolveFromRoot(pick('pythonPath'), path.join(dataDir, '.venv', 'Scripts', 'python.exe')),
    modelPath: resolveFromRoot(pick('modelPath'), path.join(dataDir, 'models', 'Illustrious-XL-v2.0.safetensors')),
    // 第二个模型：NSFW 特化（WAI-NSFW-illustrious）。没下载时 auto 会和默认模型一样，不会因为缺文件报错。
    nsfwModelPath: resolveFromRoot(
      pick('nsfwModelPath'),
      path.join(dataDir, 'models', 'waiNSFWIllustrious_v150.safetensors'),
    ),
    // 默认模型：base=Illustrious（画风稳），nsfw=WAI（默认就画色图）。auto 逻辑见 pickModelKey。
    defaultModel: pick('defaultModel') === 'nsfw' ? 'nsfw' : 'base',
    // QQ 桥 / ffmpeg 不写死本机路径：config 优先，其次环境变量，最后自动探测。
    bridgeDir: resolveBridgeDir(pick('bridgeDir')),
    ffmpegPath: resolveFfmpeg(pick('ffmpegPath')),
    idleMinutes: numberIn(pick('idleMinutes'), 0, 1440, DEFAULTS.idleMinutes),
    maxVariants: integerIn(pick('maxVariants'), 1, 4, DEFAULTS.maxVariants),
    steps: integerIn(pick('steps'), 4, 80, DEFAULTS.steps),
    cfg: numberIn(pick('cfg'), 1, 20, DEFAULTS.cfg),
    vramMode: ['auto', 'full', 'offload'].includes(pick('vramMode')) ? pick('vramMode') : DEFAULTS.vramMode,
    // 限流：0 = 关闭；vipList 支持数组或 "1,2 3" 字符串，默认 2220222310。
    drawCooldownMinutes: numberIn(pick('drawCooldownMinutes'), 0, 1440, DEFAULTS.drawCooldownMinutes),
    drawCooldownMax: integerIn(pick('drawCooldownMax'), 1, 10, DEFAULTS.drawCooldownMax),
    vipList: parseVipList(pick('vipList') === undefined ? DEFAULTS.vipList : pick('vipList')),
  }
}

function resolveFromRoot(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return path.normalize(fallback)
  const trimmed = value.trim()
  return path.normalize(path.isAbsolute(trimmed) ? trimmed : path.resolve(ROOT, trimmed))
}

function numberIn(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

function integerIn(value, min, max, fallback) {
  const num = Math.trunc(Number(value))
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

/** 人类可读的窗口长度：60 → "1 小时"，90 → "90 分钟"。 */
function formatMinutes(minutes) {
  const value = Number(minutes)
  if (!Number.isFinite(value) || value <= 0) return '0 分钟'
  if (value >= 60 && value % 60 === 0) return `${value / 60} 小时`
  return `${Math.round(value)} 分钟`
}

/**
 * 画画限流：返回 { requester, blocked|null, release|null }。
 * blocked 是给模型的 RATE_LIMITED 失败 payload；release 在生成失败时退名额。
 */
function beginRateLimit(cfg, requester) {
  if (!requester) return { requester: '', blocked: null, release: null }

  // vip 名单里的人不限次数，也不记状态。
  if (isVip(requester, cfg.vipList)) return { requester, blocked: null, release: null, vip: true }

  const minutes = Number(cfg.drawCooldownMinutes)
  if (!(minutes > 0)) return { requester, blocked: null, release: null }

  const file = path.join(cfg.dataDir, 'state', 'draw-cooldown.json')
  const windowMs = minutes * 60_000
  let reservation
  try {
    reservation = reserveDraw({ file, requester, windowMs, max: cfg.drawCooldownMax })
  } catch (error) {
    // 只是限流台账写不进去，别把画画本身卡死。
    console.warn(`[fish-paint] 限流状态读写失败，本次放行：${error.message}`)
    return { requester, blocked: null, release: null }
  }

  if (!reservation.ok) {
    const minutesLeft = Math.max(1, Math.ceil(reservation.retryAfterSec / 60))
    return {
      requester,
      blocked: {
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          message: `一个人 ${formatMinutes(minutes)}只能请求画一次（vip 名单不限），还要等约 ${minutesLeft} 分钟。`,
          retryAfterSec: reservation.retryAfterSec,
          resetAt: reservation.resetAt,
        },
        requester,
        retryAfterSec: reservation.retryAfterSec,
        resetAt: reservation.resetAt,
        summary: `还在冷却：${requester} ${formatMinutes(minutes)}只能画一次，还要等约 ${minutesLeft} 分钟（vip 名单除外）。`,
      },
      release: null,
    }
  }

  return {
    requester,
    blocked: null,
    release: () => {
      try {
        releaseDraw({ file, requester, at: reservation.reservedAt, windowMs })
      } catch (error) {
        console.warn(`[fish-paint] 退还画画名额失败：${error.message}`)
      }
    },
  }
}

/**
 * 选模型：base=Illustrious（画风稳），nsfw=WAI-NSFW（色图）。
 * auto 时 rating=nsfw 且 NSFW 模型确实在盘上才切，缺文件就老老实实用默认模型，别把画画卡死。
 */
export function pickModelKey(cfg, requested, rating) {
  if (requested === 'nsfw') return 'nsfw'
  if (requested === 'base') return 'base'
  if (cfg.defaultModel === 'nsfw') return 'nsfw'
  if (rating === 'nsfw' && cfg.nsfwModelPath) {
    try {
      if (fs.existsSync(cfg.nsfwModelPath)) return 'nsfw'
    } catch {
      /* 路径不可读就当没有 */
    }
  }
  return 'base'
}

// ── draw_image ─────────────────────────────────────────────────────────

function registerDrawImage(ctx, cfg, engine) {
  return ctx.effect(() =>
    ctx.tools.register({
      name: 'draw_image',
      description:
        '画一张二次元插画/表情包：把 danbooru tags 交给本地 SDXL（Illustrious-XL）出图，存到本地；传了 target 就顺便发到 QQ 会话。' +
        `预设：${presetSummary()}。R18 图只在私聊或 QQ 桥 R18 白名单会话能发出去（有硬闸）。` +
        '出图后建议用 read_image 自己检查，不满意改 prompt/seed 重试，最多两轮。',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '正向提示词：英文 danbooru tags，逗号分隔。角色写成 `name (series)`，例如 `hatsune miku (vocaloid)`。',
          },
          negative: {
            type: 'string',
            description:
              '可选，额外负面词；会追加到默认负面词（含手指数/肢体/比例硬约束）后面，不能替换默认词。',
          },
          preset: {
            type: 'string',
            enum: PRESET_NAMES,
            description: '画风/尺寸预设：anime（默认方图 1024²）/ portrait（立绘 832×1216）/ landscape（横图 1216×832）/ sticker（表情包，存 512²）。',
          },
          width: { type: 'number', description: '可选，覆盖预设宽度（会按 8 取整，范围 256-2048）。' },
          height: { type: 'number', description: '可选，覆盖预设高度（会按 8 取整，范围 256-2048）。' },
          steps: { type: 'number', description: `采样步数，默认 ${DEFAULTS.steps}；越大越慢越细（4-80）。` },
          cfg: { type: 'number', description: `CFG scale，默认 ${DEFAULTS.cfg}（1-20）。` },
          seed: { type: 'number', description: '随机种子：-1 或不填 = 随机；返回实际 seed，可复现。' },
          variants: { type: 'number', description: '一次出几张变体 1-4，默认 1。' },
          rating: {
            type: 'string',
            enum: ['sfw', 'nsfw'],
            description: '内容分级，默认 sfw。nsfw 会写 rating=r18 的 sidecar，只有 R18 白名单会话能发送。',
          },
          model: {
            type: 'string',
            enum: ['auto', 'base', 'nsfw'],
            description:
              '可选，用哪个模型：auto（默认，rating=nsfw 且有 NSFW 模型时自动用 WAI-NSFW）/ base（Illustrious，画风稳）/ nsfw（WAI-NSFW，画色图用）。换模型会自动重启 worker（首次切换多等 10-30 秒）。',
          },
          target: {
            type: 'string',
            description: '可选，出图后自动发到 QQ：`group:群号` 或 `private:QQ号`。不传就只存本地。',
          },
          requester: {
            type: 'string',
            description:
              '可选，点图人的 QQ 号（QQ 会话里必须填消息发送者的 QQ 号）。限流就按它记账：默认一个人 60 分钟只能画一次，vip 名单里的号不限。不传不限流（本地/主会话直接用时不传）。',
          },
          note: { type: 'string', description: '可选备注（谁要的/什么梗），会写进元数据。' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      timeoutMs: 600_000,
      output: JSON_OUTPUT,
      async execute(args = {}) {
        return executeDrawImage(cfg, engine, args)
      },
    }),
  )
}

async function executeDrawImage(cfg, engine, args) {
  const rawPrompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!rawPrompt) {
    return failure({
      code: 'BAD_REQUEST',
      message: 'prompt 必填：先把用户的要求翻成英文 danbooru tags。',
    })
  }
  const targetCheck = normalizeTarget(args.target)
  if (targetCheck.error) return failure({ code: 'BAD_REQUEST', message: targetCheck.error })

  const rating = args.rating === 'nsfw' ? 'nsfw' : 'sfw'
  const modelKey = pickModelKey(cfg, args.model, rating)
  const variants = integerIn(args.variants, 1, cfg.maxVariants, 1)
  const built = buildArgs({
    preset: args.preset,
    prompt: rawPrompt,
    negative: args.negative,
    width: args.width,
    height: args.height,
    steps: args.steps === undefined ? cfg.steps : args.steps,
    cfg: args.cfg === undefined ? cfg.cfg : args.cfg,
    seed: args.seed,
    variants,
    maxVariants: cfg.maxVariants,
  })

  // 限流：和唱歌插件一个规矩——一个人 N 分钟只能请求画一次，vip 名单除外。
  const requester = normalizeRequester(args.requester)
  const rate = beginRateLimit(cfg, requester)
  if (rate.blocked) return rate.blocked

  let payload
  try {
    payload = await runDrawGeneration(cfg, engine, { built, rawPrompt, rating, targetCheck, args, modelKey })
  } finally {
    // 生成失败就把名额退回去，别让人因为一次 OOM 白等一小时。
    if (payload?.ok !== true && rate.release) rate.release()
  }
  if (rate.requester) payload.requester = rate.requester
  return payload
}

async function runDrawGeneration(cfg, engine, { built, rawPrompt, rating, targetCheck, args, modelKey }) {
  const startedAt = Date.now()
  let done
  let outDir
  try {
    outDir = todayDir(cfg.dataDir)
    done = await engine.generate({
      prompt: built.prompt,
      negative: built.negative,
      width: built.width,
      height: built.height,
      steps: built.steps,
      cfg: built.cfg,
      seed: built.seed,
      count: built.count,
      clipSkip: built.clipSkip,
      outDir,
      resize: built.resize,
      model: modelKey,
    })
  } catch (error) {
    return failure(error, { prompt: shorten(rawPrompt), preset: built.preset, rating, model: modelKey })
  }

  const elapsedSec = Number.isFinite(Number(done?.elapsedSec))
    ? Math.round(Number(done.elapsedSec) * 10) / 10
    : Math.round((Date.now() - startedAt) / 100) / 10
  const usedModelKey = done?.modelKey === 'nsfw' ? 'nsfw' : modelKey
  const modelFile = usedModelKey === 'nsfw' ? cfg.nsfwModelPath : cfg.modelPath
  const model = typeof done?.model === 'string' && done.model ? done.model : path.basename(modelFile, '.safetensors')
  const vramMode = typeof done?.vramMode === 'string' && done.vramMode ? done.vramMode : cfg.vramMode
  const loadSec = Number(done?.loadSec) || 0
  const cold = loadSec > 0

  // 落盘：同名 .json + rating sidecar + index.jsonl。发送前必须已经有 sidecar，R18 闸才判得准。
  const images = []
  try {
    for (const image of done.images) {
      const record = recordImage({
        dataDir: cfg.dataDir,
        image,
        meta: {
          prompt: built.prompt,
          negative: built.negative,
          preset: built.preset,
          width: built.width,
          height: built.height,
          steps: built.steps,
          cfg: built.cfg,
          seed: image.seed,
          model,
          modelKey: usedModelKey,
          engine: { vramMode, loadSec },
          rating,
          target: targetCheck.target,
          note: typeof args.note === 'string' ? args.note : '',
          elapsedSec,
        },
      })
      images.push({
        path: record.path,
        seed: record.seed,
        width: record.width ?? built.width,
        height: record.height ?? built.height,
      })
    }
  } catch (error) {
    return failure(error, { images })
  }
  if (images.length === 0) {
    return failure({ code: 'BAD_RESPONSE', message: '引擎没有返回任何图片' })
  }

  let sent
  let sentError
  if (targetCheck.target) {
    try {
      const result = await sendImages({
        key: targetCheck.target,
        paths: images.map((image) => image.path),
        text: '',
        bridgeDir: cfg.bridgeDir,
        ffmpegPath: cfg.ffmpegPath,
      })
      sent = {
        key: targetCheck.target,
        kind: result.kind,
        count: result.sent?.length ?? images.length,
        messageId: result.sent?.[0]?.messageId ?? null,
      }
    } catch (error) {
      // 发送失败不丢图：本地文件都在，把原因告诉模型即可。
      sentError = String(error?.message || error)
    }
  }

  const summary = drawSummary({ built, images, elapsedSec, model, modelKey: usedModelKey, vramMode, cold, sent, sentError })
  const payload = {
    ok: true,
    images,
    elapsedSec,
    model,
    modelKey: usedModelKey,
    engine: { mode: vramMode, cold },
    prompt: shorten(built.prompt, 400),
    negative: built.negative,
    preset: built.preset,
    rating,
    summary,
  }
  if (loadSec > 0) payload.loadSec = Math.round(loadSec * 10) / 10
  if (sent) payload.sent = sent
  if (sentError) payload.sentError = sentError
  return payload
}

function drawSummary({ built, images, elapsedSec, model, modelKey, vramMode, cold, sent, sentError }) {
  const seeds = images.map((image) => image.seed).join(', ')
  const lines = [
    `已生成 ${images.length} 张（${built.preset} ${built.width}×${built.height}，耗时 ${elapsedSec}s，seed ${seeds}，模型 ${model}${modelKey === 'nsfw' ? '（NSFW）' : ''}，vramMode=${vramMode}${cold ? '，本次冷启动加载了模型' : ''}）。`,
    `文件：${images.map((image) => image.path).join('；')}`,
    `提示词摘要：${shorten(built.prompt, 160)}`,
  ]
  if (sent) lines.push(`已发送到 ${sent.key}（${sent.count} 张${sent.messageId ? `，messageId=${sent.messageId}` : ''}）。`)
  else if (sentError) lines.push(`图片已保存但发送失败：${sentError}（图没丢，可以再发一次）。`)
  else lines.push('没有指定 target，图只存在本地。')
  return lines.join(' ')
}

// ── draw_status ────────────────────────────────────────────────────────

function registerDrawStatus(ctx, cfg, engine) {
  return ctx.effect(() =>
    ctx.tools.register({
      name: 'draw_status',
      description:
        '看画图引擎状态：安装（venv/python/模型文件）、worker 是否在跑、显存与 vramMode、队列、安装进度（setup.json）、最近 5 张生成、最近错误与下一步建议。' +
        '画图失败、发不出图、或不确定装没装好时先看它。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: 60_000,
      output: JSON_OUTPUT,
      async execute() {
        try {
          return await buildStatusPayload(cfg, engine, 5)
        } catch (error) {
          return failure(error)
        }
      },
    }),
  )
}

async function buildStatusPayload(cfg, engine, recentLimit) {
  let workerStatus
  let statusError = null
  try {
    workerStatus = await engine.status()
  } catch (error) {
    statusError = { code: error?.code || 'STATUS_FAILED', message: String(error?.message || error) }
    workerStatus = null
  }
  const install = engine.installState()
  const setup = readSetupState(cfg.dataDir)
  const recent = safeListRecent(cfg.dataDir, recentLimit)
  const bridge = readBridgeState(cfg.bridgeDir)
  const gpu = workerStatus?.worker?.gpu ?? null
  const worker = workerStatus
    ? {
        running: workerStatus.running,
        ready: workerStatus.ready,
        pid: workerStatus.pid,
        pendingOps: workerStatus.pendingOps,
        queueDepth: workerStatus.queueDepth,
        crashStreak: workerStatus.crashStreak,
        cooldownMsLeft: workerStatus.cooldownMsLeft,
        note: workerStatus.note,
        error: workerStatus.error,
        readyInfo: workerStatus.readyInfo,
        live: workerStatus.worker,
      }
    : null

  const next = []
  if (!install.pythonExists || !install.workerScriptExists) next.push('先跑 draw_setup action=install 安装引擎（后台约 30-40 分钟）。')
  else if (!install.modelExists) next.push('模型文件缺失：跑 draw_setup action=install 下载模型。')
  else if (setup.running) next.push(`安装正在进行（${setup.phase} ${setup.percent}%），过几分钟再 draw_status 看。`)
  else if (workerStatus?.cooldownMsLeft > 0) next.push('引擎连续崩溃冷却中：等 1 分钟再看 data/state/worker.log 找原因。')
  else if (!workerStatus?.running) next.push('引擎空闲未启动，第一次 draw_image 会自动加载模型（约 30-60 秒）。')
  const nsfwReady = Boolean(cfg.nsfwModelPath) && fs.existsSync(cfg.nsfwModelPath)
  if (install.ok && !nsfwReady) next.push('NSFW 模型未就绪（可选）：rating=nsfw 时会退回默认模型；想画色图用 WAI-NSFW 看 README「换模型」。')
  if (statusError) next.push(`状态查询失败：${statusError.message}`)
  if (bridge.error) next.push(`QQ 桥不可用（${bridge.error}）：能出图但不能发送；填 config.bridgeDir 或设 FISH_PAINT_BRIDGE_DIR 后重试。`)

  const errors = []
  if (setup.error) errors.push({ source: 'setup', message: String(setup.error) })
  if (workerStatus?.error) errors.push({ source: 'worker', ...workerStatus.error })
  if (statusError) errors.push({ source: 'engine', ...statusError })
  const workerLogTail = tailFile(path.join(cfg.dataDir, 'state', 'worker.log'), 6)
  const setupLogTail = tailFile(path.join(cfg.dataDir, 'state', 'setup.log'), 4)

  const summary = statusSummary({ install, setup, workerStatus, gpu, recent, bridge, cfg })
  return {
    ok: true,
    installed: install.ok,
    paths: {
      root: ROOT,
      dataDir: cfg.dataDir,
      pythonPath: cfg.pythonPath,
      modelPath: cfg.modelPath,
      nsfwModelPath: cfg.nsfwModelPath,
      bridgeDir: cfg.bridgeDir,
      ffmpegPath: cfg.ffmpegPath,
      workerLog: path.join(cfg.dataDir, 'state', 'worker.log'),
      setupLog: path.join(cfg.dataDir, 'state', 'setup.log'),
    },
    models: workerStatus?.models ?? null,
    currentModel: workerStatus ? { key: workerStatus.modelKey, path: workerStatus.modelPath } : null,
    python: { path: cfg.pythonPath, exists: install.pythonExists },
    model: {
      path: cfg.modelPath,
      exists: install.modelExists,
      bytes: install.modelBytes,
      sizeText: formatBytes(install.modelBytes),
    },
    nsfwModel: {
      path: cfg.nsfwModelPath,
      exists: nsfwReady,
      sizeText: nsfwReady ? formatBytes(fileSize(cfg.nsfwModelPath)) : '0 B',
    },
    workerScript: { path: install.workerScript, exists: install.workerScriptExists },
    vramMode: cfg.vramMode,
    idleMinutes: cfg.idleMinutes,
    limits: {
      cooldownMinutes: cfg.drawCooldownMinutes,
      cooldownMax: cfg.drawCooldownMax,
      vipList: cfg.vipList,
      stateFile: path.join(cfg.dataDir, 'state', 'draw-cooldown.json'),
    },
    gpu,
    worker,
    setup,
    recent,
    bridge,
    errors,
    recentWorkerLog: workerLogTail,
    recentSetupLog: setupLogTail,
    next,
    summary,
  }
}

function statusSummary({ install, setup, workerStatus, gpu, recent, bridge, cfg }) {
  const parts = []
  parts.push(install.ok ? '引擎已安装' : `引擎未安装（缺 ${install.missing.length} 项）`)
  const nsfwReady = Boolean(cfg?.nsfwModelPath) && fs.existsSync(cfg.nsfwModelPath)
  parts.push(nsfwReady ? '模型：Illustrious + WAI-NSFW' : '模型：Illustrious（NSFW 模型未下载）')
  if (setup.running) parts.push(`安装进行中：${setup.phase} ${setup.percent}%`)
  else if (setup.present && setup.phase === 'done') parts.push('安装已完成')
  if (workerStatus?.running) {
    const gpuText = gpu && gpu.freeMiB ? `，GPU 空闲 ${gpu.freeMiB}/${gpu.totalMiB} MiB` : ''
    parts.push(`worker 在跑（pid ${workerStatus.pid}，vramMode=${workerStatus.vramMode}${gpuText}）`)
  } else if (install.ok) {
    parts.push('worker 未启动（第一次画图会自动加载）')
  }
  if (workerStatus?.cooldownMsLeft > 0) parts.push(`冷却中还剩约 ${Math.ceil(workerStatus.cooldownMsLeft / 1000)} 秒`)
  parts.push(`最近生成 ${recent.length} 张`)
  parts.push(bridge.ok ? `QQ 桥可用（${bridge.kind}，R18 名单 ${bridge.r18Count} 个）` : `QQ 桥不可用：${bridge.error}`)
  return `${parts.join('；')}。`
}

// ── draw_setup ─────────────────────────────────────────────────────────

function registerDrawSetup(ctx, cfg, engine) {
  return ctx.effect(() =>
    ctx.tools.register({
      name: 'draw_setup',
      description:
        '安装 / 检查画图引擎。action=install：后台跑 engine/setup.mjs 建 venv、装 torch/diffusers、下载 6.6G 模型（约 30-40 分钟，进度写 data/state/setup.json，日志 data/state/setup.log）；' +
        'action=verify：用已装好的引擎生成一张 512×512 冒烟图确认能画；action=status：只读状态。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'install', 'verify'],
            description: 'status=看安装状态；install=后台开始安装/续传；verify=跑一张冒烟图验证。',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      timeoutMs: 600_000,
      output: JSON_OUTPUT,
      async execute(args = {}) {
        const action = String(args.action || 'status')
        if (action === 'install') return startInstall(cfg)
        if (action === 'verify') return verifyEngine(cfg, engine)
        if (action === 'status') return setupStatus(cfg, engine)
        return failure({ code: 'BAD_REQUEST', message: 'action 只能是 status / install / verify' })
      },
    }),
  )
}

function setupStatus(cfg, engine) {
  const install = engine.installState()
  const setup = readSetupState(cfg.dataDir)
  const next = []
  if (!install.ok) next.push('跑 draw_setup action=install 开始安装。')
  else if (setup.running) next.push('安装进行中，等进度。')
  else next.push('引擎已就绪，可以直接 draw_image。')
  return {
    ok: true,
    installed: install.ok,
    missing: install.missing,
    paths: { dataDir: cfg.dataDir, pythonPath: cfg.pythonPath, modelPath: cfg.modelPath },
    setup,
    recentSetupLog: tailFile(path.join(cfg.dataDir, 'state', 'setup.log'), 8),
    next,
    summary: install.ok
      ? `引擎已安装${setup.running ? `，安装进行中（${setup.phase} ${setup.percent}%）` : '并可用'}。`
      : `引擎未安装，缺：${install.missing.join('、')}。跑 draw_setup action=install。`,
  }
}

function startInstall(cfg) {
  const setup = readSetupState(cfg.dataDir)
  const updatedMs = Date.parse(setup.updatedAt || '')
  const looksRunning = setup.running === true && Number.isFinite(updatedMs) && Date.now() - updatedMs < 10 * 60 * 1000
  if (looksRunning) {
    return {
      ok: true,
      started: false,
      running: true,
      setup,
      summary: `安装已经在跑（${setup.phase} ${setup.percent}%）：${setup.message || ''}。用 draw_status 看进度。`,
    }
  }

  const script = path.join(ROOT, 'engine', 'setup.mjs')
  if (!fs.existsSync(script)) {
    return failure({ code: 'NOT_INSTALLED', message: `找不到安装脚本：${script}（插件文件不完整）` })
  }
  const stateDir = path.join(cfg.dataDir, 'state')
  fs.mkdirSync(stateDir, { recursive: true })
  const logFile = path.join(stateDir, 'setup.log')
  let logFd = null
  try {
    logFd = fs.openSync(logFile, 'a')
  } catch {
    logFd = 'ignore'
  }
  let child
  try {
    child = spawn(process.execPath, [script, '--install'], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    })
  } catch (error) {
    return failure({ code: 'INSTALL_FAILED', message: `启动安装进程失败：${error.message}` })
  } finally {
    if (typeof logFd === 'number') {
      try {
        fs.closeSync(logFd)
      } catch {
        /* 父进程关掉自己的 fd 不影响子进程继承的那份 */
      }
    }
  }
  child.unref()
  return {
    ok: true,
    started: true,
    pid: child.pid ?? null,
    log: logFile,
    message: '已开始安装/更新引擎（后台），进度看 data/state/setup.json、日志 data/state/setup.log。用 draw_status 看进度。',
    summary: '已开始安装引擎：后台建 venv → 装 torch/diffusers → 下载模型（约 30-40 分钟）。用 draw_status 看进度，装完跑 draw_setup action=verify 验证。',
  }
}

async function verifyEngine(cfg, engine) {
  const install = engine.installState()
  if (!install.ok) {
    return failure({ code: 'NOT_INSTALLED', message: install.message })
  }
  const smokePrompt = '1girl, solo, masterpiece'
  try {
    const outDir = todayDir(cfg.dataDir)
    const done = await engine.generate({
      prompt: smokePrompt,
      negative: '',
      width: 512,
      height: 512,
      steps: 12,
      cfg: 5.5,
      seed: 42,
      count: 1,
      clipSkip: 2,
      outDir,
    })
    const image = done.images?.[0]
    const record = recordImage({
      dataDir: cfg.dataDir,
      image,
      meta: {
        prompt: smokePrompt,
        negative: '',
        preset: 'anime',
        width: 512,
        height: 512,
        steps: 12,
        cfg: 5.5,
        seed: image?.seed,
        model: done.model,
        engine: { vramMode: done.vramMode, loadSec: done.loadSec },
        rating: 'sfw',
        target: null,
        note: 'draw_setup verify 冒烟图',
        elapsedSec: done.elapsedSec,
      },
    })
    return {
      ok: true,
      verified: true,
      image: { path: record.path, seed: record.seed, width: record.width, height: record.height },
      elapsedSec: done.elapsedSec,
      model: done.model,
      loadSec: done.loadSec,
      summary: `冒烟图生成成功：${record.path}（seed ${record.seed}，耗时 ${done.elapsedSec}s${Number(done.loadSec) > 0 ? `，加载模型 ${done.loadSec}s` : ''}）。引擎可用。`,
    }
  } catch (error) {
    return failure(error, { summaryPrefix: '冒烟图生成失败' })
  }
}

// ── draw_recent ────────────────────────────────────────────────────────

function registerDrawRecent(ctx, cfg) {
  return ctx.effect(() =>
    ctx.tools.register({
      name: 'draw_recent',
      description: '列最近生成的图（默认 10 张，可按日期 / target 过滤）：路径、提示词摘要、时间、rating、seed，方便回看或重发。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回几条，1-50，默认 10。' },
          date: { type: 'string', description: '只看某一天，格式 YYYY-MM-DD（本地时区）。' },
          target: { type: 'string', description: '只看发往某个会话的记录，如 group:1104418054 / private:2220222310。' },
        },
        additionalProperties: false,
      },
      timeoutMs: 30_000,
      output: JSON_OUTPUT,
      async execute(args = {}) {
        const limit = integerIn(args.limit, 1, 50, 10)
        const date = typeof args.date === 'string' ? args.date.trim() : ''
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return failure({ code: 'BAD_REQUEST', message: 'date 格式必须是 YYYY-MM-DD' })
        }
        const targetCheck = normalizeTarget(args.target)
        if (targetCheck.error) return failure({ code: 'BAD_REQUEST', message: targetCheck.error })
        const records = safeListRecent(cfg.dataDir, 50, { date, target: targetCheck.target }).slice(0, limit)
        const items = records.map((record) => describeRecord(record))
        return {
          ok: true,
          count: items.length,
          date: date || null,
          target: targetCheck.target,
          items,
          summary: items.length
            ? `最近 ${items.length} 张：` + items.map((item) => `${item.path}（${item.rating}，${item.createdAt}，${shorten(item.prompt, 60)}）`).join('；')
            : '没有匹配的生成记录。',
        }
      },
    }),
  )
}

function describeRecord(record) {
  return {
    path: record.path,
    prompt: shorten(record.prompt, 300),
    createdAt: record.createdAt,
    rating: record.rating,
    seed: record.seed,
    preset: record.preset,
    width: record.width,
    height: record.height,
    target: record.target,
    note: record.note || '',
  }
}

// ── 共用工具 ───────────────────────────────────────────────────────────

function readSetupState(dataDir) {
  const file = path.join(dataDir, 'state', 'setup.json')
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    raw = null
  }
  if (!raw || typeof raw !== 'object') {
    return {
      present: false,
      file,
      ok: false,
      running: false,
      phase: 'missing',
      percent: 0,
      message: '还没跑过安装（data/state/setup.json 不存在）',
      error: null,
      updatedAt: null,
    }
  }
  return {
    present: true,
    file,
    ok: raw.ok === true,
    running: raw.running === true,
    phase: typeof raw.phase === 'string' ? raw.phase : 'unknown',
    percent: Number(raw.percent) || 0,
    message: typeof raw.message === 'string' ? raw.message : '',
    error: raw.error ?? null,
    startedAt: raw.startedAt ?? null,
    updatedAt: raw.updatedAt ?? null,
    bytes: raw.bytes ?? null,
    sizes: raw.sizes ?? null,
  }
}

function readBridgeState(bridgeDir) {
  try {
    const info = bridgeStatus(bridgeDir)
    return {
      ok: true,
      dir: info.dir,
      kind: info.allow.groups.length || info.allow.private.length ? '有白名单' : info.allowAllWhenEmpty ? 'allowAllWhenEmpty' : '白名单为空',
      allow: info.allow,
      deny: info.deny,
      r18Count: info.r18.groups.length + info.r18.private.length,
      r18: { groups: info.r18.groups.length, private: info.r18.private.length },
      error: null,
    }
  } catch (error) {
    return { ok: false, dir: bridgeDir, error: String(error?.message || error) }
  }
}

function safeListRecent(dataDir, limit, options = {}) {
  try {
    return listRecent(dataDir, { limit, ...options })
  } catch {
    return []
  }
}

function normalizeTarget(value) {
  if (value === undefined || value === null || value === '') return { target: null }
  if (typeof value !== 'string') return { error: 'target 必须是字符串' }
  const trimmed = value.trim()
  if (!/^(group|private):\d+$/.test(trimmed)) {
    return { error: 'target 格式必须是 group:群号 或 private:QQ号，例如 group:1104418054 / private:2220222310' }
  }
  return { target: trimmed }
}

function failure(error, extra = {}) {
  const code = typeof error?.code === 'string' ? error.code : 'DRAW_FAILED'
  const message = String(error?.message || error || '未知错误')
  const nsfwModelIssue = code === 'MODEL_MISSING' && /NSFW/i.test(message)
  const hint = nsfwModelIssue
    ? 'NSFW 模型还没装：按 README「换模型」下载 WAI-NSFW 后重载插件；或者把 model 改成 base 用默认模型。'
    : code === 'NOT_INSTALLED' || code === 'MODEL_MISSING'
      ? '先 draw_setup action=install 安装引擎/模型，再用 draw_status 看进度。'
      : code === 'OOM'
        ? '显存不够：降低尺寸（portrait 或更小）或 steps 后重试。'
        : code === 'COOLDOWN'
          ? '引擎连续崩溃进入冷却，等约 1 分钟；反复崩溃看 data/state/worker.log。'
          : code === 'BAD_REQUEST'
            ? ''
            : '可以先 draw_status 看引擎状态。'
  const prefix = extra.summaryPrefix ? `${extra.summaryPrefix}：` : '画图失败'
  return {
    ok: false,
    error: { code, message, ...(hint ? { hint } : {}) },
    summary: `${prefix}（${code}）${message}${hint ? ` ${hint}` : ''}`,
  }
}

function tailFile(file, maxLines, maxBytes = 64 * 1024) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size === 0) return []
    const start = Math.max(0, stat.size - maxBytes)
    const length = stat.size - start
    const buffer = Buffer.alloc(length)
    const fd = fs.openSync(file, 'r')
    try {
      fs.readSync(fd, buffer, 0, length, start)
    } finally {
      fs.closeSync(fd)
    }
    return buffer
      .toString('utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-maxLines)
  } catch {
    return []
  }
}

function formatBytes(bytes) {
  const num = Number(bytes)
  if (!Number.isFinite(num) || num <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = num
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(index >= 2 ? 1 : 0)} ${units[index]}`
}

function fileSize(file) {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() ? stat.size : 0
  } catch {
    return 0
  }
}

function shorten(text, max = 160) {
  const cleaned = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length <= max) return cleaned
  return `${cleaned.slice(0, max)}…`
}

// ── systemPrompt ───────────────────────────────────────────────────────

function systemPromptText(cfg) {
  return [
    '## 鱼鱼画画（draw_image）',
    '当用户要「画一张 / 画个 / 生成一张图 / 来个表情包 / 给这段配个图」时，用 draw_image 让本地 SDXL（默认 Illustrious-XL，色图可自动切 WAI-NSFW）出图。插件不调 LLM，提示词由你负责组织。',
    '',
    '**1. 先把中文要求翻成英文 danbooru tags（逗号分隔）**',
    '- 质量词不用自己写（插件自动补 masterpiece, best quality, very aesthetic, absurdres, perfect hands），重复了会被去重；想让手部更稳可以再补 `detailed hands`。',
    '- 角色写 `角色名 (系列名)`，如 `hatsune miku (vocaloid)`；点名了具体角色就按第 2 节先去 P 站对齐；不确定系列就只写外观特征（hair color/eyes/服装）。',
    '- 主体、动作、服装、构图、背景、镜头、光照分开写 tag；多人写人数（`2girls`）并用权重 `(tag:1.2)` 强调主要角色。',
    '- 例：`1girl, solo, silver hair, blue eyes, school uniform, cherry blossoms, upper body, looking at viewer`',
    '- 默认负面词始终生效，已覆盖低质量/文字/水印，以及手部硬约束（bad hands、extra fingers、fewer fingers、extra digits…）、肢体与比例（extra limbs、extra arms、bad proportions…）和脸崩；negative 参数只用来**追加**要额外规避的东西（如 logo、indoor），不会替换默认词。画全身/手部特写时把动作写具体一点（`hands together`、`peace sign`），比堆负面词管用。',
    '',
    '**2. 点名角色时：先去 P 站对齐角色（别靠猜）**',
    '- 只要用户点名了一个具体角色（中文名、日文名、外号都算），出图前先调 `mcp__pixiv__px_search`（kind=illust，queries 填角色名；中文名直接搜，搜不到再换日文/英文名；minBookmarks 设 200-500、sort=popular_desc）——看返回的 `tags`：通常同时能拿到作品名（`translated` 字段，如 `明日方舟` → `Arknights`）、角色名（如 `提丰` → `Typhon`）和外观词（`白髪` → white hair、`エルフ` → elf）。',
    '- 用「角色 + 作品」拼出 SDXL 认的 danbooru 角色标签（`typhon (arknights)`、`frieren (sousou no frieren)`、`hatsune miku (vocaloid)`），再挑 3-6 个外观 tag（发色/瞳色/发型/服装/标志性配件）翻成英文——这两样才是画像一个角色的关键。',
    '- 搜索结果里只取角色/作品/外观信息；R-18、猎奇和癖好标签（R-18、R-18G、緊縛、寝取られ…）以及质量词都忽略，不要写进 prompt。`px_detail` 能看单张作品的完整标签；主会话还可以 `px_fetch` 下载后用 read_image 看一眼确认长相。',
    '- 常见角色也照样搜一次确认系列名（几秒的事，比凭记忆写错系列重画便宜）；拿不准（同名角色多、搜索结果对不上、名字是外号）时，把 1 张参照图发到会话问一句「是这个角色吗」（QQ 里别把 R-18 图发到非 R-18 会话），确认了再画。',
    '- 搜不到或这个会话里没有 pixiv 工具：按你知道的画，并在回复里顺口说一句「没找到参考、可能不太准」；不要瞎编作品名或角色 tag。',
    '- 跳过这一步：画自己/大肥鱼/DeepSeek-Chan（走第 6 节固定人设）、用户没点名角色（「画个银发少女」这种纯描述）、用户明确说不用查。',
    '- 别把搜索过程、tag 列表念给用户听；一句「我找了下这角色的设定」带过就行。',
    '',
    '**3. 选 preset（尺寸/画风）**',
    `当前预设：${presetSummary()}。人物立绘/半身用 portrait，场景/横图用 landscape，表情包用 sticker（chibi + 厚描边，1024² 生成后存 512²），不确定就用 anime。`,
    `默认 steps=${DEFAULTS.steps}、cfg=${DEFAULTS.cfg}（config 可覆盖）。想要可复现就记住返回的 seed，下次传同一个 seed。`,
    '',
    '**4. 出图 → 自检 → 重试（最多两轮）**',
    '- 调 draw_image 后**用 read_image 看一眼**：崩坏、多手指、构图差、风格不对就改 prompt（补细节/换构图词）或换 seed/preset 重试。看不到 read_image 的会话（比如 QQ 桥）跳过自检直接发送，别反复试。',
    '- 最多重试 2 轮，还不满意就把当前结果给用户，别无限刷（每次都要真跑 GPU）。',
    '- 图默认存本地 data/out/；要发到会话就传 target（`group:群号` / `private:QQ号`），一次最多 4 张变体，发 QQ 时插件会自动分批。',
    '',
    '**5. R18 口径**',
    '- 群聊默认 sfw。nsfw 只在私聊、或该会话在 QQ 桥的 R18 白名单里才用；插件发送前会按 sidecar + bridge 的 r18-guard 硬闸判定，不满足会拒绝发送并把原因放在 sentError。',
    '- 被拒时把原因告诉用户，不要换别的发图工具绕过；图已保存在本地，用户允许时可以再发。',
    '',
    '**6. 画自己 / 大肥鱼（固定人设，不要自由发挥）**',
    '- 有人要「画你 / 画大肥鱼 / 画 DeepSeek-chan / 你自己长什么样」时，用下面这套固定 tag（蓝发鲸娘女仆；设定与来源见 docs/characters/deepseek-chan.md），只替换动作、表情、构图、背景：',
    '- 基础：`1girl, solo, deepseek-chan, long blue hair, wavy hair, gradient hair, ahoge, blue eyes, whale ears, whale tail, blush, smile`',
    '- 服装：`maid, maid headdress, frilled apron, white apron, dark blue dress, long dress, gold trim, long sleeves, frilled cuffs, white thighhighs, blue mary janes`',
    '- 构图：立绘用 portrait，提示词开头写 `full body, standing` 再写角色，最后加 `hands together, looking at viewer`（放最后容易只出半身）；头像用 anime + `upper body`；表情包用 sticker + `chibi, simple background, thick outline`。',
    '- 背景默认 `(light blue background:1.2), soft lighting`；negative 补 `text, watermark, logo, multiple views, character sheet, indoor, wooden`，避免画成设定集或木屋背景。',
    '- 「大肥鱼」就是她本人（鲸娘），不要画成真鱼或胖鱼。',
    '',
    '**7. 失败时**',
    '- 先看返回的 error.code：NOT_INSTALLED / MODEL_MISSING → 让用户跑 draw_setup action=install；OOM → 降尺寸或 steps；COOLDOWN → 等冷却。',
    '- draw_status 看安装/worker/显存/最近错误/下一步；draw_setup action=verify 能跑一张 512² 冒烟图确认引擎可用；draw_recent 回看最近生成的图（按日期/target 过滤）。',
    `日志在 ${path.join(cfg.dataDir, 'state', 'worker.log')} 与 ${path.join(cfg.dataDir, 'state', 'setup.log')}。`,
    '',
    '**8. 限流（requester，跟唱歌一个规矩）**',
    `- QQ 会话里调 draw_image 必须把点图人的 QQ 号填进 \`requester\`（发消息那个群友的 QQ 号）；一个人 ${formatMinutes(cfg.drawCooldownMinutes)}只能请求画一次，vip 名单（${cfg.vipList.length ? cfg.vipList.join(', ') : '空'}）里的人不限。`,
    '- 返回 error.code=RATE_LIMITED 时，把「还要等约 X 分钟」告诉对方就行；不要换号、不要反复重试，也不要说「管理员不让画」。',
    '',
    '**9. 两个模型（model 参数，可选）**',
    `- 默认模型是 Illustrious-XL-v2.0（画风稳，角色插画首选）；另有一个 NSFW 特化模型 WAI-NSFW-illustrious${nsfwModelReady(cfg) ? '（已就绪）' : '（未下载时 auto 会退回默认模型）'}，画色图时人体/质感更好。`,
    '- 一般不用手动传 model：rating=nsfw 且 NSFW 模型在盘上时会自动切过去；想强制指定就传 `model="base"`（Illustrious）或 `model="nsfw"`（WAI）。',
    '- 切换模型会重启 worker（首次多等 10-30 秒），同一轮别来回切；连着画色图时保持 nsfw 更省时间。',
    '',
    '**10. 画群友 / 画个我（先查档案馆的印象，再画）**',
    '- 群友说「画个我 / 画我 / 画一下我」时，只画**当前发言人本人**，不画被 @ 或点名的人；先调 `qq_impression`（`user`=发言人的 QQ 号，`chat`=当前会话的 `group:群号`；QQ 号从消息的 userId/发送者取，别猜）拿档案馆里缓存的印象与标签。',
    '- found=true：把印象里的性格、梗、习惯翻成**画面元素**（表情、动作、服装配色、随身小物、背景彩蛋），默认画成二次元少女、用 portrait，动漫插画风；可以按梗夸张、画得损一点，但不要画成真人、不要写实化，也不要出现现实身份线索（职业/学校/住址等）。',
    '- 把 `tags` 和印象文字只当灵感，不要原样塞进英文 prompt：先转成具体 danbooru tag（发型/发色/瞳色/服装/动作/表情/构图/背景），再调 draw_image；requester 照旧填发言人 QQ 号、target 填当前会话。',
    '- found=false 或这个人在缓存里没有印象：照实说「还没攒够你的印象，多聊几句再来」；**不要当场调 LLM 生成印象、不要凭空编人设**，也不要硬画一个通用萌妹糊弄过去。',
    '- 不要把印象原文念给群友听（那是档案，不是画）；画完一句话说「照你平时的样子/梗画的」即可。',
    '- 只在有 `qq_impression` 工具的会话里走这条路；没有这个工具（比如没有档案馆插件的主会话）就按普通画图处理，别假装查过。',
  ].join('\n')
}

/** systemPrompt 里说明 NSFW 模型在不在（apply 时算一次，重载插件后刷新）。 */
function nsfwModelReady(cfg) {
  const file = typeof cfg?.nsfwModelPath === 'string' ? cfg.nsfwModelPath : ''
  if (!file) return false
  try {
    return fs.existsSync(file)
  } catch {
    return false
  }
}
