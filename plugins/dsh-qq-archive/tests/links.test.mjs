import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArchive, insertBatch } from '../lib/db.mjs'
import { normalizeOneBot } from '../lib/normalize.mjs'
import { extractUrls, buildLinkIndex, filterLinks, linksMarkdown } from '../lib/links.mjs'

const T0 = 1760000000
const CHAT_NAMES = { 123: '测试群', 456: '二群' }

function ev({ time, text, user = 111, name = '阿猫', group = 123, message }) {
  return {
    time,
    self_id: 999,
    post_type: 'message',
    message_type: 'group',
    group_id: group,
    group_name: CHAT_NAMES[group] || '测试群',
    user_id: user,
    message_id: time,
    sender: { user_id: user, nickname: name },
    message: message || [{ type: 'text', data: { text } }],
    raw_message: text || '',
  }
}

function cardEv({ time, payload, user = 222, name = '阿狗', group = 123 }) {
  return ev({
    time,
    user,
    name,
    group,
    message: [{ type: 'json', data: { data: JSON.stringify(payload) } }],
  })
}

const CARD_GUIDE = {
  app: 'com.tencent.structmsg',
  config: { type: 'normal' },
  meta: {
    detail_1: {
      title: '赛博朋克牌组攻略',
      desc: '新环境上分思路',
      preview: 'https://cdn.example.com/preview.png',
      qqdocurl: 'https://blog.example.net/guide?from=qq',
    },
  },
}

const CARD_NEWS = {
  app: 'com.tencent.structmsg',
  meta: {
    news: {
      title: '新卡包解析视频',
      jumpUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
      preview: 'https://cdn.example.com/news.png',
    },
  },
}

const CARD_PLAIN = { app: 'com.tencent.miniapp_01', meta: { detail_1: { title: '没有链接的卡片' } } }

const fixture = [
  // 0：普通文本 + 中文句号结尾
  ev({ time: T0 + 10, text: '好文推荐 https://Example.com/Post/1?x=2。' }),
  // 1：一条消息两个链接，后面紧跟中文
  ev({ time: T0 + 20, text: '两个链接 http://a.example.org/x 和 https://b.example.com/y，都看看' }),
  // 2：卡片：qqdocurl + meta.detail_1.title（preview 图片不算链接）
  cardEv({ time: T0 + 30, payload: CARD_GUIDE }),
  // 3：另一个群的卡片：jumpUrl + meta.news.title
  cardEv({ time: T0 + 40, payload: CARD_NEWS, user: 333, name: '阿虎', group: 456 }),
  // 4：同一消息里重复的同一 URL 只算一次
  ev({ time: T0 + 50, text: '重复 https://dup.example.com/a 和 https://dup.example.com/a', user: 222, name: '阿狗' }),
  // 5：没有链接的普通消息
  ev({ time: T0 + 60, text: '打牌吗' }),
  // 6：没有链接的卡片消息
  cardEv({ time: T0 + 70, payload: CARD_PLAIN, user: 222, name: '阿狗' }),
  // 7：全角括号包住的链接
  ev({ time: T0 + 80, text: '（https://paren.example.com/x）', user: 333, name: '阿虎', group: 456 }),
  // 8：图片消息里带媒体 URL，但只有正文里的链接算资源（媒体 URL 不算）
  ev({
    time: T0 + 90,
    message: [
      { type: 'image', data: { url: 'https://img.example.com/pic.jpg?sign=1' } },
      { type: 'text', data: { text: ' 戳这里 https://example.com/Post/1?x=2，或者看图' } },
    ],
  }),
]

const EXPECTED_URLS = [
  'https://example.com/Post/1?x=2',
  'https://paren.example.com/x',
  'https://dup.example.com/a',
  'https://www.bilibili.com/video/BV1xx411c7mD',
  'https://blog.example.net/guide?from=qq',
  'http://a.example.org/x',
  'https://b.example.com/y',
  'https://Example.com/Post/1?x=2',
]

/** 每个用例一份独立临时库，避免互相影响。 */
async function withIndex(opts, fn) {
  const home = await mkdtemp(join(tmpdir(), 'qq-links-'))
  const archive = openArchive(home)
  try {
    insertBatch(
      archive.db,
      archive,
      fixture.map((data, i) => normalizeOneBot({ source: 'json', sourceKey: 'l' + i, data })),
    )
    await fn(archive, buildLinkIndex(archive.db, opts))
  } finally {
    archive.db.close()
    await rm(home, { recursive: true, force: true })
  }
}

test('extractUrls：普通链接 / 多链接 / 尾部标点 / 去重 / 无链接', () => {
  // 中文句号、逗号、引号、括号都要从尾部去掉
  assert.deepEqual(extractUrls('好文推荐 https://example.com/Post/1?x=2。'), ['https://example.com/Post/1?x=2'])
  assert.deepEqual(extractUrls('（http://a.example.org/x）'), ['http://a.example.org/x'])
  assert.deepEqual(extractUrls('"https://quote.example.com/path"，后面的中文'), ['https://quote.example.com/path'])
  assert.deepEqual(extractUrls('看这里 https://end.example.com/a, 还有 https://end.example.com/b!'), [
    'https://end.example.com/a',
    'https://end.example.com/b',
  ])
  // URL 后面没有空格、直接跟中文，也要截干净
  assert.deepEqual(extractUrls('看https://glued.example.com/a真不错'), ['https://glued.example.com/a'])
  // 同一段文本里的同一个 URL 只留一次
  assert.deepEqual(extractUrls('https://dup.example.com/a 和 https://dup.example.com/a'), ['https://dup.example.com/a'])
  // URL 自带平衡括号时，收尾括号属于 URL
  assert.deepEqual(extractUrls('看 https://wiki.example.com/Foo_(bar) 词条'), ['https://wiki.example.com/Foo_(bar)'])
  // 大写 scheme / host 原样保留
  assert.deepEqual(extractUrls('A HTTPS://X.EXAMPLE.COM/Path?a=1#frag B'), ['HTTPS://X.EXAMPLE.COM/Path?a=1#frag'])
  // 两条链接粘在一起也能拆开
  assert.deepEqual(extractUrls('https://a.example.com/xhttps://b.example.com/y'), [
    'https://a.example.com/x',
    'https://b.example.com/y',
  ])
  // 不是链接的 http 字样、空文本
  assert.deepEqual(extractUrls('没有链接，只有 42 和 http 这个词'), [])
  assert.deepEqual(extractUrls(''), [])
  assert.deepEqual(extractUrls(null), [])
})

test('buildLinkIndex：聚合、去重、卡片标题、按群/时间/条数过滤', async () => {
  await withIndex(undefined, (archive, index) => {
    // total 是「有链接的消息数」，links 才是链接条数
    assert.equal(index.total, 7)
    assert.equal(index.links.length, 8)
    assert.deepEqual(index.links.map((l) => l.url), EXPECTED_URLS)

    // 域名聚合：按 count 降序，同数按域名升序；lastTs 取该域名最新一条
    assert.deepEqual(index.domains, [
      { domain: 'example.com', count: 2, lastTs: T0 + 90 },
      { domain: 'a.example.org', count: 1, lastTs: T0 + 20 },
      { domain: 'b.example.com', count: 1, lastTs: T0 + 20 },
      { domain: 'blog.example.net', count: 1, lastTs: T0 + 30 },
      { domain: 'dup.example.com', count: 1, lastTs: T0 + 50 },
      { domain: 'paren.example.com', count: 1, lastTs: T0 + 80 },
      { domain: 'www.bilibili.com', count: 1, lastTs: T0 + 40 },
    ])
    assert.deepEqual(index.byChat, [
      { chatKey: 'group:123', chatName: '测试群', count: 6 },
      { chatKey: 'group:456', chatName: '二群', count: 2 },
    ])

    // 图片消息的媒体 URL 不进链接库
    assert.ok(!index.links.some((l) => l.domain === 'img.example.com'))

    // 卡片标题 & 字段
    const guide = index.links.find((l) => l.url.includes('blog.example.net'))
    assert.equal(guide.title, '赛博朋克牌组攻略')
    assert.equal(guide.kind, 'card')
    assert.equal(guide.chatName, '测试群')
    assert.equal(guide.senderName, '阿狗')
    assert.equal(guide.senderId, '222')
    assert.ok(guide.id > 0)
    assert.equal(typeof guide.ts, 'number')

    const news = index.links.find((l) => l.url.includes('bilibili.com'))
    assert.equal(news.title, '新卡包解析视频')
    assert.equal(news.chatName, '二群')

    // 普通文本消息没有卡片标题
    const plain = index.links.find((l) => l.url.includes('paren.example.com'))
    assert.equal(plain.title, '')
    assert.equal(plain.kind, 'text')

    // 没有链接的卡片不进索引
    assert.ok(!index.links.some((l) => l.title === '没有链接的卡片'))

    // 按群过滤
    const scoped = buildLinkIndex(archive.db, { chatKey: 'group:456' })
    assert.equal(scoped.total, 2)
    assert.equal(scoped.links.length, 2)
    assert.deepEqual(scoped.byChat, [{ chatKey: 'group:456', chatName: '二群', count: 2 }])
    assert.deepEqual(scoped.domains.map((d) => d.domain), ['paren.example.com', 'www.bilibili.com'])

    // 按时间过滤（开始 / 结束 / 区间）
    assert.equal(buildLinkIndex(archive.db, { fromTs: T0 + 80 }).total, 2)
    assert.equal(buildLinkIndex(archive.db, { toTs: T0 + 20 }).total, 2)
    assert.equal(buildLinkIndex(archive.db, { fromTs: T0 + 10, toTs: T0 + 20 }).total, 2)

    // limit 限制的是扫描消息数：取最新两条
    const limited = buildLinkIndex(archive.db, { limit: 2 })
    assert.equal(limited.total, 2)
    assert.deepEqual(limited.links.map((l) => l.url), [
      'https://example.com/Post/1?x=2',
      'https://paren.example.com/x',
    ])
  })
})

test('filterLinks：大小写无关的 q、domain/chatKey 精确过滤、limit', async () => {
  await withIndex(undefined, (archive, index) => {
    // 不传条件 = 全量，保持时间倒序
    assert.equal(filterLinks(index).length, 8)
    assert.deepEqual(filterLinks(index).map((l) => l.url), EXPECTED_URLS)

    // q 大小写无关，匹配 URL（含 Example.com 那条）
    const example = filterLinks(index, { q: 'EXAMPLE.COM' })
    assert.equal(example.length, 5)
    assert.ok(example.every((l) => l.url.toLowerCase().includes('example.com')))

    // q 匹配标题
    const byTitle = filterLinks(index, { q: '赛博朋克' })
    assert.equal(byTitle.length, 1)
    assert.equal(byTitle[0].title, '赛博朋克牌组攻略')

    // q 匹配群名、发送者
    assert.equal(filterLinks(index, { q: '二群' }).length, 2)
    assert.equal(filterLinks(index, { q: '阿虎' }).length, 2)
    assert.equal(filterLinks(index, { q: '不存在的关键词zzz' }).length, 0)

    // domain 精确匹配：example.com 不含 b.example.com / paren.example.com
    const exact = filterLinks(index, { domain: 'example.com' })
    assert.equal(exact.length, 2)
    assert.ok(exact.every((l) => l.domain === 'example.com'))
    assert.equal(filterLinks(index, { domain: 'b.example.com' }).length, 1)

    // chatKey 精确匹配
    const chat = filterLinks(index, { chatKey: 'group:456' })
    assert.equal(chat.length, 2)
    assert.ok(chat.every((l) => l.chatKey === 'group:456'))

    // 组合条件
    assert.equal(filterLinks(index, { q: '阿猫', chatKey: 'group:123' }).length, 4)
    // limit 截断
    assert.equal(filterLinks(index, { limit: 3 }).length, 3)
    assert.equal(filterLinks(index, { limit: 1 }).length, 1)
    assert.equal(filterLinks(index, { chatKey: 'group:999' }).length, 0)
  })
})

test('linksMarkdown：按域名分组、标题兜底 URL、limit 截断', async () => {
  await withIndex(undefined, (archive, index) => {
    const md = linksMarkdown(index)
    assert.ok(md.startsWith('# 群链接资源库\n'))
    assert.ok(md.includes('共 8 条链接 · 7 个域名'))

    // 分组顺序跟 index.domains 一致
    const headers = [...md.matchAll(/^## (.+?)（\d+ 条）$/gm)].map((m) => m[1])
    assert.deepEqual(headers, [
      'example.com',
      'a.example.org',
      'b.example.com',
      'blog.example.net',
      'dup.example.com',
      'paren.example.com',
      'www.bilibili.com',
    ])
    assert.ok(md.includes('## example.com（2 条）'))

    // 每条 `- 时间 · 群 · 发送者：[标题或 URL](URL)`
    assert.match(md, /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 测试群 · 阿猫：\[https:\/\/Example\.com\/Post\/1\?x=2\]\(https:\/\/Example\.com\/Post\/1\?x=2\)$/m)
    assert.ok(md.includes('：[赛博朋克牌组攻略](https://blog.example.net/guide?from=qq)'))
    assert.ok(md.includes('：[新卡包解析视频](https://www.bilibili.com/video/BV1xx411c7mD)'))
    assert.ok(md.includes('· 二群 · 阿虎：'))

    // 自定义标题 + limit：只出最新的 2 条（example.com、paren.example.com 各一条）
    const short = linksMarkdown(index, { title: '本周链接', limit: 2 })
    assert.ok(short.startsWith('# 本周链接\n'))
    assert.ok(short.includes('共 2 条链接 · 2 个域名'))
    assert.deepEqual([...short.matchAll(/^## (.+?)（\d+ 条）$/gm)].map((m) => m[1]), [
      'example.com',
      'paren.example.com',
    ])
    assert.equal([...short.matchAll(/^- /gm)].length, 2)
    assert.ok(!short.includes('www.bilibili.com'))

    // 空索引
    const empty = linksMarkdown(buildLinkIndex(archive.db, { chatKey: 'group:999' }))
    assert.ok(empty.includes('暂无链接'))
  })
})
