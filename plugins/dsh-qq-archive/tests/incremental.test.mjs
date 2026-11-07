/**
 * 看板增量构建：快照复用、脏群判定、@ 索引、指纹与自愈。
 *
 * 这些测试都在临时目录里跑（真库在 ~/.dsh/qq-archive，不能拿来当试验田）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, existsSync, openSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBoard } from '../lib/board.mjs'
import { buildBoardData } from '../lib/dashboard.mjs'
import { openArchive, insertBatch } from '../lib/db.mjs'
import { buildMentionIndex, mentionsFor } from '../lib/mentions.mjs'
import { normalizeOneBot } from '../lib/normalize.mjs'
import { saveReport } from '../lib/report.mjs'
import { CACHE_FILE, dbFingerprint, loadSnapshot, writeFileAtomic } from '../lib/snapshot.mjs'

const T = Math.floor(Date.now() / 1000) - 7200

function ev({ time, text, user, name, group, groupName = '测试群' }) {
  return {
    time,
    self_id: 99999,
    post_type: 'message',
    message_type: 'group',
    group_id: group,
    group_name: groupName,
    user_id: user,
    message_id: time * 1000 + (user % 1000),
    sender: { user_id: user, nickname: name },
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
  }
}

function add(archive, prefix, list) {
  insertBatch(
    archive.db,
    archive,
    list.map((data, i) => normalizeOneBot({ source: 'json', sourceKey: `${prefix}-${i}`, data })),
  )
}

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'qq-archive-inc-'))
  const archive = openArchive(home)
  const msgs = []
  // 甲群：10001 说得最多，10002 次之，10005 只冒过两次泡
  for (let i = 0; i < 12; i++)
    msgs.push(ev({ time: T + i, text: `今天打牌吗 第${i}局`, user: 10001, name: 'A甲', group: 1111 }))
  for (let i = 0; i < 6; i++)
    msgs.push(ev({ time: T + 20 + i, text: `牌店见 我带了卡组${i}`, user: 10002, name: 'B乙', group: 1111 }))
  msgs.push(ev({ time: T + 40, text: '冒个泡', user: 10005, name: 'E戊', group: 1111 }))
  msgs.push(ev({ time: T + 41, text: '继续潜水', user: 10005, name: 'E戊', group: 1111 }))
  // 乙群：10003 / 10004，和甲群没有交集
  for (let i = 0; i < 8; i++)
    msgs.push(ev({ time: T + 60 + i, text: `乙群夜聊 ${i}`, user: 10003, name: 'C丙', group: 2222, groupName: '乙群' }))
  for (let i = 0; i < 4; i++)
    msgs.push(ev({ time: T + 80 + i, text: `乙群打牌 ${i}`, user: 10004, name: 'D丁', group: 2222, groupName: '乙群' }))
  add(archive, 'base', msgs)

  archive.db
    .prepare('insert into profiles (chat_key, user_id, stats, impression, impression_at, tags, model) values (?,?,?,?,?,?,?)')
    .run('*', '10001', '{}', '甲群里最爱组局的人', T, '["牌友"]', 'fake/model')
  return { home, archive, db: archive.db }
}

async function cleanup(home, archive) {
  try {
    archive?.db?.close()
  } catch {
    /* 已经关了 */
  }
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

test('增量：没有新消息时零重算，没变的群原样复用', async () => {
  const { home, archive, db } = await setup()
  try {
    const b1 = buildBoardData(db, {})
    assert.equal(b1.stats.rebuiltChats, 2)
    assert.ok(b1.stats.rebuiltProfiles > 0)
    const b2 = buildBoardData(db, { snapshot: b1.snapshot })
    assert.equal(b2.stats.rebuiltChats, 0)
    assert.equal(b2.stats.rebuiltProfiles, 0)
    assert.equal(b2.stats.reusedChats, 2)
    assert.deepEqual(b2.data.peopleByChat['group:2222'], b1.data.peopleByChat['group:2222'])
    assert.deepEqual(b2.data.peopleByChat['*'], b1.data.peopleByChat['*'])
    // 印象和标签是装配时贴上去的，复用之后仍然在
    const a = b2.data.peopleByChat['group:1111'].find((p) => p.userId === '10001')
    assert.equal(a.impression, '甲群里最爱组局的人')
    assert.deepEqual(a.tags, ['牌友'])
  } finally {
    await cleanup(home, archive)
  }
})

test('增量：插一条消息只重建那个群，另一个群连算都不算', async () => {
  const { home, archive, db } = await setup()
  try {
    const b1 = buildBoardData(db, {})
    add(archive, 'x', [ev({ time: T + 200, text: '甲群新消息', user: 10001, name: 'A甲', group: 1111 })])
    const b2 = buildBoardData(db, { snapshot: b1.snapshot })
    assert.equal(b2.stats.rebuiltChats, 1)
    assert.equal(b2.stats.reusedChats, 1)
    assert.deepEqual(b2.data.peopleByChat['group:2222'], b1.data.peopleByChat['group:2222'])
    // 甲群里只有发消息的人要重算（本群 1 份 + 全局 1 份）
    assert.equal(b2.stats.rebuiltProfiles, 2)
    assert.ok(b2.stats.reusedProfiles > 0)
    // 会话卡片上的消息数是现算的
    const chat = b2.data.chats.find((c) => c.key === 'group:1111')
    assert.equal(chat.msgCount, 21)
  } finally {
    await cleanup(home, archive)
  }
})

test('@ 关系：被 @ 的人不重算档案，但计数立刻更新（群内和全局都要）', async () => {
  const { home, archive, db } = await setup()
  try {
    const b1 = buildBoardData(db, {})
    const before = b1.data.peopleByChat['group:1111'].find((p) => p.userId === '10005')
    assert.deepEqual(before.mentionedBy, [])

    add(archive, 'at', [ev({ time: T + 300, text: '@10005 在吗', user: 10001, name: 'A甲', group: 1111 })])
    const b2 = buildBoardData(db, { snapshot: b1.snapshot })
    // 只有 @ 人的那位要重算；被 @ 的 10005 一条新消息都没有
    assert.equal(b2.stats.rebuiltProfiles, 2)

    const after = b2.data.peopleByChat['group:1111'].find((p) => p.userId === '10005')
    assert.deepEqual(after.mentionedBy, [{ userId: '10001', name: 'A甲', count: 1 }])
    // 档案本体复用了上一份（不是重算出来的）
    assert.deepEqual(after.recent, before.recent)
    assert.deepEqual(after.topWords, before.topWords)
    // 全局视图也看得到这次 @
    const global = b2.data.peopleByChat['*'].find((p) => p.userId === '10005')
    assert.deepEqual(global.mentionedBy, [{ userId: '10001', name: 'A甲', count: 1 }])
    // @ 了谁 也记在发出的人头上
    const from = b2.data.peopleByChat['group:1111'].find((p) => p.userId === '10001')
    assert.ok(from.mentionsOut.some((m) => m.userId === '10005' && m.count === 1))
  } finally {
    await cleanup(home, archive)
  }
})

test('@ 索引与旧 SQL 的计数一致（同一条消息里重复 @ 只算一次）', async () => {
  const { home, archive, db } = await setup()
  try {
    add(archive, 'dup', [
      ev({ time: T + 400, text: '@10005 @10005 双份', user: 10001, name: 'A甲', group: 1111 }),
      ev({ time: T + 401, text: '@10005 再喊一次', user: 10002, name: 'B乙', group: 1111 }),
      ev({ time: T + 402, text: '@10005 乙群的也有人喊', user: 10003, name: 'C丙', group: 2222, groupName: '乙群' }),
    ])
    const index = buildMentionIndex(db)
    const got = mentionsFor(index, '10005', 'group:1111').mentionedBy
    const rows = db
      .prepare(
        "select sender_id, count(*) n from messages where chat_key = ? and text like '%@10005%' and sender_id <> ? group by sender_id order by n desc, sender_id",
      )
      .all('group:1111', '10005')
    assert.deepEqual(
      got.map((m) => [m.userId, m.count]),
      rows.map((r) => [String(r.sender_id), r.n]),
    )
    // 乙群自己那一条不会串进甲群
    const cross = mentionsFor(index, '10005', 'group:2222').mentionedBy
    assert.deepEqual(cross.map((m) => [m.userId, m.count]), [['10003', 1]])
    // 同一条里 @ 两次仍然只记一次
    assert.equal(got.find((m) => m.userId === '10001').count, 1)
  } finally {
    await cleanup(home, archive)
  }
})

test('指纹覆盖消息 / 日报 / 印象 / 群名 / 媒体', async () => {
  const { home, archive, db } = await setup()
  try {
    const fp0 = dbFingerprint(db)
    add(archive, 'fp', [ev({ time: T + 500, text: '指纹测试', user: 10002, name: 'B乙', group: 1111 })])
    const fp1 = dbFingerprint(db)
    assert.notEqual(fp1, fp0)

    saveReport(db, { date: '2026-01-02', chatKey: '*', text: '日报正文', stats: {}, model: 'fake/model' })
    const fp2 = dbFingerprint(db)
    assert.notEqual(fp2, fp1)

    db.prepare("update profiles set impression = ?, impression_at = ? where chat_key = '*' and user_id = '10001'").run(
      '换了个印象',
      T + 999,
    )
    const fp3 = dbFingerprint(db)
    assert.notEqual(fp3, fp2)

    db.prepare("update chats set name = '改过的甲群' where chat_key = 'group:1111'").run()
    const fp4 = dbFingerprint(db)
    assert.notEqual(fp4, fp3)

    db.prepare(
      "insert into media (source_key, message_key, chat_key, sender_id, ts, kind, status) values (?,?,?,?,?,?,?)",
    ).run('media-fp-1', 'm-fp-1', 'group:1111', '10001', T + 520, 'image', 'cached')
    const fp5 = dbFingerprint(db)
    assert.notEqual(fp5, fp4)
  } finally {
    await cleanup(home, archive)
  }
})

test('board：冷启动写盘 → 命中即秒回 → 删了 HTML 也能从快照补回来', async () => {
  const { home, archive, db } = await setup()
  try {
    const board = createBoard({ home, getDb: () => db })
    assert.equal(board.isFresh(), false)
    const cold = await board.build()
    assert.equal(cold.skipped, false)
    assert.ok(existsSync(join(home, 'dashboard.html')))
    assert.ok(existsSync(join(home, CACHE_FILE)))
    assert.equal(board.isFresh(), true)

    // 没变：直接跳过，连渲染都不做
    const again = await board.build()
    assert.equal(again.skipped, true)

    // HTML 被删：快照还能用，重建只花装配 + 渲染
    await rm(join(home, 'dashboard.html'))
    assert.equal(board.isFresh(), false)
    const healed = await board.build()
    assert.equal(healed.stats.rebuiltProfiles, 0)
    assert.equal(healed.stats.reusedChats, 2)
    assert.ok(existsSync(join(home, 'dashboard.html')))
    assert.equal(board.isFresh(), true)
  } finally {
    await cleanup(home, archive)
  }
})

test('快照自愈：坏 JSON / 版本不符都当作没有快照', async () => {
  const { home, archive, db } = await setup()
  try {
    const board = createBoard({ home, getDb: () => db })
    await board.build()
    const cachePath = join(home, CACHE_FILE)
    const good = JSON.parse(await readFile(cachePath, 'utf8'))

    await writeFile(cachePath, '{ 这不是 JSON', 'utf8')
    assert.equal(loadSnapshot(home), null)
    assert.equal(createBoard({ home, getDb: () => db }).isFresh(), false)

    await writeFile(cachePath, JSON.stringify({ ...good, version: 999 }), 'utf8')
    assert.equal(loadSnapshot(home), null)

    await writeFile(cachePath, JSON.stringify(good), 'utf8')
    assert.ok(loadSnapshot(home))
  } finally {
    await cleanup(home, archive)
  }
})

test('board：导出到别的路径不污染缓存', async () => {
  const { home, archive, db } = await setup()
  try {
    const board = createBoard({ home, getDb: () => db })
    await board.build()
    const custom = join(home, 'custom.html')
    const res = await board.build({ force: true, outPath: custom })
    assert.equal(res.snapshot, null)
    assert.ok(existsSync(custom))
    assert.equal(board.isFresh(), true)
  } finally {
    await cleanup(home, archive)
  }
})

test('发布：目标被占用时也能换成新内容，且不留 .tmp 半成品', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-archive-publish-'))
  try {
    const target = join(dir, 'dashboard.html')
    await writeFile(target, '旧内容', 'utf8')
    // 拿着一个不许删除/改名的句柄——Windows 上这正是宿主预览文件时的状态，
    // rename 会 EPERM，发布必须退化成原地覆盖，而不是把新内容丢在 .tmp 里。
    const fd = openSync(target, 'r')
    try {
      const how = writeFileAtomic(target, '新内容')
      assert.equal(how, 'inplace')
      assert.equal(await readFile(target, 'utf8'), '新内容')
      assert.equal(existsSync(`${target}.tmp`), false)
    } finally {
      closeSync(fd)
    }
    // 没有占用时走原子替换
    assert.equal(writeFileAtomic(target, '再新一点'), 'rename')
    assert.equal(await readFile(target, 'utf8'), '再新一点')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
