/**
 * 两阶段点歌的确认分支回归（不联网：pending 是手写进去的，plan 结果不依赖 B 站）。
 *   node tests/confirm.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply, runQueueTick } from '../index.js'
import { clearQueue, enqueue, readQueue } from '../queue.mjs'

const ok = (name) => console.log('PASS', name)
const home = await mkdtemp(path.join(os.tmpdir(), 'qqsing-confirm-'))
const disposers = []
const tools = new Map()
apply(
  {
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return () => {}
    },
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => {}
      },
    },
  },
  {
    home,
    bridgeUrl: 'http://127.0.0.1:9',
    bridgeDir: 'D:\\DPQQ\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1',
    pythonBili: 'Z:\\not-a-python\\python.exe',
    pythonRvc: 'Z:\\not-a-python\\python.exe',
    credentialFile: 'Z:\\not-a-file.json',
    nodePath: process.execPath,
    announce: false,
    queuePort: 0,
    // 这组测试只关心确认分支：CD 关掉，免得第二次确认被 CD 拦在前面
    cooldownMs: 0,
  },
)

const sing = tools.get('qq_sing')
const pendingPath = path.join(home, 'pending-confirm.json')

const candidates = [
  { bvid: 'BV1aaaaaaaaa', title: '《后来》刘若英 MV', duration: 341, uploader: '梁乐观同学', score: 8.0 },
  { bvid: 'BV1bbbbbbbbb', title: '万人合唱《后来》', duration: 223, uploader: '一个地黄瓜', score: 4.6 },
]

async function seedPending(token, { requester = '11111', target = 'group:1', at = Date.now() } = {}) {
  const map = {}
  try {
    Object.assign(map, JSON.parse(await readFile(pendingPath, 'utf8')))
  } catch {
    /* 第一次还没有文件 */
  }
  map[token] = {
    at,
    song: '后来',
    target,
    requester,
    plan: { keyword: '后来', confidence: 'low', reason: '前两名分太近', candidates },
  }
  await writeFile(pendingPath, JSON.stringify(map), 'utf8')
}

// ---------- 1) 确认第 2 个候选：带 bvid + 标题入队，token 作废 ----------
await enqueue(home, { song: '占位', target: 'group:1', requester: '99999' })
await seedPending('tok-1')
const r1 = await sing.execute({ confirm: 'tok-1', pick: 2, requester: '11111', target: 'group:1' })
assert.equal(r1.ok, true)
assert.equal(r1.queued, true)
let queue = await readQueue(home)
const last = queue[queue.length - 1]
assert.equal(last.bvid, 'BV1bbbbbbbbb', '确认哪首就传哪首的 BV')
assert.equal(last.expectedTitle, '万人合唱《后来》', '标题也要带进排单，起唱后才能播报')
assert.equal(last.song, '万人合唱《后来》')
let pending = JSON.parse(await readFile(pendingPath, 'utf8'))
assert.equal('tok-1' in pending, false, '用过的 token 要删掉，避免重复确认')
ok('confirm: 选中的候选带 bvid 入队，token 一次性')

// ---------- 2) 同一个 token 再用：报过期，不要重复排单 ----------
await assert.rejects(() => sing.execute({ confirm: 'tok-1', requester: '11111', target: 'group:1' }), /过期/)
ok('confirm: 用过的 token 不能再用')

// ---------- 3) 别的点歌人拿 token：拒绝 ----------
await seedPending('tok-2')
await assert.rejects(
  () => sing.execute({ confirm: 'tok-2', pick: 1, requester: '22222', target: 'group:1' }),
  /另一位点歌人/,
)
ok('confirm: token 只认原来的点歌人')

// ---------- 4) 会话对不上：拒绝 ----------
await seedPending('tok-3', { target: 'group:2' })
await assert.rejects(
  () => sing.execute({ confirm: 'tok-3', pick: 1, requester: '11111', target: 'group:1' }),
  /不是发给这个会话/,
)
ok('confirm: token 只认原来的会话')

// ---------- 5) 超过 10 分钟的 token：当作过期 ----------
await seedPending('tok-4', { at: Date.now() - 11 * 60 * 1000 })
await assert.rejects(() => sing.execute({ confirm: 'tok-4', requester: '11111', target: 'group:1' }), /过期/)
ok('confirm: 超过 10 分钟自动作废')

// ---------- 6) pick 越界：夹到最后一个候选 ----------
await seedPending('tok-5')
const r5 = await sing.execute({ confirm: 'tok-5', pick: 99, requester: '11111', target: 'group:1' })
assert.equal(r5.queued, true)
queue = await readQueue(home)
assert.equal(queue[queue.length - 1].bvid, 'BV1bbbbbbbbb')
ok('confirm: pick 越界夹到最后一个')

// ---------- 7) 排单起唱时 bvid / expectedTitle 要透传给 worker ----------
await clearQueue(home)
await enqueue(home, { song: '甲', bvid: 'BV1ccccccccc', expectedTitle: '甲（确认版）', target: 'group:1', requester: '33333' })
let seen = null
const tick = await runQueueTick({ home }, {
  startJob: async (_cfg, opts) => {
    seen = opts
    return { ok: true, started: true }
  },
})
assert.equal(tick.started, true)
assert.equal(seen.bvid, 'BV1ccccccccc')
assert.equal(seen.expectedTitle, '甲（确认版）')
ok('调度: 排单里的 bvid 一路带到 startJob')

for (const d of disposers) d()
await clearQueue(home).catch(() => {})
await rm(home, { recursive: true, force: true })
console.log('\nconfirm OK')
