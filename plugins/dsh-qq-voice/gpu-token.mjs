/**
 * 语音合成前领一张 dsh-gpu-queue 的 voice 令牌。
 *
 * 为什么需要：GPT-SoVITS 的 TTS 也吃显存（常驻 3GB 左右），而画图（SDXL）能把 8G
 * 吃到只剩几百兆。不排队的话，一边画图一边念语音很容易直接 OOM。
 *
 * 口径（与画画/翻唱那边一致）：
 *   - 队列没装/没起来 → 照念（画画那边的策略是「没队列就明确失败」，所以不会两边一起抢卡）；
 *   - 队列在、但显卡被占着 → 最多等 gpuQueueWaitMs（默认 30s），等不到就明确报错，
 *     让人过一会儿再点，而不是偷偷挤进去把显存打爆。
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_BASE = 'http://127.0.0.1:31879'

export class VoiceQueueBusy extends Error {
  constructor(message, code = 'QUEUE_BUSY') {
    super(message)
    this.name = 'VoiceQueueBusy'
    this.code = code
  }
}

function servicesDirOf(cfg) {
  if (cfg?.servicesDir) return String(cfg.servicesDir)
  if (process.env.DSH_SERVICES_DIR) return process.env.DSH_SERVICES_DIR
  return join(homedir(), '.dsh', 'dsh-services')
}

async function readToken(cfg) {
  if (cfg?.gpuQueueToken) return String(cfg.gpuQueueToken)
  try {
    return (await readFile(join(servicesDirOf(cfg), 'gpu-queue.token'), 'utf8')).trim()
  } catch {
    return ''
  }
}

async function call(base, token, path, body) {
  const init = { method: body === undefined ? 'GET' : 'POST', headers: {} }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  if (token) init.headers['x-control-token'] = token
  const response = await fetch(`${base}${path}`, init)
  const text = await response.text()
  if (!response.ok) throw new Error(`GPU 队列返回 ${response.status}：${text.slice(0, 200)}`)
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 领令牌。成功返回 {ok:true, id, skipped, release()}；拿不到就抛 VoiceQueueBusy。
 * skipped=true 表示队列不可用（没装/没起来），调用方照常干活即可。
 */
export async function acquireVoiceToken(cfg = {}, label = '语音合成') {
  const base = String(cfg.gpuQueueUrl || DEFAULT_BASE).replace(/\/+$/, '')
  const waitMs = Math.max(1000, Number(cfg.gpuQueueWaitMs) || 30_000)
  const pollMs = Math.max(200, Number(cfg.gpuQueuePollMs) || 500)
  const token = await readToken(cfg)

  let started
  try {
    started = await call(base, token, '/gpu/acquire', { kind: 'voice', label, ownerPid: process.pid })
  } catch (error) {
    return { ok: true, id: '', skipped: true, reason: String(error?.message || error), release: async () => {} }
  }

  const id = String(started?.id || '')
  const build = () => {
    let released = false
    const timer = setInterval(() => {
      call(base, token, '/gpu/heartbeat', { id }).catch(() => {})
    }, 15_000)
    timer.unref?.()
    return {
      ok: true,
      id,
      skipped: false,
      async release() {
        if (released) return
        released = true
        clearInterval(timer)
        await call(base, token, '/gpu/release', { id }).catch(() => {})
      },
    }
  }

  if (started?.state === 'granted') return build()
  if (started?.state !== 'queued') {
    throw new VoiceQueueBusy(`GPU 队列没接这次语音请求（state=${started?.state ?? 'unknown'}）`, 'QUEUE_REJECTED')
  }

  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await sleep(pollMs)
    let ticket = null
    try {
      ticket = await call(base, token, `/gpu/ticket?id=${encodeURIComponent(id)}`)
    } catch {
      continue
    }
    if (ticket?.state === 'granted') return build()
    if (ticket?.state === 'queued') continue
    throw new VoiceQueueBusy('语音令牌排队状态丢了，重试一次', 'QUEUE_LOST')
  }
  await call(base, token, '/gpu/cancel', { id }).catch(() => {})
  throw new VoiceQueueBusy(
    `显卡正被画图占着，等它画完再念（语音排队超过 ${Math.round(waitMs / 1000)} 秒）`,
    'QUEUE_TIMEOUT',
  )
}

/** 把一段吃显存的工作包起来：领令牌 → 干活 → 还令牌。 */
export async function withVoiceToken(cfg, label, fn) {
  const ticket = await acquireVoiceToken(cfg, label)
  try {
    return await fn(ticket)
  } finally {
    await ticket.release?.()
  }
}
