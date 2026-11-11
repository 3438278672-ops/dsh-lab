import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArchive, insertBatch } from '../lib/db.mjs'
import { normalizeOneBot } from '../lib/normalize.mjs'
import {
  PERIOD_FLOOR,
  PERIOD_SYSTEM,
  periodBounds,
  buildPeriod,
  buildPeriodPrompt,
  runPeriodReport,
  listPeriodReports,
  readPeriodReport,
} from '../lib/period.mjs'

// 2026-11-11 是周三：本周 11-09（周一）~ 11-15（周日）
const REF = new Date(2026, 10, 11, 15, 30)

function ts(y, m, d, h = 12, min = 0) {
  return Math.floor(new Date(y, m - 1, d, h, min, 0).getTime() / 1000)
}

function ev({ time, text, user = 111, name = '阿猫', group = 123, groupName = '测试群' }) {
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
    raw_message: text,
  }
}

const FIXTURE = [
  { time: ts(2026, 10, 20), text: '历史消息' },
  { time: ts(2026, 11, 5, 20), text: '边界前的消息' },
  { time: ts(2026, 11, 7, 9), text: '周五打牌吗' },
  { time: ts(2026, 11, 9, 10), text: '打牌打牌' },
  { time: ts(2026, 11, 9, 11), text: '牌店见', user: 222, name: '阿狗' },
  { time: ts(2026, 11, 9, 12), text: '卡组发你了 https://example.com/deck', user: 222, name: '阿狗' },
  { time: ts(2026, 11, 10, 9), text: '今天人好多', user: 222, name: '阿狗' },
  { time: ts(2026, 11, 11, 9), text: '周末继续' },
  { time: ts(2026, 11, 10, 12), text: '别的群', user: 333, group: 456, groupName: '另一个群' },
]

async function withArchive(fn) {
  const home = await mkdtemp(join(tmpdir(), 'qq-archive-period-'))
  const archive = openArchive(home)
  try {
    insertBatch(
      archive.db,
      archive,
      FIXTURE.map((data, i) => normalizeOneBot({ source: 'json', sourceKey: 'p' + i, data: ev(data) })),
    )
    await fn(archive)
  } finally {
    archive.db.close()
    await rm(home, { recursive: true, force: true })
  }
}

/** 假 llm：形状照 lib/llm.mjs 的 streamText 期望来，只记录调用、不联网。 */
function fakeLlm(chunks = ['## 这段时间聊了什么\n打牌。']) {
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'fake', name: '假模型' }],
    listModels: async () => [{ id: 'model-1', name: 'Model 1' }],
    stream: (req) => {
      calls.push(req)
      return (async function* () {
        for (const text of chunks) yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return { llm, calls }
}

test('periodBounds: 周报按周一起算（本地时区）', () => {
  const week = periodBounds('week', REF)
  assert.equal(week.kind, 'week')
  assert.equal(week.fromDate, '2026-11-09')
  assert.equal(week.toDate, '2026-11-15')
  assert.equal(week.label, '2026-11-09 ~ 2026-11-15')
  assert.equal(week.fromTs, ts(2026, 11, 9, 0))
  assert.equal(week.toTs, ts(2026, 11, 16, 0) - 1)

  const prev = periodBounds('week', REF, -1)
  assert.equal(prev.fromDate, '2026-11-02')
  assert.equal(prev.toDate, '2026-11-08')
  const next = periodBounds('week', REF, 1)
  assert.equal(next.fromDate, '2026-11-16')
  assert.equal(next.toDate, '2026-11-22')

  // 周日 23:59 仍算这一周，周一 00:00 换周
  assert.equal(periodBounds('week', new Date(2026, 10, 15, 23, 59)).fromDate, '2026-11-09')
  assert.equal(periodBounds('week', new Date(2026, 10, 16, 0, 0)).fromDate, '2026-11-16')
})

test('periodBounds: 月报按自然月', () => {
  const month = periodBounds('month', REF)
  assert.equal(month.fromDate, '2026-11-01')
  assert.equal(month.toDate, '2026-11-30')
  assert.equal(month.fromTs, ts(2026, 11, 1, 0))
  assert.equal(month.toTs, ts(2026, 12, 1, 0) - 1)

  assert.equal(periodBounds('month', REF, -1).fromDate, '2026-10-01')
  assert.equal(periodBounds('month', REF, -1).toDate, '2026-10-31')
  assert.equal(periodBounds('month', REF, 1).fromDate, '2026-12-01')
  assert.equal(periodBounds('month', REF, 1).toDate, '2026-12-31')
})

test('periodBounds: ref 支持 Date / YYYY-MM-DD，非法参数报错', () => {
  assert.equal(periodBounds('week', '2026-11-11').fromDate, '2026-11-09')
  assert.throws(() => periodBounds('day', REF), /week 或 month/)
  assert.throws(() => periodBounds('week', '不是日期'), /看不懂/)
})

test('buildPeriod: 月报裁到 2026-11-06 起点，topDays 按日计数降序', async () => {
  await withArchive(async ({ db }) => {
    assert.equal(PERIOD_FLOOR, '2026-11-06')
    const period = buildPeriod(db, { kind: 'month', ref: REF })
    assert.equal(period.kind, 'month')
    assert.equal(period.fromDate, '2026-11-06')
    assert.equal(period.toDate, '2026-11-30')
    assert.equal(period.fromTs, ts(2026, 11, 6, 0))
    assert.equal(period.clipped, true)
    // 11-05 和 10-20 不计入；剩下 11-07 + 11-09×3 + 11-10 两条（两群）+ 11-11 = 7 条
    assert.equal(period.total, 7)
    assert.equal(period.activeDays, 4)
    assert.deepEqual(period.topDays, [
      { date: '2026-11-09', count: 3 },
      { date: '2026-11-10', count: 2 },
      { date: '2026-11-07', count: 1 },
      { date: '2026-11-11', count: 1 },
    ])
    assert.equal(period.members.length, 3)
    assert.equal(period.chatName, '所有会话')
    // 指定单群时只看这个群
    const one = buildPeriod(db, { kind: 'month', chatKey: 'group:123', ref: REF })
    assert.equal(one.chatName, '测试群')
    assert.equal(one.total, 6)
    assert.ok(period.links.includes('https://example.com/deck'))
    assert.match(buildPeriodPrompt(period), /2026-11-06 ~ 2026-11-30/)
  })
})

test('buildPeriod: 周报不裁剪、单群过滤、整段早于起点报错', async () => {
  await withArchive(async ({ db }) => {
    const week = buildPeriod(db, { kind: 'week', ref: REF })
    assert.equal(week.fromDate, '2026-11-09')
    assert.equal(week.toDate, '2026-11-15')
    assert.equal(week.clipped, false)
    assert.equal(week.total, 6)

    // 11-05 那周（11-02 ~ 11-08）只保留 11-06 之后：只剩 11-07 一条
    const clipped = buildPeriod(db, { kind: 'week', ref: new Date(2026, 10, 5, 12) })
    assert.equal(clipped.fromDate, '2026-11-06')
    assert.equal(clipped.toDate, '2026-11-08')
    assert.equal(clipped.clipped, true)
    assert.equal(clipped.total, 1)
    assert.deepEqual(clipped.topDays, [{ date: '2026-11-07', count: 1 }])

    const other = buildPeriod(db, { kind: 'month', chatKey: 'group:456', ref: REF })
    assert.equal(other.chatName, '另一个群')
    assert.equal(other.total, 1)

    // 整段早于 2026-11-06：不补历史
    assert.throws(() => buildPeriod(db, { kind: 'week', ref: new Date(2026, 9, 20, 12) }), /整段早于/)
    assert.throws(() => buildPeriod(db, { kind: 'month', ref: new Date(2026, 8, 15, 12) }), /整段早于/)
  })
})

test('runPeriodReport: 假 llm 生成周报并落库，重复跑跳过', async () => {
  await withArchive(async ({ db }) => {
    const fake = fakeLlm(['## 这段时间聊了什么\n', '打牌。\n\n## 人物与关系\n阿猫和阿狗。'])
    const progress = []
    const result = await runPeriodReport({
      db,
      llm: fake.llm,
      cfg: {},
      kind: 'week',
      ref: REF,
      onProgress: (p) => progress.push(p.step),
    })
    assert.equal(result.saved, true)
    assert.equal(result.skipped, false)
    assert.equal(result.kind, 'week')
    assert.equal(result.fromDate, '2026-11-09')
    assert.equal(result.toDate, '2026-11-15')
    assert.equal(result.model, 'fake/model-1')
    assert.match(result.text, /打牌/)
    assert.deepEqual(progress, ['stats', 'llm', 'saved'])

    assert.equal(fake.calls.length, 1)
    assert.equal(fake.calls[0].provider, 'fake')
    assert.equal(fake.calls[0].model, 'model-1')
    assert.equal(fake.calls[0].system, PERIOD_SYSTEM)
    const prompt = fake.calls[0].messages[0].content[0].text
    assert.match(prompt, /2026-11-09 ~ 2026-11-15/)
    assert.match(prompt, /消息 6 条/)
    assert.match(fake.calls[0].system, /这段时间聊了什么/)
    assert.match(fake.calls[0].system, /下周期待/)

    const row = readPeriodReport(db, { kind: 'week', fromDate: '2026-11-09' })
    assert.ok(row)
    assert.equal(row.text, result.text)
    assert.equal(row.model, 'fake/model-1')
    assert.equal(row.chatKey, '*')
    assert.equal(row.chatName, '所有会话')
    assert.equal(row.stats.total, 6)
    assert.equal(row.stats.activeDays, 3)
    assert.equal(row.stats.topDays[0].date, '2026-11-09')
    assert.ok(Array.isArray(row.stats.members))
    assert.ok(Array.isArray(row.stats.links))

    // 已存在同 (kind, from_date, chat_key)：非 force 直接跳过，不再调模型
    const again = await runPeriodReport({ db, llm: fake.llm, kind: 'week', ref: REF })
    assert.equal(again.saved, false)
    assert.equal(again.skipped, true)
    assert.equal(again.reason, 'exists')
    assert.equal(again.text, result.text)
    assert.equal(fake.calls.length, 1)

    // force + 注入 _generate：覆盖旧内容
    const forced = await runPeriodReport({
      db,
      kind: 'week',
      ref: REF,
      force: true,
      _generate: async ({ system, prompt, period }) => {
        assert.equal(system, PERIOD_SYSTEM)
        assert.equal(period.fromDate, '2026-11-09')
        assert.match(prompt, /打牌/)
        return { text: '## 重写版本\n重新写一遍。', model: 'injected/x' }
      },
    })
    assert.equal(forced.saved, true)
    assert.equal(forced.text, '## 重写版本\n重新写一遍。')
    assert.equal(forced.model, 'injected/x')
    assert.equal(readPeriodReport(db, { kind: 'week', fromDate: '2026-11-09' }).text, forced.text)
  })
})

test('runPeriodReport: 空周期跳过、没有模型时报错', async () => {
  await withArchive(async ({ db }) => {
    const empty = await runPeriodReport({ db, kind: 'week', ref: new Date(2026, 10, 18, 12) })
    assert.equal(empty.saved, false)
    assert.equal(empty.skipped, true)
    assert.equal(empty.reason, 'empty')
    assert.equal(empty.text, '')

    await assert.rejects(() => runPeriodReport({ db, kind: 'week', ref: REF, llm: null }), /没有可用的模型/)
  })
})

test('listPeriodReports / readPeriodReport: 周报月报都能列，按起点倒序', async () => {
  await withArchive(async ({ db }) => {
    const fake = fakeLlm()
    await runPeriodReport({ db, llm: fake.llm, kind: 'week', ref: REF })
    await runPeriodReport({ db, llm: fake.llm, kind: 'month', ref: REF })

    const list = listPeriodReports(db, { limit: 12 })
    assert.equal(list.length, 2)
    assert.equal(list[0].kind, 'week')
    assert.equal(list[0].fromDate, '2026-11-09')
    assert.equal(list[0].label, '2026-11-09 ~ 2026-11-15')
    assert.equal(list[1].kind, 'month')
    assert.equal(list[1].fromDate, '2026-11-06')
    assert.equal(list[1].toDate, '2026-11-30')
    assert.ok(list.every((r) => r.stats && typeof r.stats.total === 'number'))

    assert.equal(listPeriodReports(db, { kind: 'month' }).length, 1)
    assert.equal(listPeriodReports(db, { kind: 'week', limit: 1 }).length, 1)
    assert.equal(listPeriodReports(db, { kind: 'year' }).length, 0)

    const month = readPeriodReport(db, { kind: 'month', fromDate: '2026-11-06' })
    assert.ok(month)
    assert.equal(month.stats.total, 7)
    assert.equal(readPeriodReport(db, { kind: 'week', fromDate: '2026-01-05' }), null)
    assert.equal(readPeriodReport(db, { kind: 'month', fromDate: '2026-11-06', chatKey: 'group:123' }), null)
  })
})
