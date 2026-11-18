import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  defaultRuntimeRoot,
  electronExe,
  ensureRuntime,
  githubUrl,
  isAsciiPath,
  markerPath,
  mirrorUrl,
  runtimeDir,
  runtimeRootOf,
  runtimeStatus,
  zipName,
} from '../lib/runtime.js'

test('zip 名与下载地址', () => {
  const zip = zipName('44.0.0', 'win32', 'x64')
  assert.equal(zip, 'electron-v44.0.0-win32-x64.zip')
  assert.equal(mirrorUrl('https://registry.npmmirror.com/-/binary/electron/', '44.0.0', zip), `https://registry.npmmirror.com/-/binary/electron/v44.0.0/${zip}`)
  assert.equal(githubUrl('44.0.0', zip), `https://github.com/electron/electron/releases/download/v44.0.0/${zip}`)
  assert.throws(() => zipName('44.0.0', 'plan9', 'x64'), /不认识的平台/)
})

test('运行目录与 exe 名', () => {
  assert.equal(electronExe('win32'), 'electron.exe')
  assert.equal(electronExe('linux'), 'electron')
  assert.equal(runtimeDir('D:\\data', '44.0.0'), join('D:\\data', 'engine', 'runtime', '44.0.0'))
  assert.equal(markerPath('D:\\data', '44.0.0'), join('D:\\data', 'engine', 'runtime', '.complete-44.0.0'))
})

test('中文路径的 dataDir 不拿来放运行时（Chromium 从那起会崩）', () => {
  const cnDir = 'D:\\新建文件夹\\DSK\\dsh-floatball\\data'
  assert.equal(isAsciiPath(cnDir), false)
  const root = runtimeRootOf(cnDir)
  assert.equal(isAsciiPath(root), true, '兜底目录必须纯 ASCII')
  assert.equal(root, defaultRuntimeRoot())
  const dir = runtimeDir(cnDir, '44.0.0')
  assert.equal(isAsciiPath(dir), true)
  // 显式配置优先
  assert.equal(runtimeRootOf(cnDir, 'C:\\rt'), 'C:\\rt')
})

test('没装好就是 ok:false', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ball-runtime-'))
  const status = await runtimeStatus({ dataDir, version: '44.0.0' })
  assert.equal(status.ok, false)
  assert.match(status.exe, /electron\.exe$/)
})

test('exe 够大且有 marker 才算装好，ensureRuntime 不再下载', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ball-runtime-'))
  const dir = runtimeDir(dataDir, '44.0.0')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'electron.exe'), Buffer.alloc(11 * 1024 * 1024))
  const half = await runtimeStatus({ dataDir, version: '44.0.0' })
  assert.equal(half.ok, false, '没有 marker 时不算装好')

  await writeFile(markerPath(dataDir, '44.0.0'), '{"version":"44.0.0"}', 'utf8')
  const status = await runtimeStatus({ dataDir, version: '44.0.0' })
  assert.equal(status.ok, true)

  const lines = []
  const ensured = await ensureRuntime({ dataDir, version: '44.0.0', log: (line) => lines.push(line) })
  assert.equal(ensured.ok, true)
  assert.equal(ensured.installed, false)
  assert.deepEqual(lines, [], '已装好时不该有任何下载动作')
})

test('自定义 electronPath 直接认', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ball-runtime-'))
  const exe = join(dataDir, 'my-electron.exe')
  await writeFile(exe, Buffer.alloc(1024))
  const status = await runtimeStatus({ dataDir, version: '44.0.0', electronPath: exe })
  assert.equal(status.ok, true)
  assert.equal(status.custom, true)
})

test('中文路径下的旧运行时会被搬到 ASCII 目录复用，不重新下载', async () => {
  // 用临时目录模拟「旧位置」（真实场景是含中文的插件 data 目录，逻辑相同）
  const realData = await mkdtemp(join(tmpdir(), 'ball-runtime-'))
  const legacyDir = join(realData, 'engine', 'runtime', '44.0.0')
  await mkdir(legacyDir, { recursive: true })
  await writeFile(join(legacyDir, electronExe()), Buffer.alloc(11 * 1024 * 1024))

  const runtimeRoot = await mkdtemp(join(tmpdir(), 'ball-runtime-root-'))
  const lines = []
  const ensured = await ensureRuntime({ dataDir: realData, version: '44.0.0', runtimeRoot, log: (line) => lines.push(line) })
  assert.equal(ensured.ok, true)
  assert.equal(ensured.adopted, true, '应复用旧位置而不是重新下载')
  assert.equal(ensured.dir, join(runtimeRoot, '44.0.0'))
  assert.ok(lines.some((line) => line.includes('复制')), '日志里应说明是复制的')
})
