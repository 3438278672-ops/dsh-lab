/**
 * 第二轮修复（排单不丢单 / 取消不误伤别人 / CD 只在该退的时候退）的回归测试。
 *   node tests/fixes.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { clearQueue, enqueue, readQueue, shiftQueue, unshiftQueue } from '../queue.mjs'
import { apply, runQueueTick } from '../index.js'

const ok = (name) => console.log('PASS', name)
const tmp = (tag) => mkdtemp(path.join(os.tmpdir(), `qqsing-${tag}-`))
const DEAD_PID = 999999 // 一定不存在的进程：取消会走「worker 已经不在了」分支，不会真杀东西

// ---------- 1) unshiftQueue 把取出来的那单放回队头 ----------
const home = await tmp('f1')
await enqueue(home, { song: 'B', target: 'group:1', requester: '2' })
await enqueue(home, { song: 'C', target: 'group:1', requester: '3' })
const taken = await shiftQueue(home)
assert.equal(taken.song, 'B')
await unshiftQueue(home, taken)
assert.deepEqual((await readQueue(home)).map((i) => i.song), ['B', 'C'])
assert.equal(typeof (await readQueue(home))[0].requeuedAt, 'number')
ok('unshiftQueue: 取出的单回到队头')

// ---------- 2) 调度：忙的时候不动队列 ----------
const home2 = await tmp('f2')
await enqueue(home2, { song: 'X', target: 'group:1', requester: '9' })
const busyCfg = { home: home2 }
await writeFile(
  path.join(home2, 'state.json'),
  JSON.stringify({ jobId: 'busy-1', pid: process.pid, song: 'A', finishedAt: null, sent: 1, total: 3 }),
  'utf8',
)
let started = 0
const busyTick = await runQueueTick(busyCfg, {
  startJob: async () => {
    started += 1
    return { ok: true }
  },
})
assert.equal(busyTick.skipped, 'busy')
assert.equal(started, 0)
assert.deepEqual((await readQueue(home2)).map((i) => i.song), ['X'])
ok('调度: 有任务在跑时不动队列')

// ---------- 3) 调度：抢锁失败（startJob 返回 busy）时那单回到队头，不丢 ----------
await writeFile(path.join(home2, 'state.json'), JSON.stringify({ jobId: '', finishedAt: Date.now() }), 'utf8')
const requeueTick = await runQueueTick(busyCfg, {
  startJob: async () => ({ ok: false, busy: true, summary: '还没唱完' }),
})
assert.equal(requeueTick.requeued, true)
assert.deepEqual((await readQueue(home2)).map((i) => i.song), ['X'])
ok('调度: 起不来时塞回队头（以前这里直接丢单）')

// ---------- 4) 调度：起得来时队列前进一首 ----------
const okTick = await runQueueTick(busyCfg, {
  startJob: async () => ({ ok: true, started: true }),
})
assert.equal(okTick.started, true)
assert.equal((await readQueue(home2)).length, 0)
ok('调度: 起唱成功后出队')

// ---------- 5) qq_sing_cancel：默认只掐当前这首，排单继续 ----------
const home3 = await tmp('f3')
const now = Date.now()
await writeFile(
  path.join(home3, 'state.json'),
  JSON.stringify({
    jobId: 'job-A',
    pid: DEAD_PID,
    song: 'A',
    target: 'group:1',
    requester: '111',
    stage: 'send',
    stageText: '正在发第 0/5 条',
    sent: 0,
    total: 5,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    ok: null,
    error: '',
  }),
  'utf8',
)
await writeFile(path.join(home3, 'busy.lock'), JSON.stringify({ jobId: 'job-A', at: now }), 'utf8')
await writeFile(
  path.join(home3, 'cooldown.json'),
  JSON.stringify({
    111: { song: 'A', at: now },
    222: { song: 'B', at: now },
    333: { song: 'C', at: now },
  }),
  'utf8',
)
await enqueue(home3, { song: 'B', target: 'group:1', requester: '222' })
await enqueue(home3, { song: 'C', target: 'group:1', requester: '333' })

const disposers = []
const tools = new Map()
apply(
  {
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return typeof d === 'function' ? d : () => {}
    },
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => {}
      },
    },
  },
  {
    home: home3,
    bridgeUrl: 'http://127.0.0.1:9',
    bridgeDir: 'D:\\DPQQ\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1',
    pythonBili: 'Z:\\not-a-python\\python.exe',
    pythonRvc: 'Z:\\not-a-python\\python.exe',
    credentialFile: 'Z:\\not-a-file.json',
    nodePath: process.execPath,
    announce: false,
    queuePort: 0,
  },
)

const cancel = tools.get('qq_sing_cancel')
const res = await cancel.execute({})
assert.equal(res.cancelled, false, '进程已经没了，不该报 cancelled')
assert.deepEqual((await readQueue(home3)).map((i) => i.song), ['B', 'C'], '别人的排单不能被清')
assert.equal(res.cdRefunded, true, '一段都没发出去，A 的 CD 该退')
let cd = JSON.parse(await readFile(path.join(home3, 'cooldown.json'), 'utf8'))
assert.equal('111' in cd, false)
assert.equal('222' in cd && '333' in cd, true, '排队的人没被取消，CD 不该动')
ok('cancel: 只掐当前这首，排单与排队者 CD 保持不动')

// ---------- 6) alsoQueue=true：才清排单，并逐条退 CD ----------
const res2 = await cancel.execute({ alsoQueue: true })
assert.deepEqual(await readQueue(home3), [])
cd = JSON.parse(await readFile(path.join(home3, 'cooldown.json'), 'utf8'))
assert.equal('222' in cd || '333' in cd, false, '被清掉的排队者 CD 该退')
assert.match(res2.summary, /排单里 2 首也清了/)
ok('cancel alsoQueue: 清排单 + 逐条退 CD')

// ---------- 7) 已经发过几段再取消：不退 CD ----------
const home4 = await tmp('f4')
await writeFile(
  path.join(home4, 'state.json'),
  JSON.stringify({
    jobId: 'job-P',
    pid: DEAD_PID,
    song: 'P',
    target: 'group:1',
    requester: '444',
    stage: 'send',
    stageText: '正在发第 3/5 条',
    sent: 3,
    total: 5,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    ok: null,
    error: '',
  }),
  'utf8',
)
await writeFile(path.join(home4, 'busy.lock'), JSON.stringify({ jobId: 'job-P', at: now }), 'utf8')
await writeFile(path.join(home4, 'cooldown.json'), JSON.stringify({ 444: { song: 'P', at: now } }), 'utf8')
const disposers2 = []
apply(
  {
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers2.push(d)
      return typeof d === 'function' ? d : () => {}
    },
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => {}
      },
    },
  },
  {
    home: home4,
    bridgeUrl: 'http://127.0.0.1:9',
    pythonBili: 'Z:\\not-a-python\\python.exe',
    pythonRvc: 'Z:\\not-a-python\\python.exe',
    credentialFile: 'Z:\\not-a-file.json',
    nodePath: process.execPath,
    announce: false,
    queuePort: 0,
  },
)
const res3 = await tools.get('qq_sing_cancel').execute({})
assert.equal(res3.cdRefunded, false, '已经发出去 3 段，不该退 CD')
cd = JSON.parse(await readFile(path.join(home4, 'cooldown.json'), 'utf8'))
assert.equal('444' in cd, true)
ok('cancel: 已发出的那几段算数，不退 CD')

for (const d of disposers) d()
for (const d of disposers2) d()
for (const h of [home, home2, home3, home4]) {
  await clearQueue(h).catch(() => {})
  await rm(h, { recursive: true, force: true })
}
console.log('\nfixes OK')
