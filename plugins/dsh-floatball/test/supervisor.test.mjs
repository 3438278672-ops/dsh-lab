import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSupervisor, restartPlan, statePathOf } from '../lib/supervisor.js'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return true
    if (Date.now() > deadline) return false
    await wait(40)
  }
}

test('restartPlan 按窗口计数', () => {
  const now = 1_000_000
  assert.deepEqual(restartPlan({ crashes: [], now }), { recent: [], allowed: true, attempt: 1, limit: 5, windowMs: 600_000 })
  const fresh = [now - 1000, now - 2000]
  assert.equal(restartPlan({ crashes: fresh, now, limit: 3 }).allowed, true)
  assert.equal(restartPlan({ crashes: fresh, now, limit: 2 }).allowed, false)
  // 窗口外的老崩溃不算
  assert.equal(restartPlan({ crashes: [now - 900_000, now - 1000, now - 2000], now, limit: 2 }).recent.length, 2)
})

test('起停一个子进程，状态落盘', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ball-sup-'))
  const script = join(dataDir, 'child.mjs')
  await writeFile(script, "setTimeout(() => {}, 5000)\n", 'utf8')
  const lines = []
  // 拿 node 本身当 electron 用：spawn(electronExe, [helperEntry])
  const sup = createSupervisor({
    electronExe: process.execPath,
    helperEntry: script,
    dataDir,
    log: (line) => lines.push(line),
    restartDelayMs: 100,
  })

  const started = sup.start()
  assert.equal(started.ok, true)
  assert.ok(started.pid > 0)
  assert.equal(sup.running(), true)
  assert.equal(sup.start().already, true, '已经在跑就不重复起')

  const state = JSON.parse(await readFile(statePathOf(dataDir), 'utf8').catch(async () => {
    await sup.persist()
    return readFile(statePathOf(dataDir), 'utf8')
  }))
  assert.equal(state.pid, started.pid)
  assert.match(state.electronExe, /node/i)

  const stopped = await sup.stop({ reason: 'test' })
  assert.equal(stopped.ok, true)
  assert.equal(sup.running(), false)
  assert.ok(lines.some((line) => line.includes('球起来了')))
})

test('崩了重拉，超过上限就不再折腾', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ball-sup-'))
  const script = join(dataDir, 'boom.mjs')
  await writeFile(script, 'process.exit(1)\n', 'utf8')
  const lines = []
  const sup = createSupervisor({
    electronExe: process.execPath,
    helperEntry: script,
    dataDir,
    log: (line) => lines.push(line),
    limit: 2,
    windowMs: 60_000,
    restartDelayMs: 80,
  })
  sup.start()
  const reached = await waitFor(() => sup.status().crashes >= 2 && !sup.running())
  assert.equal(reached, true, `没等到连续崩溃：${JSON.stringify(sup.status())}`)
  assert.match(sup.status().lastError, /不再自动重拉/)
  await sup.stop({ reason: 'cleanup' })
})
