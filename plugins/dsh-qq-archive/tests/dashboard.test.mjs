import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArchive, insertBatch } from '../lib/db.mjs'
import { normalizeOneBot } from '../lib/normalize.mjs'
import { buildBoardData } from '../lib/dashboard.mjs'
import { isoDate } from '../lib/util.mjs'

function ev({ time, text, user = 111, name = '阿猫', group = 123, message }) {
  return {
    time,
    self_id: 999,
    post_type: 'message',
    message_type: 'group',
    group_id: group,
    group_name: '测试群',
    user_id: user,
    message_id: time + user,
    sender: { user_id: user, nickname: name },
    message: message || [{ type: 'text', data: { text } }],
    raw_message: text || '',
  }
}

test('看板数据：名场面解析 chatName/count，日历 / 资源库 / 榜单 / 高频词齐备', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qq-archive-'))
  const archive = openArchive(home)
  try {
    const now = Math.floor(Date.now() / 1000)
    const day = now - 86400
    const fixture = [
      ev({ time: day, text: '今天下午三点在牌店打牌' }),
      ev({ time: day + 1, text: '链接在这 https://example.com/guide', user: 222, name: '阿狗' }),
      ev({ time: day + 2, text: '你来吗 @阿狗', message: [
        { type: 'text', data: { text: '你来吗 ' } },
        { type: 'at', data: { qq: '222' } },
      ] }),
      ev({ time: day + 3, text: '开黑四缺一，来不来', user: 222, name: '阿狗', group: 456 }),
      ev({ time: now - 60, text: '今天继续打牌', group: 456 }),
    ]
    const records = fixture.map((data, i) => normalizeOneBot({ source: 'json', sourceKey: 'd' + i, data }))
    insertBatch(archive.db, archive, records)

    archive.db.prepare(
      `insert into highlights(chat_key, from_ts, to_ts, msg_count, stats, summary, model, created_at)
       values(?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('group:123', day + 60, day + 120, 42, JSON.stringify({
      participants: [{ userId: '111', name: '阿猫', count: 20 }], samples: [],
    }), '一段摘要', 'test/model', now)

    const data = buildBoardData(archive.db).data
    assert.equal(data.highlights.length, 1)
    assert.equal(data.highlights[0].count, 42)
    assert.equal(data.highlights[0].chatName, '测试群')
    assert.equal(data.highlights[0].summary, '一段摘要')

    const today = isoDate(day)
    assert.ok(data.calendar.days.some((d) => d.date === today && d.total > 0), '日历应包含有消息的日期')
    assert.ok(data.calendar.byChat['group:123'], '按群日历应存在')
    assert.ok(data.links.total >= 1, '资源库应抽到消息里的链接')
    assert.ok(Array.isArray(data.leaderboard.people), '榜单应返回人物数组')
    assert.ok(data.topics.words.length > 0, '高频词应非空')
    assert.equal(data.chats.length, 2)
  } finally {
    archive.db.close()
    await rm(home, { recursive: true, force: true })
  }
})
