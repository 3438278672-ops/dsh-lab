// index.js 的接线单测：用假 ctx 验证工具/提示词注册、参数校验和未安装时的可读错误。
// 这里不会真的启动 worker（临时 dataDir 里没有 venv/模型，engine 在 spawn 前就会拒绝）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, inject, name } from '../index.js'

function makeCtx() {
  const tools = new Map()
  const sections = []
  const disposers = []
  const ctx = {
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
  }
  return { ctx, tools, sections, disposers }
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-paint-index-'))
  const dataDir = path.join(root, 'data')
  const { ctx, tools, sections, disposers } = makeCtx()
  apply(ctx, { dataDir, bridgeDir: path.join(root, 'no-such-bridge') })
  const cleanup = () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        /* 已经关掉 */
      }
    }
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* Windows 上临时目录可能刚被占用，留着无妨 */
    }
  }
  return { root, dataDir, tools, sections, cleanup }
}

test('导出约定与注册：4 个工具 + fish-paint 提示词 section', () => {
  assert.equal(name, 'dsh-fish-paint')
  assert.deepEqual(inject, ['tools', 'systemPrompt'])
  const { tools, sections, cleanup } = setup()
  try {
    assert.deepEqual([...tools.keys()].sort(), ['draw_image', 'draw_recent', 'draw_setup', 'draw_status'])
    for (const tool of tools.values()) {
      assert.ok(tool.description.length > 20, `${tool.name} 描述太短`)
      assert.equal(tool.parameters.type, 'object')
      assert.ok(tool.output?.schema, `${tool.name} 需要 output.schema`)
      assert.equal(typeof tool.output.render, 'function')
      // render 要把 payload 变成 JSON 文本（CONTRACT §4）
      const blocks = tool.output.render({}, { ok: true, summary: 'x' })
      assert.deepEqual(blocks.map((block) => block.type), ['text'])
      assert.deepEqual(JSON.parse(blocks[0].text), { ok: true, summary: 'x' })
    }
    assert.equal(tools.get('draw_image').timeoutMs, 600_000)
    assert.equal(tools.get('draw_image').parameters.required[0], 'prompt')

    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, 'fish-paint')
    assert.equal(sections[0].order, 900)
    for (const keyword of ['draw_image', 'draw_status', 'draw_setup', 'draw_recent', 'R18', 'sticker', 'danbooru']) {
      assert.ok(sections[0].text.includes(keyword), `systemPrompt 应提到 ${keyword}`)
    }
  } finally {
    cleanup()
  }
})

test('draw_image 参数校验：prompt 必填、target 格式错误都返回 ok:false', async () => {
  const { tools, cleanup } = setup()
  try {
    const drawImage = tools.get('draw_image')
    const noPrompt = await drawImage.execute({})
    assert.equal(noPrompt.ok, false)
    assert.equal(noPrompt.error.code, 'BAD_REQUEST')

    const badTarget = await drawImage.execute({ prompt: '1girl', target: 'qq群123' })
    assert.equal(badTarget.ok, false)
    assert.match(badTarget.error.message, /group:群号/)

    const badPresetTarget = await drawImage.execute({ prompt: '1girl', target: 'group:abc' })
    assert.equal(badPresetTarget.ok, false)
  } finally {
    cleanup()
  }
})

test('draw_image 未安装时给 NOT_INSTALLED + 安装建议，不 spawn 任何进程', async () => {
  const { tools, cleanup } = setup()
  try {
    const payload = await tools.get('draw_image').execute({ prompt: '1girl, solo, silver hair', preset: 'sticker' })
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, 'NOT_INSTALLED')
    assert.match(payload.error.hint, /draw_setup/)
    assert.match(payload.summary, /draw_setup/)
  } finally {
    cleanup()
  }
})

test('draw_status：未安装时 installed=false、next 指向 draw_setup install', async () => {
  const { tools, cleanup } = setup()
  try {
    const payload = await tools.get('draw_status').execute({})
    assert.equal(payload.ok, true)
    assert.equal(payload.installed, false)
    assert.equal(payload.python.exists, false)
    assert.equal(payload.model.exists, false)
    assert.equal(payload.worker.running, false)
    assert.match(payload.worker.note, /draw_setup/)
    assert.ok(payload.next.some((item) => item.includes('draw_setup')))
    assert.match(payload.summary, /未安装/)
    assert.equal(payload.bridge.ok, false)
  } finally {
    cleanup()
  }
})

test('draw_setup：status 只读；未知 action 返回 BAD_REQUEST', async () => {
  const { tools, cleanup } = setup()
  try {
    const drawSetup = tools.get('draw_setup')
    const status = await drawSetup.execute({ action: 'status' })
    assert.equal(status.ok, true)
    assert.equal(status.installed, false)
    assert.ok(status.next.some((item) => item.includes('draw_setup')))

    const bad = await drawSetup.execute({ action: 'nuke' })
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'BAD_REQUEST')
  } finally {
    cleanup()
  }
})

test('draw_recent：空目录返回 0 条；date 格式错误返回 BAD_REQUEST', async () => {
  const { tools, cleanup } = setup()
  try {
    const drawRecent = tools.get('draw_recent')
    const empty = await drawRecent.execute({ limit: 5 })
    assert.equal(empty.ok, true)
    assert.equal(empty.count, 0)
    assert.deepEqual(empty.items, [])

    const badDate = await drawRecent.execute({ date: '2026/11/17' })
    assert.equal(badDate.ok, false)
    assert.equal(badDate.error.code, 'BAD_REQUEST')
  } finally {
    cleanup()
  }
})
