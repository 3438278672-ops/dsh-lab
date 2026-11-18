import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'

import { collectSnapshot, summarizeSnapshot } from '../lib/snapshot.js'

function serverFor(payload, status = 200) {
  const server = createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function closedPort() {
  const { server, port } = await serverFor({}, 200)
  await new Promise((resolve) => server.close(resolve))
  return port
}

test('三个服务都通时拼出快照与摘要', async () => {
  const qqsing = await serverFor({
    ok: true,
    paused: false,
    active: { song: '晴天', sent: 2, total: 6 },
    queue: [{ song: '稻香' }],
    recent: [],
    limits: { cooldownMinutes: 60 },
    cooldowns: [],
  })
  const paint = await serverFor({
    ok: true,
    paused: { paused: true },
    worker: { running: true, pid: 4242 },
    inFlight: [{ jobId: 'draw-1', phase: 'drawing' }],
    cooldowns: [],
  })
  const queue = await serverFor({ ok: true, holder: { kind: 'sing', label: '唱《晴天》' }, queue: [{}, {}] })
  try {
    const snapshot = await collectSnapshot({
      endpoints: {
        qqsing: { url: `http://127.0.0.1:${qqsing.port}` },
        paint: { url: `http://127.0.0.1:${paint.port}` },
        queue: { url: `http://127.0.0.1:${queue.port}` },
      },
    })
    assert.equal(snapshot.qqsing.ok, true)
    assert.equal(snapshot.paint.ok, true)
    assert.equal(snapshot.queue.ok, true)
    const text = summarizeSnapshot(snapshot)
    assert.match(text, /点歌：在唱《晴天》2\/6 段/)
    assert.match(text, /画画：已暂停；worker 在跑（pid 4242）；在飞 1 张/)
    assert.match(text, /显卡：被唱歌占着/)
  } finally {
    for (const item of [qqsing, paint, queue]) item.server.close()
  }
})

test('服务没起时摘要里如实写读不到', async () => {
  const port = await closedPort()
  const snapshot = await collectSnapshot({
    endpoints: {
      qqsing: { url: `http://127.0.0.1:${port}` },
      paint: { url: `http://127.0.0.1:${port}` },
      queue: { url: `http://127.0.0.1:${port}` },
    },
    timeoutMs: 800,
  })
  assert.equal(snapshot.qqsing.ok, false)
  assert.ok(snapshot.qqsing.error)
  const text = summarizeSnapshot(snapshot)
  assert.match(text, /点歌：读不到 31877/)
  assert.match(text, /显卡队列：读不到 31879/)
})

test('快照带 token 时把令牌头发出去', async () => {
  const seen = []
  const server = createServer((req, res) => {
    seen.push(req.headers['x-control-token'] || '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  const { port } = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port }))
  })
  try {
    await collectSnapshot({
      endpoints: { qqsing: { url: `http://127.0.0.1:${port}` }, paint: { url: `http://127.0.0.1:${port}` }, queue: { url: `http://127.0.0.1:${port}` } },
      tokens: { qqsing: 'tk-1', paint: 'tk-2' },
    })
    assert.ok(seen.includes('tk-1'))
    assert.ok(seen.includes('tk-2'))
  } finally {
    server.close()
  }
})
