import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArchive, insertBatch } from '../lib/db.mjs'
import { normalizeOneBot } from '../lib/normalize.mjs'
import { findCandidates, buildProfile } from '../lib/people.mjs'

function ev({ time, text, user, name, message }) {
  return {
    time,
    self_id: 999,
    post_type: 'message',
    message_type: 'group',
    group_id: 123,
    group_name: '测试群',
    user_id: user,
    message_id: time,
    sender: { user_id: user, nickname: name },
    message: message || [{ type: 'text', data: { text } }],
    raw_message: text || '',
  }
}

const T0 = 1760000000
const fixture = [
  ev({ time: T0 + 1, text: '有人打牌吗', user: 11111, name: '阿猫' }),
  ev({ time: T0 + 2, text: '我来', user: 22222, name: '阿狗' }),
  ev({ time: T0 + 3, text: '你上次说的那套卡组还在吗', user: 11111, name: '阿猫' }),
  ev({ time: T0 + 4, text: '在的', user: 22222, name: '阿狗' }),
  ev({
    time: T0 + 5,
    user: 11111,
    name: '阿猫',
    message: [
      { type: 'at', data: { qq: '22222' } },
      { type: 'text', data: { text: ' 晚上老地方' } },
    ],
  }),
  ev({
    time: T0 + 6,
    user: 22222,
    name: '阿狗',
    message: [
      { type: 'at', data: { qq: '11111' } },
      { type: 'text', data: { text: ' 好' } },
    ],
  }),
]

test('人物档案：候选、别名、统计、@、最近', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qq-people-'))
  const archive = openArchive(home)
  try {
    insertBatch(
      archive.db,
      archive,
      fixture.map((data, i) => normalizeOneBot({ source: 'json', sourceKey: 'p' + i, data })),
    )

    // 按昵称找人
    const candidates = findCandidates(archive.db, '阿猫')
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].userId, '11111')
    assert.ok(candidates[0].names.includes('阿猫'))

    // 按 QQ 号找人
    const byId = findCandidates(archive.db, '22222')
    assert.equal(byId.length, 1)
    assert.equal(byId[0].userId, '22222')
    assert.equal(findCandidates(archive.db, '不存在的人').length, 0)

    const names = new Map([['group:123', '测试群']])
    const p = buildProfile(archive.db, names, { userId: '11111' })
    assert.equal(p.total, 3)
    assert.deepEqual(p.aliases, ['阿猫'])
    assert.equal(p.chats.length, 1)
    assert.equal(p.chats[0].msgCount, 3)
    assert.equal(p.recent.length, 3)
    assert.equal(p.recent[0].text, '@22222 晚上老地方')
    assert.ok(p.mentionsOut.some((m) => m.userId === '22222'))
    assert.ok(p.mentionedBy.some((m) => m.userId === '22222'))
    assert.ok(p.summary.includes('【阿猫】QQ 11111'))
    assert.ok(p.summary.includes('共 3 条消息'))

    // 限定会话后只统计这个会话
    const scoped = buildProfile(archive.db, names, { userId: '11111', chatKey: 'group:123' })
    assert.equal(scoped.total, 3)
  } finally {
    archive.db.close()
    await rm(home, { recursive: true, force: true })
  }
})
