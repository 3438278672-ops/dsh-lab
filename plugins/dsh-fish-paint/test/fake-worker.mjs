#!/usr/bin/env node
// test/fake-worker.mjs
//
// 按 CONTRACT.md §3 的 JSONL 协议说话的假 worker，只给单测用：
//   引擎以为自己在跑 engine/worker.py，其实 pythonPath=process.execPath、workerScript=本文件。
// 行为由 FISH_FAKE_* 环境变量控制（见下方 switch），便于测崩溃/超时/串行/空闲退出。
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const modelPath = argValue('--model', '')
const dataDir = argValue('--data-dir', '')
const stateDir = path.join(dataDir || '.', 'state')
const env = process.env

// 守卫：只有引擎 spawn（带 --model/--data-dir）时才当 worker 跑。
// 否则 `node --test` 的自动发现会把本文件当测试文件执行，它会一直等 stdin 把测试挂死。
if (!args.includes('--model') || !args.includes('--data-dir')) {
  process.exit(0)
}


const readyDelayMs = numOf(env.FISH_FAKE_READY_DELAY_MS, 10)
const generateDelayMs = numOf(env.FISH_FAKE_GENERATE_DELAY_MS, 25)
const crashBudget = numOf(env.FISH_FAKE_CRASH_TIMES, 0)
const crashAlways = env.FISH_FAKE_CRASH_ALWAYS === '1'
const neverReady = env.FISH_FAKE_NO_READY === '1'
const withProgress = env.FISH_FAKE_PROGRESS === '1'
const silentGenerate = env.FISH_FAKE_SILENT_GENERATE === '1'
const ignoreShutdown = env.FISH_FAKE_IGNORE_SHUTDOWN === '1'
const emitBadJson = env.FISH_FAKE_BAD_JSON === '1'
const trackFile = env.FISH_FAKE_TRACK || ''

let activeGenerates = 0

function numOf(value, fallback) {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function track(kind) {
  if (!trackFile) return
  try {
    fs.mkdirSync(path.dirname(trackFile), { recursive: true })
    fs.appendFileSync(trackFile, `${kind}\n`)
  } catch {
    /* 测试辅助，写不进去不影响 */
  }
}

function logLine(text) {
  try {
    fs.mkdirSync(stateDir, { recursive: true })
    fs.appendFileSync(path.join(stateDir, 'worker.log'), `${text}\n`)
  } catch {
    /* 测试辅助 */
  }
}

/** 崩溃次数跨进程持久化：FISH_FAKE_CRASH_TIMES=1 表示「总共只崩一次」，重试的进程就能成功。 */
function takeCrashBudget() {
  if (!crashAlways && crashBudget <= 0) return false
  if (crashAlways) return true
  const file = path.join(stateDir, 'fake-crash-budget')
  let used = 0
  try {
    used = Number(fs.readFileSync(file, 'utf8')) || 0
  } catch {
    used = 0
  }
  if (used >= crashBudget) return false
  try {
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(file, String(used + 1), 'utf8')
  } catch {
    /* 写不进去就按余量算 */
  }
  return true
}

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function onGenerate(message) {
  activeGenerates += 1
  if (activeGenerates > 1) track('overlap')
  track(`generate:${message.prompt}`)
  try {
    if (emitBadJson) process.stdout.write('这是一行故意写坏的噪声\n')
    if (takeCrashBudget()) {
      process.stderr.write(`fake worker: 按设置故意崩溃（prompt=${message.prompt}）\n`)
      logLine('fake worker 故意崩溃')
      process.exit(1)
    }
    const prompt = String(message.prompt || '')
    if (prompt.includes('trigger-error')) {
      write({ id: message.id, type: 'error', code: 'OOM', message: 'CUDA out of memory', hint: '显存不够：试试更小的尺寸或降低 steps' })
      return
    }
    if (silentGenerate) {
      track('silent')
      return // 故意不回，让引擎侧 OP_TIMEOUT
    }
    if (withProgress) write({ id: message.id, type: 'progress', stage: 'load', step: 0, total: 1 })
    await sleep(generateDelayMs)
    const outDir = String(message.outDir || path.join(dataDir, 'out'))
    fs.mkdirSync(outDir, { recursive: true })
    const count = Math.max(1, Math.min(4, Number(message.count) || 1))
    const baseSeed = Number.isFinite(Number(message.seed)) && Number(message.seed) >= 0 ? Number(message.seed) : 12345
    const images = []
    for (let i = 0; i < count; i += 1) {
      const seed = baseSeed + i
      const file = path.join(outDir, `${stamp()}-${seed}.png`)
      fs.writeFileSync(file, 'fake-png')
      images.push({ path: file, seed, width: Number(message.width) || 1024, height: Number(message.height) || 1024 })
    }
    if (withProgress) write({ id: message.id, type: 'progress', stage: 'generate', step: 1, total: 1, variant: count })
    write({
      id: message.id,
      type: 'done',
      images,
      elapsedSec: 0.42,
      loadSec: 0,
      vramMode: env.FISH_PAINT_VRAM || 'auto',
      model: path.basename(modelPath || 'fake-model'),
    })
  } finally {
    activeGenerates -= 1
  }
}

function onStatus(message) {
  write({
    id: message.id,
    type: 'status',
    loaded: true,
    loading: false,
    vramMode: env.FISH_PAINT_VRAM || 'auto',
    device: 'cuda',
    gpu: { totalMiB: 8192, freeMiB: 5300 },
    loadSec: 41.2,
    model: path.basename(modelPath || 'fake-model'),
  })
}

track('start')
if (!neverReady) {
  setTimeout(() => {
    write({
      type: 'ready',
      pid: process.pid,
      python: process.version,
      torch: '2.5.1+cu124',
      diffusers: '0.31.0',
      cuda: true,
      deviceName: 'NVIDIA GeForce RTX 3070 (fake)',
      modelPath,
    })
  }, readyDelayMs)
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    process.stderr.write('fake worker: 收到非 JSON 输入行\n')
    return
  }
  switch (message.op) {
    case 'generate':
      onGenerate(message).catch((error) => {
        write({ id: message.id, type: 'error', code: 'INTERNAL', message: String(error?.message || error), hint: String(error?.message || error) })
      })
      break
    case 'status':
      onStatus(message)
      break
    case 'ping':
      write({ id: message.id, type: 'pong' })
      break
    case 'load':
      write({ id: message.id, type: 'loaded', loaded: true })
      break
    case 'shutdown':
      if (!ignoreShutdown) {
        write({ id: message.id, type: 'bye' })
        process.exit(0)
      }
      break
    default:
      write({ id: message.id, type: 'error', code: 'BAD_REQUEST', message: `unknown op: ${message.op}`, hint: `未知操作 ${message.op}` })
  }
})

rl.on('close', () => {
  // stdin EOF = 父进程关了管道，按契约正常退出
  process.exit(0)
})
