// GPU 队列客户端：领牌、排队、超时撤单、不可达、心跳、重复释放。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createGpuClient, GpuQueueError } from '../lib/gpu.js'

// 假令牌服务：按 mode 决定第一次 acquire 是发牌还是排队。
async function fakeQueue(mode = 'grant') {
  const state = { mode, calls: [], polls: 0 }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    let body = ''
    for await (const chunk of req) body += chunk
    const json = body ? JSON.parse(body) : {}
    state.calls.push({ method: req.method, path: url.pathname, body: json })
    const send = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.method === 'POST' && url.pathname === '/gpu/acquire') {
      if (state.mode === 'grant') return send(200, { ok: true, state: 'granted', id: 'g-1' })
      return send(200, { ok: true, state: 'queued', id: 'q-1', position: 2 })
    }
    if (req.method === 'GET' && url.pathname === '/gpu/ticket') {
      state.polls += 1
      if (state.mode === 'queue-then-grant' && state.polls >= 2) return send(200, { ok: true, state: 'granted', id: 'q-1' })
      if (state.mode === 'cancelled') return send(200, { ok: true, state: 'cancelled', id: 'q-1' })
      if (state.mode === 'lost') return send(200, { ok: true, state: 'lost', id: 'q-1' })
      return send(200, { ok: true, state: 'queued', id: 'q-1', position: 2 })
    }
    if (url.pathname === '/gpu/heartbeat') return send(200, { ok: true, state: 'granted' })
    if (url.pathname === '/gpu/release') return send(200, { ok: true, released: true })
    if (url.pathname === '/gpu/cancel') return send(200, { ok: true, cancelled: true })
    if (req.method === 'GET' && url.pathname === '/gpu/state') return send(200, { ok: true, holder: null, queue: [], recent: [] })
    if (req.method === 'GET' && url.pathname === '/gpu/ping') return send(200, { ok: true })
    return send(404, { ok: false, error: { code: 'NOT_FOUND', message: 'no route' } })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
    count: (pathname) => state.calls.filter((call) => call.path === pathname).length,
  }
}

function clientFor(queue, overrides = {}) {
  return createGpuClient(
    { gpuQueueUrl: queue.base, gpuQueuePollMs: 50, gpuQueueHeartbeatMs: 200, ...overrides },
    { log: () => {} },
  )
}

test('直接发牌：acquire 拿到 ticket，release 只发一次', async () => {
  const queue = await fakeQueue('grant')
  try {
    const client = clientFor(queue)
    const ticket = await client.acquire({ kind: 'draw', label: 'anime 1024x1024', waitMs: 5000 })
    assert.equal(ticket.id, 'g-1')
    assert.equal(await ticket.release(), true)
    assert.equal(await ticket.release(), false, '第二遍不该再发 HTTP')
    const acquireCall = queue.state.calls.find((call) => call.path === '/gpu/acquire')
    assert.equal(acquireCall.body.kind, 'draw')
    assert.equal(acquireCall.body.label, 'anime 1024x1024')
    assert.equal(queue.count('/gpu/release'), 1)
  } finally {
    await queue.close()
  }
})

test('排队 → 轮询到发牌；position 变化会通知调用方', async () => {
  const queue = await fakeQueue('queue-then-grant')
  try {
    const client = clientFor(queue)
    const seen = []
    const ticket = await client.acquire({ kind: 'draw', waitMs: 5000, onWaiting: (position) => seen.push(position) })
    assert.equal(ticket.id, 'q-1')
    assert.deepEqual(seen, [2], '第一次排队位置报一次就够了')
    await ticket.release()
  } finally {
    await queue.close()
  }
})

test('排队超时会撤单并抛 QUEUE_TIMEOUT', async () => {
  const queue = await fakeQueue('always-queue')
  try {
    const client = clientFor(queue)
    await assert.rejects(
      () => client.acquire({ kind: 'draw', waitMs: 1200 }),
      (error) => {
        assert.ok(error instanceof GpuQueueError)
        assert.equal(error.code, 'QUEUE_TIMEOUT')
        return true
      },
    )
    assert.equal(queue.count('/gpu/cancel'), 1, '超时要把排队项撤掉')
  } finally {
    await queue.close()
  }
})

test('被面板撤掉 → QUEUE_CANCELLED；状态丢了 → QUEUE_LOST', async () => {
  const cancelled = await fakeQueue('cancelled')
  try {
    await assert.rejects(() => clientFor(cancelled).acquire({ waitMs: 5000 }), /QUEUE_CANCELLED|撤掉/)
  } finally {
    await cancelled.close()
  }
  const lost = await fakeQueue('lost')
  try {
    await assert.rejects(
      () => clientFor(lost).acquire({ waitMs: 5000 }),
      (error) => error.code === 'QUEUE_LOST',
    )
  } finally {
    await lost.close()
  }
})

test('队列连不上 → QUEUE_UNAVAILABLE（明确失败，不静默放行）', async () => {
  const client = createGpuClient({ gpuQueueUrl: 'http://127.0.0.1:1', gpuQueuePollMs: 50 }, { log: () => {} })
  await assert.rejects(
    () => client.acquire({ waitMs: 2000 }),
    (error) => {
      assert.equal(error.code, 'QUEUE_UNAVAILABLE')
      assert.match(error.message, /连不上 GPU 队列/)
      return true
    },
  )
  const snapshot = await client.snapshot()
  assert.equal(snapshot.ok, false)
  assert.equal(snapshot.error.code, 'QUEUE_UNAVAILABLE')
  assert.equal(await client.ping(), false)
})

test('持有期间按时打心跳', async () => {
  const queue = await fakeQueue('grant')
  try {
    const client = clientFor(queue)
    const ticket = await client.acquire({ waitMs: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 450))
    await ticket.release()
    assert.ok(queue.count('/gpu/heartbeat') >= 1, `应至少打一次心跳，实际 ${queue.count('/gpu/heartbeat')}`)
  } finally {
    await queue.close()
  }
})

test('snapshot / ping 正常时返回队列状态', async () => {
  const queue = await fakeQueue('grant')
  try {
    const client = clientFor(queue)
    assert.equal(await client.ping(), true)
    const state = await client.snapshot()
    assert.equal(state.ok, true)
    assert.deepEqual(state.queue, [])
  } finally {
    await queue.close()
  }
})
