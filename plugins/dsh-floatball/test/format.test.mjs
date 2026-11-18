import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatClock,
  formatLeft,
  holderText,
  jobProgress,
  queueLines,
  queueStrip,
  short,
  workerText,
} from '../helper/format.js'

test('short 折叠空白并截断', () => {
  assert.equal(short('  唱   晴天  '), '唱 晴天')
  assert.equal(short('abcdef', 4), 'abc…')
  assert.equal(short('', 10), '')
  assert.equal(short(null), '')
})

test('formatLeft 说人话', () => {
  assert.equal(formatLeft(0), '可点')
  assert.equal(formatLeft(-5), '可点')
  assert.equal(formatLeft(90_000), '还差 2 分钟')
  assert.equal(formatLeft(7_200_000), '还差 2 小时')
  assert.equal(formatLeft(12_600_000), '还差 3 小时 30 分')
  assert.equal(formatLeft(Number.NaN), '可点')
})

test('formatClock 是本地时分', () => {
  const at = new Date(2026, 0, 2, 9, 5, 0).getTime()
  assert.equal(formatClock(at), '09:05')
  assert.equal(formatClock(0), '')
})

test('jobProgress 出文字与比例', () => {
  assert.deepEqual(jobProgress({ sent: 1, total: 4 }), { text: '1/4 段', ratio: 0.25 })
  assert.deepEqual(jobProgress({ sent: 2, total: 0 }), { text: '已发 2 段', ratio: 0 })
  assert.deepEqual(jobProgress({}), { text: '准备中', ratio: 0 })
  assert.equal(jobProgress({ sent: 9, total: 3 }).ratio, 1)
})

test('holderText 说清谁占着卡', () => {
  assert.equal(holderText(null), '空闲')
  assert.equal(holderText({ kind: 'sing', label: '唱《晴天》' }), '唱歌占着（唱《晴天》）')
  assert.match(holderText({ kind: 'draw', label: '1024x1024' }), /^画画占着/)
  assert.equal(holderText({ kind: 'weird' }), 'weird占着（没写说明）')
})

test('workerText 说清 worker 状态', () => {
  assert.equal(workerText({ running: true, modelKey: 'D:\\m\\Illustrious-XL-v2.0.safetensors' }), '在跑 · Illustrious-XL-v2.0.safetensors')
  assert.equal(workerText({ running: true, modelKey: '', ready: false }), '在跑 · SDXL（还没热）')
  assert.equal(workerText({ running: false, note: '空闲自动退出' }), '没起 · 空闲自动退出')
  assert.equal(workerText(null), '未知')
})

test('queueLines 编号与截断', () => {
  const lines = queueLines([
    { song: '晴天', requesterName: '小明', targetName: '辣条群', queuedAt: 1 },
    { song: '', requester: '222', target: 'group:1' },
  ])
  assert.equal(lines.length, 2)
  assert.equal(lines[0].index, 1)
  assert.equal(lines[0].title, '晴天')
  assert.equal(lines[0].who, '小明')
  assert.equal(lines[0].where, '辣条群')
  assert.equal(lines[1].title, '（没写歌名）')
  assert.equal(lines[1].index, 2)
})

test('queueStrip 汇总队列条', () => {
  assert.deepEqual(queueStrip(null), { holder: null, waiting: 0, waitingText: '没人等' })
  const strip = queueStrip({ holder: { kind: 'sing', label: '唱《晴天》' }, queue: [{}, {}] })
  assert.equal(strip.holder.kind, 'sing')
  assert.equal(strip.waiting, 2)
  assert.equal(strip.waitingText, '后面排了 2 个')
})
