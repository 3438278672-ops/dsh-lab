import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArchive, insertBatch } from '../lib/db.mjs'
import { normalizeOneBot } from '../lib/normalize.mjs'
import { buildCalendar, dayBreakdown } from '../lib/calendar.mjs'

function ev({ time, text, user = 111, name = '阿猫', group = 123, groupName = '测试群', message }) {
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
    message: message || [{ type: 'text', data: { text } }],
    raw_message: text || '',
  }
}

/** 本地时区的 'YYYY-MM-DD HH:mm' → unix 秒（测试不依赖机器当前时间）。 */
function at(dateStr, hh = 12, mm = 0) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  return Math.floor(new Date(y, m - 1, d, hh, mm, 0).getTime() / 1000)
}

function image(file, url = 'https://x/' + file) {
  return { type: 'image', data: { file, url } }
}

function fixture() {
  return [
    // 窗口外：9 月 30 日（months=2 时不该出现，months=3 时才进窗口）
    ev({ time: at('2026-09-30', 23, 0), text: '九月最后一天' }),
    // 十月一日边界：凌晨和深夜都算 10-01
    ev({ time: at('2026-10-01', 0, 5), text: '十月一号凌晨' }),
    ev({ time: at('2026-10-01', 23, 55), text: '十月一号深夜' }),
    // 10-02：两个群、三个发送者、一条链接消息
    ev({ time: at('2026-10-02', 12, 0), text: '二号中午', user: 222, name: '阿狗' }),
    ev({ time: at('2026-10-02', 12, 5), text: '二号链接 https://example.com/oct' }),
    ev({ time: at('2026-10-02', 13, 0), text: '二群', user: 333, name: '阿鼠', group: 456, groupName: '二群' }),
    // 11-10 / 11-11
    ev({ time: at('2026-11-10', 10, 0), text: '昨天' }),
    ev({ time: at('2026-11-11', 9, 0), text: '早上好' }),
    ev({ time: at('2026-11-11', 10, 30), user: 222, name: '阿狗', message: [image('a.jpg')] }),
    ev({ time: at('2026-11-11', 11, 0), message: [image('b.jpg'), image('c.jpg')] }),
    // 最新一条用的是新昵称：dayBreakdown 的名字要跟着最近一条
    ev({ time: at('2026-11-11', 15, 20), text: '下午链接 https://example.com/nov', name: '阿猫改名' }),
    // 窗口外：11-12（now 是 11-11，future 消息不该进日历）
    ev({ time: at('2026-11-12', 9, 0), text: '未来的消息', user: 444, name: '阿龙' }),
    ev({ time: at('2026-11-11', 16, 0), text: '二群今天', user: 333, name: '阿鼠', group: 456, groupName: '二群' }),
  ]
}

async function withSeededArchive(fn) {
  const home = await mkdtemp(join(tmpdir(), 'qq-archive-cal-'))
  const archive = openArchive(home)
  try {
    const counts = insertBatch(
      archive.db,
      archive,
      fixture().map((data, i) => normalizeOneBot({ source: 'json', sourceKey: 'cal-' + i, data })),
    )
    return await fn({ archive, home, counts })
  } finally {
    archive.db.close()
    await rm(home, { recursive: true, force: true })
  }
}

/** 从 fromDate 往后数 n 天的本地日期串，用来校验 days 是连续补齐的。 */
function dayAfter(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  const dt = new Date(y, m - 1, d + n)
  const p = (v) => String(v).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}

const NOW = new Date(2026, 10, 11, 19, 30) // 2026-11-11 19:30 本地时间

test('buildCalendar：自然月窗口 + 连续补零 + 分日统计', async () => {
  await withSeededArchive(async ({ archive, counts }) => {
    assert.equal(counts.inserted, 13)

    const cal = buildCalendar(archive.db, { months: 2, now: NOW })
    // 含当前月在内往前数 2 个自然月：10-01 ~ 11-11（今天）
    assert.equal(cal.fromDate, '2026-10-01')
    assert.equal(cal.toDate, '2026-11-11')
    assert.equal(cal.days.length, 42) // 10 月 31 天 + 11 月 11 天
    assert.deepEqual([cal.days[0].date, cal.days[41].date], ['2026-10-01', '2026-11-11'])
    // 日期从旧到新、一天不差
    for (let i = 0; i < cal.days.length; i++) {
      assert.equal(cal.days[i].date, dayAfter(cal.fromDate, i))
    }
    // 窗口外的日子不能出现
    assert.ok(!cal.days.some((d) => d.date === '2026-09-30'))
    assert.ok(!cal.days.some((d) => d.date === '2026-11-12'))

    // 全群：10-01 两条、10-02 三条、11-10 一条、11-11 五条 = 11 条
    assert.equal(cal.totals.messages, 11)
    assert.equal(cal.totals.activeDays, 4)
    assert.equal(cal.totals.avgPerDay, 0.3) // 11 / 42 天，保留一位小数
    assert.equal(cal.maxDay, 5)

    const empty = cal.days.find((d) => d.date === '2026-10-03')
    assert.deepEqual(empty, { date: '2026-10-03', total: 0, speakers: 0, media: 0, links: 0, chats: [] })

    const oct1 = cal.days.find((d) => d.date === '2026-10-01')
    assert.deepEqual(oct1, {
      date: '2026-10-01',
      total: 2,
      speakers: 1,
      media: 0,
      links: 0,
      chats: [['group:123', 2]],
    })

    const oct2 = cal.days.find((d) => d.date === '2026-10-02')
    assert.equal(oct2.total, 3)
    assert.equal(oct2.speakers, 3)
    assert.equal(oct2.links, 1)
    assert.deepEqual(oct2.chats, [
      ['group:123', 2],
      ['group:456', 1],
    ])

    const nov11 = cal.days.find((d) => d.date === '2026-11-11')
    assert.equal(nov11.total, 5)
    assert.equal(nov11.speakers, 3)
    // 一条单图 + 一条双图（同一条消息两个附件只算一次）
    assert.equal(nov11.media, 2)
    assert.equal(nov11.links, 1)
    assert.deepEqual(nov11.chats, [
      ['group:123', 4],
      ['group:456', 1],
    ])
  })
})

test('buildCalendar：months 默认 3 个月，能覆盖到 9 月；窗口边界收口', async () => {
  await withSeededArchive(async ({ archive }) => {
    const cal = buildCalendar(archive.db, { now: NOW }) // 默认 months=3
    assert.equal(cal.fromDate, '2026-09-01')
    assert.equal(cal.toDate, '2026-11-11')
    assert.equal(cal.days.length, 72) // 9 月 30 + 10 月 31 + 11 月 11
    // 9-30 的窗口外消息这次进来了；11-12 仍然不算（now 是 11-11）
    assert.equal(cal.days.find((d) => d.date === '2026-09-30').total, 1)
    assert.equal(cal.totals.messages, 12)
    assert.equal(cal.totals.activeDays, 5)
    assert.equal(cal.maxDay, 5)

    const one = buildCalendar(archive.db, { months: 1, now: NOW })
    assert.equal(one.fromDate, '2026-11-01')
    assert.equal(one.toDate, '2026-11-11')
    assert.equal(one.days.length, 11)
    assert.equal(one.totals.messages, 6) // 11-10 + 11-11
    assert.equal(one.totals.activeDays, 2)
    assert.equal(one.totals.avgPerDay, Math.round((6 / 11) * 10) / 10)

    // months 非法值退回默认 3；0/负数至少 1 个月
    assert.equal(buildCalendar(archive.db, { months: 0, now: NOW }).fromDate, '2026-11-01')
    assert.equal(buildCalendar(archive.db, { months: 'abc', now: NOW }).fromDate, '2026-09-01')
  })
})

test('buildCalendar：chatKey 过滤只统计这个群', async () => {
  await withSeededArchive(async ({ archive }) => {
    const cal = buildCalendar(archive.db, { months: 2, chatKey: 'group:123', now: NOW })
    // group:123 在窗口内：10-01 2 + 10-02 2 + 11-10 1 + 11-11 4 = 9
    assert.equal(cal.totals.messages, 9)
    assert.equal(cal.maxDay, 4)
    assert.deepEqual(cal.days.find((d) => d.date === '2026-10-02').chats, [['group:123', 2]])
    assert.deepEqual(cal.days.find((d) => d.date === '2026-11-11').chats, [['group:123', 4]])
    // 10-01 只有 group:123 的消息，但 speakers 是过滤后的不同发送者数
    assert.equal(cal.days.find((d) => d.date === '2026-10-01').speakers, 1)
  })
})

test('dayBreakdown：某天明细（小时分布 / 群 / 发言人 / 媒体 / 链接）', async () => {
  await withSeededArchive(async ({ archive }) => {
    const day = dayBreakdown(archive.db, { date: '2026-11-11' })
    assert.equal(day.date, '2026-11-11')
    assert.equal(day.total, 5)
    assert.equal(day.speakers, 3)
    assert.equal(day.media, 2)
    assert.equal(day.links, 1)

    assert.equal(day.hourly.length, 24)
    assert.equal(day.hourly[9], 1)
    assert.equal(day.hourly[10], 1)
    assert.equal(day.hourly[11], 1)
    assert.equal(day.hourly[15], 1)
    assert.equal(day.hourly[16], 1)
    assert.equal(day.hourly.reduce((a, b) => a + b, 0), 5)

    assert.deepEqual(day.chats, [
      { chatKey: 'group:123', name: '测试群', count: 4 },
      { chatKey: 'group:456', name: '二群', count: 1 },
    ])

    // 按条数降序；名字取这个发送者最近一条消息的 sender_name
    assert.deepEqual(
      day.topSenders.map((s) => [s.userId, s.count]),
      [
        ['111', 3],
        ['222', 1],
        ['333', 1],
      ],
    )
    assert.equal(day.topSenders.find((s) => s.userId === '111').name, '阿猫改名')

    const filtered = dayBreakdown(archive.db, { date: '2026-11-11', chatKey: 'group:456' })
    assert.equal(filtered.total, 1)
    assert.equal(filtered.speakers, 1)
    assert.equal(filtered.media, 0)
    assert.equal(filtered.links, 0)
    assert.deepEqual(filtered.chats, [{ chatKey: 'group:456', name: '二群', count: 1 }])
    assert.deepEqual(filtered.topSenders, [{ userId: '333', name: '阿鼠', count: 1 }])
  })
})

test('dayBreakdown：空白日期与非法日期', async () => {
  await withSeededArchive(async ({ archive }) => {
    const blank = dayBreakdown(archive.db, { date: '2026-11-05' })
    assert.equal(blank.total, 0)
    assert.equal(blank.speakers, 0)
    assert.equal(blank.media, 0)
    assert.equal(blank.links, 0)
    assert.deepEqual(blank.hourly, Array.from({ length: 24 }, () => 0))
    assert.deepEqual(blank.chats, [])
    assert.deepEqual(blank.topSenders, [])

    // 不在日历窗口里、但库里有数据的日子照样能查
    assert.equal(dayBreakdown(archive.db, { date: '2026-09-30' }).total, 1)

    assert.throws(() => dayBreakdown(archive.db, { date: '2026/11/11' }), /YYYY-MM-DD/)
    assert.throws(() => dayBreakdown(archive.db, { date: '2026-02-30' }), /日期不存在/)
    assert.throws(() => dayBreakdown(archive.db, { date: '' }), /YYYY-MM-DD/)
  })
})
