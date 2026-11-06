/** cooldown.mjs 单元测试：node tests/cooldown.test.mjs */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  COOLDOWN_DEFAULT_MS,
  parseRequester,
  remainingMs,
  checkCooldown,
  markCooldown,
  clearCooldown,
  formatLeft,
  readCooldowns,
  readAllowlist,
} from '../cooldown.mjs'

const home = await mkdtemp(path.join(os.tmpdir(), 'qqsing-cd-'))
let passed = 0
const ok = (name) => { passed += 1; console.log('PASS', name) }

// 1. 解析
assert.equal(parseRequester('123456789'), '123456789')
assert.equal(parseRequester(' 100000002 '), '100000002')
assert.equal(parseRequester('1234'), null)
assert.equal(parseRequester('12a45'), null)
assert.equal(parseRequester(''), null)
assert.equal(parseRequester(undefined), null)
ok('parseRequester')

// 2. remainingMs
const now = 1_700_000_000_000
assert.equal(remainingMs({}, '1', now), 0)
assert.equal(remainingMs({ 1: { at: now - 10 * 60_000 } }, '1', now), 50 * 60_000)
assert.equal(remainingMs({ 1: { at: now - 61 * 60_000 } }, '1', now), 0)
assert.equal(remainingMs({ 1: now - 5 * 60_000 }, '1', now, 10 * 60_000), 5 * 60_000)
ok('remainingMs')

// 3. 标记 → 拦 → 到期放开
await markCooldown(home, '111111', '晴天', 'group:1', now)
const blocked = await checkCooldown(home, '111111', now + 60_000)
assert.equal(blocked.blocked, true)
assert.equal(blocked.last.song, '晴天')
assert.ok(blocked.left > 0 && blocked.left <= COOLDOWN_DEFAULT_MS)
const expired = await checkCooldown(home, '111111', now + COOLDOWN_DEFAULT_MS + 1)
assert.equal(expired.blocked, false)
ok('mark/check/expire')

// 4. 清除（失败退还）
assert.equal(await clearCooldown(home, '111111'), true)
assert.equal((await checkCooldown(home, '111111', now)).blocked, false)
assert.equal(await clearCooldown(home, '111111'), false)
ok('clear/refund')

// 5. 过期条目被剪掉
const old = Date.now() - 72 * 60 * 60 * 1000
await markCooldown(home, '222222', 'a', 'group:1', old)
await markCooldown(home, '333333', 'b', 'group:1', Date.now())
const map = await readCooldowns(home)
assert.equal('222222' in map, false)
assert.equal('333333' in map, true)
ok('prune')

// 6. formatLeft
assert.equal(formatLeft(30_000), '1 分钟')
assert.equal(formatLeft(25 * 60_000), '25 分钟')
assert.equal(formatLeft(60 * 60_000), '1 小时')
assert.equal(formatLeft(59 * 60_000), '59 分钟')
ok('formatLeft')

// 7. cooldown.json 是合法 JSON（中文不被转义丢失）
const raw = await import('node:fs/promises').then((fs) => fs.readFile(path.join(home, 'cooldown.json'), 'utf8'))
assert.ok(JSON.parse(raw)['333333'])
ok('file-format')

// 8. 白名单解析：注释、逗号、坏行、中文分号都要能处理
const home2 = await mkdtemp(path.join(os.tmpdir(), 'qqsing-allow-'))
assert.equal((await readAllowlist(home2)).size, 0)
await writeFile(
  path.join(home2, 'allowlist.txt'),
  '# 注释行\n123456789 # 小明\n 100000002,333333\nnot-a-uid\n444444；555555\n',
  'utf8',
)
const allow = [...(await readAllowlist(home2))].sort()
assert.deepEqual(allow, ['123456789', '100000002', '333333', '444444', '555555'].sort())
ok('allowlist')

console.log(`\n${passed} checks passed`)
