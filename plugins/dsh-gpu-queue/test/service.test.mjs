import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeConfig, startQueueService } from '../index.js'

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function waitPing(base, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/gpu/ping`)
      if (response.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`service did not come up: ${base}`)
}

function post(base, token, path, body) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-control-token': token } : {}) },
    body: JSON.stringify(body ?? {}),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }))
}

function get(base, path) {
  return fetch(base + path).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }))
}

async function boot(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gpuq-'))
  const port = await freePort()
  const cfg = mergeConfig({ dataDir: dir, servicesDir: dir, port, ...overrides })
  const logs = []
  const dispose = startQueueService(cfg, { log: (message) => logs.push(message) })
  t.after(async () => {
    dispose()
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })
  const base = `http://127.0.0.1:${port}`
  await waitPing(base)
  const token = String(await readFile(join(dir, 'gpu-queue.token'), 'utf8')).trim()
  return { base, cfg, token, logs, dir }
}

test('ping / state 形状', async (t) => {
  const { base } = await boot(t)
  const ping = await get(base, '/gpu/ping')
  assert.equal(ping.status, 200)
  assert.equal(ping.body.name, 'dsh-gpu-queue')

  const state = await get(base, '/gpu/state')
  assert.equal(state.status, 200)
  assert.equal(state.body.ok, true)
  assert.equal(state.body.holder, null)
  assert.deepEqual(state.body.queue, [])
  assert.equal(typeof state.body.config.holderTtlMs, 'number')
})

test('写端点没令牌一律 403', async (t) => {
  const { base } = await boot(t)
  const acquire = await post(base, '', '/gpu/acquire', { kind: 'draw', label: 'x', ownerPid: process.pid })
  assert.equal(acquire.status, 403)
  const cancel = await post(base, 'wrong', '/gpu/cancel', { id: 'draw-1' })
  assert.equal(cancel.status, 403)
})

test('两张画串行：第二张排队，第一张 release 后拿到', async (t) => {
  const { base, token } = await boot(t)
  const first = await post(base, token, '/gpu/acquire', { kind: 'draw', label: 'A', ownerPid: process.pid })
  assert.equal(first.status, 200)
  assert.equal(first.body.state, 'granted')

  const second = await post(base, token, '/gpu/acquire', { kind: 'draw', label: 'B', ownerPid: process.pid })
  assert.equal(second.body.state, 'queued')
  assert.equal(second.body.position, 1)

  const released = await post(base, token, '/gpu/release', { id: first.body.id })
  assert.equal(released.body.released, true)

  await new Promise((resolve) => setTimeout(resolve, 120))
  const ticket = await get(base, `/gpu/ticket?id=${encodeURIComponent(second.body.id)}`)
  assert.equal(ticket.body.state, 'granted')
})

test('取消排队项：ticket 变 cancelled，不会拿到牌', async (t) => {
  const { base, token } = await boot(t)
  await post(base, token, '/gpu/acquire', { kind: 'draw', label: 'holder', ownerPid: process.pid })
  const queued = await post(base, token, '/gpu/acquire', { kind: 'sing', label: 'Q', ownerPid: process.pid })
  assert.equal(queued.body.state, 'queued')

  const cancelled = await post(base, token, '/gpu/cancel', { id: queued.body.id })
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.body.cancelled, true)

  const ticket = await get(base, `/gpu/ticket?id=${encodeURIComponent(queued.body.id)}`)
  assert.equal(ticket.body.state, 'cancelled')
})

test('发唱歌令牌前会去敲让位端点', async (t) => {
  const hits = []
  const yieldServer = createServer((req, res) => {
    hits.push({ url: req.url, token: req.headers['x-control-token'] ?? null })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, alreadyStopped: false }))
  })
  await new Promise((resolve) => yieldServer.listen(0, '127.0.0.1', resolve))
  const yieldPort = yieldServer.address().port
  t.after(() => yieldServer.close())

  const { base, token } = await boot(t, {
    yieldTargets: { sing: [{ url: `http://127.0.0.1:${yieldPort}/paint/yield`, token: 'fly-token' }] },
  })
  const acquired = await post(base, token, '/gpu/acquire', { kind: 'sing', label: '歌', ownerPid: process.pid })
  assert.equal(acquired.body.state, 'granted')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].url, '/paint/yield')
  assert.equal(hits[0].token, 'fly-token')
})

test('让位失败也照发牌，但把原因记进 yieldWarning', async (t) => {
  const yieldServer = createServer((req, res) => {
    res.writeHead(409, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, reason: 'busy' }))
  })
  await new Promise((resolve) => yieldServer.listen(0, '127.0.0.1', resolve))
  const yieldPort = yieldServer.address().port
  t.after(() => yieldServer.close())

  const { base, token } = await boot(t, {
    yieldTargets: { sing: [{ url: `http://127.0.0.1:${yieldPort}/paint/yield` }] },
  })
  const acquired = await post(base, token, '/gpu/acquire', { kind: 'sing', label: '歌', ownerPid: process.pid })
  assert.equal(acquired.body.state, 'granted')
  const state = await get(base, '/gpu/state')
  assert.match(String(state.body.holder.yieldWarning), /409|busy/)
})

test('持有者没心跳会被回收，排队的人接上', async (t) => {
  const { base, token } = await boot(t, { holderTtlMs: 1200, reapIntervalMs: 100 })
  await post(base, token, '/gpu/acquire', { kind: 'draw', label: 'lazy', ownerPid: process.pid })
  const waiting = await post(base, token, '/gpu/acquire', { kind: 'draw', label: 'next', ownerPid: process.pid })
  assert.equal(waiting.body.state, 'queued')

  await new Promise((resolve) => setTimeout(resolve, 1600))
  const ticket = await get(base, `/gpu/ticket?id=${encodeURIComponent(waiting.body.id)}`)
  assert.equal(ticket.body.state, 'granted')
  const state = await get(base, '/gpu/state')
  assert.ok(state.body.recent.some((item) => item.how === 'stale'))
})

test('心跳续命不会被回收', async (t) => {
  const { base, token } = await boot(t, { holderTtlMs: 1200, reapIntervalMs: 100 })
  const acquired = await post(base, token, '/gpu/acquire', { kind: 'draw', label: 'busy', ownerPid: process.pid })
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    const beat = await post(base, token, '/gpu/heartbeat', { id: acquired.body.id })
    assert.equal(beat.body.state, 'granted')
  }
  const ticket = await get(base, `/gpu/ticket?id=${encodeURIComponent(acquired.body.id)}`)
  assert.equal(ticket.body.state, 'granted')
  const state = await get(base, '/gpu/state')
  assert.ok(!state.body.recent.some((item) => item.id === acquired.body.id))
})
