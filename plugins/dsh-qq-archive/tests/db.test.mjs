import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArchive, insertBatch, searchMessages, contextAround, dbStats, listChats } from '../lib/db.mjs'
import { normalizeOneBot } from '../lib/normalize.mjs'

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

const T0 = 1760000000
const fixture = [
  ev({ time: T0 + 1, text: '今天下午三点在牌店打牌' }),
  ev({ time: T0 + 2, text: '你来吗' }),
  ev({ time: T0 + 3, text: '不来，我打牌打腻了', user: 222, name: '阿狗' }),
  ev({ time: T0 + 4, user: 222, name: '阿狗', message: [{ type: 'record', data: { file: 'v.amr', url: 'https://example.com/v.amr' } }] }),
  ev({ time: T0 + 5, text: '卡组发你了' }),
]

test('入库 + 中文精确搜索 / 过滤 / 上下文', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qq-archive-'))
  const archive = openArchive(home)
  try {
    const records = fixture.map((data, i) =>
      normalizeOneBot({ source: 'json', sourceKey: 'k' + i, data }),
    )
    const counts = insertBatch(archive.db, archive, records)
    assert.equal(counts.inserted, 5)

    assert.equal(dbStats(archive.db).total, 5)
    assert.equal(listChats(archive.db).length, 1)

    // 2 字中文词必须能搜到（trigram 做不到，这里靠 chars 表）
    const hit = searchMessages(archive, { query: '打牌' })
    assert.equal(hit.mode, 'chars')
    assert.equal(hit.hits.length, 2)

    const exact = searchMessages(archive, { query: '牌店' })
    assert.equal(exact.hits.length, 1)
    assert.equal(exact.hits[0].text, '今天下午三点在牌店打牌')

    // 查不到的词不能靠 OR 把含常见字的消息全捞出来
    const none = searchMessages(archive, { query: '不存在的词zzz' })
    assert.equal(none.hits.length, 0)

    // 语音消息的 kind 是 voice
    const voice = searchMessages(archive, { query: '', kind: 'voice' })
    assert.equal(voice.hits.length, 1)
    assert.equal(voice.hits[0].kind, 'voice')

    // 按发送者过滤
    const bySender = searchMessages(archive, { query: '打牌', senderName: '阿狗' })
    assert.equal(bySender.hits.length, 1)

    // 时间过滤
    const recent = searchMessages(archive, { query: '打牌', fromTs: T0 + 2 })
    assert.equal(recent.hits.length, 1)

    // 上下文
    const target = hit.hits.find((h) => h.text.startsWith('今天'))
    const ctx = contextAround(archive.db, target, 1)
    assert.deepEqual(ctx.map((r) => r.text), ['你来吗'])
  } finally {
    archive.db.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('重复导入同一条消息不会重复入库', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qq-archive-'))
  const archive = openArchive(home)
  try {
    const record = normalizeOneBot({ source: 'json', sourceKey: 'dup', data: fixture[0] })
    insertBatch(archive.db, archive, [record])
    insertBatch(archive.db, archive, [record])
    assert.equal(dbStats(archive.db).total, 1)
  } finally {
    archive.db.close()
    await rm(home, { recursive: true, force: true })
  }
})
