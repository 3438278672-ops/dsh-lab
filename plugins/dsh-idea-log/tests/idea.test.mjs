import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addIdea, ideaStats, listIdeas, openIdeas, updateIdea } from '../lib/db.mjs'
import { decodeSessionFile, extractMaterial, materialToText, parseDigest } from '../lib/digest.mjs'
import { dueForDigest, markDigestDay } from '../index.js'

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'idea-test-'))
  const a = openIdeas(dir)
  return { ...a, dir, cleanup: () => { a.db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('记一条、同题去重、按类型与状态筛', () => {
  const t = freshDb()
  try {
    const r1 = addIdea(t.db, { kind: 'idea', title: '给 QQ 群做个语音转写', body: '历史语音下不动', tags: ['qq', '语音'] })
    assert.equal(r1.duplicate, false)
    const r2 = addIdea(t.db, { kind: 'pitfall', title: '  给 QQ 群做个语音转写  ' })
    assert.equal(r2.duplicate, true)
    assert.equal(r2.id, r1.id)

    addIdea(t.db, { kind: 'pitfall', title: 'ffmpeg 中文路径要传数组参数' })
    addIdea(t.db, { kind: 'improve', title: '探案板红线太多' })

    assert.equal(listIdeas(t.db, { kind: 'pitfall' }).length, 1)
    assert.equal(listIdeas(t.db, { q: '语音' }).length, 1)
    const s = ideaStats(t.db)
    assert.equal(s.total, 3)
    assert.equal(s.byKind.idea, 1)
    assert.equal(s.fresh, 3)

    updateIdea(t.db, { id: r1.id, status: 'done' })
    assert.equal(ideaStats(t.db).fresh, 2)
    assert.equal(listIdeas(t.db, { status: 'done' }).length, 1)
  } finally {
    t.cleanup()
  }
})

test('parseDigest 容错三种写法', () => {
  const plain = parseDigest('{"items":[{"kind":"idea","title":"做个 X","body":"因为 Y","tags":["a"]}]}')
  assert.equal(plain.length, 1)
  assert.equal(plain[0].title, '做个 X')

  const fenced = parseDigest('```json\n{"items":[{"kind":"pitfall","title":"Z 会挂"}]}\n```')
  assert.equal(fenced[0].kind, 'pitfall')

  const noisy = parseDigest('好的，我整理了一下：{"items":[{"title":"W"}]} 就这些')
  assert.equal(noisy[0].title, 'W')

  assert.deepEqual(parseDigest('没有值得记的'), [])
})

test('decodeSessionFile 能解开多帧 zstd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idea-zstd-'))
  try {
    const file = join(dir, 'session.v4.jsonl.zstd')
    const events = [
      { type: 'session', version: 4, id: 'x' },
      { type: 'user/message', data: { content: [{ type: 'text', text: '今天踩了个坑' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '说说看' }] } } },
      { type: 'tool/call', data: { name: 'pwsh', arguments: '{"command":"dir"}' } },
    ]
    // 一行一帧，模拟 DSH 的写法
    const buf = Buffer.concat(events.map((e) => zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8'))))
    writeFileSync(file, buf)

    const got = decodeSessionFile(file)
    assert.equal(got.length, 4)
    assert.equal(got[1].type, 'user/message')

    const m = extractMaterial(got)
    assert.deepEqual(m.users, ['今天踩了个坑'])
    assert.deepEqual(m.assistant, ['说说看'])
    assert.equal(m.tools.length, 1)
    assert.match(materialToText([m]), /今天踩了个坑/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractMaterial 过滤系统注入的用户消息', () => {
  const events = [
    { type: 'user/message', data: { source: { kind: 'user-approval' }, content: [{ type: 'text', text: 'The user changed...' }] } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '真正的需求' }] } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '[MNEMON] 别记我' }] } },
  ]
  const m = extractMaterial(events)
  assert.deepEqual(m.users, ['真正的需求'])
})

test('dueForDigest 到点才跑，当天跑过不再跑', () => {
  const t = freshDb()
  try {
    const cfg = { digest: { schedule: '23:30' } }
    const at = (h, m) => new Date(2026, 4, 20, h, m, 0, 0).getTime()
    assert.equal(dueForDigest(cfg, t.db, at(22, 0)), false)
    assert.equal(dueForDigest(cfg, t.db, at(23, 45)), true)
    markDigestDay(t.db, at(23, 45))
    assert.equal(dueForDigest(cfg, t.db, at(23, 50)), false)
    assert.equal(dueForDigest({ digest: { schedule: '' } }, t.db, at(23, 45)), false)
    assert.equal(dueForDigest({ digest: { schedule: '99:99' } }, t.db, at(23, 45)), false)
  } finally {
    t.cleanup()
  }
})
