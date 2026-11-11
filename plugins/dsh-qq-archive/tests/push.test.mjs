import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArchive, getMeta } from '../lib/db.mjs'
import {
  DEFAULT_BRIDGE_URL,
  readBridgeConfig,
  sendPrivate,
  pushReport,
  splitPushText,
  effectivePushSettings,
  setPushSettings,
  pushStatus,
  applyPushUpdate,
  recordPushResult,
} from '../lib/push.mjs'

/** 假 fetch：记录每次 url/init，按 handler 返回响应（不联网）。 */
function fakeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init, calls.length)
  }
  return { calls, fetchImpl }
}

function res(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data }
}

test('readBridgeConfig: config 优先，纯数字 target 按私聊，baseUrl 去尾斜杠', () => {
  const cfg = { push: { baseUrl: 'http://127.0.0.1:9999/', token: 'tk', target: '2220222310' } }
  assert.deepEqual(readBridgeConfig(cfg), {
    baseUrl: 'http://127.0.0.1:9999',
    token: 'tk',
    target: 'private:2220222310',
  })
  // 关掉本机桥接探测，才能在测试里断言「什么都没配」的缺省值
  const off = { push: { discover: false } }
  assert.deepEqual(readBridgeConfig({ push: { ...off.push, target: 'group:456' } }), {
    baseUrl: DEFAULT_BRIDGE_URL,
    token: '',
    target: 'group:456',
  })
  assert.deepEqual(readBridgeConfig(off), { baseUrl: DEFAULT_BRIDGE_URL, token: '', target: '' })
  assert.deepEqual(readBridgeConfig(undefined), { baseUrl: DEFAULT_BRIDGE_URL, token: '', target: '' })
})

test('readBridgeConfig: 自动探测本机桥接（端口 / 白名单私聊号 / console-token）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-archive-bridge-'))
  const old = process.env.QQ_BRIDGE_HOME
  try {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ consolePort: 3999, allow: { private: [2220222310], groups: [1] } }),
      'utf8',
    )
    await mkdir(join(dir, 'state'), { recursive: true })
    await writeFile(join(dir, 'state', 'console-token'), 'tk-from-state\n', 'utf8')
    process.env.QQ_BRIDGE_HOME = dir
    assert.deepEqual(readBridgeConfig({ push: { discover: true } }), {
      baseUrl: 'http://127.0.0.1:3999',
      token: 'tk-from-state',
      target: 'private:2220222310',
    })
  } finally {
    if (old === undefined) delete process.env.QQ_BRIDGE_HOME
    else process.env.QQ_BRIDGE_HOME = old
    await rm(dir, { recursive: true, force: true })
  }
})

test('readBridgeConfig: token 空时读 tokenFile（含 BOM 也能读）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-archive-push-'))
  try {
    const tokenFile = join(dir, 'token.txt')
    await writeFile(tokenFile, '\ufeffconsole-token-123\n', 'utf8')
    assert.equal(readBridgeConfig({ push: { tokenFile } }).token, 'console-token-123')
    // config 里直接配了 token 就以它为准
    assert.equal(readBridgeConfig({ push: { token: 'direct', tokenFile } }).token, 'direct')
    // 文件不存在不炸
    assert.equal(readBridgeConfig({ push: { tokenFile: join(dir, 'nope.txt') } }).token, '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sendPrivate: 请求形状（test-send 端点 / 头 / body）', async () => {
  const f = fakeFetch(() => res(200, { ok: true }))
  const r = await sendPrivate({
    baseUrl: 'http://127.0.0.1:3100/',
    token: 'tk',
    userId: 'private:2220222310',
    message: '你好',
    fetchImpl: f.fetchImpl,
  })
  assert.equal(r.ok, true)
  assert.equal(r.status, 200)
  assert.deepEqual(r.data, { ok: true })

  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, 'http://127.0.0.1:3100/api/test-send')
  assert.equal(f.calls[0].init.method, 'POST')
  assert.equal(f.calls[0].init.headers['x-console-token'], 'tk')
  assert.equal(f.calls[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { kind: 'private', id: 2220222310, message: '你好' })
})

test('sendPrivate: 桥接拒绝和网络错误都不抛', async () => {
  const denied = fakeFetch(() => res(403, { ok: false, error: '目标不在白名单' }))
  const r1 = await sendPrivate({ baseUrl: 'http://x', token: 'tk', userId: '222', message: 'hi', fetchImpl: denied.fetchImpl })
  assert.equal(r1.ok, false)
  assert.equal(r1.status, 403)
  assert.equal(r1.data.error, '目标不在白名单')

  const network = fakeFetch(() => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:3100')
  })
  const r2 = await sendPrivate({ baseUrl: 'http://x', token: 'tk', userId: '222', message: 'hi', fetchImpl: network.fetchImpl })
  assert.equal(r2.ok, false)
  assert.match(r2.error, /ECONNREFUSED/)

  // HTTP 200 但 body 里 ok:false（桥接偶尔这么返回）
  const softFail = fakeFetch(() => res(200, { ok: false, error: '消息含敏感信息，已阻止发送' }))
  const r3 = await sendPrivate({ baseUrl: 'http://x', token: 'tk', userId: '222', message: 'hi', fetchImpl: softFail.fetchImpl })
  assert.equal(r3.ok, false)
  assert.match(r3.error, /敏感信息/)

  assert.equal((await sendPrivate({ baseUrl: '', userId: '222', message: 'hi' })).ok, false)
  const noToken = await sendPrivate({ baseUrl: 'http://x', userId: '222', message: 'hi', fetchImpl: denied.fetchImpl })
  assert.equal(noToken.ok, false)
  assert.match(noToken.error, /令牌/)
  const badUid = await sendPrivate({ baseUrl: 'http://x', token: 'tk', userId: 'abc', message: 'hi', fetchImpl: denied.fetchImpl })
  assert.equal(badUid.ok, false)
  assert.match(badUid.error, /不是数字/)
})

test('pushReport: 标题 + 正文私聊发一条', async () => {
  const f = fakeFetch(() => res(200, { ok: true }))
  const cfg = { push: { baseUrl: 'http://127.0.0.1:3100', token: 'tk', target: '2220222310' } }
  const r = await pushReport(cfg, {
    date: '2026-11-11',
    chatKey: 'group:123',
    chatName: '测试群',
    text: '## 今天聊了什么\n打牌。',
    fetchImpl: f.fetchImpl,
  })
  assert.equal(r.ok, true)
  assert.equal(r.target, 'private:2220222310')
  assert.equal(r.parts, 1)
  assert.equal(f.calls.length, 1)
  const body = JSON.parse(f.calls[0].init.body)
  assert.equal(body.id, 2220222310)
  assert.match(body.message, /2026-11-11/)
  assert.match(body.message, /测试群/)
  assert.match(body.message, /日报/)
  assert.match(body.message, /打牌/)
})

test('splitPushText: 段落装得下按段落切，装不下按字数均匀切', () => {
  assert.deepEqual(splitPushText('短消息'), ['短消息'])
  const paras = ['甲'.repeat(700), '乙'.repeat(700), '丙'.repeat(700)]
  const byPara = splitPushText(paras.join('\n\n'))
  assert.equal(byPara.length, 2)
  assert.ok(byPara[0].includes('甲'.repeat(700)) && byPara[0].includes('乙'.repeat(700)))
  assert.ok(byPara[1].includes('丙'.repeat(700)))

  const longText = '长'.repeat(5000)
  const even = splitPushText(longText)
  assert.equal(even.length, 3)
  assert.ok(even.every((p) => p.length <= 1800))
  assert.equal(even.join('').match(/长/g).length, 5000)

  // 更长的才截断，而且只截最后一条、带省略号
  const tooLong = splitPushText('字'.repeat(6000))
  assert.equal(tooLong.length, 3)
  assert.ok(tooLong[2].endsWith('…'))
})

test('pushReport: 超长正文切最多 3 条，每条不超 1800 字，内容不丢', async () => {
  const f = fakeFetch(() => res(200, { ok: true }))
  const cfg = { push: { target: '2220222310', token: 'tk' } }
  const r = await pushReport(cfg, {
    date: '2026-11-11',
    chatName: '测试群',
    text: '长'.repeat(5000),
    fetchImpl: f.fetchImpl,
  })
  assert.equal(r.ok, true)
  assert.equal(r.parts, 3)
  assert.equal(f.calls.length, 3)
  const messages = f.calls.map((c) => JSON.parse(c.init.body).message)
  for (const m of messages) assert.ok(m.length <= 1800, `单条 ${m.length} 字超上限`)
  assert.equal(messages.join('').match(/长/g).length, 5000)
})

test('pushReport: 多段落按段落边界切成两条', async () => {
  const f = fakeFetch(() => res(200, { ok: true }))
  const cfg = { push: { target: '2220222310', token: 'tk' } }
  const text = ['甲'.repeat(700), '乙'.repeat(700), '丙'.repeat(700)].join('\n\n')
  const r = await pushReport(cfg, { date: '2026-11-11', chatName: '测试群', text, fetchImpl: f.fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(r.parts, 2)
  const messages = f.calls.map((c) => JSON.parse(c.init.body).message)
  assert.ok(messages[0].includes('甲'.repeat(700)))
  assert.ok(messages[0].includes('乙'.repeat(700)))
  assert.ok(messages[1].includes('丙'.repeat(700)))
  for (const m of messages) assert.ok(m.length <= 1800)
})

test('pushReport: 中途某条失败就停下，returns parts 为已发条数', async () => {
  const f = fakeFetch((url, init, n) => (n === 1 ? res(200, { ok: true }) : res(500, { ok: false, error: 'boom' })))
  const cfg = { push: { target: '2220222310', token: 'tk' } }
  const text = ['甲'.repeat(700), '乙'.repeat(700), '丙'.repeat(700)].join('\n\n')
  const r = await pushReport(cfg, { date: '2026-11-11', text, fetchImpl: f.fetchImpl })
  assert.equal(r.ok, false)
  assert.equal(r.parts, 1)
  assert.equal(f.calls.length, 2)
  assert.match(r.error, /第 2 条/)
  assert.match(r.error, /boom/)
})

test('pushReport: 只支持私聊目标，纯数字也算私聊', async () => {
  const group = await pushReport({ push: { target: 'group:456' } }, { text: 'hi' })
  assert.equal(group.ok, false)
  assert.match(group.error, /只支持私聊/)

  const none = await pushReport({}, { text: 'hi' })
  assert.equal(none.ok, false)
  assert.match(none.error, /没有配置推送目标/)

  const f = fakeFetch(() => res(200, { ok: true }))
  const numeric = await pushReport({ push: { target: '2220222310', token: 'tk' } }, { text: 'hi', fetchImpl: f.fetchImpl })
  assert.equal(numeric.ok, true)
  assert.equal(numeric.target, 'private:2220222310')
  assert.equal(JSON.parse(f.calls[0].init.body).id, 2220222310)
})

test('effectivePushSettings / setPushSettings: meta 覆盖 config', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qq-archive-push-'))
  const archive = openArchive(home)
  try {
    // 什么配置都没有：默认关闭、baseUrl 本机默认端口、token 没准备、只推汇总
    assert.deepEqual(effectivePushSettings(archive.db, {}), {
      enabled: false,
      target: '',
      baseUrl: DEFAULT_BRIDGE_URL,
      tokenReady: false,
      scope: 'digest',
    })

    const cfg = { push: { enabled: false, baseUrl: 'http://127.0.0.1:9999', target: '2220222310', token: 'tk' } }
    assert.deepEqual(effectivePushSettings(archive.db, cfg), {
      enabled: false,
      target: 'private:2220222310',
      baseUrl: 'http://127.0.0.1:9999',
      tokenReady: true,
      scope: 'digest',
    })

    setPushSettings(archive.db, { enabled: true })
    let eff = effectivePushSettings(archive.db, cfg)
    assert.equal(eff.enabled, true)
    assert.equal(eff.target, 'private:2220222310')
    assert.equal(getMeta(archive.db, 'push_enabled'), '1')

    setPushSettings(archive.db, { target: '333444555' })
    eff = effectivePushSettings(archive.db, cfg)
    assert.equal(eff.target, 'private:333444555')
    assert.equal(getMeta(archive.db, 'push_target'), 'private:333444555')

    setPushSettings(archive.db, { enabled: false })
    eff = effectivePushSettings(archive.db, cfg)
    assert.equal(eff.enabled, false)
    assert.equal(eff.target, 'private:333444555')
  } finally {
    archive.db.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('pushStatus / applyPushUpdate: 看板开关的读写与输入校验', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qq-archive-push-'))
  const archive = openArchive(home)
  const cfg = {
    push: { discover: false, baseUrl: 'http://127.0.0.1:9999', token: 'tk', target: '2220222310', enabled: false },
  }
  try {
    let s = pushStatus(archive.db, cfg)
    assert.equal(s.enabled, false)
    assert.equal(s.target, 'private:2220222310')
    assert.equal(s.scope, 'digest')
    assert.equal(s.lastAt, 0)
    assert.equal(s.lastResult, '')

    s = applyPushUpdate(archive.db, cfg, { enabled: true, scope: 'digest' })
    assert.equal(s.enabled, true)
    assert.equal(s.scope, 'digest')
    assert.equal(getMeta(archive.db, 'push_enabled'), '1')

    s = applyPushUpdate(archive.db, cfg, { scope: 'all', target: '333444555' })
    assert.equal(s.scope, 'all')
    assert.equal(s.target, 'private:333444555')
    assert.equal(getMeta(archive.db, 'push_scope'), 'all')

    // 非法输入一律拒绝，别把看板表单的脏值写进库里
    assert.throws(() => applyPushUpdate(archive.db, cfg, { enabled: 'yes' }), /true \/ false/)
    assert.throws(() => applyPushUpdate(archive.db, cfg, { scope: 'week' }), /digest 或 all/)
    assert.throws(() => applyPushUpdate(archive.db, cfg, { target: 'group:123456' }), /只支持私聊/)
    assert.throws(() => applyPushUpdate(archive.db, cfg, {}), /没有要改的字段/)

    recordPushResult(archive.db, { ok: true, text: '测试消息 → private:333444555' })
    s = pushStatus(archive.db, cfg)
    assert.ok(s.lastAt > 0)
    assert.equal(s.lastResult, 'ok 测试消息 → private:333444555')
  } finally {
    archive.db.close()
    await rm(home, { recursive: true, force: true })
  }
})
