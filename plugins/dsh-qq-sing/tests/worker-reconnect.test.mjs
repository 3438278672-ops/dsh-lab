/**
 * worker 的「桥重启」重连测试：语音发到一半桥挂了（或正在重启），worker 要能等回来接着发。
 *
 * 这个场景 2026-10-27 真实踩过：桥重启 12s，worker 只重试 15s，最后一首 4/5 段就断了。
 *
 * 做法：先用一个临时端口占位再关掉，worker 前几秒统统拒连；8 秒后再在同端口起假桥，
 * 于是 worker 必须靠自己的重试把它等回来，5 段全发完、状态 done、退出码 0。
 *
 *   node tests/worker-reconnect.test.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKER = path.join(PLUGIN_DIR, 'worker.mjs')
const SONG = '重连测试'
const SEGMENTS = 5
const DOWN_MS = 8000
const KEEP = process.env.KEEP === '1'

const tmp = await mkdtemp(path.join(os.tmpdir(), 'qqsing-reconnect-'))
const home = path.join(tmp, 'home')
const jobDir = path.join(home, 'jobs', 'sing-reconnect-test')
const mediaDir = path.join(tmp, 'media')
await mkdir(jobDir, { recursive: true })
await mkdir(mediaDir, { recursive: true })
for (let i = 1; i <= SEGMENTS; i += 1) {
  await writeFile(path.join(mediaDir, `seg${i}.wav`), 'RIFFxxxx', 'utf8')
}

const fakeFetch = path.join(tmp, 'fake-fetch.mjs')
await writeFile(
  fakeFetch,
  `console.log('RESULT=' + JSON.stringify({ ok: true, title: ${JSON.stringify(SONG)}, bvid: 'BV1xx411c7mD', duration: 30, file: ${JSON.stringify(path.join(mediaDir, 'src.wav'))} }))\n`,
  'utf8',
)
const fakePipeline = path.join(tmp, 'fake-pipeline.mjs')
await writeFile(
  fakePipeline,
  [
    `const segments = []`,
    `for (let i = 1; i <= ${SEGMENTS}; i += 1) segments.push({ file: ${JSON.stringify(mediaDir)} + '/seg' + i + '.wav' })`,
    `console.log('SEGMENTS=${SEGMENTS}')`,
    `console.log('RESULT=' + JSON.stringify({ ok: true, segments, total: 30, pitch: 0, style: '', adlibs: 0 }))`,
  ].join('\n'),
  'utf8',
)

// 先占一个端口再放掉，后面在同一个端口起服务
const probe = createServer(() => {})
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port
await new Promise((resolve) => probe.close(resolve))

let sends = 0
async function startBridge() {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/api/voice/send') {
        sends += 1
        res.end(JSON.stringify({ ok: true, messageId: 2000 + sends, verified: true }))
        return
      }
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return server
}

const jobFile = path.join(jobDir, 'job.json')
await writeFile(
  jobFile,
  JSON.stringify(
    {
      jobId: 'sing-reconnect-test',
      home,
      jobDir,
      song: SONG,
      requester: '888888',
      whitelisted: true,
      target: 'group:1',
      bridgeUrl: `http://127.0.0.1:${port}`,
      bridgeDir: '',
      consoleToken: 'test-token',
      pythonBili: process.execPath,
      pythonRvc: process.execPath,
      fetchScript: fakeFetch,
      pipelineScript: fakePipeline,
      credentialFile: '',
      minIntervalMs: 30,
      maxSegments: 10,
      maxSongMinutes: 9,
      announce: false,
      exposePaths: false,
    },
    null,
    2,
  ),
  'utf8',
)

const startedAt = Date.now()
let stderr = ''
const child = spawn(process.execPath, [WORKER, jobFile], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
child.stderr.on('data', (chunk) => {
  stderr += chunk
})
child.stdout.on('data', () => {})

// 桥「重启」：前 8 秒不在，之后回来
let server = null
const bridgeUp = new Promise((resolve) => {
  setTimeout(async () => {
    server = await startBridge()
    resolve()
  }, DOWN_MS)
})
const exitCode = await new Promise((resolve) => {
  child.on('exit', (code) => resolve(code ?? -1))
  child.on('error', () => resolve(-1))
})
await bridgeUp
const elapsedMs = Date.now() - startedAt

try {
  const log = await readFile(path.join(jobDir, 'worker.log'), 'utf8').catch(() => '')
  assert.equal(exitCode, 0, `桥回来后应当唱完收工，退出码 ${exitCode}；stderr=${stderr}\nlog:\n${log}`)
  assert.equal(stderr.trim(), '', `不该有 stderr：${stderr}`)
  assert.equal(sends, SEGMENTS, `5 段都要发出去，实际发了 ${sends}`)
  const state = JSON.parse(await readFile(path.join(home, 'state.json'), 'utf8'))
  assert.equal(state.stage, 'done')
  assert.equal(state.sent, SEGMENTS)
  assert.match(log, /发送网络异常（第 1 次）/, '应当走过拒连重试')
  console.log('PASS', `survived a ${DOWN_MS}ms bridge outage, sent ${sends} segments in ${elapsedMs}ms`)
  console.log('PASS', 'state = done, exit 0')
  console.log('\nworker reconnect OK')
} finally {
  if (server) await new Promise((resolve) => server.close(resolve))
  if (KEEP) {
    console.log('kept:', tmp)
    console.log('stderr:', stderr || '(empty)')
  } else {
    await rm(tmp, { recursive: true, force: true })
  }
}
