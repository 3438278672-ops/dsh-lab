import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { START, KIND_INTENT, buildStartPrompt, nextStatusAfterStart } from '../lib/start.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

test('buildStartPrompt 带全条目信息与类型意图', () => {
  const p = buildStartPrompt({
    id: 12,
    kind: 'idea',
    title: '一键开新对话实施更新/创造',
    body: '灵感账本里每条都能一键开个新对话去干。',
    tags: ['idea-log', 'web-ui'],
  })
  assert.match(p, /灵感账本 #12 · 插件点子/)
  assert.match(p, /标题：一键开新对话实施更新\/创造/)
  assert.match(p, /正文：灵感账本里每条都能一键开个新对话去干。/)
  assert.match(p, /标签：idea-log、web-ui/)
  assert.match(p, new RegExp(KIND_INTENT.idea))
  assert.match(p, /不做打补丁式的最小改动/)
})

test('三种类型给不同的开工意图，踩坑强调修根上', () => {
  const base = { id: 1, title: 'x' }
  const idea = buildStartPrompt({ ...base, kind: 'idea' })
  const improve = buildStartPrompt({ ...base, kind: 'improve' })
  const pitfall = buildStartPrompt({ ...base, kind: 'pitfall' })

  assert.match(idea, /插件点子/)
  assert.match(improve, /改进点/)
  assert.match(pitfall, /踩坑/)
  assert.match(pitfall, /不许单点特判、临时绕过/)
  assert.doesNotMatch(idea, /不许单点特判/)
})

test('空正文、空标签、未知类型都能排', () => {
  const p = buildStartPrompt({ id: 7, kind: 'nonsense', title: '  只有标题  ', body: '', tags: [] })
  assert.match(p, /插件点子/)
  assert.match(p, /标题：只有标题/)
  assert.doesNotMatch(p, /正文：/)
  assert.doesNotMatch(p, /标签：/)
  assert.doesNotMatch(p, /#\?/)
})

test('超长正文截断、垃圾标签被过滤', () => {
  const p = buildStartPrompt({
    id: 3,
    title: 't',
    body: '字'.repeat(5000),
    tags: ['ok', '', '  ', 42, null],
  })
  const bodyLine = p.split('\n').find((l) => l.startsWith('正文：'))
  assert.equal(bodyLine.length, '正文：'.length + 2000)
  assert.match(p, /^标签：ok$/m)
})

test('开工后状态：已孵化中的不动，其余认领为孵化中', () => {
  assert.equal(nextStatusAfterStart('new'), 'incubating')
  assert.equal(nextStatusAfterStart('parked'), 'incubating')
  assert.equal(nextStatusAfterStart('done'), 'incubating')
  assert.equal(nextStatusAfterStart('incubating'), null)
})

test('网页半边的协议常量与 Host 侧一致', () => {
  for (const file of ['client.js', 'page.mjs']) {
    const src = readFileSync(join(root, 'lib', file), 'utf8')
    for (const v of Object.values(START)) assert.ok(src.includes(`'${v}'`), `${file} 缺少协议常量 ${v}`)
  }
})
