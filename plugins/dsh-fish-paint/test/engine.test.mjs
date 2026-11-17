// lib/engine.js 的单测：用 test/fake-worker.mjs 冒充 engine/worker.py，真起真杀进程。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../lib/engine.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fakeWorker = path.join(here, 'fake-worker.mjs')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 每个用例一个临时插件根：假模型文件 + 假 venv 用当前 node 冒充 python。 */
function makeEnv({ env = {}, engineOptions = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-paint-engine-'))
  fs.mkdirSync(path.join(root, 'engine'), { recursive: true })
  fs.writeFileSync(path.join(root, 'engine', 'worker.py'), '# 单测占位\n')
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true })
  const modelPath = path.join(dataDir, 'models', 'Illustrious-XL-v2.0.safetensors')
  fs.writeFileSync(modelPath, 'fake-model')
  const engine = createEngine({
    root,
    dataDir,
    pythonPath: process.execPath,
    modelPath,
    workerScript: fakeWorker,
    idleMinutes: 0,
    readyTimeoutMs: 5000,
    generateTimeoutMs: 5000,
    statusTimeoutMs: 2000,
    env,
    ...engineOptions,
  })
  const cleanup = () => {
    try {
      engine.dispose()
    } catch {
      /* 已经关掉 */
    }
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* Windows 上刚 kill 的进程可能还占着 cwd，临时目录留着无妨 */
    }
  }
  return { root, dataDir, modelPath, engine, cleanup }
}

function request(dataDir, prompt, extra = {}) {
  return {
    prompt,
    negative: 'lowres, bad quality',
    width: 1024,
    height: 1024,
    steps: 8,
    cfg: 5.5,
    seed: 700,
    count: 1,
    clipSkip: 2,
    outDir: path.join(dataDir, 'out', 'test'),
    ...extra,
  }
}

test('generate：spawn worker、按 id 分发 JSONL、返回图片列表与 pid 文件', async () => {
  const { engine, dataDir, cleanup } = makeEnv()
  try {
    const done = await engine.generate(request(dataDir, '1girl, solo', { count: 2 }))
    assert.equal(done.type, 'done')
    assert.equal(done.images.length, 2)
    assert.deepEqual(
      done.images.map((image) => image.seed),
      [700, 701],
    )
    for (const image of done.images) assert.ok(fs.existsSync(image.path), `图片应存在：${image.path}`)
    assert.equal(engine.isRunning(), true)
    const pidRecord = JSON.parse(fs.readFileSync(engine.paths.pidFile, 'utf8'))
    assert.ok(pidRecord.pid > 0)
  } finally {
    cleanup()
  }
})

test('串行队列：两个 generate 同时调用不会并发进 worker', async () => {
  const track = path.join(os.tmpdir(), `fish-paint-track-${process.pid}-${Date.now()}.log`)
  const { engine, dataDir, cleanup } = makeEnv({
    env: { FISH_FAKE_TRACK: track, FISH_FAKE_GENERATE_DELAY_MS: '80' },
  })
  try {
    const [first, second] = await Promise.all([
      engine.generate(request(dataDir, 'A')),
      engine.generate(request(dataDir, 'B')),
    ])
    assert.equal(first.images.length, 1)
    assert.equal(second.images.length, 1)
    const events = fs.readFileSync(track, 'utf8').split('\n').filter(Boolean)
    assert.ok(!events.includes('overlap'), `不应该并发：${events.join(' / ')}`)
    assert.deepEqual(events.filter((event) => event.startsWith('generate:')), ['generate:A', 'generate:B'])
    assert.equal(events.filter((event) => event === 'start').length, 1, '同一个 worker 进程就够了')
  } finally {
    cleanup()
    try {
      fs.rmSync(track, { force: true })
    } catch {
      /* 忽略 */
    }
  }
})

test('崩溃自动重启：同一请求最多重试 1 次，重试成功', async () => {
  const track = path.join(os.tmpdir(), `fish-paint-track-${process.pid}-${Date.now()}.log`)
  const { engine, dataDir, cleanup } = makeEnv({
    env: { FISH_FAKE_CRASH_TIMES: '1', FISH_FAKE_TRACK: track },
  })
  try {
    const done = await engine.generate(request(dataDir, 'crash once'))
    assert.equal(done.images.length, 1)
    const events = fs.readFileSync(track, 'utf8').split('\n').filter(Boolean)
    assert.equal(events.filter((event) => event === 'start').length, 2, '崩一次后应重启一个新进程')
  } finally {
    cleanup()
    try {
      fs.rmSync(track, { force: true })
    } catch {
      /* 忽略 */
    }
  }
})

test('连续崩溃进入冷却：重试 1 次后仍是 CRASH，下一次直接 COOLDOWN', async () => {
  const { engine, dataDir, cleanup } = makeEnv({
    env: { FISH_FAKE_CRASH_ALWAYS: '1' },
    engineOptions: { maxCrashes: 2, cooldownMs: 60_000 },
  })
  try {
    const first = await engine.generate(request(dataDir, 'always crash')).then(
      () => null,
      (error) => error,
    )
    assert.equal(first?.code, 'CRASH')
    const second = await engine.generate(request(dataDir, 'again')).then(
      () => null,
      (error) => error,
    )
    assert.equal(second?.code, 'COOLDOWN')
    assert.match(second.message, /冷却/)
  } finally {
    cleanup()
  }
})

test('错误映射：worker error 行优先用 hint 作为 message', async () => {
  const { engine, dataDir, cleanup } = makeEnv()
  try {
    const error = await engine.generate(request(dataDir, 'trigger-error')).then(
      () => null,
      (err) => err,
    )
    assert.ok(error, '应该 reject')
    assert.equal(error.code, 'OOM')
    assert.match(error.message, /显存/)
    assert.equal(error.workerCode, 'OOM')
  } finally {
    cleanup()
  }
})

test('未安装：python / worker 缺失时给 draw_setup install 的人话错误', async () => {
  const { engine, dataDir, cleanup } = makeEnv({
    engineOptions: { pythonPath: path.join(os.tmpdir(), `definitely-missing-python-${Date.now()}.exe`) },
  })
  try {
    const error = await engine.generate(request(dataDir, 'no engine')).then(
      () => null,
      (err) => err,
    )
    assert.equal(error?.code, 'NOT_INSTALLED')
    assert.match(error.message, /draw_setup install/)
  } finally {
    cleanup()
  }
})

test('启动超时：worker 迟迟不发 ready 时报 START_TIMEOUT', async () => {
  const { engine, dataDir, cleanup } = makeEnv({
    env: { FISH_FAKE_NO_READY: '1' },
    engineOptions: { readyTimeoutMs: 400 },
  })
  try {
    const error = await engine.generate(request(dataDir, 'no ready')).then(
      () => null,
      (err) => err,
    )
    assert.equal(error?.code, 'START_TIMEOUT')
  } finally {
    cleanup()
  }
})

test('操作超时：worker 不回 done 时报 OP_TIMEOUT', async () => {
  const { engine, dataDir, cleanup } = makeEnv({
    env: { FISH_FAKE_SILENT_GENERATE: '1' },
    engineOptions: { generateTimeoutMs: 400 },
  })
  try {
    const error = await engine.generate(request(dataDir, 'silent')).then(
      () => null,
      (err) => err,
    )
    assert.equal(error?.code, 'OP_TIMEOUT')
  } finally {
    cleanup()
  }
})

test('空闲退出：idleMinutes 到点后 worker 自己停掉并清 pid 文件', async () => {
  const { engine, dataDir, cleanup } = makeEnv({ engineOptions: { idleMinutes: 0.02 } }) // 1.2 秒
  try {
    await engine.generate(request(dataDir, 'idle'))
    const deadline = Date.now() + 8000
    while (engine.isRunning() && Date.now() < deadline) await sleep(100)
    assert.equal(engine.isRunning(), false, '空闲到点应该自己退出')
    assert.equal(fs.existsSync(engine.paths.pidFile), false, 'pid 文件应清掉')
  } finally {
    cleanup()
  }
})

test('status：running/ready/worker 状态与安装探测', async () => {
  const { engine, dataDir, cleanup } = makeEnv()
  try {
    await engine.generate(request(dataDir, 'status test'))
    const info = await engine.status()
    assert.equal(info.installed, true)
    assert.equal(info.running, true)
    assert.equal(info.ready, true)
    assert.equal(info.worker?.type, 'status')
    assert.equal(info.worker?.loaded, true)
    assert.equal(info.error, null)
  } finally {
    cleanup()
  }
})

test('shutdown：优雅停掉 worker、清 pid 文件', async () => {
  const { engine, dataDir, cleanup } = makeEnv()
  try {
    await engine.generate(request(dataDir, 'bye'))
    const result = await engine.shutdown('单测')
    assert.equal(result.ok, true)
    assert.equal(engine.isRunning(), false)
    assert.equal(fs.existsSync(engine.paths.pidFile), false)
  } finally {
    cleanup()
  }
})

test('stdout 噪声行不会把引擎搞挂（坏 JSON 忽略）', async () => {
  const { engine, dataDir, cleanup } = makeEnv({ env: { FISH_FAKE_BAD_JSON: '1' } })
  try {
    const done = await engine.generate(request(dataDir, 'noise'))
    assert.equal(done.images.length, 1)
  } finally {
    cleanup()
  }
})
