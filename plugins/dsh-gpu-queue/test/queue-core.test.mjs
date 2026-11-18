import test from 'node:test'
import assert from 'node:assert/strict'
import * as core from '../lib/queue-core.js'

const T = 1_700_000_000_000
const alive = (pids) => (pid) => pids.includes(Number(pid))

test('enqueue 生成唯一 id，kind 非法直接抛', () => {
  const state = core.createState()
  const a = core.enqueue(state, { kind: 'draw', label: '画一张', ownerPid: 11, now: T })
  const b = core.enqueue(state, { kind: 'draw', label: '画一张', ownerPid: 11, now: T })
  assert.notEqual(a.id, b.id)
  assert.equal(state.queue.length, 2)
  assert.throws(() => core.enqueue(state, { kind: 'video', now: T }), /unknown kind/)
})

test('排队顺序：voice 插到所有排队项前面，draw/sing 按 seq', () => {
  const state = core.createState()
  const d1 = core.enqueue(state, { kind: 'draw', label: 'd1', ownerPid: 1, now: T })
  const s1 = core.enqueue(state, { kind: 'sing', label: 's1', ownerPid: 1, now: T })
  const d2 = core.enqueue(state, { kind: 'draw', label: 'd2', ownerPid: 1, now: T })
  const v1 = core.enqueue(state, { kind: 'voice', label: 'v1', ownerPid: 1, now: T })
  assert.deepEqual(
    core.order(state).map((item) => item.id),
    [v1.id, d1.id, s1.id, d2.id],
  )
  assert.equal(core.positionOf(state, s1.id), 3)
})

test('有 holder 时不发牌；release 后才发下一个', () => {
  const state = core.createState()
  const a = core.enqueue(state, { kind: 'draw', label: 'a', ownerPid: 1, now: T })
  const b = core.enqueue(state, { kind: 'draw', label: 'b', ownerPid: 1, now: T })
  assert.equal(core.grant(state, a.id, T).id, a.id)
  assert.equal(core.grant(state, b.id, T), null, 'holder 还在，不能发第二张')
  assert.equal(core.release(state, a.id, T + 1000, 'released'), true)
  assert.equal(core.grant(state, b.id, T + 1001).id, b.id)
  assert.equal(state.holder.id, b.id)
})

test('ticket 五种状态', () => {
  const state = core.createState()
  const a = core.enqueue(state, { kind: 'draw', label: 'a', ownerPid: 1, now: T })
  const b = core.enqueue(state, { kind: 'draw', label: 'b', ownerPid: 1, now: T })
  const c = core.enqueue(state, { kind: 'draw', label: 'c', ownerPid: 1, now: T })
  core.grant(state, a.id, T)
  assert.equal(core.ticketOf(state, a.id).state, 'granted')
  assert.equal(core.ticketOf(state, b.id).state, 'queued')
  assert.equal(core.ticketOf(state, b.id).position, 1)
  assert.equal(core.cancel(state, c.id, T + 1), true)
  assert.equal(core.ticketOf(state, c.id).state, 'cancelled')
  core.release(state, a.id, T + 2, 'released')
  assert.equal(core.ticketOf(state, a.id).state, 'lost')
  assert.equal(core.ticketOf(state, 'nope').state, 'unknown')
})

test('心跳过期：回收 holder（how=stale）', () => {
  const state = core.createState()
  const a = core.enqueue(state, { kind: 'draw', label: 'a', ownerPid: 7, now: T })
  core.grant(state, a.id, T)
  core.heartbeat(state, a.id, T + 30_000)
  const outcome = core.reap(state, { now: T + 95_000, isPidAlive: alive([7]), holderTtlMs: 60_000 })
  assert.equal(outcome.holderReleased?.how, 'stale')
  assert.equal(state.holder, null)
  assert.equal(state.recent[0].how, 'stale')
})

test('持有者进程死：立刻回收（how=owner-dead），排队项进程死也丢', () => {
  const state = core.createState()
  const a = core.enqueue(state, { kind: 'draw', label: 'a', ownerPid: 7, now: T })
  const b = core.enqueue(state, { kind: 'sing', label: 'b', ownerPid: 8, now: T })
  core.grant(state, a.id, T)
  const outcome = core.reap(state, { now: T + 100, isPidAlive: alive([]), holderTtlMs: 60_000 })
  assert.equal(outcome.holderReleased?.how, 'owner-dead')
  assert.deepEqual(outcome.dropped, [b.id])
  assert.equal(state.queue.length, 0)
})

test('排队项 90s 没轮询就丢掉，按时轮询的留下来', () => {
  const state = core.createState()
  const stale = core.enqueue(state, { kind: 'draw', label: 'stale', ownerPid: 7, now: T })
  const polled = core.enqueue(state, { kind: 'draw', label: 'polled', ownerPid: 7, now: T })
  const holder = core.enqueue(state, { kind: 'draw', label: 'h', ownerPid: 7, now: T - 1000 })
  core.grant(state, holder.id, T - 1000)
  core.markPoll(state, polled.id, T + 80_000)
  const outcome = core.reap(state, {
    now: T + 95_000,
    isPidAlive: alive([7]),
    holderTtlMs: 600_000,
    queueIdleDropMs: 90_000,
  })
  assert.deepEqual(outcome.dropped, [stale.id])
  assert.deepEqual(
    state.queue.map((item) => item.id),
    [polled.id],
  )
})

test('热重载恢复：活着的退回队列，死掉的进 recent，seq 不回退', () => {
  const state = core.createState()
  const a = core.enqueue(state, { kind: 'draw', label: 'a', ownerPid: 7, now: T })
  const b = core.enqueue(state, { kind: 'draw', label: 'b', ownerPid: 9, now: T })
  core.grant(state, a.id, T)
  const restored = core.restore(state, { now: T + 500, isPidAlive: alive([7]) })
  assert.deepEqual(restored, [a.id])
  assert.equal(state.queue.length, 1)
  assert.equal(state.holder, null)
  assert.ok(state.recent.some((item) => item.id === b.id && item.how === 'owner-dead'))
  const next = core.enqueue(state, { kind: 'draw', label: 'c', ownerPid: 7, now: T + 600 })
  assert.ok(Number(next.seq) > Number(a.seq))
})

test('snapshot 只吐公开字段并带上位次', () => {
  const state = core.createState()
  const a = core.enqueue(state, { kind: 'draw', label: 'a', ownerPid: 7, now: T })
  core.grant(state, a.id, T)
  core.enqueue(state, { kind: 'voice', label: 'v', ownerPid: 7, now: T })
  const snap = core.snapshot(state)
  assert.equal(snap.holder.kind, 'draw')
  assert.equal(snap.queue[0].kind, 'voice')
  assert.equal(snap.queue[0].position, 1)
  assert.equal(snap.queue[0].lastPollAt, undefined)
})
