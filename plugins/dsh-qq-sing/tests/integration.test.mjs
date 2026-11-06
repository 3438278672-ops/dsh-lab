/**
 * 点歌 CD 的集成测试：直接 import index.js 的 apply()，用 stub ctx 拿到 qq_sing，
 * 在临时 home 里跑「拦截 / 记账 / 失败退还」三条路径。
 * fetch 阶段用不存在的 pythonBili 让它快速失败，不碰真桥、不下歌。
 *   node tests/integration.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const home = await mkdtemp(path.join(os.tmpdir(), 'qqsing-it-'))
const tools = new Map()
const disposers = []
const ctx = {
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    return typeof d === 'function' ? d : () => {}
  },
  tools: { register(def) { tools.set(def.name, def); return () => {} } },
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
  maxSongMinutes: 9,
  announce: false,
})

const sing = tools.get('qq_sing')
assert.ok(sing, 'qq_sing not registered')
const ok = (name) => console.log('PASS', name)

// 1. 预置 CD 的人再点 → 拦，不 spawn
await writeFile(
  path.join(home, 'cooldown.json'),
  JSON.stringify({ 111111: { at: Date.now(), song: '晴天', target: 'group:1' } }),
  'utf8',
)
const blocked = await sing.execute({ song: '稻香', requester: '111111', target: 'group:1' })
assert.equal(blocked.ok, false)
assert.equal(blocked.cooldown, true)
assert.equal(blocked.requester, '111111')
assert.ok(blocked.remainingMs > 0)
assert.match(blocked.summary, /还要等/)
assert.equal((await readFile(path.join(home, 'state.json'), 'utf8').catch(() => '')).length, 0)
ok('blocked -> no spawn')

// 2. 私聊不传 requester → 用对方 QQ 号记账并起唱
const started = await sing.execute({ song: '稻香', target: 'private:100000002' })
assert.equal(started.ok, true)
assert.equal(started.started, true)
const cd1 = JSON.parse(await readFile(path.join(home, 'cooldown.json'), 'utf8'))
assert.equal(cd1['100000002'].song, '稻香')
const job = JSON.parse(await readFile(path.join(home, 'jobs', started.jobId, 'job.json'), 'utf8'))
assert.equal(job.requester, '100000002')
ok('private auto-requester + marked')

// 3. 群里不传 requester → 明确报错，不起唱
let badError = ''
try {
  await sing.execute({ song: '稻香', target: 'group:562437955' })
} catch (error) {
  badError = error.message
}
assert.match(badError, /点歌人/)
ok('group without requester rejected')

// 4. worker 失败 → 退还 CD，同一人立刻能再点
const deadline = Date.now() + 20_000
let refunded = false
while (Date.now() < deadline) {
  const cd = JSON.parse(await readFile(path.join(home, 'cooldown.json'), 'utf8'))
  if (!cd['100000002']) { refunded = true; break }
  await new Promise((r) => setTimeout(r, 300))
}
assert.equal(refunded, true, 'cooldown not refunded after failed fetch')
const again = await sing.execute({ song: '稻香', requester: '100000002', target: 'private:100000002' })
assert.equal(again.ok, true)
assert.equal(again.started, true)
ok('refund on failure -> can re-request')

// 等上一个 job 彻底收尾（失败会自己删锁、释放 busy）
async function waitIdle(ms = 20_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      await readFile(path.join(home, 'busy.lock'))
    } catch {
      await new Promise((r) => setTimeout(r, 300))
      return
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('waitIdle timeout')
}
await waitIdle()

// 5. 白名单：不计时，连点两次都放行
await writeFile(path.join(home, 'allowlist.txt'), '# 测试\n555555\n', 'utf8')
const w1 = await sing.execute({ song: '稻香', requester: '555555', target: 'private:100000002' })
assert.equal(w1.ok, true)
assert.equal(w1.whitelisted, true)
const cdw = JSON.parse(await readFile(path.join(home, 'cooldown.json'), 'utf8'))
assert.equal('555555' in cdw, false, 'whitelisted user must not be recorded')
const wjob = JSON.parse(await readFile(path.join(home, 'jobs', w1.jobId, 'job.json'), 'utf8'))
assert.equal(wjob.whitelisted, true)
// 等 worker 失败/或直接杀掉，清掉锁和 state，模拟“空闲”
try {
  const st = JSON.parse(await readFile(path.join(home, 'state.json'), 'utf8'))
  if (st?.pid) process.kill(st.pid)
} catch { /* 已退出 */ }
await new Promise((r) => setTimeout(r, 500))
await rm(path.join(home, 'state.json'), { force: true })
await rm(path.join(home, 'busy.lock'), { force: true })
const w2 = await sing.execute({ song: '稻香', requester: '555555', target: 'private:100000002' })
assert.equal(w2.ok, true)
assert.equal(w2.whitelisted, true)
ok('whitelist -> no cooldown, can point repeatedly')

// 清理：杀掉残留 worker
for (const jobId of [started.jobId, again.jobId, w1.jobId, w2.jobId]) {
  try {
    const st = JSON.parse(await readFile(path.join(home, 'state.json'), 'utf8'))
    if (st?.pid) process.kill(st.pid)
  } catch { /* 已退出 */ }
}
await new Promise((r) => setTimeout(r, 500))
for (const d of disposers) d()
await rm(home, { recursive: true, force: true })
console.log('\nintegration OK')
