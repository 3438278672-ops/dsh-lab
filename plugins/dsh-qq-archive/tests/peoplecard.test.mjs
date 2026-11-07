import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArchive, insertBatch } from '../lib/db.mjs'
import { buildPeopleCard } from '../lib/peoplecard.mjs'

/**
 * 熟人卡是给 QQ 桥接读的：每个会话挑最常说话的人，配上人物印象。
 * 这里盯三件容易坏的事：排序与截断、脏印象（JSON 原文）、系统消息名。
 */
function rec(chatKey, senderId, senderName, text, ts) {
  const [chatType, chatId] = chatKey.split(':')
  return {
    message: {
      source: 'test',
      sourceKey: `${chatKey}:${ts}:${senderId}`,
      chatKey,
      chatType,
      chatId,
      chatName: chatType === 'group' ? '测试群' : '好友',
      senderId,
      senderName,
      ts,
      kind: 'text',
      text,
      replyTo: '',
      raw: '{}',
    },
    media: [],
  }
}

async function withArchive(fn) {
  const home = await mkdtemp(join(tmpdir(), 'qqa-card-'))
  const archive = openArchive(home)
  try {
    await fn(archive, home)
  } finally {
    archive.db.close()
    await rm(home, { recursive: true, force: true })
  }
}

test('buildPeopleCard：按会话挑最活跃的人，带印象和标签', () =>
  withArchive((archive) => {
    const T0 = 1760000000
    const records = []
    for (let i = 0; i < 3; i++) records.push(rec('group:111', 'u1', '甲', `甲的消息${i}`, T0 + i))
    for (let i = 0; i < 2; i++) records.push(rec('group:111', 'u2', '乙', `乙的消息${i}`, T0 + 10 + i))
    records.push(rec('group:111', 'u3', '丙', '丙只说一句', T0 + 20))
    insertBatch(archive.db, archive, records)
    archive.db
      .prepare("insert into profiles (user_id, chat_key, impression, tags) values ('u1','*','甲很能说','[\"活跃\"]')")
      .run()

    const card = buildPeopleCard(archive.db, { minMsgs: 2 })
    const people = card.chats['group:111'].people
    assert.deepEqual(people.map((p) => p.id), ['u1', 'u2'])
    assert.equal(people[0].name, '甲')
    assert.equal(people[0].impression, '甲很能说')
    assert.deepEqual(people[0].tags, ['活跃'])
    assert.equal(people[1].impression, '')
  }))

test('buildPeopleCard：整段 JSON 当正文的脏印象会被拆回文字', () =>
  withArchive((archive) => {
    const T0 = 1760000000
    insertBatch(
      archive.db,
      archive,
      [0, 1, 2].map((i) => rec('group:1', 'u9', '九', `第${i}条`, T0 + i)),
    )
    archive.db
      .prepare(
        `insert into profiles (user_id, chat_key, impression, tags)
         values ('u9','*', '{"impression":"一个爱折腾 AI 的人，说话很快。","tags":["折腾"]}', '[]')`,
      )
      .run()

    const card = buildPeopleCard(archive.db)
    const p = card.chats['group:1'].people[0]
    assert.equal(p.impression, '一个爱折腾 AI 的人，说话很快。')
    assert.ok(!p.impression.startsWith('{'))
  }))

test('buildPeopleCard：系统消息名不冒充人名', () =>
  withArchive((archive) => {
    const T0 = 1760000000
    insertBatch(
      archive.db,
      archive,
      [0, 1, 2].map((i) => rec('group:1', 'u7', '某某 邀请“某位群友”加入了群聊', `第${i}条`, T0 + i)),
    )
    const card = buildPeopleCard(archive.db)
    assert.equal(card.chats['group:1'].people[0].name, 'QQ u7')
  }))

test('buildPeopleCard：没人说话的会话不出现', () =>
  withArchive((archive) => {
    insertBatch(archive.db, archive, [rec('group:empty', 'u1', '甲', '只有一条', 1760000000)])
    const card = buildPeopleCard(archive.db, { minMsgs: 5 })
    assert.equal(card.chats['group:empty'], undefined)
  }))
