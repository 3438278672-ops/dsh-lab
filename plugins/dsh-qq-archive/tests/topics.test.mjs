/**
 * 群梗考古 / 高频词：用固定时间戳的假消息造库，只测纯查询逻辑，不联网。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArchive, insertBatch } from '../lib/db.mjs'
import { normalizeOneBot } from '../lib/normalize.mjs'
import { investigateTopic, topWords } from '../lib/topics.mjs'

/** 本地时区构造 unix 秒，保证「按本地时间分月」的断言不随机器时区漂。 */
function T(y, mo, d, h, mi = 0) {
  return Math.floor(new Date(y, mo - 1, d, h, mi, 0, 0).getTime() / 1000)
}

function ev({ time, text, user = 111, name = '阿猫', group = 1001, groupName = '测试群' }) {
  return {
    time,
    self_id: 999,
    post_type: 'message',
    message_type: 'group',
    group_id: group,
    group_name: groupName,
    user_id: user,
    message_id: time * 1000 + user,
    sender: { user_id: user, nickname: name },
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
  }
}

async function makeArchive(events) {
  const home = await mkdtemp(join(tmpdir(), 'qqa-topics-'))
  const archive = openArchive(home)
  const records = events.map((data, i) => normalizeOneBot({ source: 'test', sourceKey: 'k' + i, data }))
  insertBatch(archive.db, archive, records)
  return {
    home,
    archive,
    db: archive.db,
    cleanup: async () => {
      archive.db.close()
      await rm(home, { recursive: true, force: true })
    },
  }
}

const fixture = [
  ev({ time: T(2026, 1, 10, 12, 0), text: '我的卡组又被打爆了' }),
  ev({ time: T(2026, 1, 10, 12, 1), text: '你这卡组不行', user: 222, name: '阿狗' }),
  ev({ time: T(2026, 2, 3, 20, 0), text: '谁有卡组推荐' }),
  ev({ time: T(2026, 2, 4, 9, 30), text: '今天组了套新卡组', user: 333, name: '阿明', group: 2002, groupName: '第二个群' }),
  ev({ time: T(2026, 2, 5, 9, 30), text: '今天天气不错', user: 222, name: '阿狗' }),
]

test('investigateTopic：总数 / 按月 / 按群 / 按人 / 首末条 / 均匀采样', async () => {
  const { archive, cleanup } = await makeArchive(fixture)
  try {
    const r = investigateTopic(archive, { word: '卡组' })
    assert.equal(r.word, '卡组')
    assert.equal(r.total, 4)
    assert.deepEqual(r.byMonth, [
      { month: '2026-01', count: 2 },
      { month: '2026-02', count: 2 },
    ])
    assert.deepEqual(r.byChat, [
      { chatKey: 'group:1001', name: '测试群', count: 3 },
      { chatKey: 'group:2002', name: '第二个群', count: 1 },
    ])
    assert.deepEqual(r.topUsers, [
      { userId: '111', name: '阿猫', count: 2 },
      { userId: '222', name: '阿狗', count: 1 },
      { userId: '333', name: '阿明', count: 1 },
    ])

    assert.equal(r.first.ts, T(2026, 1, 10, 12, 0))
    assert.equal(r.first.text, '我的卡组又被打爆了')
    assert.equal(r.first.chatName, '测试群')
    assert.equal(r.first.senderName, '阿猫')
    assert.equal(r.last.ts, T(2026, 2, 4, 9, 30))
    assert.equal(r.last.text, '今天组了套新卡组')
    assert.equal(r.last.chatKey, 'group:2002')

    // samples 按时间正序、均匀取
    assert.deepEqual(
      r.samples.map((s) => s.text),
      ['我的卡组又被打爆了', '你这卡组不行', '谁有卡组推荐', '今天组了套新卡组'],
    )
    assert.ok(r.samples.every((s) => s.chatName && s.senderName && s.id > 0))

    // 也容忍直接传 archive.db
    assert.equal(investigateTopic(archive.db, { word: '卡组' }).total, 4)
  } finally {
    await cleanup()
  }
})

test('investigateTopic：会话 / 时间过滤，limit 控制采样条数，查不到时返回空结构', async () => {
  const { archive, cleanup } = await makeArchive(fixture)
  try {
    const onlyChat = investigateTopic(archive, { word: '卡组', chatKey: 'group:2002' })
    assert.equal(onlyChat.total, 1)
    assert.deepEqual(onlyChat.byChat, [{ chatKey: 'group:2002', name: '第二个群', count: 1 }])
    assert.equal(onlyChat.first.text, '今天组了套新卡组')

    const feb = investigateTopic(archive, { word: '卡组', fromTs: T(2026, 2, 1, 0, 0) })
    assert.equal(feb.total, 2)
    assert.deepEqual(feb.byMonth, [{ month: '2026-02', count: 2 }])

    const jan = investigateTopic(archive, { word: '卡组', toTs: T(2026, 1, 31, 23, 59) })
    assert.equal(jan.total, 2)
    assert.deepEqual(jan.byMonth, [{ month: '2026-01', count: 2 }])

    const both = investigateTopic(archive, { word: '卡组', chatKey: 'group:1001', fromTs: T(2026, 2, 1, 0, 0) })
    assert.equal(both.total, 1)
    assert.equal(both.first.text, '谁有卡组推荐')

    // total=4、limit=2：首尾各锚一条
    const sampled = investigateTopic(archive, { word: '卡组', limit: 2 })
    assert.deepEqual(
      sampled.samples.map((s) => s.text),
      ['我的卡组又被打爆了', '今天组了套新卡组'],
    )
    assert.deepEqual(investigateTopic(archive, { word: '卡组', limit: 1 }).samples.map((s) => s.text), ['我的卡组又被打爆了'])

    const none = investigateTopic(archive, { word: '根本不存在的词' })
    assert.equal(none.total, 0)
    assert.deepEqual(none.byMonth, [])
    assert.deepEqual(none.byChat, [])
    assert.deepEqual(none.topUsers, [])
    assert.equal(none.first, null)
    assert.equal(none.last, null)
    assert.deepEqual(none.samples, [])

    assert.throws(() => investigateTopic(archive, { word: '   ' }), /不能为空/)
  } finally {
    await cleanup()
  }
})

test('investigateTopic：LIKE 通配符必须转义（% _ \\ 按字面匹配）', async () => {
  const events = [
    ev({ time: T(2026, 3, 1, 10, 0), text: '进度 100% 了' }),
    ev({ time: T(2026, 3, 1, 10, 1), text: 'a_b 是啥意思' }),
    ev({ time: T(2026, 3, 1, 10, 2), text: '反斜杠 \\ 不是通配符' }),
    ev({ time: T(2026, 3, 1, 10, 3), text: '普通消息' }),
    ev({ time: T(2026, 3, 1, 10, 4), text: '100 分' }),
  ]
  const { archive, cleanup } = await makeArchive(events)
  try {
    // 不转义的话 '%' 会做成 '%%%' 把所有消息都捞出来
    const pct = investigateTopic(archive, { word: '%' })
    assert.equal(pct.total, 1)
    assert.equal(pct.samples[0].text, '进度 100% 了')

    const underscore = investigateTopic(archive, { word: '_' })
    assert.equal(underscore.total, 1)
    assert.equal(underscore.samples[0].text, 'a_b 是啥意思')

    const backslash = investigateTopic(archive, { word: '\\' })
    assert.equal(backslash.total, 1)
    assert.equal(backslash.samples[0].text, '反斜杠 \\ 不是通配符')

    assert.equal(investigateTopic(archive, { word: '100%' }).total, 1)
  } finally {
    await cleanup()
  }
})

test('topWords：词频降序，过滤虚词/单字/纯数字/占位符，支持会话与时间过滤', async () => {
  const events = [
    ev({ time: T(2026, 3, 1, 10, 0), text: '打牌 打牌 打牌 什么 这个 [图片] 123 45' }),
    ev({ time: T(2026, 3, 1, 10, 1), text: '打牌 比赛 比赛', group: 2002, groupName: '第二个群' }),
    ev({ time: T(2026, 3, 1, 10, 2), text: '奶茶 吃饭' }),
    ev({ time: T(2026, 3, 1, 10, 3), text: '[表情] 今天 天气 不错' }),
    ev({ time: T(2026, 3, 1, 10, 4), text: '可以 已经 就是 真的' }),
  ]
  const { db, cleanup } = await makeArchive(events)
  try {
    const words = topWords(db, {})
    const freq = new Map(words.map((w) => [w.word, w.count]))
    assert.deepEqual(words.slice(0, 2), [
      { word: '打牌', count: 4 },
      { word: '比赛', count: 2 },
    ])
    assert.equal(freq.get('奶茶'), 1)
    for (const banned of ['什么', '这个', '可以', '已经', '就是', '真的', '图片', '表情', '123', '45']) {
      assert.equal(freq.has(banned), false, `不该出现：${banned}`)
    }
    assert.ok(words.every((w) => w.word.length >= 2 && !/^\d+$/.test(w.word)))
    // 同次数按词升序，结果稳定
    for (let i = 1; i < words.length; i++) {
      assert.ok(words[i - 1].count >= words[i].count)
    }

    assert.equal(topWords(db, { limit: 2 }).length, 2)

    const onlyGroup = new Map(topWords(db, { chatKey: 'group:1001' }).map((w) => [w.word, w.count]))
    assert.equal(onlyGroup.get('打牌'), 3)
    assert.equal(onlyGroup.has('比赛'), false)

    const onlyGroup2 = new Map(topWords(db, { chatKey: 'group:2002' }).map((w) => [w.word, w.count]))
    assert.equal(onlyGroup2.get('比赛'), 2)
    assert.equal(onlyGroup2.get('打牌'), 1)

    const firstMsg = new Map(
      topWords(db, { fromTs: T(2026, 3, 1, 10, 0), toTs: T(2026, 3, 1, 10, 0) }).map((w) => [w.word, w.count]),
    )
    assert.equal(firstMsg.get('打牌'), 3)

    const later = topWords(db, { fromTs: T(2026, 3, 1, 10, 2) })
    assert.equal(later.some((w) => w.word === '打牌'), false, '时间过滤后不该有第一条消息里的词')
    assert.ok(later.some((w) => w.word === '奶茶'))

    // 空范围返回空数组
    assert.deepEqual(topWords(db, { fromTs: T(2030, 1, 1, 0, 0) }), [])
  } finally {
    await cleanup()
  }
})
