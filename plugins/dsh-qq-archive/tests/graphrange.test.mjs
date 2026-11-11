import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { graphRangeBounds, GRAPH_RANGES } from '../lib/graphrange.mjs'
import { buildGraph } from '../lib/graph.mjs'
import { openArchive, insertBatch } from '../lib/db.mjs'
import { normalizeOneBot } from '../lib/normalize.mjs'

function local(y, m, d, h = 0, min = 0) {
  return new Date(y, m - 1, d, h, min, 0, 0)
}

function ev({ time, user, name, message, group = 123 }) {
  return {
    time,
    self_id: 999,
    post_type: 'message',
    message_type: 'group',
    group_id: group,
    group_name: '测试群',
    user_id: user,
    message_id: time,
    sender: { user_id: user, nickname: name },
    message,
    raw_message: '',
  }
}

test('时间切片按本地时区、周一起算', () => {
  // 2026-11-11 是周三
  const now = local(2026, 11, 11, 15, 30)

  const week = graphRangeBounds('week', now)
  assert.equal(week.label, '本周')
  assert.equal(week.fromDate, '2026-11-09')
  assert.equal(week.toDate, '2026-11-11')
  assert.deepEqual(new Date(week.fromTs * 1000), local(2026, 11, 9))
  assert.equal(week.toTs, Math.floor(now.getTime() / 1000) + 1)

  const last = graphRangeBounds('lastweek', now)
  assert.equal(last.label, '上周')
  assert.equal(last.fromDate, '2026-11-02')
  assert.equal(last.toDate, '2026-11-08')
  assert.deepEqual(new Date(last.fromTs * 1000), local(2026, 11, 2))
  assert.deepEqual(new Date(last.toTs * 1000), local(2026, 11, 9))

  const month = graphRangeBounds('month', now)
  assert.equal(month.label, '本月')
  assert.equal(month.fromDate, '2026-11-01')
  assert.equal(month.toDate, '2026-11-11')
  assert.deepEqual(new Date(month.fromTs * 1000), local(2026, 11, 1))

  const all = graphRangeBounds('all', now)
  assert.equal(all.label, '全部时间')
  assert.equal(all.fromTs, 0)
  assert.equal(all.toTs, 0)

  assert.deepEqual(GRAPH_RANGES, ['all', 'week', 'lastweek', 'month'])
})

test('本周一跨月时边界正确（2026-10-01 是周四）', () => {
  const now = local(2026, 10, 1, 9, 0)
  const week = graphRangeBounds('week', now)
  assert.equal(week.fromDate, '2026-09-28')
  const last = graphRangeBounds('lastweek', now)
  assert.equal(last.fromDate, '2026-09-21')
  assert.equal(last.toDate, '2026-09-27')
})

test('buildGraph 的 toTs 是开区间，上周的 @ 不会混进本周', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qq-archive-'))
  const archive = openArchive(home)
  try {
    const lastWeek = local(2026, 11, 4, 12, 0)
    const thisWeek = local(2026, 11, 10, 12, 0)
    const at = (qq) => [{ type: 'at', data: { qq } }, { type: 'text', data: { text: ' 在吗' } }]
    const data = [
      ev({ time: Math.floor(lastWeek.getTime() / 1000), user: 111, name: '阿猫', message: at('222') }),
      ev({ time: Math.floor(thisWeek.getTime() / 1000), user: 111, name: '阿猫', message: at('333') }),
    ]
    const records = data.map((d, i) => normalizeOneBot({ source: 'json', sourceKey: 'k' + i, data: d }))
    insertBatch(archive.db, archive, records)

    const bounds = graphRangeBounds('week', local(2026, 11, 11, 15, 30))
    const week = buildGraph(archive.db, { sinceTs: bounds.fromTs, toTs: bounds.toTs })
    assert.deepEqual(
      week.edges.map((e) => `${e.source}>${e.target}`),
      ['111>333'],
    )

    const all = buildGraph(archive.db, {})
    assert.equal(all.edges.length, 2)
    assert.equal(all.totalAt, 2)
  } finally {
    archive.db.close()
    await rm(home, { recursive: true, force: true })
  }
})
