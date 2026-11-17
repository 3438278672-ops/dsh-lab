/**
 * 工具自动注册机制的单测：发现 → 构建 → 自检 → 注册。
 *
 * 这些测试不碰真实档案库，只验证「加一个文件就能加一个工具」这条契约，
 * 以及写坏时是硬失败而不是悄悄少注册一个。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TOOL_CONTRACTS, buildContracts } from '../lib/tooling/contracts.mjs'
import { ToolRegistryError, validateToolDefinitions } from '../lib/tooling/selfcheck.mjs'
import { buildToolDefinitions, loadToolModules, registerTools } from '../lib/tooling/registry.mjs'

const TOOLS_DIR = new URL('../tools/', import.meta.url)
const EXPECTED_TOOLS = [
  'qq_archive',
  'qq_ask',
  'qq_find',
  'qq_highlights',
  'qq_impression',
  'qq_links',
  'qq_people',
  'qq_report',
  'qq_topic',
]

/** 装配期就 throw 的 Proxy：工具工厂不允许在构建时读运行时。 */
function throwingRuntime() {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`工具工厂在构建期读了运行时字段：${String(prop)}`)
      },
    },
  )
}

function toolSource(name) {
  return `export default (rt) => ({
  name: ${JSON.stringify(name)},
  description: '测试工具',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ summary: 'ok' }),
  output: 'TEXT_SUMMARY',
})
`
}

test('契约表：TEXT_SUMMARY 渲染 summary，重名/坏形状直接抛错', () => {
  assert.ok(TOOL_CONTRACTS.has('TEXT_SUMMARY'))
  const contract = TOOL_CONTRACTS.get('TEXT_SUMMARY')
  assert.deepEqual(contract.render({}, { summary: '摘要' }), [{ type: 'text', text: '摘要' }])
  assert.deepEqual(contract.render({}, { a: 1 }), [{ type: 'text', text: '{"a":1}' }])

  assert.throws(
    () =>
      buildContracts([
        ['OK', { schema: { type: 'object' }, render: () => [{ type: 'text', text: '' }] }],
        ['OK', { schema: { type: 'object' }, render: () => [{ type: 'text', text: '' }] }],
      ]),
    /重名/,
  )
  assert.throws(() => buildContracts([['lower_case', { schema: { type: 'object' }, render: () => [] }]]), /不合规/)
  assert.throws(() => buildContracts([['OK', { schema: { type: 'object' } }]]), /render/)
  assert.throws(() => buildContracts([['OK', { schema: { type: 'array' }, render: () => [] }]]), /object/)
})

test('loadToolModules：按文件名排序发现 9 个工具，跳过 _ 前缀模块', async () => {
  const modules = await loadToolModules(TOOLS_DIR)
  assert.equal(modules.length, EXPECTED_TOOLS.length)
  assert.deepEqual(modules.map((m) => m.name), [...EXPECTED_TOOLS])
  for (const mod of modules) {
    assert.equal(mod.file, `${mod.name}.mjs`)
    assert.equal(typeof mod.factory, 'function')
  }

  // _ 开头是共享模块；没有 default 函数也不该被当成工具
  const dir = await mkdtemp(join(tmpdir(), 'qq-archive-tools-'))
  try {
    await writeFile(join(dir, '_shared.mjs'), 'export const helper = 1\n')
    await writeFile(join(dir, 'qq_demo.mjs'), toolSource('qq_demo'))
    const found = await loadToolModules(new URL('.', pathToFileURL(join(dir, 'entry')).href))
    assert.deepEqual(found.map((m) => m.name), ['qq_demo'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadToolModules：空目录 / 默认导出不是函数 / 语法错都硬失败', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-archive-tools-bad-'))
  const asUrl = () => new URL('.', pathToFileURL(join(dir, 'entry')).href)
  try {
    await assert.rejects(() => loadToolModules(asUrl()), /工具目录为空/)

    await writeFile(join(dir, 'qq_bad.mjs'), 'export default 42\n')
    await assert.rejects(() => loadToolModules(asUrl()), (e) => e instanceof ToolRegistryError && /export default \(rt\)/.test(e.message))

    await rm(join(dir, 'qq_bad.mjs'))
    await writeFile(join(dir, 'qq_broken.mjs'), 'export default (rt) => ({\n')
    await assert.rejects(() => loadToolModules(asUrl()), (e) => e instanceof ToolRegistryError && /加载失败/.test(e.message))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildToolDefinitions：真实 9 个工具都能在「不读运行时」的前提下构建', async () => {
  const modules = await loadToolModules(TOOLS_DIR)
  const built = buildToolDefinitions(modules, throwingRuntime())
  assert.equal(built.length, EXPECTED_TOOLS.length)
  assert.deepEqual(built.map((b) => b.definition.name), [...EXPECTED_TOOLS])
})

test('validateToolDefinitions：真实工具全部通过（含 qq_ 前缀）', async () => {
  const modules = await loadToolModules(TOOLS_DIR)
  const built = buildToolDefinitions(modules, throwingRuntime())
  assert.deepEqual(validateToolDefinitions(built, { contracts: TOOL_CONTRACTS, namePrefix: 'qq_' }), [])
})

test('registerTools：注册 9 个工具，输出被替换成契约对象', async () => {
  const modules = await loadToolModules(TOOLS_DIR)
  const registered = new Map()
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    effect(fn) {
      fn()
    },
  }
  const names = registerTools(ctx, modules, { runtime: throwingRuntime(), namePrefix: 'qq_' })
  assert.deepEqual(names, [...EXPECTED_TOOLS])
  assert.deepEqual([...registered.keys()].sort(), [...EXPECTED_TOOLS])
  for (const definition of registered.values()) {
    assert.equal(typeof definition.execute, 'function')
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.output, 'object')
    assert.equal(typeof definition.output.render, 'function')
    assert.deepEqual(definition.output.render({}, { summary: 'x' }), [{ type: 'text', text: 'x' }])
  }
})

function fabricated(overrides = {}, file = 'qq_demo.mjs') {
  return [{ file, definition: { name: 'qq_demo', description: '测试', parameters: { type: 'object', properties: {} }, execute: async () => ({}), output: 'TEXT_SUMMARY', ...overrides } }]
}

test('自检：重名、前缀、空 description、坏参数、坏 timeout、坏 execute、坏契约都会报出来', () => {
  const cases = [
    [fabricated({}, 'qq_other.mjs'), /与文件名不一致/],
    [fabricated({ name: 'find' }, 'find.mjs'), /缺少插件前缀/],
    [fabricated({ description: '  ' }), /description 不能为空/],
    [fabricated({ parameters: [] }), /parameters 必须是 JSON schema 对象/],
    [fabricated({ parameters: { type: 'object', properties: {}, required: ['q'] } }), /required 里的「q」没有在 properties 里声明/],
    [fabricated({ parameters: { type: 'array', properties: {} } }), /parameters\.type 必须是 "object"/],
    [fabricated({ timeoutMs: 0 }), /timeoutMs 必须是正整数/],
    [fabricated({ execute: 'nope' }), /execute 必须是函数/],
    [fabricated({ output: 'NOPE' }), /引用了不存在的输出契约/],
  ]
  for (const [entries, pattern] of cases) {
    const problems = validateToolDefinitions(entries, { contracts: TOOL_CONTRACTS, namePrefix: 'qq_' })
    assert.equal(problems.length, 1, `应只报一处：${JSON.stringify(problems)}`)
    assert.match(problems[0], pattern)
  }

  // 重名要聚合，不能第一个就停
  const dup = [
    ...fabricated({}, 'qq_demo.mjs'),
    ...fabricated({}, 'qq_demo.mjs'),
  ]
  const problems = validateToolDefinitions(dup, { contracts: TOOL_CONTRACTS, namePrefix: 'qq_' })
  assert.ok(problems.some((p) => /工具名重复：qq_demo/.test(p)))
})

test('registerTools：自检不过时整组不注册，抛 ToolRegistryError 并带全部问题', async () => {
  const modules = await loadToolModules(TOOLS_DIR)
  const registered = []
  const logged = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition.name)
      },
    },
    effect(fn) {
      fn()
    },
  }
  const bad = fabricated({ execute: 'nope' })
  assert.throws(
    () => registerTools(ctx, [{ file: 'qq_demo.mjs', factory: () => bad[0].definition }], { runtime: {}, namePrefix: 'qq_', log: { error: (m) => logged.push(m) } }),
    (e) => e instanceof ToolRegistryError && e.problems.length === 1,
  )
  assert.deepEqual(registered, [])
  assert.match(logged[0], /自检未通过/)
  // 真实模块仍然可用，保证这个断言不是靠碰巧
  assert.equal(modules.length, EXPECTED_TOOLS.length)
})
