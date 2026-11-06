/**
 * 排单（queue.mjs）+ qq_sing 排单路径的测试。
 *   node tests/queue.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { QUEUE_LIMIT, clearQueue, enqueue, readQueue, shiftQueue } from '../queue.mjs'
import { apply } from '../index.js'

const ok = (name) => console.log('PASS', name)

// ---------- 队列本体 ----------
const home = await mkdtemp(path.join(os.tmpdir(), 'qqsing-q-'))
assert.deepEqual(await readQueue(home), [])
const r1 = await enqueue(home, { song: 'A', target: 'group:1', requester: '1' })
const r2 = await enqueue(home, { song: 'B', target: 'group:1', requester: '2' })
assert.deepEqual([r1.position, r2.position], [1, 2])
const full = []
for (let i = 0; i < QUEUE_LIMIT - 2; i += 1) full.push(await enqueue(home, { song: `C${i}`, target: 'group:1' }))
assert.equal(full.every((r) => r.ok), true)
const overflow = await enqueue(home, { song: 'D', target: 'group:1' })
assert.equal(overflow.ok, false)
assert.equal(overflow.size, QUEUE_LIMIT)
const first = await shiftQueue(home)
assert.equal(first.song, 'A')
assert.equal((await readQueue(home)).length, QUEUE_LIMIT - 1)
await clearQueue(home)
assert.deepEqual(await readQueue(home), [])
ok('queue enqueue/limit/shift/clear')

// ---------- 插件层：忙的时候排单 ----------
const home2 = await mkdtemp(path.join(os.tmpdir(), 'qqsing-q2-'))
const disposers = []
const tools = new Map()
const ctx = {
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    return typeof d === 'function' ? d : () => {}
  },
  tools: { register(def) { tools.set(def.name, def); return () => {} } },
}

// 伪造一个「正在唱」的任务：pid 用自己（一定存活），stage 发语音
const fakeState = {
  jobId: 'fake-busy',
  pid: process.pid,
  song: '正在唱',
  target: 'group:1',
  stage: 'send',
  stageText: '正在发第 1/2 条',
  total: 2,
  sent: 1,
  startedAt: Date.now(),
  updatedAt: Date.now(),
  finishedAt: null,
  ok: null,
  error: '',
}
await writeFile(path.join(home2, 'state.json'), JSON.stringify(fakeState), 'utf8')
await writeFile(path.join(home2, 'busy.lock'), JSON.stringify({ jobId: 'fake-busy', pid: process.pid }), 'utf8')

apply(ctx, {
  home: home2,
  bridgeUrl: 'http://127.0.0.1:9',
  bridgeDir: 'D:\\DPQQ\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1',
  bridgeTimezone: 'Asia/Shanghai',
  pythonBili: 'Z:\\not-a-python\\python.exe',
  pythonRvc: 'Z:\\not-a-python\\python.exe',
  credentialFile: 'Z:\\not-a-file.json',
  nodePath: process.execPath,
  minIntervalMs: 100,
  maxSegments: 2,
  maxSongMinutes: 9,
  announce: false,
  queuePort: 0,
})

const sing = tools.get('qq_sing')
assert.ok(sing, 'qq_sing not registered')

const q1 = await sing.execute({ song: '稻香', requester: '333333', target: 'private:100000002' })
assert.equal(q1.ok, true)
assert.equal(q1.queued, true)
assert.equal(q1.position, 1)
const q2 = await sing.execute({ song: '晴天', requester: '444444', target: 'group:562437955' })
assert.equal(q2.queued, true)
assert.equal(q2.position, 2)
const list = await readQueue(home2)
assert.deepEqual(list.map((i) => i.song), ['稻香', '晴天'])
assert.equal(list[0].requester, '333333')
const cds = JSON.parse(await readFile(path.join(home2, 'cooldown.json'), 'utf8'))
assert.equal('333333' in cds, true, 'queued requester should be marked for CD')
ok('busy -> queued with position + CD marked')

// 状态工具能看到排单
const status = tools.get('qq_sing_status')
const st = await status.execute({})
assert.match(st.summary, /排单还有 2 首/)
ok('status shows queue')

for (const d of disposers) d()
await clearQueue(home2)
await rm(home, { recursive: true, force: true })
await rm(home2, { recursive: true, force: true })
console.log('\nqueue OK')
