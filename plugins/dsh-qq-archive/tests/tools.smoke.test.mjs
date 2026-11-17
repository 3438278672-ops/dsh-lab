/**
 * 整插件冒烟：用假 ctx 装配一遍，确认自动发现 + 自检 + 注册跑通，
 * 9 个工具的对外形状（名字 / 参数 schema / 输出契约 / execute）都对。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, toolModules, TOOL_NAME_PREFIX } from '../index.js'

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

test('apply 装配：注册 9 个工具，形状合法，输出契约可渲染', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qq-archive-smoke-'))
  const toolDefs = new Map()
  const disposers = []
  const ctx = {
    logger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
    tools: {
      register(definition) {
        toolDefs.set(definition.name, definition)
        return () => toolDefs.delete(definition.name)
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    get() {
      throw new Error('冒烟装配不该取别的服务')
    },
    webServer: null,
  }

  const realSetTimeout = globalThis.setTimeout
  // 压掉启动定时器：这里只验同步装配，不等 1.5s 后的后台同步
  globalThis.setTimeout = () => ({ unref() {} })
  try {
    apply(ctx, { home, syncIntervalMin: 0 })
  } finally {
    globalThis.setTimeout = realSetTimeout
  }

  try {
    assert.equal(toolModules.length, EXPECTED_TOOLS.length)
    assert.deepEqual([...toolDefs.keys()].sort(), [...EXPECTED_TOOLS])
    for (const name of EXPECTED_TOOLS) assert.ok(name.startsWith(TOOL_NAME_PREFIX), `${name} 应带 ${TOOL_NAME_PREFIX} 前缀`)

    for (const [name, definition] of toolDefs) {
      assert.equal(definition.name, name)
      assert.ok(definition.description.trim(), `${name} 缺 description`)
      assert.equal(definition.parameters?.type, 'object', `${name} parameters 不是 object schema`)
      assert.equal(typeof definition.execute, 'function', `${name} 缺 execute`)
      assert.equal(typeof definition.output, 'object', `${name} 的 output 应被替换成契约对象`)
      assert.equal(typeof definition.output.render, 'function', `${name} 的契约缺 render`)
      assert.deepEqual(definition.output.render({}, { summary: `${name} 摘要` }), [{ type: 'text', text: `${name} 摘要` }])
      if (definition.timeoutMs !== undefined) {
        assert.ok(Number.isInteger(definition.timeoutMs) && definition.timeoutMs > 0, `${name} timeoutMs 非法`)
      }
    }
  } finally {
    // 按 Cordis 的清理顺序（后注册先清理）跑一遍，确认不会抛
    assert.doesNotThrow(() => {
      for (const dispose of disposers.reverse()) dispose()
    })
    await rm(home, { recursive: true, force: true })
  }
})
