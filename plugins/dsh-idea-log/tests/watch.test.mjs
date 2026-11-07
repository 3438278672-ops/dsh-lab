import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addIdea,
  awaitingIdeas,
  bindIdeaSession,
  confirmIdeaDone,
  dismissIdeaDone,
  ideaBySession,
  listIdeas,
  markTurnDone,
  openIdeas,
  updateIdea,
} from '../lib/db.mjs'
import { createCompletionWatcher, parseIdeaMarker, userMessageText } from '../lib/watch.mjs'

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'idea-watch-'))
  const a = openIdeas(dir)
  return { ...a, dir, cleanup: () => { a.db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('从消息里认出「【灵感账本 #N ·」标记，只认用户手打的消息', () => {
  assert.equal(parseIdeaMarker('【灵感账本 #15 · 改进点】\n标题在这里'), 15)
  assert.equal(parseIdeaMarker('【灵感账本#7·插件点子】'), 7)
  assert.equal(parseIdeaMarker('随便聊聊'), null)

  const ev = (data) => ({ type: 'user/message', data })
  assert.equal(
    userMessageText(ev({ content: [{ type: 'text', text: '开工吧' }] })),
    '开工吧',
  )
  // runtime-context 不是人打的
  assert.equal(userMessageText(ev({ source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'x' }] })), '')
  // 非 user/message 事件、非文本块
  assert.equal(userMessageText({ type: 'assistant/message', data: { content: [{ type: 'text', text: 'x' }] } }), '')
  assert.equal(userMessageText(ev({ content: [{ type: 'image' }] })), '')
})

test('绑定、跑完一轮、确认/收起：DB 状态都守得住', () => {
  const t = freshDb()
  try {
    const r = addIdea(t.db, { title: '把看板改成增量', status: 'incubating' })
    const id = r.id

    bindIdeaSession(t.db, id, 'sess-1')
    const got = ideaBySession(t.db, 'sess-1')
    assert.equal(got.id, id)
    assert.equal(got.sessionId, 'sess-1')

    markTurnDone(t.db, id, 1234)
    assert.equal(awaitingIdeas(t.db).length, 1)
    assert.equal(awaitingIdeas(t.db)[0].id, id)
    assert.equal(listIdeas(t.db, { status: 'incubating' })[0].turnDoneAt, 1234)

    dismissIdeaDone(t.db, id)
    assert.equal(awaitingIdeas(t.db).length, 0)
    assert.equal(listIdeas(t.db, { status: 'incubating' })[0].awaitingDone, false)

    markTurnDone(t.db, id, 2000)
    confirmIdeaDone(t.db, id)
    assert.equal(listIdeas(t.db, { status: 'done' }).length, 1)
    assert.equal(awaitingIdeas(t.db).length, 0)

    // 状态被手动改掉时，等确认的提示也顺手清掉
    const r2 = addIdea(t.db, { title: '第二条', status: 'incubating' })
    markTurnDone(t.db, r2.id, 3000)
    assert.equal(awaitingIdeas(t.db).length, 1)
    updateIdea(t.db, { id: r2.id, status: 'parked' })
    assert.equal(awaitingIdeas(t.db).length, 0)

    // 只有孵化中的条目光能被绑
    const r3 = addIdea(t.db, { title: '还只是待看', status: 'new' })
    assert.equal(bindIdeaSession(t.db, r3.id, 'sess-2'), null)
    assert.equal(ideaBySession(t.db, 'sess-2'), null)
  } finally {
    t.cleanup()
  }
})

test('watcher：时间窗绑新对话，按标记纠正，status 变空闲就等确认', () => {
  const t = freshDb()
  try {
    const r = addIdea(t.db, { title: '孵化中的一条', status: 'incubating' })
    const id = r.id
    const handlers = new Map()
    const ctx = {
      on(name, fn) {
        handlers.set(name, fn)
        return () => handlers.delete(name)
      },
      get(name) {
        if (name === 'agents') return { get: () => ({ status: 'running' }) }
        return undefined
      },
    }
    const watcher = createCompletionWatcher(ctx, { home: t.dir })
    try {
      watcher.startPending(id)
      handlers.get('session/created')({ id: 'sess-a' })
      assert.equal(ideaBySession(t.db, 'sess-a').id, id)

      // 用户把任务真的发出去：标记一致，不再改绑
      handlers.get('session/event')(
        { id: 'sess-a' },
        { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '【灵感账本 #' + id + ' · 改进点】 干活' }] } },
      )
      assert.equal(ideaBySession(t.db, 'sess-a').id, id)

      handlers.get('api-session/status')('sess-a', true)
      handlers.get('api-session/status')('sess-a', false)
      assert.equal(awaitingIdeas(t.db).length, 1)
      assert.equal(awaitingIdeas(t.db)[0].id, id)
    } finally {
      watcher.dispose()
    }
  } finally {
    t.cleanup()
  }
})

test('watcher：打开旧对话接着聊，历史里的任务书标记也能把它绑回来', () => {
  const t = freshDb()
  try {
    const r = addIdea(t.db, { title: '功能上线前就开着的对话', status: 'incubating' })
    const id = r.id
    const handlers = new Map()
    const ctx = {
      on(name, fn) { handlers.set(name, fn); return () => {} },
      get(name) {
        if (name === 'agents') return { get: () => ({ status: 'running' }) }
        return undefined
      },
    }
    // 这条会话是「开工」功能上线前开的：没有时间窗，也没有 session_id。
    // 用户这次只补了一句“继续”，标记只在历史的第一条任务书里。
    const oldSession = {
      id: 'sess-old',
      ownEvents: () => [
        { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `【灵感账本 #${id} · 改进点】 原来的任务` }] } },
      ],
    }
    const watcher = createCompletionWatcher(ctx, { home: t.dir })
    try {
      handlers.get('session/event')(oldSession, {
        type: 'user/message',
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] },
      })
      assert.equal(ideaBySession(t.db, 'sess-old').id, id)

      handlers.get('api-session/status')('sess-old', true)
      handlers.get('api-session/status')('sess-old', false)
      assert.equal(awaitingIdeas(t.db).length, 1)
      assert.equal(awaitingIdeas(t.db)[0].id, id)
    } finally {
      watcher.dispose()
    }
  } finally {
    t.cleanup()
  }
})

test('watcher：时间窗绑错时，以对话里的标记为准改绑', () => {
  const t = freshDb()
  try {
    const a = addIdea(t.db, { title: '条目 A', status: 'incubating' })
    const b = addIdea(t.db, { title: '条目 B', status: 'incubating' })
    const handlers = new Map()
    const ctx = {
      on(name, fn) { handlers.set(name, fn); return () => {} },
      get() { return undefined },
    }
    const watcher = createCompletionWatcher(ctx, { home: t.dir })
    try {
      watcher.startPending(a.id)
      handlers.get('session/created')({ id: 'sess-x' })
      assert.equal(ideaBySession(t.db, 'sess-x').id, a.id)

      // 用户在 sess-x 里发的是 B 的任务书：以标记为准，A 解绑、B 绑上
      handlers.get('session/event')(
        { id: 'sess-x' },
        { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '【灵感账本 #' + b.id + ' · 改进点】 B 的任务' }] } },
      )
      assert.equal(ideaBySession(t.db, 'sess-x').id, b.id)
      assert.equal(listIdeas(t.db, { status: 'incubating' }).find((x) => x.id === a.id).sessionId, null)

      // 真对话在别处开出来：标记把条目从绑错的会话上抢回来
      handlers.get('session/event')(
        { id: 'sess-real' },
        { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '【灵感账本 #' + a.id + ' · 改进点】 A 的任务' }] } },
      )
      assert.equal(ideaBySession(t.db, 'sess-real').id, a.id)
      // sess-x 上留给 B，A 已经从绑错的会话上摘干净了
      assert.equal(ideaBySession(t.db, 'sess-x').id, b.id)
      assert.equal(listIdeas(t.db, { status: 'incubating' }).find((x) => x.id === a.id).sessionId, 'sess-real')
    } finally {
      watcher.dispose()
    }
  } finally {
    t.cleanup()
  }
})
