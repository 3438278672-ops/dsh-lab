import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { COLLAPSED, EXPANDED, clampPosition, defaultPosition, displayForPoint, resolvePosition } = require('../helper/position.cjs')

const primary = { workArea: { x: 0, y: 0, width: 1600, height: 900 } }
const secondary = { workArea: { x: 1600, y: 0, width: 1280, height: 720 } }

test('没有历史位置时落在主屏右下角（避开任务栏）', () => {
  assert.deepEqual(defaultPosition(primary.workArea, COLLAPSED), { x: 1600 - 96 - 32, y: 900 - 96 - 96 })
  assert.deepEqual(resolvePosition({ saved: null, displays: [primary], size: COLLAPSED }), { x: 1472, y: 708 })
})

test('历史位置在屏内就原样保留', () => {
  assert.deepEqual(resolvePosition({ saved: { x: 300, y: 200 }, displays: [primary] }), { x: 300, y: 200 })
})

test('位置只探出边界一点点时夹回屏内（拖到贴边那种）', () => {
  assert.deepEqual(resolvePosition({ saved: { x: 1650, y: 200 }, displays: [primary] }), { x: 1600 - 96, y: 200 })
})

test('位置落在很远的屏外时回主屏右下角（换过分辨率/缩放过）', () => {
  assert.deepEqual(resolvePosition({ saved: { x: 2432, y: 1248 }, displays: [primary] }), { x: 1472, y: 708 })
})

test('历史位置是负数时夹到左上角', () => {
  assert.deepEqual(resolvePosition({ saved: { x: -80, y: -20 }, displays: [primary] }), { x: 0, y: 0 })
})

test('历史位置在副屏上就留在副屏', () => {
  assert.deepEqual(resolvePosition({ saved: { x: 1800, y: 100 }, displays: [primary, secondary] }), { x: 1800, y: 100 })
})

test('副屏拔掉后回主屏右下角，而不是留在看不见的地方', () => {
  assert.deepEqual(resolvePosition({ saved: { x: 1800, y: 100 }, displays: [primary] }), { x: 1472, y: 708 })
})

test('展开态按大窗口夹，球不会因为面板变宽被顶出屏', () => {
  assert.deepEqual(resolvePosition({ saved: { x: 1500, y: 500 }, displays: [primary], size: EXPANDED }), {
    x: 1600 - 392,
    y: 900 - 572,
  })
})

test('坐标是脏数据时退回默认位置', () => {
  assert.deepEqual(resolvePosition({ saved: { x: Number.NaN, y: 10 }, displays: [primary] }), { x: 1472, y: 708 })
  // 字符串不当坐标用（window.json 是我们自己写的数字，出现字符串说明文件被改坏了）
  assert.deepEqual(resolvePosition({ saved: { x: '300', y: 10 }, displays: [primary] }), { x: 1472, y: 708 })
})

test('displayForPoint 按工作区判定归属', () => {
  assert.equal(displayForPoint([primary, secondary], { x: 10, y: 10 }), primary)
  assert.equal(displayForPoint([primary, secondary], { x: 1700, y: 10 }), secondary)
  assert.equal(displayForPoint([primary], { x: 9999, y: 9999 }), null)
})

test('clampPosition 的 slack 允许贴边露一点点（拖拽时用）', () => {
  assert.deepEqual(clampPosition({ x: 5000, y: 5000 }, primary.workArea, COLLAPSED, 8), {
    x: 1600 - 96 + 8,
    y: 900 - 96 + 8,
  })
})
