import assert from 'node:assert/strict'
import test from 'node:test'
import { estimateHeight, personCardHtml } from '../lib/card.mjs'

const profile = {
  userId: '10086',
  aliases: ['阿鱼', '大肥鱼'],
  total: 678,
  chats: [{ chatKey: 'group:1', name: '测试群', msgCount: 678 }],
  links: 3,
  firstTs: 1790000000,
  lastTs: 1794000000,
  hours: Array.from({ length: 24 }, (_, i) => (i > 8 ? i : 0)),
  peak: [{ from: 9, to: 23, pct: 100, label: '全天在线' }],
  topWords: [
    { word: '游戏', count: 24 },
    { word: '该死', count: 18 },
  ],
  mentionsOut: [{ userId: '3276839130', name: '大肥鱼', count: 102 }],
  mentionedBy: [{ userId: '999', name: '', count: 3 }],
  impression: '群里的老熟人，一句话带三个梗。',
  tags: ['白饭教', '接梗快'],
}

test('把档案拼成一张卡：名字、统计、印象、标签都在', () => {
  const html = personCardHtml(profile, { chatName: '测试群', today: '2026-11-08' })
  assert.match(html, /阿鱼/)
  assert.match(html, /QQ 10086/)
  assert.match(html, /678/)
  assert.match(html, /群里的老熟人/)
  assert.match(html, /白饭教/)
  assert.match(html, /测试群/)
  assert.match(html, /全天在线/)
})

test('没有名字的 QQ 号显示成「QQ xxx」，不裸露数字', () => {
  const html = personCardHtml(profile, {})
  assert.match(html, /QQ 999/)
  assert.doesNotMatch(html, />999</)
})

test('没有印象时给一句引导，而不是空白', () => {
  const html = personCardHtml({ ...profile, impression: '', tags: [] }, {})
  assert.match(html, /还没有人物印象/)
  assert.doesNotMatch(html, /class="tags"/)
})

test('高度随内容增长，但有个下限', () => {
  const short = estimateHeight({ ...profile, impression: '短', tags: [], topWords: [], chats: [] })
  const long = estimateHeight({ ...profile, impression: 'x'.repeat(600) })
  assert.ok(long > short)
  assert.ok(short >= 720)
})
