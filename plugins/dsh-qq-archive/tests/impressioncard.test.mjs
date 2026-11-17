import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArchive, insertBatch } from '../lib/db.mjs'
import { readImpressionCard, saveImpression } from '../lib/impression.mjs'
import { apply } from '../index.js'

/**
 * qq_impression：只读缓存的人物印象。
 *
 * 这份测试盯四件容易坏的事：
 * 1. 有印象 / 没印象 / 认错人三种结果字段和 summary 的说法；
 * 2. chat 作用域只收窄「这人是谁」，不会去读另一份印象；
 * 3. 只读性：不写库、不调模型、不把聊天原文带出去；
 * 4. 工具注册与 doSync 自动刷新 people.json 的接线。
 */

const T0 = 1767000000

function rec(chatKey, chatName, senderId, senderName, text, ts) {
  const [chatType, chatId] = chatKey.split(':')
  return {
    message: {
      source: 'test',
      sourceKey: `${chatKey}:${ts}:${senderId}`,
      chatKey,
      chatType,
      chatId,
      chatName,
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

/** 造两个群、五个人：有印象的、没攒够的、同名的、只在别群说话的、根本不存在的。 */
function makeRecords() {
  const rows = []
  const push = (chatKey, chatName, id, name, texts) => {
    texts.forEach((text, i) => rows.push(rec(chatKey, chatName, id, name, text, T0 + rows.length * 60 + i)))
  }
  push('group:1001', '测试群', '11111', '阿甲', [
    '今天下午三点在牌店打牌',
    '有人来打牌吗',
    '我带新卡组',
    '这句是完整原文不该被返回',
    '打完去吃夜宵',
    '夜宵就吃烧烤',
  ])
  push('group:2002', '二群', '22222', '小乙', ['二群晚上开黑吗', '我来', '等我十分钟'])
  push('group:1001', '测试群', '33333', '小明', ['老板这个能便宜点吗', '再少五块'])
  push('group:2002', '二群', '44444', '小明', ['看我转的梗图', '笑死'])
  push('group:1001', '测试群', '55555', '阿丙', ['冒个泡', '继续潜水'])
  return rows
}

function seed(archive) {
  insertBatch(archive.db, archive, makeRecords())
  saveImpression(archive.db, '11111', {
    impression: '阿甲是群里的牌佬，下午基本泡在牌店，打完牌还要吃夜宵。',
    tags: ['牌佬', '夜猫子'],
    model: 'fake/model',
  })
  saveImpression(archive.db, '22222', { impression: '小乙只在二群活跃，喜欢接话。', tags: ['二群'], model: 'fake/model' })
  saveImpression(archive.db, '44444', { impression: '二群的小明，喜欢转发梗图。', tags: ['梗图'], model: 'fake/model' })
  // 老版本可能把整段 JSON 写进 impression 列，读的时候要拆回文字
  archive.db
    .prepare(
      `insert into profiles (chat_key, user_id, impression, impression_at, tags, model)
       values ('*', '33333', ?, ?, '[]', 'old/model')`,
    )
    .run('{"impression":"一群的小明，讲价一把好手。","tags":["砍价"]}', 1766000000)
}

async function withArchive(fn) {
  const home = await mkdtemp(join(tmpdir(), 'qqa-impcard-'))
  const archive = openArchive(home)
  try {
    seed(archive)
    await fn(archive, home)
  } finally {
    archive.db.close()
    await rm(home, { recursive: true, force: true })
  }
}

test('readImpressionCard：有缓存印象时给全字段和可当素材的 summary', () =>
  withArchive(({ db }) => {
    const r = readImpressionCard(db, { user: '11111' })

    assert.equal(r.ok, true)
    assert.equal(r.found, true)
    assert.match(r.impression, /牌佬/)
    assert.deepEqual(r.tags, ['牌佬', '夜猫子'])
    assert.equal(typeof r.at, 'number')
    assert.equal(r.model, 'fake/model')

    assert.equal(r.person.userId, '11111')
    assert.ok(r.person.names.includes('阿甲'))
    assert.equal(r.person.chatKey, null)
    assert.equal(r.person.chatMsgs, 6)
    assert.ok(r.person.topWords.length > 0)
    assert.ok(r.person.topWords.every((w) => typeof w === 'string'))
    assert.ok(r.person.hours.every((h) => typeof h === 'string'))

    assert.match(r.summary, /档案馆里记着/)
    assert.match(r.summary, /阿甲（QQ 11111）/)
    assert.match(r.summary, /牌佬 \/ 夜猫子/)
    assert.match(r.summary, /没有重新生成/)
    // 不返回聊天原文，也不返回 profile（profile.summary 里有最近发言）
    assert.ok(!JSON.stringify(r).includes('这句是完整原文不该被返回'))
    assert.equal(r.profile, undefined)
    assert.equal(r.recent, undefined)
  }))

test('readImpressionCard：有发言但还没攒够印象时 found=false，明确让模型别编', () =>
  withArchive(({ db }) => {
    const r = readImpressionCard(db, { user: '55555' })

    assert.equal(r.ok, true)
    assert.equal(r.found, false)
    assert.equal(r.impression, undefined)
    assert.equal(r.ambiguous, undefined)
    assert.equal(r.person.userId, '55555')
    assert.equal(r.person.chatMsgs, 2)
    assert.match(r.summary, /还没攒够/)
    assert.match(r.summary, /照实说，别编/)
    assert.match(r.summary, /阿丙（QQ 55555）/)
  }))

test('readImpressionCard：归档里根本没这个人时 found=false', () =>
  withArchive(({ db }) => {
    const r = readImpressionCard(db, { user: '99999' })

    assert.equal(r.ok, true)
    assert.equal(r.found, false)
    assert.match(r.summary, /档案馆里还没攒够/)
    assert.match(r.summary, /归档里找不到 QQ 99999/)
    // 不能拼成 “QQ 99999（QQ 99999）”
    assert.ok(!r.summary.includes('（QQ 99999）'))
  }))

test('readImpressionCard：同名多号返回候选，不瞎挑一个', () =>
  withArchive(({ db }) => {
    const r = readImpressionCard(db, { user: '小明' })

    assert.equal(r.ok, true)
    assert.equal(r.found, false)
    assert.equal(r.ambiguous, true)
    assert.equal(r.person, undefined)
    assert.deepEqual(
      r.candidates.map((c) => c.userId).sort(),
      ['33333', '44444'],
    )
    assert.match(r.summary, /能对上 2 个人/)
    assert.match(r.summary, /33333/)
    assert.match(r.summary, /44444/)
  }))

test('readImpressionCard：chat 作用域收窄同名候选，也过滤掉没在该群说话的人', () =>
  withArchive(({ db }) => {
    // 「小明」在两个群各有一个，限定测试群后只剩 33333；脏 JSON 印象被拆回文字
    const scoped = readImpressionCard(db, { user: '小明', chatKey: 'group:1001' })
    assert.equal(scoped.found, true)
    assert.equal(scoped.person.userId, '33333')
    assert.equal(scoped.person.chatKey, 'group:1001')
    assert.equal(scoped.person.chatMsgs, 2)
    assert.equal(scoped.impression, '一群的小明，讲价一把好手。')
    assert.deepEqual(scoped.tags, ['砍价'])
    assert.match(scoped.summary, /只在「测试群」里看了 TA 的 2 条发言/)

    // 小乙只活在二群，拿测试群去查应该查不到，而不是把二群的他报出来
    const miss = readImpressionCard(db, { user: '22222', chatKey: 'group:1001' })
    assert.equal(miss.found, false)
    assert.equal(miss.person, undefined)
    assert.match(miss.summary, /没人在「测试群」说过话/)
    assert.ok(!miss.summary.includes('在在'))
  }))

test('readImpressionCard：只读——只有 select，不改 impression_at', () =>
  withArchive(({ db }) => {
    const writes = []
    const guarded = new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql) => {
            if (!/^\s*select\b/i.test(sql)) {
              writes.push(String(sql).slice(0, 80))
              throw new Error(`只读工具执行了写库 SQL：${sql}`)
            }
            return target.prepare(sql)
          }
        }
        if (prop === 'exec') {
          return () => {
            writes.push('exec')
            throw new Error('只读工具执行了 exec')
          }
        }
        const value = target[prop]
        return typeof value === 'function' ? value.bind(target) : value
      },
      set() {
        writes.push('set')
        return false
      },
    })

    const before = db
      .prepare("select impression_at from profiles where chat_key = '*' and user_id = '11111'")
      .get().impression_at
    const r = readImpressionCard(guarded, { user: '11111' })
    const after = db
      .prepare("select impression_at from profiles where chat_key = '*' and user_id = '11111'")
      .get().impression_at

    assert.equal(r.found, true)
    assert.deepEqual(writes, [])
    assert.equal(after, before)
  }))

test('readImpressionCard：同步纯函数，实现里不碰模型客户端', () => {
  // 同步函数不可能 await 一次模型调用；再做一层源码断言，防止以后偷偷改成生成
  assert.equal(readImpressionCard.constructor.name, 'Function')
  const body = readImpressionCard.toString()
  assert.doesNotMatch(body, /generateImpression|generateText|pickRoute|listRoutes|getLlm|fetch\(/)
})

test('qq_impression 工具：注册参数、execute 的三种结果、只读不走 LLM', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qqa-impcard-tool-'))
  const archive = openArchive(home)
  seed(archive)
  archive.db.close()

  const toolDefs = new Map()
  const disposers = []
  let llmTouched = 0
  const ctx = {
    logger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
    tools: {
      register(def) {
        toolDefs.set(def.name, def)
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    get() {
      llmTouched++
      throw new Error('qq_impression 不该碰 LLM 服务')
    },
    webServer: null,
  }

  // 压掉启动时那个 1500ms 的同步定时器，测试里不需要真的同步
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = () => ({ unref() {} })
  try {
    apply(ctx, { home, syncIntervalMin: 0 })
  } finally {
    globalThis.setTimeout = realSetTimeout
  }

  try {
    const tool = toolDefs.get('qq_impression')
    assert.ok(tool, 'qq_impression 应该注册了')
    assert.deepEqual(tool.parameters.required, ['user'])
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['chat', 'user'])
    assert.ok(tool.timeoutMs <= 60000)
    assert.equal(tool.output.render({}, { summary: '测试摘要' })[0].text, '测试摘要')

    const hit = await tool.execute({ user: '11111' })
    assert.equal(hit.found, true)
    assert.match(hit.summary, /阿甲/)
    assert.equal(tool.output.render({}, hit)[0].text, hit.summary)

    const miss = await tool.execute({ user: '55555' })
    assert.equal(miss.found, false)
    assert.match(miss.summary, /还没攒够/)

    const empty = await tool.execute({ user: '   ' })
    assert.equal(empty.ok, false)
    assert.match(empty.error, /user 不能为空/)

    // chat 支持群名片段，走 resolveChatKey
    const byName = await tool.execute({ user: '33333', chat: '测试群' })
    assert.equal(byName.found, true)
    assert.equal(byName.person.chatKey, 'group:1001')

    const badChat = await tool.execute({ user: '11111', chat: '不存在的群xyz' })
    assert.equal(badChat.ok, false)
    assert.match(badChat.error, /没找到会话/)

    assert.equal(llmTouched, 0, 'execute 不该调 ctx.get / LLM')
  } finally {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        /* 清理失败不影响断言 */
      }
    }
    await rm(home, { recursive: true, force: true })
  }
})

test('doSync 成功后自动刷新 people.json，失败只记日志', async () => {
  const source = await readFile(new URL('../lib/runtime.mjs', import.meta.url), 'utf8')

  // 触发点：手动 sync、定时同步、启动同步都走 doSync，所以刷新放在 board.prewarm() 后面一处就够
  assert.match(source, /board\.prewarm\(\)\s*\n\s*\/\/ 同步成功就顺手刷一遍熟人卡[\s\S]{0,80}?refreshPeopleCard\(arch\)/)

  const start = source.indexOf('function refreshPeopleCard')
  assert.ok(start > 0, '应该有 refreshPeopleCard helper')
  const helper = source.slice(start, start + 700)
  assert.match(helper, /exportPeopleCard\(arch\.db, \{ home: cfg\.home \}\)/)
  assert.match(helper, /catch/)
  assert.match(helper, /log\.warn/)
})
