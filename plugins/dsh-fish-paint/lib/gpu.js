// dsh-fish-paint · GPU 队列客户端
//
// 画画要跟唱歌抢同一张 8G 显卡（用户 2026-11-18 要求「画一张」和「翻唱一首」排队，
// 别同时把显存占满）。令牌服务是 dsh-gpu-queue（默认 127.0.0.1:31879）：
//   POST /gpu/acquire   {kind,label,ownerPid} → {state:'granted'|'queued', id}
//   GET  /gpu/ticket?id= → {state:'granted'|'queued'|'cancelled'|'lost'|'unknown', position}
//   POST /gpu/heartbeat {id}   持有期间每 15s 打一次，超时 60s 会被回收
//   POST /gpu/release   {id}
//   POST /gpu/cancel    {id}   只撤排队项
//
// 队列连不上时**明确失败**（QUEUE_UNAVAILABLE），不静默放行——放行就等于回到
// 「两个进程同时抢显卡」的老问题。
export class GpuQueueError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'GpuQueueError'
    this.code = code
    Object.assign(this, extra)
  }
}

export function createGpuClient(cfg, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const log = deps.log ?? ((message) => console.warn(`[fish-paint] ${message}`))
  const base = String(cfg.gpuQueueUrl || '').replace(/\/+$/, '')
  const pollMs = Math.max(50, Number(cfg.gpuQueuePollMs) || 1000)
  const heartbeatMs = Math.max(200, Number(cfg.gpuQueueHeartbeatMs) || 15000)

  async function call(method, pathname, body, timeoutMs = 5000) {
    const url = `${base}${pathname}`
    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new GpuQueueError('QUEUE_UNAVAILABLE', `连不上 GPU 队列（${base}）：${error.message}`, { cause: error })
    }
    let payload = null
    try {
      payload = await response.json()
    } catch {
      // 队列回了非 JSON：下面按状态码报错
    }
    if (!response.ok || payload?.ok === false) {
      const code = payload?.error?.code || payload?.code || `HTTP_${response.status}`
      const message =
        payload?.error?.message || (typeof payload?.error === 'string' ? payload.error : '') || payload?.message || `GPU 队列返回 ${response.status}`
      throw new GpuQueueError(String(code), String(message), { status: response.status })
    }
    return payload
  }

  function makeTicket(id) {
    let released = false
    const timer = setInterval(() => {
      call('POST', '/gpu/heartbeat', { id }, 3000).catch((error) => {
        log(`GPU 令牌心跳失败（${error.code || error.message}），队列会把这张牌回收`)
      })
    }, heartbeatMs)
    timer.unref?.()

    async function release() {
      if (released) return false
      released = true
      clearInterval(timer)
      try {
        await call('POST', '/gpu/release', { id }, 3000)
        return true
      } catch (error) {
        log(`释放 GPU 令牌失败（${error.code || error.message}）`)
        return false
      }
    }

    return {
      id,
      release,
      async heartbeat() {
        const payload = await call('POST', '/gpu/heartbeat', { id }, 3000)
        return payload.state
      },
    }
  }

  /**
   * 领一张令牌。granted 直接返回 ticket；queued 就轮询到 granted。
   * 超时 → QUEUE_TIMEOUT（顺手撤掉排队项）；被面板撤掉 → QUEUE_CANCELLED。
   */
  async function acquire({ kind = 'draw', label = '', waitMs = 10 * 60 * 1000, onWaiting = null } = {}) {
    const started = await call('POST', '/gpu/acquire', {
      kind,
      label: String(label || '').slice(0, 120),
      ownerPid: typeof process !== 'undefined' ? process.pid : 0,
    })
    if (started.state === 'granted') return makeTicket(started.id)
    if (started.state !== 'queued') {
      throw new GpuQueueError('QUEUE_REJECTED', `GPU 队列没接这次请求（state=${started.state}）`)
    }

    let position = Number(started.position) || 1
    onWaiting?.(position)
    const deadline = now() + Math.max(1000, Number(waitMs) || 0)
    while (now() < deadline) {
      await sleep(pollMs)
      const ticket = await call('GET', `/gpu/ticket?id=${encodeURIComponent(started.id)}`, undefined, 5000)
      if (ticket.state === 'granted') return makeTicket(started.id)
      if (ticket.state === 'queued') {
        const next = Number(ticket.position) || position
        if (next !== position) {
          position = next
          onWaiting?.(position)
        }
        continue
      }
      if (ticket.state === 'cancelled') {
        throw new GpuQueueError('QUEUE_CANCELLED', '这次排队被面板撤掉了')
      }
      throw new GpuQueueError('QUEUE_LOST', `排队状态丢了（${ticket.state}），请重试`)
    }

    try {
      await call('POST', '/gpu/cancel', { id: started.id }, 2000)
    } catch {
      // 撤不掉也要给出超时，队列那边会按「排队项 90s 没轮询」自己丢
    }
    const minutes = Math.max(1, Math.round((Number(waitMs) || 0) / 60000))
    throw new GpuQueueError('QUEUE_TIMEOUT', `排队超时（等了约 ${minutes} 分钟），稍后再试`)
  }

  /** 队列整体快照；连不上返回 {ok:false,error}，给面板画「队列不可达」。 */
  async function snapshot() {
    try {
      return await call('GET', '/gpu/state', undefined, 4000)
    } catch (error) {
      return { ok: false, error: { code: error.code || 'QUEUE_UNAVAILABLE', message: error.message } }
    }
  }

  async function ping() {
    try {
      await call('GET', '/gpu/ping', undefined, 2000)
      return true
    } catch {
      return false
    }
  }

  return { base, acquire, snapshot, ping }
}
