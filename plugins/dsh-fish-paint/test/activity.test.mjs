// 在飞请求登记表：jobId 生成、阶段推进、按开始时间排序、结束时删掉。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createActivity } from '../lib/activity.js'

function fakeClock(start = 1_700_000_000_000) {
  let now = start
  return { now: () => now, tick: (ms = 1) => (now += ms) }
}

test('begin 生成 draw-<ts36>-<seq>，出多张变体也只算一个 job', () => {
  const clock = fakeClock()
  const activity = createActivity({ now: clock.now })
  const first = activity.begin({ prompt: '1girl, solo', requester: '10001', rating: 'sfw', note: '群友' })
  const second = activity.begin({ prompt: '2girls', rating: 'nsfw' })
  assert.match(first, /^draw-[0-9a-z]+-1$/)
  assert.match(second, /^draw-[0-9a-z]+-2$/)
  assert.notEqual(first, second)
  assert.equal(activity.size(), 2)
  const items = activity.list()
  assert.equal(items.length, 2)
  assert.equal(items[0].phase, 'waiting')
  assert.equal(items[0].requester, '10001')
  assert.equal(items[1].rating, 'nsfw')
  assert.equal(items[1].requester, '')
})

test('mark 推阶段；未知 jobId 返回 null；end 之后查不到', () => {
  const clock = fakeClock()
  const activity = createActivity({ now: clock.now })
  const jobId = activity.begin({ prompt: 'x' })
  clock.tick()
  assert.equal(activity.mark(jobId, { phase: 'queued', position: 3 }).phase, 'queued')
  clock.tick()
  const drawing = activity.mark(jobId, { phase: 'drawing', position: 0 })
  assert.equal(drawing.phase, 'drawing')
  assert.equal(activity.get(jobId).phase, 'drawing')
  assert.equal(activity.mark('nope', { phase: 'drawing' }), null)
  assert.equal(activity.end(jobId), true)
  assert.equal(activity.end(jobId), false)
  assert.equal(activity.get(jobId), null)
  assert.deepEqual(activity.list(), [])
})

test('subscribe 收到快照；监听器抛错不影响别的监听器', () => {
  const clock = fakeClock()
  const activity = createActivity({ now: clock.now })
  const seen = []
  activity.subscribe(() => {
    throw new Error('面板坏了')
  })
  const off = activity.subscribe((list) => seen.push(list.map((item) => item.phase)))
  const jobId = activity.begin({ prompt: 'a' })
  activity.mark(jobId, { phase: 'drawing' })
  activity.end(jobId)
  off()
  activity.begin({ prompt: 'b' })
  assert.deepEqual(seen.slice(0, 3), [['waiting'], ['drawing'], []])
  assert.equal(seen.length, 3, 'off 之后不该再收到')
})

test('长 prompt 被截断，空白折叠', () => {
  const clock = fakeClock()
  const activity = createActivity({ now: clock.now })
  const jobId = activity.begin({ prompt: `  ${'x'.repeat(300)}  \n\n  tail ` })
  const item = activity.get(jobId)
  assert.ok(item.prompt.length <= 120)
  assert.ok(!item.prompt.includes('\n'))
})
