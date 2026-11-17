// dsh-fish-paint · 限流单测
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_VIP_LIST,
  cooldownStatus,
  isVip,
  normalizeRequester,
  parseVipList,
  releaseDraw,
  reserveDraw,
} from '../lib/ratelimit.js'

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-paint-limit-'))
  return path.join(dir, 'draw-cooldown.json')
}

test('normalizeRequester 认 QQ 号的各种写法，不认的返回空', () => {
  assert.equal(normalizeRequester('2220222310'), '2220222310')
  assert.equal(normalizeRequester('private:2220222310'), '2220222310')
  assert.equal(normalizeRequester(' QQ 2220222310 '), '2220222310')
  assert.equal(normalizeRequester(2220222310), '2220222310')
  assert.equal(normalizeRequester(''), '')
  assert.equal(normalizeRequester(undefined), '')
  assert.equal(normalizeRequester('abc'), '')
  assert.equal(normalizeRequester('12'), '')
})

test('parseVipList 支持数组/字符串、去重、丢掉不合法的号码', () => {
  assert.deepEqual(parseVipList(['2220222310', 'private:2220222310', '12345', 'x']), ['2220222310', '12345'])
  assert.deepEqual(parseVipList('2220222310, 3438278672 2220222310'), ['2220222310', '3438278672'])
  assert.deepEqual(parseVipList(undefined), [])
})

test('isVip 只认名单里的号；默认名单含 2220222310', () => {
  assert.equal(isVip('2220222310', DEFAULT_VIP_LIST), true)
  assert.equal(isVip('private:2220222310', DEFAULT_VIP_LIST), true)
  assert.equal(isVip('1234567', DEFAULT_VIP_LIST), false)
  assert.equal(isVip('', DEFAULT_VIP_LIST), false)
})

test('同一人 N 分钟内只能占一次名额，不同人互不影响', () => {
  const file = tempFile()
  const windowMs = 60 * 60 * 1000
  const now = 1_800_000_000_000

  const first = reserveDraw({ file, requester: '2220222310', windowMs, max: 1, now })
  assert.equal(first.ok, true)
  assert.equal(first.requester, '2220222310')

  const second = reserveDraw({ file, requester: '2220222310', windowMs, max: 1, now: now + 1000 })
  assert.equal(second.ok, false)
  assert.ok(second.retryAfterSec >= 3500 && second.retryAfterSec <= 3600)

  const other = reserveDraw({ file, requester: '3438278672', windowMs, max: 1, now: now + 1000 })
  assert.equal(other.ok, true)

  const later = reserveDraw({ file, requester: '2220222310', windowMs, max: 1, now: now + windowMs + 1 })
  assert.equal(later.ok, true)
})

test('releaseDraw 只在生成失败时退还那一次名额', () => {
  const file = tempFile()
  const windowMs = 60 * 60 * 1000
  const now = 1_800_000_000_000

  const first = reserveDraw({ file, requester: '2220222310', windowMs, now })
  assert.equal(first.ok, true)
  assert.equal(reserveDraw({ file, requester: '2220222310', windowMs, now: now + 1 }).ok, false)

  assert.equal(releaseDraw({ file, requester: '2220222310', at: first.reservedAt }), true)
  assert.equal(reserveDraw({ file, requester: '2220222310', windowMs, now: now + 2 }).ok, true)
})

test('max>1 时按次数放行，用满才拦', () => {
  const file = tempFile()
  const windowMs = 10 * 60 * 1000
  const now = 1_800_000_000_000
  assert.equal(reserveDraw({ file, requester: '7777777', windowMs, max: 2, now }).ok, true)
  assert.equal(reserveDraw({ file, requester: '7777777', windowMs, max: 2, now: now + 1 }).ok, true)
  const third = reserveDraw({ file, requester: '7777777', windowMs, max: 2, now: now + 2 })
  assert.equal(third.ok, false)
})

test('cooldownStatus 能报还要等多少秒；没有 requester 不限流', () => {
  const file = tempFile()
  const windowMs = 60 * 60 * 1000
  const now = 1_800_000_000_000
  assert.deepEqual(cooldownStatus({ file, requester: '', windowMs, now }), { requester: '', remaining: 0, retryAfterSec: 0 })

  reserveDraw({ file, requester: '2220222310', windowMs, now })
  const status = cooldownStatus({ file, requester: '2220222310', windowMs, now: now + 30 * 60 * 1000 })
  assert.equal(status.remaining, 0)
  assert.ok(status.retryAfterSec >= 1790 && status.retryAfterSec <= 1810)
})

test('坏掉的 JSON 当空状态，限流放行而不是报错', () => {
  const file = tempFile()
  fs.writeFileSync(file, '{ not json')
  const result = reserveDraw({ file, requester: '2220222310', windowMs: 60_000, now: 1_800_000_000_000 })
  assert.equal(result.ok, true)
})
