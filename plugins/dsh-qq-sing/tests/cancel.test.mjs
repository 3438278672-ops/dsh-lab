/**
 * qq_sing_cancel 的测试：不碰真桥、不跑真流水线，只伪造 state.json / busy.lock / job.json。
 *
 * 覆盖四条：
 *   1. 空闲时取消 → 什么也不干
 *   2. 部分发送（sent>0）被取消 → 不退 CD（否则同一首会被从头重听）
 *   3. 一段都没发就取消 → 退 CD
 *   4. PID 对不上（被系统复用）→ 绝不 taskkill，只清状态
 *
 *   node tests/cancel.test.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const home = await mkdtemp(path.join(os.tmpdir(), 'qqsing-cancel-'))
const tools = new Map()
const ctx = {
  effect(fn) {
    return fn() || (() => {})
  },
  tools: {
    register(def) {
      tools.set(def.name, def)
      return () => {}
    },
  },
}

apply(ctx, {
  home,
  bridgeUrl: 'http://127.0.0.1:9',
  bridgeDir: 'D:\\DPQQ\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1',
  pythonBili: 'Z:\\not-a-python\\python.exe',
  pythonRvc: 'Z:\\not-a-python\\python.exe',
  credentialFile: 'Z:\\not-a-file.json',
  nodePath: process.execPath,
  minIntervalMs: 100,
  maxSegments: 2,
  announce: false,
})

const cancel = tools.get('qq_sing_cancel')
assert.ok(cancel, 'qq_sing_cancel not registered')
const ok = (name) => console.log('PASS', name)

const statePath = path.join(home, 'state.json')
const lockPath = path.join(home, 'busy.lock')
const cdPath = path.join(home, 'cooldown.json')
const REQUESTER = '666666'

async function writeFixtures({ jobId, pid, sent, song = '晴天' }) {
  await mkdir(path.join(home, 'jobs', jobId), { recursive: true })
  await writeFile(
    path.join(home, 'jobs', jobId, 'job.json'),
    JSON.stringify({ jobId, requester: REQUESTER, whitelisted: false, song, target: 'group:1' }),
    'utf8',
  )
  const now = Date.now()
  await writeFile(
    statePath,
    JSON.stringify({ jobId, pid, song, target: 'group:1', stage: 'send', stageText: '正在发语音', total: 5, sent, startedAt: now, updatedAt: now, finishedAt: null, ok: null, error: '' }),
    'utf8',
  )
  await writeFile(lockPath, JSON.stringify({ jobId, pid, at: now }), 'utf8')
  await writeFile(cdPath, JSON.stringify({ [REQUESTER]: { at: now, song, target: 'group:1' } }), 'utf8')
}

/** 起一个命令行里带 worker.mjs 的长命进程，冒充卡死的 worker。 */
async function startFakeWorker() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qqsing-fake-'))
  const file = path.join(dir, 'worker.mjs')
  await writeFile(file, 'setTimeout(() => {}, 120000)\n', 'utf8')
  const child = spawn(process.execPath, [file], { stdio: 'ignore', windowsHide: true })
  return { child, pid: child.pid, dir }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const stub = await startFakeWorker()
assert.ok(stub.pid > 0)

try {
  // 1. 空闲
  await rm(statePath, { force: true })
  const idle = await cancel.execute({})
  assert.equal(idle.cancelled, false)
  assert.match(idle.summary, /没有正在唱/)
  ok('idle -> nothing to cancel')

  // 2. 部分发送：已发 2/5 → 取消但不退 CD
  await writeFixtures({ jobId: 'sing-partial', pid: stub.pid, sent: 2 })
  const partial = await cancel.execute({})
  assert.equal(partial.cancelled, true, partial.summary)
  assert.equal(partial.sent, 2)
  assert.equal(partial.cdRefunded, false)
  const cdAfterPartial = JSON.parse(await readFile(cdPath, 'utf8'))
  assert.ok(cdAfterPartial[REQUESTER], 'partial send must keep the cooldown')
  const statePartial = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(statePartial.stage, 'cancelled')
  assert.ok(statePartial.finishedAt)
  await rm(lockPath, { force: true })
  ok('partial send -> cancel keeps cooldown')

  // 3. 一段都没发 → 取消并退 CD
  const stub2 = await startFakeWorker()
  await writeFixtures({ jobId: 'sing-zero', pid: stub2.pid, sent: 0 })
  const zero = await cancel.execute({})
  assert.equal(zero.cancelled, true, zero.summary)
  assert.equal(zero.cdRefunded, true)
  const cdAfterZero = JSON.parse(await readFile(cdPath, 'utf8'))
  assert.equal(REQUESTER in cdAfterZero, false, 'zero-sent cancel must refund the cooldown')
  await new Promise((r) => setTimeout(r, 800))
  assert.equal(alive(stub2.pid), false, 'stuck worker should be killed')
  await rm(lockPath, { force: true })
  await rm(stub2.dir, { recursive: true, force: true })
  ok('zero sent -> cancel refunds cooldown and kills worker')

  // 4. PID 被复用（命令行对不上）→ 不许杀，只清状态
  await writeFixtures({ jobId: 'sing-reuse', pid: process.pid, sent: 0 })
  const reuse = await cancel.execute({})
  assert.equal(reuse.cancelled, false)
  assert.match(reuse.summary, /没杀任何东西|对不上|不是点歌 worker/)
  assert.equal(alive(process.pid), true)
  const stateReuse = JSON.parse(await readFile(statePath, 'utf8'))
  assert.ok(stateReuse.finishedAt)
  await rm(lockPath, { force: true })
  ok('pid reused -> refuses to taskkill')

  // 5. jobId 对不上 → 报错不动
  await writeFixtures({ jobId: 'sing-real', pid: stub.pid, sent: 0 })
  let mismatch = ''
  try {
    await cancel.execute({ jobId: 'sing-other' })
  } catch (error) {
    mismatch = error.message
  }
  assert.match(mismatch, /不是 sing-other/)
  ok('jobId mismatch -> refuses')
} finally {
  try {
    stub.child.kill()
  } catch {
    /* already gone */
  }
  await rm(stub.dir, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
}

console.log('\ncancel OK')
// apply() 里的调度 tick / 看门狗定时器还在跑，显式收尾，别让测试进程挂着不退
process.exit(0)
