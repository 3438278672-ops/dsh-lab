/**
 * 名场面：滑窗 / 合并 / 摘要 / 入库 / 列表，全部用固定时间戳的假消息和假 llm，不联网。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArchive, insertBatch } from '../lib/db.mjs'
import { normalizeOneBot } from '../lib/normalize.mjs'
import { isoDate } from '../lib/util.mjs'
import {
  HIGHLIGHT_SYSTEM,
  buildHighlightPrompt,
  findBursts,
  generateHighlightSummary,
  listHighlights,
  readHighlight,
  runHighlights,
} from '../lib/highlights.mjs'

/** 本地时区构造 unix 秒。 */
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
  const home = await mkdtemp(join(tmpdir(), 'qqa-highlights-'))
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

/** 连续 count 条、间隔 step 秒的刷屏消息。 */
function burstEvents({ start, count, group = 1001, groupName = '测试群', user = 111, name = '阿猫', step = 10, word = '打牌' }) {
  return Array.from({ length: count }, (_, i) =>
    ev({ time: start + i * step, text: `${word} ${i}`, user, name, group, groupName }),
  )
}

/** 假 llm：实现 listRoutes 需要的 listProviders/listModels，stream 吐一段固定文本。 */
function fakeLlm(reply) {
  const state = { calls: 0, last: null }
  const llm = {
    listProviders: () => [{ id: 'fake', name: 'Fake' }],
    listModels: async () => [{ id: 'm', name: 'M' }],
    stream(opts) {
      state.calls++
      state.last = opts
      return (async function* () {
        yield { type: 'text-delta', text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return { llm, state }
}

const OPTS = { minMessages: 5, windowSec: 600, gapSec: 600 }
const B = T(2026, 4, 1, 20, 0)

test('findBursts：窗口内 6 条算爆聊，隔了 1 万秒的孤立消息不计', async () => {
  const texts = ['打牌 走起', '今天 来不来', '打牌 打牌', '都在 摸鱼', '打牌 上号', '走起 走起']
  const events = texts.map((text, i) => ev({ time: B + i * 10, text, user: i < 4 ? 111 : 222, name: i < 4 ? '阿猫' : '阿狗' }))
  events.push(ev({ time: B + 10000, text: '随便 聊聊', user: 333, name: '阿明' }))

  const { db, cleanup } = await makeArchive(events)
  try {
    const bursts = findBursts(db, OPTS)
    assert.equal(bursts.length, 1)
    const b = bursts[0]
    assert.equal(b.chatKey, 'group:1001')
    assert.equal(b.chatName, '测试群')
    assert.equal(b.fromTs, B)
    assert.equal(b.toTs, B + 50)
    assert.equal(b.count, 6)
    assert.deepEqual(b.participants, [
      { userId: '111', name: '阿猫', count: 4 },
      { userId: '222', name: '阿狗', count: 2 },
    ])
    const top = new Map(b.topWords.map((w) => [w.word, w.count]))
    assert.equal(top.get('打牌'), 4)
    // 单字（走/起/来/都）被过滤，不会混进高频词
    assert.ok(b.topWords.every((w) => w.word.length >= 2))
    assert.equal(b.samples.length, 6)
    assert.deepEqual(b.samples[0], { ts: B, senderName: '阿猫', text: '打牌 走起' })
    assert.ok(b.samples.every((s, i) => i === 0 || s.ts > b.samples[i - 1].ts))

    // 门槛不自动降低：6 条达不到 7 条就不算
    assert.deepEqual(findBursts(db, { ...OPTS, minMessages: 7 }), [])
    // 时间范围把整段排除掉
    assert.deepEqual(findBursts(db, { ...OPTS, fromTs: B + 100, toTs: B + 200 }), [])
  } finally {
    await cleanup()
  }
})

test('findBursts：大空档切段，3 段按条数降序，limit 截断', async () => {
  const events = [
    ...burstEvents({ start: B, count: 6 }),
    ...burstEvents({ start: B + 2000, count: 8, group: 2002, groupName: '第二个群', user: 222, name: '阿狗' }),
    ...burstEvents({ start: B + 4000, count: 5 }),
  ]
  const { db, cleanup } = await makeArchive(events)
  try {
    const all = findBursts(db, { ...OPTS, limit: 12 })
    assert.deepEqual(all.map((b) => b.count), [8, 6, 5])
    assert.deepEqual(all.map((b) => b.chatKey), ['group:2002', 'group:1001', 'group:1001'])
    assert.deepEqual(all.map((b) => b.fromTs), [B + 2000, B, B + 4000])

    assert.deepEqual(findBursts(db, { ...OPTS, limit: 2 }).map((b) => b.count), [8, 6])
    assert.equal(findBursts(db, { ...OPTS, limit: 1 }).length, 1)
  } finally {
    await cleanup()
  }
})

test('findBursts：10 条每分钟一条，重叠窗口合并成一条，fromTs/toTs 覆盖首末', async () => {
  const events = burstEvents({ start: B, count: 10, step: 60 })
  const { db, cleanup } = await makeArchive(events)
  try {
    const bursts = findBursts(db, { ...OPTS, windowSec: 600 })
    assert.equal(bursts.length, 1)
    assert.equal(bursts[0].count, 10)
    assert.equal(bursts[0].fromTs, B)
    assert.equal(bursts[0].toTs, B + 540)
    assert.equal(bursts[0].samples.length, 10)
  } finally {
    await cleanup()
  }
})

test('findBursts：不同会话分开算，chatKey 只看一个群', async () => {
  const events = [
    ...burstEvents({ start: B, count: 6 }),
    ...burstEvents({ start: B + 5, count: 6, group: 2002, groupName: '第二个群', user: 222, name: '阿狗' }),
  ]
  const { db, cleanup } = await makeArchive(events)
  try {
    const bursts = findBursts(db, OPTS)
    assert.equal(bursts.length, 2)
    assert.deepEqual(bursts.map((b) => b.chatKey), ['group:1001', 'group:2002'])
    assert.deepEqual(bursts.map((b) => b.chatName), ['测试群', '第二个群'])
    assert.ok(bursts.every((b) => b.count === 6 && b.participants.length === 1))

    const only = findBursts(db, { ...OPTS, chatKey: 'group:2002' })
    assert.equal(only.length, 1)
    assert.equal(only[0].chatKey, 'group:2002')
    assert.equal(only[0].participants[0].name, '阿狗')
  } finally {
    await cleanup()
  }
})

test('generateHighlightSummary：走 streamText / 注入 _generate / 报错分支', async () => {
  const events = [
    ...burstEvents({ start: B, count: 6 }),
    ...burstEvents({ start: B + 2000, count: 8, group: 2002, groupName: '第二个群', user: 222, name: '阿狗' }),
  ]
  const { db, cleanup } = await makeArchive(events)
  try {
    const burst = findBursts(db, { ...OPTS, chatKey: 'group:1001' })[0]
    const route = { provider: 'fake', model: 'm' }

    // buildHighlightPrompt 里有群名、条数、参与者、高频词、摘录
    const prompt = buildHighlightPrompt(burst)
    assert.ok(prompt.includes('群聊名场面 · 测试群'))
    assert.ok(prompt.includes('消息：6 条'))
    assert.ok(prompt.includes('阿猫(6)'))
    assert.ok(prompt.includes('打牌(6)'))
    assert.ok(prompt.includes('摘录'))

    const { llm, state } = fakeLlm('这十分钟群里全在刷打牌。')
    const r = await generateHighlightSummary({ db, llm, route, burst })
    assert.deepEqual(r, { summary: '这十分钟群里全在刷打牌。', model: 'fake/m' })
    assert.equal(state.calls, 1)
    assert.equal(state.last.system, HIGHLIGHT_SYSTEM)
    assert.equal(state.last.messages[0].content[0].text, prompt)
    assert.equal(state.last.temperature, 0.7)

    // 模型输出带代码块围栏时清掉
    const fenced = await generateHighlightSummary({ db, llm: fakeLlm('```\n这波很爽\n```').llm, route, burst })
    assert.equal(fenced.summary, '这波很爽')

    // 注入 _generate：返回字符串或 {text} 都行，model 记为 injected
    let seen = null
    const injected = await generateHighlightSummary({
      db,
      llm: null,
      burst,
      _generate: async (ctx) => {
        seen = ctx
        return '注入的摘要'
      },
    })
    assert.deepEqual(injected, { summary: '注入的摘要', model: 'injected' })
    assert.equal(seen.system, HIGHLIGHT_SYSTEM)
    assert.equal(seen.prompt, prompt)
    assert.equal(seen.burst.count, 6)

    const objectOut = await generateHighlightSummary({ db, llm: null, burst, _generate: async () => ({ text: '对象形式' }) })
    assert.equal(objectOut.summary, '对象形式')

    // 模型没吐出内容
    await assert.rejects(generateHighlightSummary({ db, llm: fakeLlm('   ').llm, route, burst }), /没有返回/)
    // 没有 route
    await assert.rejects(generateHighlightSummary({ db, llm: fakeLlm('x').llm, burst }), /没有可用的模型/)
    // 没有 llm
    await assert.rejects(generateHighlightSummary({ db, burst }), /llm 服务不可用/)
  } finally {
    await cleanup()
  }
})

test('runHighlights：全链路 built→skipped→force，list/read 能读回 stats', async () => {
  const events = [
    ...burstEvents({ start: B, count: 6 }),
    ...burstEvents({ start: B + 2000, count: 8, group: 2002, groupName: '第二个群', user: 222, name: '阿狗' }),
  ]
  const { db, cleanup } = await makeArchive(events)
  try {
    const { llm, state } = fakeLlm('这波打牌太激烈了，满屏都是上号。')
    const summary = '这波打牌太激烈了，满屏都是上号。'

    const progress = []
    const r1 = await runHighlights({ db, llm, cfg: {}, ...OPTS, onProgress: (p) => progress.push(p) })
    assert.equal(r1.found, 2)
    assert.equal(r1.built, 2)
    assert.equal(r1.skipped, 0)
    assert.equal(r1.results.length, 2)
    assert.ok(r1.results.every((x) => x.ok === true && x.summary === summary && x.chatKey && x.fromTs > 0))
    assert.equal(r1.results[0].fromDate, isoDate(B + 2000))
    assert.equal(r1.results[1].fromDate, isoDate(B))
    assert.equal(state.calls, 2)
    assert.deepEqual(progress.map((p) => p.done), [1, 2])
    assert.ok(progress.every((p) => p.total === 2 && !p.skipped))

    const list = listHighlights(db)
    assert.equal(list.length, 2)
    // 新的在前：2 条簇从 B+2000 开始，排在前面
    assert.deepEqual(list.map((h) => h.chatKey), ['group:2002', 'group:1001'])
    assert.equal(list[0].chatName, '第二个群')
    assert.equal(list[0].msgCount, 8)
    assert.equal(list[0].summary, summary)
    assert.equal(list[0].model, 'fake/m')
    assert.ok(list[0].createdAt > 0)
    assert.deepEqual(Object.keys(list[0].stats).sort(), ['chatName', 'participants', 'samples', 'topWords'])
    assert.equal(list[0].stats.chatName, '第二个群')
    assert.deepEqual(list[0].stats.participants, [{ userId: '222', name: '阿狗', count: 8 }])
    assert.equal(list[0].stats.samples.length, 8)
    assert.ok(Array.isArray(list[0].stats.topWords) && list[0].stats.topWords.length > 0)

    assert.deepEqual(readHighlight(db, list[0].id), list[0])
    assert.equal(readHighlight(db, 999999), null)
    assert.equal(listHighlights(db, { chatKey: 'group:1001' }).length, 1)
    assert.equal(listHighlights(db, { limit: 1 }).length, 1)

    // 重跑：已有窗口跳过，不再调模型
    const skipProgress = []
    const r2 = await runHighlights({ db, llm, cfg: {}, ...OPTS, onProgress: (p) => skipProgress.push(p) })
    assert.equal(r2.found, 2)
    assert.equal(r2.built, 0)
    assert.equal(r2.skipped, 2)
    assert.ok(r2.results.every((x) => x.ok === true && x.skipped === true))
    assert.equal(state.calls, 2)
    assert.ok(skipProgress.every((p) => p.skipped === true))

    // force：重写已有窗口
    const r3 = await runHighlights({ db, llm, cfg: {}, ...OPTS, force: true })
    assert.equal(r3.built, 2)
    assert.equal(r3.skipped, 0)
    assert.equal(state.calls, 4)
    assert.equal(listHighlights(db).length, 2)
  } finally {
    await cleanup()
  }
})

test('runHighlights：模型抛错时 results 标 ok=false 且不写库，signal 取消直接抛', async () => {
  const events = burstEvents({ start: B, count: 6 })
  const { db, cleanup } = await makeArchive(events)
  try {
    const broken = {
      listProviders: () => [{ id: 'fake' }],
      listModels: async () => [{ id: 'm' }],
      stream() {
        throw new Error('boom')
      },
    }
    const r = await runHighlights({ db, llm: broken, cfg: {}, ...OPTS })
    assert.equal(r.found, 1)
    assert.equal(r.built, 0)
    assert.equal(r.skipped, 0)
    assert.equal(r.results.length, 1)
    assert.equal(r.results[0].ok, false)
    assert.match(r.results[0].error, /boom/)
    assert.deepEqual(listHighlights(db), [])

    await assert.rejects(
      runHighlights({ db, _generate: async () => 'x', signal: { aborted: true }, ...OPTS }),
      /已取消/,
    )
  } finally {
    await cleanup()
  }
})

test('runHighlights：没有可用模型时报错；只注入 _generate 时可以不依赖 llm', async () => {
  const events = burstEvents({ start: B, count: 6 })
  const { db, cleanup } = await makeArchive(events)
  try {
    await assert.rejects(runHighlights({ db, llm: undefined, cfg: {}, ...OPTS }), /没有可用的模型/)
    await assert.rejects(
      runHighlights({ db, llm: { listProviders: () => [], listModels: async () => [] }, cfg: {}, ...OPTS }),
      /没有可用的模型/,
    )
    assert.deepEqual(listHighlights(db), [])

    const r = await runHighlights({ db, llm: undefined, cfg: {}, ...OPTS, _generate: async () => '注入的名场面' })
    assert.equal(r.found, 1)
    assert.equal(r.built, 1)
    const list = listHighlights(db)
    assert.equal(list.length, 1)
    assert.equal(list[0].summary, '注入的名场面')
    assert.equal(list[0].model, 'injected')
  } finally {
    await cleanup()
  }
})
