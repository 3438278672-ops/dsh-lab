/**
 * qq-sing 本机控制口的回归：悬浮球就是靠这几个端点干活，坏一个面板就瞎了。
 *
 * 覆盖：
 *   1. 起服务写 status 文件（端口/pid/tokenFile），GET /qqsing.json 带 limits 与 cooldowns；
 *   2. /qqsing/pause 的权限：无令牌 + 外站 Origin → 403；令牌 / file:// Origin 放行，updatedBy 记得住；
 *   3. /qqsing/cancel 只认令牌（403），空闲时 cancelled:false 不是错误；
 *   4. jobId 对不上回 409 JOB_MISMATCH，且不动在唱的任务；
 *   5. alsoQueue=1 连带清空排单；PID 被别的程序占着时绝不乱杀。
 *
 *   node tests/control-endpoint.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const home = await mkdtemp(path.join(os.tmpdir(), 'qqsing-ctl-'))
const servicesDir = path.join(home, 'services')
const disposers = []
const ctx = {
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    return typeof d === 'function' ? d : () => {}
  },
  tools: { register() { return () => {} } },
}

function ok(name) {
  console.log(`PASS ${name}`)
}

const port = await new Promise((resolve, reject) => {
  const probe = createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port: found } = probe.address()
    probe.close(() => resolve(found))
  })
})

apply(ctx, {
  home,
  queuePort: port,
  servicesDir,
  announce: false,
  bridgeUrl: 'http://127.0.0.1:9',
  bridgeDir: 'D:\\DPQQ\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1',
  pythonBili: 'Z:\\not-a-python\\python.exe',
  pythonRvc: 'Z:\\not-a-python\\python.exe',
  nodePath: process.execPath,
})

const base = `http://127.0.0.1:${port}`

async function waitReady() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${base}/qqsing.json`)
      if (response.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('queue server 没起来')
}

async function call(pathname, { method = 'GET', token = '', by = '', origin = '', body } = {}) {
  const headers = {}
  if (token) headers['x-control-token'] = token
  // 头只能是 latin1：中文名字必须 encodeURIComponent，服务端再解回来
  if (by) headers['x-control-by'] = encodeURIComponent(by)
  if (origin) headers.origin = origin
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try {
    json = await response.json()
  } catch {
    /* 空 body */
  }
  return { status: response.status, json }
}

await waitReady()
const token = (await readFile(path.join(servicesDir, 'qq-sing.token'), 'utf8')).trim()
assert.equal(token.length, 48, '令牌不是 48 位')

// 1. status 文件 + 快照形状
const status = JSON.parse(await readFile(path.join(servicesDir, 'qq-sing.status.json'), 'utf8'))
assert.equal(status.port, port)
assert.equal(status.pid, process.pid)
assert.ok(String(status.tokenFile).endsWith('qq-sing.token'))
await writeFile(path.join(home, 'allowlist.txt'), '111111\n# 注释\n', 'utf8')
const nowMs = Date.now()
await writeFile(
  path.join(home, 'cooldown.json'),
  JSON.stringify({
    222222: { at: nowMs - 60_000, song: '晴天', target: 'group:1' },
    111111: { at: nowMs - 60_000, song: '稻香', target: 'group:1' }, // 白名单，不该出现
  }),
  'utf8',
)
const snap = (await call('/qqsing.json')).json
assert.equal(snap.ok, true)
assert.equal(snap.limits.cooldownMinutes, 60)
assert.equal(snap.limits.maxQueue, 5)
assert.equal(snap.limits.allowlistCount, 1)
assert.equal(snap.limits.bypassCount, 0)
assert.equal(snap.cooldowns.length, 1, '白名单不该出现在 cooldowns 里')
assert.equal(snap.cooldowns[0].requester, '222222')
assert.ok(snap.cooldowns[0].leftMs > 0 && snap.cooldowns[0].leftMs <= 3_600_000)
assert.ok(snap.cooldowns[0].resetAt > nowMs)
ok('status 文件 + 快照带 limits/cooldowns（白名单已排除）')

// 2. pause 权限与 updatedBy
assert.equal((await call('/qqsing/pause?on=1', { method: 'POST', origin: 'http://evil.example' })).status, 403)
const paused = await call('/qqsing/pause?on=1', { method: 'POST', token, by: '测试员A' })
assert.equal(paused.status, 200)
assert.equal(paused.json.paused, true)
assert.equal(paused.json.updatedBy, '测试员A')
const pausedFile = JSON.parse(await readFile(path.join(home, 'paused.json'), 'utf8'))
assert.equal(pausedFile.paused, true)
assert.equal(pausedFile.updatedBy, '测试员A')
assert.equal((await call('/qqsing.json')).json.paused, true)
// file:// 页面（Origin: null）不带令牌也放行，老卡片不会突然失效
const byOrigin = await call('/qqsing/pause?on=0', { method: 'POST', origin: 'null' })
assert.equal(byOrigin.status, 200)
assert.equal(byOrigin.json.paused, false)
assert.equal(byOrigin.json.updatedBy, '悬浮球', '没传 by 时兜底成悬浮球')
// ?by= 也认（curl 调试方便），中文同样 encodeURIComponent
const byQuery = await call(`/qqsing/pause?on=0&by=${encodeURIComponent('面板')}`, { method: 'POST', token })
assert.equal(byQuery.json.updatedBy, '面板')
ok('pause：外站 403、令牌/file:// 放行、updatedBy 落盘')

// 3. cancel 只认令牌；空闲时 cancelled:false
assert.equal((await call('/qqsing/cancel', { method: 'POST', origin: 'null' })).status, 403)
const idle = await call('/qqsing/cancel', { method: 'POST', token })
assert.equal(idle.status, 200)
assert.equal(idle.json.ok, true)
assert.equal(idle.json.cancelled, false)
ok('cancel 需要令牌；空闲时 cancelled:false 不报错')

// 4. jobId 对不上 → 409，不碰在唱的那首
await writeFile(
  path.join(home, 'state.json'),
  JSON.stringify({
    jobId: 'sing-abc',
    pid: process.pid,
    song: '晴天',
    target: 'group:1',
    sent: 0,
    total: 3,
    startedAt: nowMs,
  }),
  'utf8',
)
const mismatch = await call('/qqsing/cancel?jobId=sing-other', { method: 'POST', token })
assert.equal(mismatch.status, 409)
assert.equal(mismatch.json.code, 'JOB_MISMATCH')
assert.equal(mismatch.json.jobId, 'sing-abc')
const stillThere = JSON.parse(await readFile(path.join(home, 'state.json'), 'utf8'))
assert.equal(stillThere.finishedAt, undefined, 'JOB_MISMATCH 不该改状态')
ok('cancel：jobId 不匹配回 409 且不动在唱的任务')

// 5. alsoQueue 连带清排单；PID 被别的程序占着不乱杀
await mkdir(path.join(home, 'jobs', 'sing-abc'), { recursive: true })
await writeFile(
  path.join(home, 'jobs', 'sing-abc', 'job.json'),
  JSON.stringify({ jobId: 'sing-abc', song: '晴天', requester: '222222', target: 'group:1', whitelisted: false }),
  'utf8',
)
await writeFile(
  path.join(home, 'queue.json'),
  JSON.stringify([{ song: '稻香', target: 'group:1', requester: '333333', queuedAt: nowMs }]),
  'utf8',
)
const cancelled = await call('/qqsing/cancel?alsoQueue=1', { method: 'POST', token })
assert.equal(cancelled.status, 200)
assert.equal(cancelled.json.ok, true)
assert.equal(cancelled.json.cancelled, false, `PID ${process.pid} 上是我们自己，不该被当成 worker 杀掉`)
assert.equal(cancelled.json.clearedQueue, 1)
assert.match(cancelled.json.summary, /没杀任何东西|进程看起来已经没了/)
const queueAfter = JSON.parse(await readFile(path.join(home, 'queue.json'), 'utf8'))
assert.deepEqual(queueAfter, [])
const patched = JSON.parse(await readFile(path.join(home, 'state.json'), 'utf8'))
assert.ok(patched.finishedAt > 0, '收尾后要写 finishedAt，否则面板会一直显示在唱')
ok('cancel：alsoQueue 清排单、PID 复用时只收尾不乱杀')

for (const d of disposers) d()
await rm(home, { recursive: true, force: true })
console.log('\ncontrol endpoint OK')
