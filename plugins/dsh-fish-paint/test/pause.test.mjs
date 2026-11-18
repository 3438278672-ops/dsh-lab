// 暂停开关：默认不暂停；写进去能读回来；坏 JSON 当「没暂停」。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPauseStore } from '../lib/pause.js'

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-paint-pause-'))
  return { dir, file: path.join(dir, 'state', 'paint-paused.json') }
}

test('默认不暂停；写了能读回来，含 by / updatedAt', () => {
  const { dir, file } = tmpFile()
  try {
    const store = createPauseStore(file)
    assert.equal(store.read().paused, false)
    assert.equal(store.isPaused(), false)

    const written = store.write(true, '悬浮球')
    assert.equal(written.paused, true)
    const read = store.read()
    assert.equal(read.paused, true)
    assert.equal(read.updatedBy, '悬浮球')
    assert.ok(read.updatedAt > 0)

    assert.equal(store.write(false, '悬浮球').paused, false)
    assert.equal(store.isPaused(), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('状态文件坏了 / 不存在都当没暂停（别把画画彻底卡死）', () => {
  const { dir, file } = tmpFile()
  try {
    const store = createPauseStore(file)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{oops', 'utf8')
    assert.equal(store.isPaused(), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('by 太长会被截断，非布尔值一律当 false', () => {
  const { dir, file } = tmpFile()
  try {
    const store = createPauseStore(file)
    const written = store.write('yes', 'x'.repeat(80))
    assert.equal(written.paused, false)
    assert.equal(written.updatedBy.length, 40)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
