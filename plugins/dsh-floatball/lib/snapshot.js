/**
 * 从三个本机服务抓一份统一的快照，给 floatball_status 和 README 里的排障用。
 * 服务名：qqsing（31877）、paint（31878）、queue（31879）。
 */
const DEFAULTS = {
  qqsing: { url: 'http://127.0.0.1:31877', path: '/qqsing.json' },
  paint: { url: 'http://127.0.0.1:31878', path: '/paint.json' },
  queue: { url: 'http://127.0.0.1:31879', path: '/gpu/state' },
}

async function getJson(url, { timeoutMs = 1500, fetchImpl = fetch, token = '' } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = {}
    if (token) headers['x-control-token'] = token
    const response = await fetchImpl(url, { headers, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return { ok: true, data: await response.json() }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  } finally {
    clearTimeout(timer)
  }
}

export async function collectSnapshot({ endpoints = {}, tokens = {}, timeoutMs = 1500, fetchImpl = fetch } = {}) {
  const targets = {
    qqsing: { ...DEFAULTS.qqsing, ...(endpoints.qqsing || {}) },
    paint: { ...DEFAULTS.paint, ...(endpoints.paint || {}) },
    queue: { ...DEFAULTS.queue, ...(endpoints.queue || {}) },
  }
  const [qqsing, paint, queue] = await Promise.all([
    getJson(`${targets.qqsing.url}${targets.qqsing.path}`, { timeoutMs, fetchImpl, token: tokens.qqsing }),
    getJson(`${targets.paint.url}${targets.paint.path}`, { timeoutMs, fetchImpl, token: tokens.paint }),
    getJson(`${targets.queue.url}${targets.queue.path}`, { timeoutMs, fetchImpl }),
  ])
  return { at: Date.now(), qqsing, paint, queue, targets }
}

function short(text, max = 40) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** 一段能直接读的中文摘要（工具输出/日志共用）。 */
export function summarizeSnapshot(snapshot) {
  const lines = []
  const { qqsing, paint, queue } = snapshot

  if (qqsing.ok) {
    const data = qqsing.data || {}
    const active = data.active
    const paused = data.paused ? '（已暂停接新单）' : ''
    const queueLen = Array.isArray(data.queue) ? data.queue.length : 0
    lines.push(
      active
        ? `点歌：在唱《${short(active.song || active.title, 24)}》${active.sent ?? 0}/${active.total ?? 0} 段${paused}；排单 ${queueLen} 首`
        : `点歌：空闲${paused}；排单 ${queueLen} 首`,
    )
    const cd = Array.isArray(data.cooldowns) ? data.cooldowns.length : 0
    if (cd) lines.push(`点歌限流：${cd} 人还在冷却（${data.limits?.cooldownMinutes ?? '?'} 分钟/人）`)
  } else {
    lines.push(`点歌：读不到 31877（${short(qqsing.error, 60)}）`)
  }

  if (paint.ok) {
    const data = paint.data || {}
    const worker = data.worker || {}
    const inFlight = Array.isArray(data.inFlight) ? data.inFlight.length : 0
    lines.push(
      `画画：${data.paused ? '已暂停' : '接单中'}；worker ${worker.running ? `在跑（pid ${worker.pid ?? '?'}）` : '没起'}${inFlight ? `；在飞 ${inFlight} 张` : ''}`,
    )
    const cds = Array.isArray(data.cooldowns) ? data.cooldowns.length : 0
    if (cds) lines.push(`画画限流：${cds} 人还在冷却`)
  } else {
    lines.push(`画画：读不到 31878（${short(paint.error, 60)}）`)
  }

  if (queue.ok) {
    const data = queue.data || {}
    const holder = data.holder
    const waiting = Array.isArray(data.queue) ? data.queue.length : 0
    lines.push(
      holder
        ? `显卡：被${holder.kind === 'sing' ? '唱歌' : holder.kind === 'draw' ? '画画' : '语音'}占着（${short(holder.label, 20)}）；排队 ${waiting} 个`
        : `显卡：空闲；排队 ${waiting} 个`,
    )
  } else {
    lines.push(`显卡队列：读不到 31879（${short(queue.error, 60)}）`)
  }
  return lines.join('\n')
}
