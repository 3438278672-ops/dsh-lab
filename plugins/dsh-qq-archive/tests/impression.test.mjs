/**
 * 人物印象：JSON 解析、采样、存读、假模型跑通生成链路、每日调度判定。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArchive, insertBatch, setMeta } from '../lib/db.mjs'
import {
  collectSamples,
  dueForDaily,
  generateImpression,
  parseImpression,
  readImpression,
  saveImpression,
} from '../lib/impression.mjs'
import { isoDate } from '../lib/util.mjs'

const T0 = 1767000000

function makeRecord(i, overrides = {}) {
  const group = i % 3 === 0
  return {
    message: {
      source: 'test',
      sourceKey: `k${i}`,
      chatKey: group ? 'group:2002' : 'group:1001',
      chatType: 'group',
      chatId: group ? '2002' : '1001',
      chatName: group ? '第二个群' : '测试群',
      senderId: '12345',
      senderName: i % 5 === 0 ? '阿明' : 'ming',
      ts: T0 + i * 600,
      kind: i % 7 === 0 ? 'image' : 'text',
      text: i % 7 === 0 ? '[图片]' : `第${i}条：今天下午三点在牌店打牌，谁去？`,
      replyTo: null,
      raw: null,
      ...overrides,
    },
    media: [],
  }
}

function makeDb(count = 60) {
  const dir = mkdtempSync(join(tmpdir(), 'qqa-impression-'))
  const archive = openArchive(dir)
  const records = []
  for (let i = 0; i < count; i++) records.push(makeRecord(i))
  insertBatch(archive.db, archive, records)
  return { dir, archive, db: archive.db, close: () => archive.db.close() }
}

function fakeLlm(reply) {
  return {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

test('parseImpression：裸 JSON、代码块包裹、纯文本兜底', () => {
  assert.deepEqual(parseImpression('{"impression":"爱打牌的人","tags":["牌佬"]}'), {
    impression: '爱打牌的人',
    tags: ['牌佬'],
  })
  assert.deepEqual(parseImpression('```json\n{"impression":"夜猫子","tags":["熬夜"]}\n```'), {
    impression: '夜猫子',
    tags: ['熬夜'],
  })
  assert.deepEqual(parseImpression('就是一句普通的话。'), { impression: '就是一句普通的话。', tags: [] })
  assert.deepEqual(parseImpression(''), { impression: '', tags: [] })
})

test('collectSamples：采样不超预算、按时间正序、跳过纯占位消息、最近的发言在', () => {
  const { db, close } = makeDb(60)
  try {
    const samples = collectSamples(db, '12345', null, 10)
    assert.ok(samples.length <= 10 && samples.length > 0)
    assert.ok(samples[0].ts <= samples[samples.length - 1].ts, '应按时间正序')
    assert.ok(samples.every((s) => !/^\[.*\]$/.test(s.text)), '不该采样 [图片]')
    // i=59 是最近的一条文本消息，降采样时首尾要保住
    assert.equal(samples[samples.length - 1].ts, T0 + 59 * 600)
  } finally {
    close()
  }
})

test('collectSamples：chatKey 限定只取指定会话', () => {
  const { db, close } = makeDb(60)
  try {
    const samples = collectSamples(db, '12345', 'group:2002', 6)
    assert.ok(samples.length > 0)
    assert.ok(samples.every((s) => s.chat_key === 'group:2002'))
  } finally {
    close()
  }
})

test('saveImpression / readImpression 往返（含标签和模型名）', () => {
  const { db, close } = makeDb(1)
  try {
    assert.equal(readImpression(db, '12345'), null)
    const at = saveImpression(db, '12345', {
      impression: '一个在牌店出没的人。',
      tags: ['牌佬', '夜猫子'],
      model: 'fake/m',
      stats: { total: 60 },
    })
    const got = readImpression(db, '12345')
    assert.equal(got.impression, '一个在牌店出没的人。')
    assert.deepEqual(got.tags, ['牌佬', '夜猫子'])
    assert.equal(got.model, 'fake/m')
    assert.equal(got.at, at)
    // 再存一次是更新，不是插入第二行
    saveImpression(db, '12345', { impression: '改过了。', tags: [], model: 'fake/m2' })
    assert.equal(readImpression(db, '12345').impression, '改过了。')
  } finally {
    close()
  }
})

test('generateImpression：假模型返回 JSON → 解析并写库', async () => {
  const { db, close } = makeDb(40)
  try {
    const chatNames = new Map([['group:1001', '测试群'], ['group:2002', '第二个群']])
    const r = await generateImpression({
      db,
      chatNames,
      userId: '12345',
      llm: fakeLlm('{"impression":"每天三点准时约牌的人。","tags":["牌佬","准点"]}'),
      route: { provider: 'fake', model: 'm' },
      sample: 20,
    })
    assert.equal(r.impression, '每天三点准时约牌的人。')
    assert.deepEqual(r.tags, ['牌佬', '准点'])
    assert.ok(r.promptChars > 100)
    const saved = readImpression(db, '12345')
    assert.equal(saved.impression, '每天三点准时约牌的人。')
    assert.equal(saved.model, 'fake/m')
  } finally {
    close()
  }
})

test('generateImpression：归档里没有这个人时明确报错', async () => {
  const { db, close } = makeDb(5)
  try {
    await assert.rejects(
      () => generateImpression({ db, chatNames: new Map(), userId: '99999', llm: fakeLlm('{}'), route: { provider: 'fake', model: 'm' } }),
      /没有消息/,
    )
  } finally {
    close()
  }
})

test('dueForDaily：到点才跑、当天跑过不重复、增强层关着不跑', () => {
  const { db, close } = makeDb(1)
  try {
    const cfg = { enhance: { impression: true }, impression: { schedule: '03:30' } }
    const at = (h, m) => new Date(2026, 10, 7, h, m, 0)
    assert.equal(dueForDaily(cfg, db, at(3, 29)), false, '还没到点')
    assert.equal(dueForDaily(cfg, db, at(3, 30)), true)
    assert.equal(dueForDaily(cfg, db, at(8, 0)), true, '错过了也要补')
    setMeta(db, 'last_impression_date', isoDate(Math.floor(at(3, 30).getTime() / 1000)))
    assert.equal(dueForDaily(cfg, db, at(8, 0)), false, '当天已经跑过')
    assert.equal(dueForDaily({ enhance: { impression: false }, impression: { schedule: '03:30' } }, db, at(9, 0)), false)
    assert.equal(dueForDaily({ enhance: { impression: true }, impression: { schedule: '' } }, db, at(9, 0)), false)
  } finally {
    close()
  }
})
