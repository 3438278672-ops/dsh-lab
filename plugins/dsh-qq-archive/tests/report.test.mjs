import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArchive, insertBatch } from '../lib/db.mjs'
import { normalizeOneBot } from '../lib/normalize.mjs'
import { dayBounds, buildReport, saveReport, readReport, listReports, dueForReport, markReportDay } from '../lib/report.mjs'
import { buildGraph } from '../lib/graph.mjs'
import { buildDashboardData, renderDashboard } from '../lib/dashboard.mjs'

function ev({ time, text, user = 111, name = '阿猫', group = 123, message }) {
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
    message: message || [{ type: 'text', data: { text } }],
    raw_message: text || '',
  }
}

const now = Date.now()
const today = dayBounds('today', now)
const T1 = today.fromTs + 7200 // 今天 02:00 左右

test('dayBounds 三种写法', () => {
  const t = dayBounds('today', now)
  assert.match(t.day, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(t.fromTs, Math.floor(new Date(now).setHours(0, 0, 0, 0) / 1000))

  const y = dayBounds('yesterday', now)
  assert.equal(y.toTs, t.fromTs - 1)
  assert.equal(y.fromTs, t.fromTs - 86400)

  const d = dayBounds('2026-03-05', now)
  assert.equal(d.day, '2026-03-05')
  assert.equal(d.toTs - d.fromTs, 86399)

  assert.throws(() => dayBounds('周五', now), /YYYY-MM-DD/)
})

test('buildReport 统计 + 高频词剥占位 + 采样', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qq-archive-rpt-'))
  const archive = openArchive(home)
  try {
    const fixture = [
      ev({ time: T1, text: '今天打牌吗？' }),
      ev({ time: T1 + 1, text: '打牌打牌，牌店见' }),
      ev({ time: T1 + 2, text: '好', user: 222, name: '阿狗' }),
      ev({ time: T1 + 3, text: '卡组发你了 https://example.com/deck', user: 222, name: '阿狗' }),
      ev({ time: T1 + 4, user: 222, name: '阿狗', message: [{ type: 'image', data: { file: 'a.jpg', url: 'https://x/a.jpg' } }] }),
      ev({ time: T1 + 5, user: 222, name: '阿狗', message: [{ type: 'face', data: { id: '1' } }] }),
    ]
    insertBatch(
      archive.db,
      archive,
      fixture.map((data, i) => normalizeOneBot({ source: 'json', sourceKey: 'r' + i, data })),
    )

    const rep = buildReport(archive.db, { fromTs: today.fromTs, toTs: today.toTs })
    assert.equal(rep.total, 6)
    assert.equal(rep.members.length, 2)
    assert.equal(rep.members[0].id, '222')
    assert.equal(rep.members[0].count, 4)
    assert.equal(rep.kinds.text, 5) // 4 条文本 + 1 条表情占位
    assert.equal(rep.kinds.image, 1)

    // 高频词不能是 [图片]/[表情] 这类占位符
    assert.ok(rep.topWords.length > 0)
    assert.ok(rep.topWords.some((w) => w.word === '打牌'))
    assert.ok(!rep.topWords.some((w) => ['图片', '表情', '动画'].includes(w.word)))

    assert.ok(rep.links.includes('https://example.com/deck'))
    assert.ok(rep.samples.length >= 1)
    assert.ok(rep.samples.every((s) => !s.text.startsWith('[')))

    // 写库 + 读回
    saveReport(archive.db, {
      date: today.day,
      chatKey: 'group:123',
      text: '## 今天聊了什么\n打牌。',
      stats: { total: 6, members: [], topWords: [], links: [] },
      model: 'fake/model',
    })
    const back = readReport(archive.db, { date: today.day, chatKey: 'group:123' })
    assert.equal(back.model, 'fake/model')
    assert.match(back.text, /打牌/)
    assert.equal(listReports(archive.db, { date: today.day }).length, 1)

    // 同一天同一会话再写一次是覆盖，不是新增
    saveReport(archive.db, {
      date: today.day,
      chatKey: 'group:123',
      text: '改过了',
      stats: { total: 6, members: [], topWords: [], links: [] },
      model: 'fake/model',
    })
    assert.equal(readReport(archive.db, { date: today.day, chatKey: 'group:123' }).text, '改过了')

    // 关系图：@ 边
    const at = [{ type: 'at', data: { qq: '222' } }, { type: 'text', data: { text: ' 来打牌' } }]
    insertBatch(archive.db, archive, [
      normalizeOneBot({ source: 'json', sourceKey: 'g1', data: ev({ time: T1 + 10, text: '', message: at }) }),
      normalizeOneBot({
        source: 'json',
        sourceKey: 'g2',
        data: ev({ time: T1 + 11, text: '', user: 222, name: '阿狗', message: [{ type: 'at', data: { qq: 'all' } }] }),
      }),
    ])
    const g = buildGraph(archive.db, { sinceTs: today.fromTs })
    const edge = g.edges.find((e) => e.source === '111' && e.target === '222')
    assert.ok(edge && edge.count >= 1)
    assert.equal(g.nodes.find((n) => n.id === '111').out, 1)

    // 看板数据与 HTML
    const data = buildDashboardData(archive.db, { home, feedLimit: 50 })
    assert.ok(data.chats.length >= 1)
    const card = data.reportCards.find((c) => c.chatKey === 'group:123')
    assert.ok(card && card.today.text === '改过了')
    assert.ok(data.feed.length >= 1)
    assert.ok(data.graph.nodes.length >= 2)
    // 群友档案：按发言量聚合，带上印象字段（没生成过就是空串）
    assert.ok(data.peopleByChat['*'].length >= 2)
    const p111 = data.peopleByChat['*'].find((p) => p.userId === '111')
    assert.ok(p111 && p111.total >= 1)
    assert.equal(p111.impression, '')
    assert.ok(Array.isArray(p111.tags))
    // 按群筛选：每个会话各有一份，且只统计这个群里的发言
    assert.ok(data.peopleByChat['group:123'])
    const inGroup = data.peopleByChat['group:123'].find((p) => p.userId === '111')
    assert.ok(inGroup && inGroup.total >= 1)
    assert.ok(inGroup.chats.every((c) => c.chatKey === 'group:123'))

    const html = renderDashboard(data, { title: '测试档案馆' })
    assert.match(html, /测试档案馆/)
    assert.match(html, /application\/json/)
    assert.ok(!html.includes('</script><script>'))
  } finally {
    archive.db.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('dueForReport：到点才跑、当天只跑一次、第二天再跑', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qq-archive-due-'))
  const archive = openArchive(home)
  try {
    const db = archive.db
    assert.equal(dueForReport({ report: { schedule: '' } }, db, now), false)
    assert.equal(dueForReport({ report: { schedule: 'abc' } }, db, now), false)

    const at10 = new Date(now).setHours(10, 0, 0, 0)
    // 还没到点
    assert.equal(dueForReport({ report: { schedule: '23:00' } }, db, at10), false)
    // 到点且今天没跑过
    assert.equal(dueForReport({ report: { schedule: '00:00' } }, db, at10), true)

    markReportDay(db, dayBounds('yesterday', at10).day)
    assert.equal(dueForReport({ report: { schedule: '00:00' } }, db, at10), false)

    // 第二天到点后又该跑了
    assert.equal(dueForReport({ report: { schedule: '00:00' } }, db, at10 + 86400000), true)
  } finally {
    archive.db.close()
    await rm(home, { recursive: true, force: true })
  }
})
