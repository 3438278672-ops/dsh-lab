import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArchive, insertBatch } from '../lib/db.mjs'
import { normalizeOneBot } from '../lib/normalize.mjs'
import { weekBounds, buildLeaderboard } from '../lib/leaderboard.mjs'

function ev({ time, text, user = 111, name = '阿猫', group = 1, groupName = '一群' }) {
  return {
    time,
    self_id: 999,
    post_type: 'message',
    message_type: 'group',
    group_id: group,
    group_name: groupName,
    user_id: user,
    message_id: time,
    sender: { user_id: user, nickname: name },
    message: [{ type: 'text', data: { text } }],
    raw_message: text || '',
  }
}

/** 本地时区的 'YYYY-MM-DD HH:mm' → unix 秒（测试不依赖机器当前时间）。 */
function at(dateStr, hh = 12, mm = 0) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  return Math.floor(new Date(y, m - 1, d, hh, mm, 0).getTime() / 1000)
}

// 2026-11-11 是周三；本周 = 11-09(一) ~ 11-15(日)，现在停在 11-11 19:30。
// 上周的对比窗口不是整周，而是「上周同一时段」：11-02 00:00 ~ 11-04 19:30。
const NOW = new Date(2026, 10, 11, 19, 30)

function fixture() {
  return [
    // ---- 本周至今 ----
    // 111 阿猫改名：本周 5 条（一群 3、二群 2），上周同期 2 条
    ev({ time: at('2026-11-09', 9, 0), text: 'a1' }),
    ev({ time: at('2026-11-09', 10, 0), text: 'a2' }),
    ev({ time: at('2026-11-10', 9, 0), text: 'a3', group: 2, groupName: '二群' }),
    ev({ time: at('2026-11-10', 10, 0), text: 'a4', group: 2, groupName: '二群' }),
    ev({ time: at('2026-11-11', 9, 0), text: 'a5', name: '阿猫改名' }),
    // 222 阿狗：本周 2 条、上周同期 0 → new
    ev({ time: at('2026-11-11', 12, 0), text: 'b1', user: 222, name: '阿狗' }),
    ev({ time: at('2026-11-11', 12, 1), text: 'b2', user: 222, name: '阿狗' }),
    // 333 阿猪：本周 1 条（二群）、上周同期 1 条（一群）→ flat
    ev({ time: at('2026-11-11', 18, 0), text: 'c1', user: 333, name: '阿猪', group: 2, groupName: '二群' }),
    // 边界：周一 00:00 算本周
    ev({ time: at('2026-11-09', 0, 0), text: '周一零点', user: 777, name: '阿牛' }),
    // 未来（周日晚）与下周的都不进本周统计
    ev({ time: at('2026-11-15', 23, 59), text: '周日夜里', user: 777, name: '阿牛' }),
    ev({ time: at('2026-11-16', 0, 0), text: '下周一条', user: 888, name: '阿马', group: 2, groupName: '二群' }),
    // ---- 上周同一时段（11-02 00:00 ~ 11-04 19:30）----
    ev({ time: at('2026-11-03', 9, 0), text: 'a0' }),
    ev({ time: at('2026-11-03', 10, 0), text: 'a0b' }),
    ev({ time: at('2026-11-04', 9, 0), text: 'c0', user: 333, name: '阿猪' }),
    // 444 阿鸡：上周同期 4 条、本周 0 → gone（失踪人口第一）
    ev({ time: at('2026-11-02', 9, 0), text: 'd1', user: 444, name: '阿鸡', group: 2, groupName: '二群' }),
    ev({ time: at('2026-11-02', 10, 0), text: 'd2', user: 444, name: '阿鸡', group: 2, groupName: '二群' }),
    ev({ time: at('2026-11-02', 11, 0), text: 'd3', user: 444, name: '阿鸡', group: 2, groupName: '二群' }),
    ev({ time: at('2026-11-04', 10, 0), text: 'd4', user: 444, name: '阿鸡', group: 2, groupName: '二群' }),
    // 555 阿鸭：上周同期 2 条、本周 0 → gone
    ev({ time: at('2026-11-03', 11, 0), text: 'e1', user: 555, name: '阿鸭' }),
    ev({ time: at('2026-11-04', 11, 0), text: 'e2', user: 555, name: '阿鸭' }),
    // 上周后半段（11-05 之后）不在「同期」窗口里，不该进统计
    ev({ time: at('2026-11-05', 9, 0), text: 'late-week', user: 444, name: '阿鸡', group: 2, groupName: '二群' }),
    // ---- 更早：两周前，不该进任何统计 ----
    ev({ time: at('2026-10-28', 9, 0), text: 'old', user: 666, name: '阿龙' }),
  ]
}

async function withSeededArchive(fn) {
  const home = await mkdtemp(join(tmpdir(), 'qq-archive-lb-'))
  const archive = openArchive(home)
  try {
    const counts = insertBatch(
      archive.db,
      archive,
      fixture().map((data, i) => normalizeOneBot({ source: 'json', sourceKey: 'lb-' + i, data })),
    )
    return await fn({ archive, home, counts })
  } finally {
    archive.db.close()
    await rm(home, { recursive: true, force: true })
  }
}

test('weekBounds：周一起算、offset 正负、边界收口', () => {
  const wk = weekBounds(NOW)
  assert.deepEqual(wk, {
    fromTs: at('2026-11-09', 0, 0),
    toTs: at('2026-11-16', 0, 0) - 1,
    fromDate: '2026-11-09',
    toDate: '2026-11-15',
  })
  assert.equal(weekBounds(NOW, -1).fromDate, '2026-11-02')
  assert.equal(weekBounds(NOW, -1).toDate, '2026-11-08')
  assert.equal(weekBounds(NOW, 1).fromDate, '2026-11-16')
  assert.equal(weekBounds(NOW, 1).toDate, '2026-11-22')
  // 周日晚上、周一凌晨都属于同一周
  assert.deepEqual(weekBounds(new Date(2026, 10, 15, 23, 59)), wk)
  assert.deepEqual(weekBounds(new Date(2026, 10, 9, 0, 0)), wk)
  // 接受毫秒时间戳
  assert.equal(weekBounds(at('2026-11-11', 19, 30) * 1000).fromDate, '2026-11-09')
  assert.throws(() => weekBounds(new Date('not-a-date')), /合法的 Date/)
})

test('buildLeaderboard：本周至今 vs 上周同期、状态、会话拆分、失踪人口', async () => {
  await withSeededArchive(async ({ archive, counts }) => {
    assert.equal(counts.inserted, 22)

    const lb = buildLeaderboard(archive.db, { now: NOW })
    // 本周到 11-11 19:30 为止；上周只取同长度的 11-02 00:00 ~ 11-04 19:30
    assert.deepEqual(lb.week, { fromDate: '2026-11-09', toDate: '2026-11-11', partial: true })
    assert.deepEqual(lb.prev, { fromDate: '2026-11-02', toDate: '2026-11-04' })
    // 本周：111×5 + 222×2 + 333×1 + 777×1 = 9；同期上周：111×2 + 333×1 + 444×4 + 555×2 = 9
    assert.deepEqual(lb.totals, { cur: 9, prev: 9, delta: 0 })

    // 按本周条数降序；new / gone 的人也必须在 people 里
    assert.deepEqual(
      lb.people.map((p) => [p.userId, p.cur, p.prev, p.delta, p.status]),
      [
        ['111', 5, 2, 3, 'up'],
        ['222', 2, 0, 2, 'new'],
        ['333', 1, 1, 0, 'flat'],
        ['777', 1, 0, 1, 'new'],
        ['444', 0, 4, -4, 'gone'],
        ['555', 0, 2, -2, 'gone'],
      ],
    )
    // 名字取最近一条 sender_name（111 最新的昵称是「阿猫改名」）
    assert.equal(lb.people.find((p) => p.userId === '111').name, '阿猫改名')
    assert.equal(lb.people.find((p) => p.userId === '444').name, '阿鸡')

    // people[].chats 是本周在哪些群说的（gone 的本周 0 条 → 空）
    assert.deepEqual(lb.people.find((p) => p.userId === '111').chats, [
      { chatKey: 'group:1', name: '一群', count: 3 },
      { chatKey: 'group:2', name: '二群', count: 2 },
    ])
    assert.deepEqual(lb.people.find((p) => p.userId === '444').chats, [])

    // 会话维度：两周都算，没有本周发言的群也要留一行（cur=0）
    assert.deepEqual(lb.chats, [
      { chatKey: 'group:1', name: '一群', cur: 6, prev: 5, delta: 1 },
      { chatKey: 'group:2', name: '二群', cur: 3, prev: 4, delta: -1 },
    ])

    // 失踪人口：上周同期有、本周 0 条，按上周同期条数降序；lastTs 是这个人最后一次发言（含同期窗口之后的）
    assert.deepEqual(lb.missing, [
      { userId: '444', name: '阿鸡', prev: 4, lastTs: at('2026-11-05', 9, 0) },
      { userId: '555', name: '阿鸭', prev: 2, lastTs: at('2026-11-04', 11, 0) },
    ])

    // 未来的人、更早的人、上周后半段的人都不该出现
    assert.ok(!lb.people.some((p) => p.userId === '666'))
    assert.ok(!lb.people.some((p) => p.userId === '888'))
    assert.ok(!lb.people.some((p) => p.userId === '999'))
    assert.ok(!lb.chats.some((c) => c.cur === 0 && c.prev === 0))
  })
})

test('buildLeaderboard：周末之后按整周对比（partial=false）', async () => {
  await withSeededArchive(async ({ archive }) => {
    // 周日 23:59 之后，本周窗口已走完，上周也按整周（11-02 ~ 11-08）对比
    const lb = buildLeaderboard(archive.db, { now: new Date(2026, 10, 15, 23, 59, 59) })
    assert.deepEqual(lb.week, { fromDate: '2026-11-09', toDate: '2026-11-15', partial: false })
    assert.deepEqual(lb.prev, { fromDate: '2026-11-02', toDate: '2026-11-08' })
    // 加上周日夜里的一条和上周后半段（11-05）的一条
    assert.deepEqual(lb.totals, { cur: 10, prev: 10, delta: 0 })
    assert.equal(lb.people.find((p) => p.userId === '444').prev, 5)
  })
})

test('buildLeaderboard：top 截断时 new/gone 仍然出现', async () => {
  await withSeededArchive(async ({ archive }) => {
    const lb = buildLeaderboard(archive.db, { now: NOW, top: 1 })
    // 只取本周第一名 111，但 new（222/777）和 gone（444/555）要补上；
    // flat 且不在 top 里的 333 被截断。
    assert.deepEqual(
      lb.people.map((p) => [p.userId, p.status]),
      [
        ['111', 'up'],
        ['222', 'new'],
        ['777', 'new'],
        ['444', 'gone'],
        ['555', 'gone'],
      ],
    )
    assert.ok(!lb.people.some((p) => p.userId === '333'))
  })
})

test('buildLeaderboard：chatKey 过滤只统计这个群', async () => {
  await withSeededArchive(async ({ archive }) => {
    const lb = buildLeaderboard(archive.db, { now: NOW, chatKey: 'group:1' })
    // 一群：本周 111×3 + 222×2 + 777×1 = 6；上周同期 111×2 + 333×1 + 555×2 = 5
    assert.deepEqual(lb.totals, { cur: 6, prev: 5, delta: 1 })
    assert.deepEqual(lb.chats, [{ chatKey: 'group:1', name: '一群', cur: 6, prev: 5, delta: 1 }])

    assert.deepEqual(
      lb.people.map((p) => [p.userId, p.cur, p.prev, p.status]),
      [
        ['111', 3, 2, 'up'],
        ['222', 2, 0, 'new'],
        ['777', 1, 0, 'new'],
        ['555', 0, 2, 'gone'],
        ['333', 0, 1, 'gone'],
      ],
    )
    // 过滤后 chats 只含这个群
    assert.deepEqual(lb.people.find((p) => p.userId === '111').chats, [{ chatKey: 'group:1', name: '一群', count: 3 }])
    // 333 上周在一群说话、本周只在二群 → 在这个过滤口径下是 gone，lastTs 也是一群里的最后一条
    assert.deepEqual(lb.missing, [
      { userId: '555', name: '阿鸭', prev: 2, lastTs: at('2026-11-04', 11, 0) },
      { userId: '333', name: '阿猪', prev: 1, lastTs: at('2026-11-04', 9, 0) },
    ])
  })
})

test('buildLeaderboard：空会话也能给出稳定的空结构', async () => {
  await withSeededArchive(async ({ archive }) => {
    const lb = buildLeaderboard(archive.db, { now: NOW, chatKey: 'group:999' })
    assert.deepEqual(lb.totals, { cur: 0, prev: 0, delta: 0 })
    assert.deepEqual(lb.people, [])
    assert.deepEqual(lb.missing, [])
    assert.deepEqual(lb.chats, [{ chatKey: 'group:999', name: 'group:999', cur: 0, prev: 0, delta: 0 }])
  })
})
