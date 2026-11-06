/**
 * dsh-qq-voice — 让智能体把「大肥鱼」的声音直接发到 QQ 里。
 *
 * 链路：
 *   text ──► D:\GSV\gsv\gsv_speak.py（本地 GPT-SoVITS，大肥鱼音色）──► 临时 wav
 *        ──► QQ 桥操作者通道 POST /api/voice/send（consoleToken + 白名单 + 语音限流 + 落地校验）
 *        ──► SnowLuma record 段 ──► QQ 语音条
 *
 * 为什么走「操作者通道」而不是 AI 通道（/api/socialV2/send-voice）：
 *   AI 通道要求 socialV2.voice.enabled === true，且只能读语音库里的文件、只允许当前会话；
 *   操作者通道用 consoleToken 鉴权，允许库外绝对路径（我们自己渲染的临时 wav 就在库外），
 *   白名单、语音限流、文件名审计、get_msg 落地校验一个都不少 —— 对「本机插件」来说这才是正路。
 *
 * 失败时保留 wav 便于排查，成功默认删掉（keepAudio=true 可保留）。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, mkdir, unlink, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

export const name = 'dsh-qq-voice'
export const inject = ['tools']

const execFileP = promisify(execFile)
const MAX_BUFFER = 32 * 1024 * 1024

const DEFAULTS = {
  // QQ 桥控制台（操作者通道）
  bridgeUrl: 'http://127.0.0.1:3100',
  // QQ 桥安装目录：用于读白名单（config.json）和兜底读控制台令牌（state/console-token）
  bridgeDir: 'D:\\DPQQ\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1',
  // 留空则自动从 bridgeDir 里读
  consoleToken: '',
  // 本地 TTS
  pythonPath: 'D:\\GSV\\GPT-SoVITS-v2pro-20250604\\runtime\\python.exe',
  ttsScript: 'D:\\GSV\\gsv\\gsv_speak.py',
  ttsUrl: 'http://127.0.0.1:9880',
  // 0 = 用 gsv_config.json 里的 speed_factor
  speed: 0,
  // 0 = 用 QQ 桥的 socialV2.voice.defaultVolume
  volume: 0,
  normalize: false,
  // 不传 target 时的默认会话（如 "group:562437955"）
  defaultTarget: '',
  // 临时音频目录，留空 = 系统临时目录下 dsh-qq-voice
  workDir: '',
  keepAudio: false,
  maxChars: 500,
  // 单次调用总预算。桥侧发一条语音的链路是「入队 → 网关 60s → get_msg 回读 30s」，
  // 之前 150s 会在这条链路的上限附近超时，而超时后桥其实已经发出去了 —— 模型一重试就是两条。
  // 给 300s 留足余量；真超时也要报成「可能已发出」，不能报「连不上桥」。
  timeoutMs: 300000,
  // 出错时是否在工具报错里带上 wav 的绝对路径。默认 false：QQ 会话里模型可能把它念/贴出来，
  // 绝对路径属于本地信息。只有管理员自己排查时再打开。
  exposePaths: false,
}

function textResult(value) {
  return [{ type: 'text', text: value }]
}

function lastJson(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      /* keep looking upward */
    }
  }
  return null
}

function mergeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const out = { ...DEFAULTS }
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = raw[key]
    if (value === undefined || value === null || value === '') continue
    out[key] = typeof fallback === 'number' ? Number(value) : value
  }
  if (raw.keepAudio === true) out.keepAudio = true
  if (raw.normalize === true) out.normalize = true
  return out
}

function parseTarget(raw) {
  const match = /^(group|private):([1-9]\d*)$/.exec(String(raw ?? '').trim())
  if (!match) return null
  return { kind: match[1], id: match[2] }
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

/** 控制台令牌：配置 > 桥的 config.json > state/console-token。 */
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
      /* fall through */
    }
  }
  throw new Error('拿不到 QQ 桥控制台令牌：在插件配置里填 consoleToken，或把 bridgeDir 指到 qq-bridge 安装目录')
}

function bridgeBase(cfg) {
  return String(cfg.bridgeUrl || '').replace(/\/+$/, '')
}

async function bridgeRequest(cfg, token, pathname, init = {}) {
  const url = `${bridgeBase(cfg)}${pathname}`
  let response
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-console-token': token,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(cfg.timeoutMs),
    })
  } catch (error) {
    const name = String(error?.name ?? '')
    const timedOut = name === 'TimeoutError' || name === 'AbortError' || /timed?\s*out/i.test(String(error?.message ?? ''))
    if (timedOut) {
      // 关键：超时不等于"没发出去"。桥是先入队再回执，DSH 这边先超时的话语音往往已经发出去了，
      // 旧文案会让模型以为失败并重发，群里就出现两条一样的语音。
      throw new Error(
        `等 QQ 桥回执超过 ${Math.round(cfg.timeoutMs / 1000)}s（${bridgeBase(cfg)}${pathname}）：` +
          '语音很可能已经入队并发出去了，**不要重发**；先看一眼群里，或调 qq_voice_status。',
      )
    }
    throw new Error(`连不上 QQ 桥控制台（${bridgeBase(cfg)}）：${error?.message ?? error}。先确认 qq-bridge 在跑。`)
  }
  // A body that fails to parse is NOT the same as a failed request: the bridge answers after the
  // voice is already queued, so a read timeout here usually means "sent anyway". Keep the reason.
  let data = {}
  let parseError = null
  try {
    data = await response.json()
  } catch (error) {
    parseError = error
  }
  return { status: response.status, data, parseError }
}

async function tcpAlive(url, timeoutMs = 900) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
  const host = parsed.hostname
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

async function renderSpeech(cfg, content) {
  const dir = cfg.workDir || join(tmpdir(), 'dsh-qq-voice')
  await mkdir(dir, { recursive: true })
  const wav = join(dir, `qqvoice-${Date.now()}-${randomBytes(3).toString('hex')}.wav`)
  const argv = ['--no-play', '--out', wav]
  const speed = Number(cfg.speed)
  if (Number.isFinite(speed) && speed > 0) argv.push('--speed', String(speed))
  // `--` 让以 "-" 开头的文本也当正文，而不是被 argparse 当成选项
  argv.push('--', content)
  let stdout = ''
  try {
    const result = await execFileP(cfg.pythonPath, [cfg.ttsScript, ...argv], {
      timeout: cfg.timeoutMs,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    })
    stdout = result.stdout
  } catch (error) {
    if (error?.killed === true || error?.signal) {
      throw new Error(`语音合成超时（${Math.round(cfg.timeoutMs / 1000)}s 没出结果），请缩短文本再试。`)
    }
    const parsed = lastJson(error?.stdout)
    if (parsed?.error) throw new Error(`语音合成失败：${parsed.error}`)
    throw new Error(`语音合成进程失败：${error?.message ?? error}${error?.stderr ? ` | ${String(error.stderr).slice(-300)}` : ''}`)
  }
  const parsed = lastJson(stdout)
  if (!parsed?.wav) throw new Error(`语音合成没有返回 wav：${String(stdout).slice(-400)}`)
  const info = await stat(wav).catch(() => null)
  if (!info || !info.size) throw new Error(`语音合成产物是空的：${parsed.wav}`)
  return { wav, bytes: info.size }
}

async function sendVoice(cfg, token, payload) {
  const { status, data, parseError } = await bridgeRequest(cfg, token, '/api/voice/send', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  if (!data || data.ok !== true) {
    if (parseError) {
      // Previously this fell through to `HTTP 200` and read like a plain failure, so the model
      // resent and the group got the same voice twice.
      const error = new Error(
        `QQ 桥回了 HTTP ${status}，但回执读不出来（${parseError?.message ?? parseError}）。` +
          '读不到回执不等于没发出去 —— 语音很可能已经入队并发出了，**不要重发**；先看一眼群里，或调 qq_voice_status。',
      )
      error.bridgeStatus = status
      throw error
    }
    const message = data?.error ? String(data.error) : `HTTP ${status}`
    const error = new Error(message)
    error.bridgeStatus = status
    error.response = data
    throw error
  }
  return data
}

function describeSend(data, cfg, target) {
  if (data.dryRun) {
    return `试运行（未真正发出）：${target}，音频 ${data.detail}${data.duration ? ` / ${data.duration.toFixed?.(1) ?? data.duration}s` : ''}`
  }
  const verify = data.verified === true ? '，落地校验通过' : '，落地校验未确认'
  return `已把语音发到 ${target}（messageId=${data.messageId ?? '?'}${verify}，${data.detail ?? `${Math.round((data.bytes ?? 0) / 1024)} KB`}）`
}

export function apply(ctx, config) {
  const cfg = mergeConfig(config)

  ctx.effect(() =>
    ctx.tools.register({
      name: 'qq_voice_say',
      description:
        '用本机「大肥鱼」音色（GPT-SoVITS）把一段文字念成语音，并作为 QQ 语音条发到指定会话。' +
        'target 形如 group:群号 / private:QQ号（一般用你当前会话的 key）。' +
        '适合短句、语气化的回复；别连续发多条，语音比文字更打扰。' +
        '只接受 QQ 桥白名单里的会话，并受语音限流（默认每分钟 2 条、每小时 10 条）。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要念出来的内容（中文最好，短句为宜）。' },
          target: { type: 'string', description: '会话 key：group:群号 或 private:QQ号。不填则用插件配置的默认会话。' },
          speed: { type: 'number', description: '语速系数，1 = 正常，建议 0.8–1.3。不填用默认。' },
          volume: { type: 'number', description: '音量倍数（1 = 原始），一般不用填。' },
          normalize: { type: 'boolean', description: '是否做响度归一化（人声更平），默认否。' },
          verify: { type: 'boolean', description: '发完是否回读确认（get_msg），默认 true。' },
          dryRun: { type: 'boolean', description: '只校验路径/时长/白名单，不真正发出。' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      // 工具级预算必须比 cfg.timeoutMs 大，否则 DSH 会先掐断，插件自己那条"超时≠没发出"的提示就轮不到说
      timeoutMs: 330000,
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            target: { type: 'string' },
            messageId: { type: 'number' },
            verified: { type: 'boolean' },
            dryRun: { type: 'boolean' },
            bytes: { type: 'number' },
            text: { type: 'string' },
            audio: { type: 'string' },
          },
          required: ['ok', 'target'],
          additionalProperties: true,
        },
        render: (_args, value) => textResult(value?.summary ?? JSON.stringify(value)),
      },
      async execute(args) {
        const content = String(args?.text ?? '').trim()
        if (!content) throw new Error('text 不能为空')
        if (content.length > cfg.maxChars) {
          throw new Error(`text 太长（${content.length} 字），上限 ${cfg.maxChars} 字；语音请用短句。`)
        }
        const rawTarget = String(args?.target ?? cfg.defaultTarget ?? '').trim()
        const target = parseTarget(rawTarget)
        if (!target) {
          throw new Error(`target 要写成 group:群号 或 private:QQ号${rawTarget ? `，收到的是「${rawTarget}」` : '（没传 target，也没配置默认会话）'}`)
        }
        const targetKey = `${target.kind}:${target.id}`
        const token = await resolveToken(cfg)
        const volume = Number(args?.volume ?? cfg.volume)
        const payload = {
          target: targetKey,
          verify: args?.verify !== false,
          ...(Number.isFinite(volume) && volume > 0 ? { volume } : {}),
          ...(args?.normalize === true || cfg.normalize ? { normalize: true } : {}),
        }
        const dryRun = args?.dryRun === true

        const { wav, bytes } = await renderSpeech(cfg, content)
        let keepFile = cfg.keepAudio === true || dryRun
        try {
          const data = await sendVoice(cfg, token, { ...payload, file: wav, dryRun })
          if (dryRun) keepFile = args?.keepAudio === true || cfg.keepAudio === true
          const value = {
            ok: true,
            target: targetKey,
            verified: data.verified === true,
            dryRun: data.dryRun === true,
            bytes: typeof data.bytes === 'number' ? data.bytes : bytes,
            text: content,
            summary: describeSend(data, cfg, targetKey),
          }
          // 注意：不能留 undefined / null 的已声明字段，否则返回值不是 lossless JSON 或过不了 schema
          if (typeof data.messageId === 'number') value.messageId = data.messageId
          // 只在显式允许时才把 wav 路径交出去：QQ 会话里路径属于本地信息
          if (keepFile && cfg.exposePaths) value.audio = wav
          return value
        } catch (error) {
          keepFile = true
          error.message =
            `${error.message}\n（渲染好的语音已保留在插件工作目录，方便排查；` +
            (cfg.exposePaths ? `路径：${wav}。` : '开启配置 exposePaths 可看到路径。') +
            '发完后这个文件可以删）'
          throw error
        } finally {
          if (!keepFile) await unlink(wav).catch(() => {})
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'qq_voice_status',
      description:
        '自检 QQ 语音发送链路：本地语音服务（GPT-SoVITS 127.0.0.1:9880）、QQ 桥控制台、语音限流、白名单会话、语音库。发语音前想确认一下环境时用。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      timeoutMs: 30000,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => textResult(value?.summary ?? JSON.stringify(value)),
      },
      async execute() {
        const report = {
          tts: { url: cfg.ttsUrl, up: await tcpAlive(cfg.ttsUrl) },
          bridge: { url: bridgeBase(cfg), up: await tcpAlive(bridgeBase(cfg)), ok: false },
          voice: null,
          targets: { groups: [], private: [] },
          defaultTarget: cfg.defaultTarget || '',
        }

        const bridgeCfg = cfg.bridgeDir ? await readJson(join(cfg.bridgeDir, 'config.json')) : null
        if (bridgeCfg?.allow) {
          report.targets.groups = Array.isArray(bridgeCfg.allow.groups) ? bridgeCfg.allow.groups : []
          report.targets.private = Array.isArray(bridgeCfg.allow.private) ? bridgeCfg.allow.private : []
        }

        let token = null
        try {
          token = await resolveToken(cfg)
        } catch (error) {
          report.tokenError = error.message
        }

        if (token) {
          try {
            const status = await bridgeRequest(cfg, token, '/api/status')
            if (status.data?.ok !== false) {
              report.bridge.ok = true
              report.bridge.mode = status.data.mode ?? status.data.currentMode ?? null
              report.bridge.snowlumaConnected = status.data.snowluma?.connected ?? status.data.snowlumaConnected ?? null
            } else {
              report.bridge.error = status.data?.error ?? `HTTP ${status.status}`
            }
          } catch (error) {
            report.bridge.error = error.message
          }
          try {
            const social = await bridgeRequest(cfg, token, '/api/socialV2/config')
            const voice = social.data?.config?.voice ?? social.data?.socialV2?.voice ?? social.data?.voice
            if (voice) {
              report.voice = {
                enabled: voice.enabled,
                dir: voice.dir,
                maxSeconds: voice.maxSeconds,
                maxBytes: voice.maxBytes,
                maxPerMinute: voice.maxPerMinute,
                maxPerHour: voice.maxPerHour,
                defaultVolume: voice.defaultVolume,
              }
            }
          } catch {
            /* 控制台版本差异，缺这个字段不影响发语音 */
          }
          try {
            const list = await bridgeRequest(cfg, token, '/api/voice/list')
            if (list.data?.ok !== false) report.library = { dir: list.data?.dir ?? null, count: list.data?.count ?? (list.data?.files?.length ?? 0) }
          } catch {
            /* 语音库列表只是锦上添花 */
          }
        }

        const targets = [...report.targets.groups.map((id) => `group:${id}`), ...report.targets.private.map((id) => `private:${id}`)]
        report.summary = [
          `语音服务 ${report.tts.up ? '在线' : '没起来（会在合成时自动拉起）'} ${cfg.ttsUrl}`,
          `QQ 桥 ${report.bridge.ok ? '正常' : '异常'} ${bridgeBase(cfg)}${report.bridge.mode ? `（模式 ${report.bridge.mode}）` : ''}`,
          report.voice
            ? `语音限流：每分钟 ${report.voice.maxPerMinute} 条 / 每小时 ${report.voice.maxPerHour} 条`
            : '语音限流：未读到配置',
          `可发会话：${targets.length ? targets.join('、') : '没读到白名单'}`,
        ].join('；')
        return report
      },
    }),
  )
}
