import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArchive, insertBatch } from '../lib/db.mjs'
import { normalizeOneBot } from '../lib/normalize.mjs'
import { pendingVoiceCount } from '../lib/voice.mjs'

const T0 = 1760000000

function voiceEvent(seq) {
  return {
    time: T0 + seq,
    self_id: 999,
    post_type: 'message',
    message_type: 'group',
    group_id: 123,
    group_name: '测试群',
    user_id: 111,
    message_id: T0 + seq,
    sender: { user_id: 111, nickname: '阿猫' },
    message: [{ type: 'record', data: { file: `v${seq}.amr`, url: `https://example.com/v${seq}.amr` } }],
    raw_message: '',
  }
}

test('待转写语音：只数已下载且没有转写结果的', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qq-archive-voice-'))
  const archive = openArchive(home)
  try {
    const records = [1, 2].map((i) => normalizeOneBot({ source: 'json', sourceKey: 'v' + i, data: voiceEvent(i) }))
    insertBatch(archive.db, archive, records)

    // 刚入库是 meta，还没下载
    assert.equal(pendingVoiceCount(archive.db), 0)

    archive.db
      .prepare("update media set status = 'cached', local_path = 'C:/tmp/v1.amr' where kind = 'voice' and source_key = 'v1#0'")
      .run()
    archive.db
      .prepare("update media set status = 'cached', local_path = 'C:/tmp/v2.amr' where kind = 'voice' and source_key = 'v2#0'")
      .run()
    assert.equal(pendingVoiceCount(archive.db), 2)

    archive.db.prepare("update media set transcript = '今天打牌吗' where source_key = 'v1#0'").run()
    assert.equal(pendingVoiceCount(archive.db), 1)

    // 空转写（静音/听不清）也算处理过，不能无限重试
    archive.db.prepare("update media set transcript = '' where source_key = 'v2#0'").run()
    assert.equal(pendingVoiceCount(archive.db), 0)

    archive.db.prepare("update media set transcript = null where source_key = 'v2#0'").run()
    assert.equal(pendingVoiceCount(archive.db), 1)
  } finally {
    archive.db.close()
    await rm(home, { recursive: true, force: true })
  }
})
