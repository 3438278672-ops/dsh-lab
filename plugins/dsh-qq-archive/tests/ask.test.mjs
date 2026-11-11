import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { insertBatch, openArchive } from '../lib/db.mjs'
import { askArchive } from '../lib/ask.mjs'
import { normalizeOneBot } from '../lib/normalize.mjs'

const T0 = 1760000000

function ev({ time, text, user = 111, name = '阿猫', group = 123, groupName = '测试群', message }) {
  return {
    time,
    self_id: 999,
    post_type: 'message',
    message_type: 'group',
    group_id: group,
    group_name: groupName,
    user_id: user,
    message_id: time,
    sender: { user_id: user, nickname: name },
    message: message || [{ type: 'text', data: { text } }],
    raw_message: text || '',
  }
}

// 够长（> 200 字）的消息，用来验证材料截断
const LONG_TEXT = '打牌' + '记录'.repeat(160)

const FIXTURE = [
  ev({ time: T0 + 10, text: '今天下午三点在牌店打牌' }), // 1 · 阿猫 · 群 123
  ev({ time: T0 + 20, text: '你来吗', user: 222, name: '阿狗' }), // 2 · 阿狗
  ev({ time: T0 + 30, text: '不来，我打牌打腻了', user: 222, name: '阿狗' }), // 3 · 阿狗
  ev({ time: T0 + 40, text: '卡组发你了，快看' }), // 4 · 阿猫
  ev({ time: T0 + 50, text: '上次那个做视频的群叫什么来着', user: 333, name: '阿鸡', group: 456, groupName: '二群' }), // 5 · 群 456
  ev({ time: T0 + 60, text: LONG_TEXT, user: 222, name: '阿狗' }), // 6 · 够长
]

async function makeArchive(fixture = FIXTURE) {
  const home = await mkdtemp(join(tmpdir(), 'qq-archive-ask-'))
  const archive = openArchive(home)
  const records = fixture.map((data, i) => normalizeOneBot({ source: 'json', sourceKey: 'ask-' + i, data }))
  insertBatch(archive.db, archive, records)
  return { home, archive }
}

async function withArchive(fn, fixture) {
  const { home, archive } = await makeArchive(fixture)
  try {
    await fn({ home, archive })
  } finally {
    archive.db.close()
    await rm(home, { recursive: true, force: true })
  }
}

function idOf(archive, text) {
  const row = archive.db.prepare('select id from messages where text = ?').get(text)
  assert.ok(row, `没找到消息：${text}`)
  return row.id
}

test('关键词检索 + _generate：prompt、编号、时间序、used 都能对上', async () => {
  await withArchive(async ({ archive }) => {
    const calls = []
    const result = await askArchive({
      archive,
      db: archive.db,
      llm: null,
      cfg: {},
      question: '打牌',
      _generate: async (args) => {
        calls.push(args)
        return '大家在牌店打牌 [1][3]。'
      },
    })

    assert.equal(result.question, '打牌')
    assert.equal(result.mode, 'keyword')
    assert.equal(result.answer, '大家在牌店打牌 [1][3]。')
    assert.equal(calls.length, 1)
    assert.match(calls[0].system, /只依据/)
    assert.match(calls[0].system, /\[n\]/)
    assert.match(calls[0].prompt, /【问题】打牌/)
    assert.match(calls[0].prompt, /\[1\]/)
    assert.match(calls[0].prompt, /今天下午三点在牌店打牌/)

    const citations = result.citations
    assert.equal(citations.length, 3)
    assert.deepEqual(citations.map((c) => c.n), [1, 2, 3])
    for (let i = 1; i < citations.length; i++) {
      assert.ok(citations[i].ts >= citations[i - 1].ts, 'citations 应按时间升序')
    }
    const first = citations[0]
    assert.equal(first.id, idOf(archive, '今天下午三点在牌店打牌'))
    assert.equal(first.chatKey, 'group:123')
    assert.equal(first.chatName, '测试群')
    assert.equal(first.senderName, '阿猫')

    assert.equal(result.used.length, citations.length)
    assert.equal(result.used[0].id, first.id)
    assert.equal(result.used[0].source, 'keyword')
    assert.equal(result.used[0].score, null)
  })
})

test('k 限制材料条数；材料与 citation 都截断到 200 字', async () => {
  await withArchive(async ({ archive }) => {
    const prompts = []
    const result = await askArchive({
      archive,
      db: archive.db,
      llm: null,
      cfg: {},
      question: '记录',
      k: 1,
      _generate: async (args) => {
        prompts.push(args.prompt)
        return 'ok [1]'
      },
    })

    assert.equal(result.citations.length, 1)
    const only = result.citations[0]
    assert.equal(only.id, idOf(archive, LONG_TEXT))
    assert.ok(only.text.length <= 200, 'citation 应截断到 200 字')
    assert.ok(only.text.endsWith('…'))
    assert.ok(prompts[0].includes(only.text), 'prompt 里的材料和 citation 文本一致')
    assert.ok(!prompts[0].includes(LONG_TEXT), 'prompt 里不应出现未截断的长文')

    const capped = await askArchive({
      archive,
      db: archive.db,
      llm: null,
      cfg: {},
      question: '打牌',
      k: 2,
      _generate: async () => 'ok [1]',
    })
    assert.equal(capped.citations.length, 2, 'k 是最终材料上限')
    const ids = capped.citations.map((c) => c.id)
    assert.equal(new Set(ids).size, ids.length, '同一条消息不能重复出现')
  })
})

test('会话过滤与时间过滤（fromTs / toTs 为 0 时不能变成 ts<=0）', async () => {
  await withArchive(async ({ archive }) => {
    const generate = async () => 'ok [1]'

    const inChat = await askArchive({
      archive,
      db: archive.db,
      llm: null,
      cfg: {},
      question: '视频',
      chatKey: 'group:456',
      _generate: generate,
    })
    assert.equal(inChat.citations.length, 1)
    assert.equal(inChat.citations[0].chatKey, 'group:456')
    assert.equal(inChat.citations[0].chatName, '二群')
    assert.equal(inChat.citations[0].senderName, '阿鸡')

    // 会话里没有「打牌」：不能把别的会话的结果漏进来
    const otherChat = await askArchive({
      archive,
      db: archive.db,
      llm: null,
      cfg: {},
      question: '打牌',
      chatKey: 'group:456',
      _generate: generate,
    })
    assert.deepEqual(otherChat.citations, [])

    const from = await askArchive({
      archive,
      db: archive.db,
      llm: null,
      cfg: {},
      question: '打牌',
      fromTs: T0 + 25,
      _generate: generate,
    })
    assert.ok(from.citations.length > 0)
    assert.ok(from.citations.every((c) => c.ts >= T0 + 25))
    assert.ok(!from.citations.some((c) => c.id === idOf(archive, '今天下午三点在牌店打牌')))

    const to = await askArchive({
      archive,
      db: archive.db,
      llm: null,
      cfg: {},
      question: '打牌',
      toTs: T0 + 20,
      _generate: generate,
    })
    assert.equal(to.citations.length, 1)
    assert.equal(to.citations[0].id, idOf(archive, '今天下午三点在牌店打牌'))
  })
})

test('没有可用模型时抛清晰错误；问题为空也拒绝', async () => {
  await withArchive(async ({ archive }) => {
    await assert.rejects(
      () => askArchive({ archive, db: archive.db, llm: null, cfg: {}, question: '打牌' }),
      /DSH 里没有可用模型/,
    )
    await assert.rejects(
      () => askArchive({ archive, db: archive.db, llm: null, cfg: {}, question: '   ' }),
      /问题不能为空/,
    )
  })
})

test('一条材料都没有时不调模型，直接说没找到', async () => {
  await withArchive(async ({ archive }) => {
    let called = 0
    const result = await askArchive({
      archive,
      db: archive.db,
      llm: null,
      cfg: {},
      question: '不存在的词zzz',
      _generate: async () => {
        called++
        return '不应该被调用'
      },
    })
    assert.equal(called, 0)
    assert.equal(result.mode, 'keyword')
    assert.deepEqual(result.citations, [])
    assert.deepEqual(result.used, [])
    assert.match(result.answer, /没在归档里找到/)
  })
})

test('语义 + 关键词合并：home 从 archive.path 推出，语义优先去重', async () => {
  await withArchive(async ({ home, archive }) => {
    // semanticReady 只看这两个文件在不在；真正检索用注入的 _semanticSearch，避免起 Python
    await mkdir(join(home, 'semantic'), { recursive: true })
    await writeFile(join(home, 'semantic', 'ids.npy'), '')
    await writeFile(join(home, 'semantic', 'vectors.npy'), '')

    const idFirst = idOf(archive, '今天下午三点在牌店打牌')
    const idLong = idOf(archive, LONG_TEXT)
    const seen = []
    let prompt = ''
    const result = await askArchive({
      archive,
      db: archive.db,
      llm: null,
      cfg: {},
      question: '打牌',
      _semanticSearch: async (semArchive, text, opts) => {
        seen.push({ semArchive, text, opts })
        return [
          { id: idLong, score: 0.92 },
          { id: idFirst, score: 0.4 },
        ]
      },
      _generate: async (args) => {
        prompt = args.prompt
        return '答案 [1]'
      },
    })

    assert.equal(seen.length, 1)
    assert.equal(seen[0].semArchive.home, home, 'archive 没带 home 时应从 archive.path 推')
    assert.equal(seen[0].text, '打牌')
    assert.equal(seen[0].opts.k, 60)

    assert.equal(result.mode, 'semantic+keyword')
    const usedById = new Map(result.used.map((u) => [u.id, u]))
    assert.equal(usedById.get(idLong).source, 'semantic')
    assert.equal(usedById.get(idLong).score, 0.92)
    assert.equal(usedById.get(idFirst).source, 'semantic')
    assert.equal(usedById.get(idFirst).score, 0.4)
    const keywordOnly = result.used.filter((u) => u.source === 'keyword')
    assert.equal(keywordOnly.length, 1, '只有第 3 条消息是纯关键词命中')
    assert.equal(keywordOnly[0].score, null)

    // 同一条消息只出现一次（idFirst 同时被语义和关键词命中）
    assert.equal(result.citations.filter((c) => c.id === idFirst).length, 1)
    // 先按语义分取前 k，最后按时间排：10 → 30 → 60
    assert.deepEqual(result.citations.map((c) => c.id), [idFirst, idOf(archive, '不来，我打牌打腻了'), idLong])
    assert.match(prompt, /\[1\]/)
  })
})

test('语义检索没有命中时退回 keyword', async () => {
  await withArchive(async ({ archive }) => {
    let called = 0
    const result = await askArchive({
      archive,
      db: archive.db,
      llm: null,
      cfg: {},
      question: '打牌',
      _semanticReady: () => true,
      _semanticSearch: async () => {
        called++
        return []
      },
      _generate: async () => 'ok [1]',
    })
    assert.equal(called, 1)
    assert.equal(result.mode, 'keyword')
    assert.ok(result.citations.length > 0)
  })
})

test('语义检索报错时降级为 keyword，并带上 semanticError', async () => {
  await withArchive(async ({ archive }) => {
    const result = await askArchive({
      archive,
      db: archive.db,
      llm: null,
      cfg: {},
      question: '打牌',
      _semanticReady: () => true,
      _semanticSearch: async () => {
        throw new Error('找不到 Python 解释器')
      },
      _generate: async () => '仍能回答 [1]',
    })
    assert.equal(result.mode, 'keyword')
    assert.match(result.semanticError, /Python/)
    assert.ok(result.citations.length > 0)
    assert.equal(result.answer, '仍能回答 [1]')
  })
})

test('不注入 _generate 时走 listRoutes / pickRoute / streamText，并上报进度', async () => {
  await withArchive(async ({ archive }) => {
    const streamCalls = []
    const llm = {
      listProviders: () => [{ id: 'fake', name: '假提供方' }],
      listModels: async () => [{ id: 'fake-chat', name: '假模型' }],
      stream: (opts) => {
        streamCalls.push(opts)
        return (async function* () {
          yield { type: 'text-delta', text: '来自假模型的' }
          yield { type: 'text-delta', text: '回答 [1]' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
    const events = []
    const result = await askArchive({
      archive,
      db: archive.db,
      llm,
      cfg: { llm: { provider: '', model: '' } },
      question: '打牌',
      onProgress: (event) => events.push(event.phase),
    })

    assert.equal(result.answer, '来自假模型的回答 [1]')
    assert.equal(streamCalls.length, 1)
    assert.equal(streamCalls[0].provider, 'fake')
    assert.equal(streamCalls[0].model, 'fake-chat')
    assert.match(streamCalls[0].system, /只依据/)
    assert.equal(streamCalls[0].temperature, 0.3)
    assert.equal(streamCalls[0].maxTokens, 1200)
    assert.match(streamCalls[0].messages[0].content[0].text, /【材料】/)
    assert.deepEqual(events, ['retrieving', 'calling', 'done'])
  })
})
