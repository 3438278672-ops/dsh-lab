import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArchive, insertBatch } from '../lib/db.mjs'
import { normalizeOneBot } from '../lib/normalize.mjs'
import { buildViewerData, renderViewerHtml } from '../lib/export.mjs'

const T0 = 1760000000

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

test('浏览页：数据、相对路径、HTML 不破注入', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qq-archive-viewer-'))
  const archive = openArchive(home)
  try {
    const events = [
      ev({ time: T0 + 1, text: '普通一句 <script>alert(1)</script>' }),
      ev({ time: T0 + 2, user: 222, name: '阿狗', message: [{ type: 'image', data: { file: 'a.jpg', url: 'https://example.com/a.jpg' } }] }),
    ]
    const records = events.map((data, i) => normalizeOneBot({ source: 'json', sourceKey: 'k' + i, data }))
    insertBatch(archive.db, archive, records)
    archive.db.prepare("update media set local_path = ? where kind = 'image'").run(join(home, 'media', 'a.jpg'))

    const data = buildViewerData(archive.db, home)
    assert.equal(data.chats.length, 1)
    assert.equal(data.messages.length, 2)
    assert.equal(data.messages[1][6][0].path, 'media/a.jpg')

    const html = renderViewerHtml(data, { title: '测试' })
    assert.ok(html.includes('const DATA ='))
    assert.ok(html.includes('media/a.jpg'))
    // 数据里的 </script> 必须被转义，不能提前闭合脚本
    assert.ok(!html.includes('<script>alert(1)</script>'))
    assert.ok(html.includes('\\u003cscript>'))
  } finally {
    archive.db.close()
    await rm(home, { recursive: true, force: true })
  }
})
