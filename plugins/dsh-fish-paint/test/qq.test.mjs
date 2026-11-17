// lib/qq.js 的探测单测：桥目录不能只看「有 config.json」——名字和结构都要像 qq-bridge，
// 否则会把 .ai_completion 这类同样带 config.json 的目录误认成桥（2026-11-17 真机踩过）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectBridgeDir, isBridgeDir } from '../lib/qq.js'

const BRIDGE_CONFIG = {
  ownerQQ: 2220222310,
  allow: { groups: [1104418054], private: [] },
  deny: { groups: [], private: [] },
  r18: { groups: [], private: [] },
  snowluma: { httpUrl: 'http://127.0.0.1:3000', accessToken: 'x' },
  consolePort: 8787,
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-paint-qq-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function mkConfig(dir, config) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config))
  return dir
}

function mkBridge(dir, config = BRIDGE_CONFIG) {
  return mkConfig(dir, config)
}

test('isBridgeDir：只有结构像 qq-bridge 的 config.json 才算', (t) => {
  const root = tempRoot(t)
  assert.equal(isBridgeDir(mkBridge(path.join(root, 'qq-bridge'))), true)

  // 别的工具也有 config.json，但没有 allow 名单 + 桥接字段 → 不算桥
  assert.equal(isBridgeDir(mkConfig(path.join(root, 'some-tool'), { model: 'x', endpoint: 'y' })), false)
  assert.equal(isBridgeDir(mkConfig(path.join(root, 'allow-only'), { allow: { groups: [] } })), false)

  const broken = path.join(root, 'broken')
  fs.mkdirSync(broken)
  fs.writeFileSync(path.join(broken, 'config.json'), '{ not json')
  assert.equal(isBridgeDir(broken), false)

  assert.equal(isBridgeDir(path.join(root, 'missing')), false)
  assert.equal(isBridgeDir(''), false)
})

test('detectBridgeDir：根目录下的 qq-bridge-* 能认出来', (t) => {
  const root = tempRoot(t)
  const bridge = mkBridge(path.join(root, 'qq-bridge-0.2.1-r1'))
  assert.equal(detectBridgeDir({ roots: [root] }), bridge)
})

test('detectBridgeDir：支持 xx/qq-bridge-x/qq-bridge-x 双层整合包结构', (t) => {
  const root = tempRoot(t)
  const nested = mkBridge(path.join(root, 'DPQQ', 'qq-bridge-0.2.1-r1', 'qq-bridge-0.2.1-r1'))
  assert.equal(detectBridgeDir({ roots: [root] }), nested)
})

test('detectBridgeDir：不把别的工具的 config.json 当成桥', (t) => {
  const root = tempRoot(t)
  mkConfig(path.join(root, '.ai_completion'), { apiKey: 'x', model: 'y' })
  mkConfig(path.join(root, 'tools', '.ai_completion'), { apiKey: 'x' })
  assert.equal(detectBridgeDir({ roots: [root] }), '')
})

test('detectBridgeDir：名字像但结构不对时继续找，不误报', (t) => {
  const root = tempRoot(t)
  mkConfig(path.join(root, 'qq-bridge-fake'), { model: 'x' })
  const real = mkBridge(path.join(root, 'apps', 'qqbridge'))
  assert.equal(detectBridgeDir({ roots: [root] }), real)
})

test('detectBridgeDir：多个候选时优先浅层', (t) => {
  const root = tempRoot(t)
  const shallow = mkBridge(path.join(root, 'qq-bridge-a'))
  mkBridge(path.join(root, 'nested', 'qq-bridge-b', 'qq-bridge-b'))
  assert.equal(detectBridgeDir({ roots: [root] }), shallow)
})
