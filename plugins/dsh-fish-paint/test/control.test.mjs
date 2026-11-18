// 控制口（悬浮球面板用）：ping / 快照 / 令牌 / 暂停 / 让位 / 中止。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startControlServer } from '../lib/control.js'
import { createPauseStore } from '../lib/pause.js'
import { createActivity } from '../lib/activity.js'

function fakeEngine({ shutdownResult, statusPayload } = {}) {
  const reasons = []
  return {
    reasons,
    async status() {
      return statusPayload ?? { running: false, ready: false, pid: null, modelKey: 'base', vramMode: 'offload', note: '', error: null, worker: null }
    },
    async shutdown(reason) {
      reasons.push(reason)
      return shutdownResult ?? { ok: true, alreadyStopped: false }
    },
  }
}

const fakeGpu = {
  async snapshot() {
    return { ok: true, holder: { kind: 'sing', id: 's-1' }, queue: [{ id: 'd-2', kind: 'draw', label: '正在等' }], recent: [] }
  },
}

async function boot({ engine, activity, abortState } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-paint-control-'))
  const servicesDir = path.join(dir, 'services')
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const logs = []
  const abort = abortState ?? { at: 0 }
  const control = startControlServer(
    {
      controlPort: 0,
      controlBind: '127.0.0.1',
      servicesDir,
      dataDir,
      drawCooldownMinutes: 60,
      drawCooldownMax: 1,
      vipList: ['2220222310'],
      vramMode: 'offload',
      gpuQueueUrl: 'http://127.0.0.1:31879',
    },
    {
      engine: engine ?? fakeEngine(),
      pauseStore: createPauseStore(path.join(dataDir, 'state', 'paint-paused.json')),
      activity: activity ?? createActivity(),
      gpu: fakeGpu,
      abortState: abort,
      log: (message) => logs.push(message),
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 60))
  const base = `http://127.0.0.1:${control.port()}`
  return {
    base,
    control,
    logs,
    servicesDir,
    dataDir,
    abortState: abort,
    token: fs.readFileSync(path.join(servicesDir, 'fish-paint.token'), 'utf8').trim(),
    close: async () => {
      await control.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function call(base, pathname, { method = 'GET', token, by, body } = {}) {
  const headers = {}
  if (token) headers['x-control-token'] = token
  if (by) headers['x-control-by'] = encodeURIComponent(by)
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${base}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  let json = null
  try {
    json = await response.json()
  } catch {
    // 忽略
  }
  return { status: response.status, json }
}

test('ping 活着；读端点不用令牌；listen 后写 status 文件', async () => {
  const app = await boot()
  try {
    const ping = await call(app.base, '/paint/ping')
    assert.equal(ping.status, 200)
    assert.equal(ping.json.ok, true)
    const statusFile = path.join(app.servicesDir, 'fish-paint.status.json')
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'))
    assert.equal(status.service, 'fish-paint')
    assert.equal(status.port, app.control.port())
  } finally {
    await app.close()
  }
})

test('写端点没令牌 → 403；令牌错了也是 403', async () => {
  const app = await boot()
  try {
    const missing = await call(app.base, '/paint/pause?on=1', { method: 'POST' })
    assert.equal(missing.status, 403)
    assert.equal(missing.json.error.code, 'FORBIDDEN')
    const wrong = await call(app.base, '/paint/pause?on=1', { method: 'POST', token: 'x'.repeat(48) })
    assert.equal(wrong.status, 403)
  } finally {
    await app.close()
  }
})

test('pause 开关：写进状态文件，快照里能看见，by 记下来', async () => {
  const app = await boot()
  try {
    const on = await call(app.base, '/paint/pause?on=1', { method: 'POST', token: app.token, by: '大肥鱼' })
    assert.equal(on.status, 200)
    assert.equal(on.json.paused, true)
    assert.equal(on.json.updatedBy, '大肥鱼')
    const snap = await call(app.base, '/paint.json')
    assert.equal(snap.json.paused, true)
    assert.equal(snap.json.pausedBy, '大肥鱼')

    const off = await call(app.base, '/paint/pause?on=0', { method: 'POST', token: app.token })
    assert.equal(off.json.paused, false)
    const after = await call(app.base, '/paint.json')
    assert.equal(after.json.paused, false)
  } finally {
    await app.close()
  }
})

test('快照形状：limits / cooldowns / inFlight / worker / queue 都在', async () => {
  const activity = createActivity()
  const app = await boot({ activity })
  try {
    const jobId = activity.begin({ prompt: '1girl', requester: '10001' })
    activity.mark(jobId, { phase: 'drawing' })
    const snap = await call(app.base, '/paint.json')
    assert.equal(snap.status, 200)
    const body = snap.json
    assert.equal(body.ok, true)
    assert.equal(body.limits.cooldownMinutes, 60)
    assert.deepEqual(body.limits.vipList, ['2220222310'])
    assert.ok(Array.isArray(body.cooldowns))
    assert.equal(body.inFlight.length, 1)
    assert.equal(body.inFlight[0].phase, 'drawing')
    assert.equal(body.worker.running, false)
    assert.equal(body.worker.modelKey, 'base')
    assert.equal(body.queue.ok, true)
    assert.equal(body.queue.holder.kind, 'sing')
    assert.equal(body.queue.queue.length, 1)
  } finally {
    await app.close()
  }
})

test('yield：没在画 → 停 worker 回 yielded；worker 本来就闲 → already-idle', async () => {
  const stopping = await boot({ engine: fakeEngine({ shutdownResult: { ok: true, alreadyStopped: false } }) })
  try {
    const result = await call(stopping.base, '/paint/yield', { method: 'POST', token: stopping.token })
    assert.equal(result.status, 200)
    assert.deepEqual(
      { ok: result.json.ok, yielded: result.json.yielded, workerStopped: result.json.workerStopped, reason: result.json.reason },
      { ok: true, yielded: true, workerStopped: true, reason: 'stopped' },
    )
  } finally {
    await stopping.close()
  }

  const idle = await boot({ engine: fakeEngine({ shutdownResult: { ok: true, alreadyStopped: true } }) })
  try {
    const result = await call(idle.base, '/paint/yield', { method: 'POST', token: idle.token })
    assert.equal(result.status, 200)
    assert.equal(result.json.yielded, false)
    assert.equal(result.json.reason, 'already-idle')
  } finally {
    await idle.close()
  }
})

test('yield：正在画的时候拒绝，回 409 drawing（别把画一半的图打断）', async () => {
  const activity = createActivity()
  const app = await boot({ activity })
  try {
    const jobId = activity.begin({ prompt: 'x' })
    activity.mark(jobId, { phase: 'drawing' })
    const result = await call(app.base, '/paint/yield', { method: 'POST', token: app.token })
    assert.equal(result.status, 409)
    assert.equal(result.json.ok, false)
    assert.equal(result.json.reason, 'drawing')
    assert.equal(result.json.inFlight[0].jobId, jobId)
  } finally {
    await app.close()
  }
})

test('abort：杀掉 worker、回在飞的 jobId、并记下中止时刻（供 ABORTED 映射）', async () => {
  const activity = createActivity()
  const engine = fakeEngine({ shutdownResult: { ok: true, alreadyStopped: false } })
  const app = await boot({ activity, engine, abortState: { at: 0 } })
  try {
    const first = activity.begin({ prompt: 'a' })
    const second = activity.begin({ prompt: 'b' })
    activity.mark(first, { phase: 'drawing' })
    const result = await call(app.base, '/paint/abort', { method: 'POST', token: app.token })
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, true)
    assert.deepEqual(result.json.aborted.sort(), [first, second].sort())
    assert.equal(result.json.workerStopped, true)
    assert.equal(engine.reasons.length, 1)
    assert.match(engine.reasons[0], /中止/)
    assert.ok(app.abortState.at > 0, '中止时刻要记下来，draw_image 才能把 WORKER_EXIT 映射成 ABORTED')
  } finally {
    await app.close()
  }
})

test('未知端点 404；OPTIONS 预检 204；GET 写端点 405', async () => {
  const app = await boot()
  try {
    const missing = await call(app.base, '/paint/nope', { method: 'POST', token: app.token })
    assert.equal(missing.status, 404)
    const options = await fetch(`${app.base}/paint/pause`, { method: 'OPTIONS' })
    assert.equal(options.status, 204)
    assert.equal(options.headers.get('access-control-allow-origin'), '*')
    const getWrite = await call(app.base, '/paint/pause?on=1')
    assert.equal(getWrite.status, 405)
  } finally {
    await app.close()
  }
})
