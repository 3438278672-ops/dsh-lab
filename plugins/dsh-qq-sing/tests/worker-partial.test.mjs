/**
 * worker 的「部分发送」语义测试：用假 python（其实是 node）+ 假桥，跑一遍真 worker。
 *
 * 要证明三件事：
 *   1. 发到第 2 条撞上「每小时」限流 → 立刻判死，不再傻等 8×61s；
 *   2. 状态是 partial 而不是 error，文案里带「第 2/5 段」；
 *   3. 已经发出去 2 段 → 不退点歌 CD（旧行为会退，导致同一首被从头重听）。
 *
 *   node tests/worker-partial.test.mjs
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
const REQUESTER = '777777'
const SONG = '测试歌'
const KEEP = process.env.KEEP === '1'

const tmp = await mkdtemp(path.join(os.tmpdir(), 'qqsing-worker-'))
const home = path.join(tmp, 'home')
const jobDir = path.join(home, 'jobs', 'sing-partial-test')
const mediaDir = path.join(tmp, 'media')
await mkdir(jobDir, { recursive: true })
await mkdir(mediaDir, { recursive: true })

const SEGMENTS = 5
for (let i = 1; i <= SEGMENTS; i += 1) {
  await writeFile(path.join(mediaDir, `seg${i}.wav`), 'RIFFxxxx', 'utf8')
}

// ── 假 python：node 直接执行，吐出 worker 认的 RESULT= / STAGE= / SEGMENTS= ──────
const fakeFetch = path.join(tmp, 'fake-fetch.mjs')
await writeFile(
  fakeFetch,
  `console.log('RESULT=' + JSON.stringify({ ok: true, title: ${JSON.stringify(SONG)}, bvid: 'BV1xx411c7mD', duration: 60, file: ${JSON.stringify(path.join(mediaDir, 'src.wav'))} }))\n`,
  'utf8',
)
const fakePipeline = path.join(tmp, 'fake-pipeline.mjs')
await writeFile(
  fakePipeline,
  [
    `console.log('STAGE=separate')`,
    `console.log('SEGMENTS=${SEGMENTS}')`,
    `const segments = []`,
    `for (let i = 1; i <= ${SEGMENTS}; i += 1) segments.push({ file: ${JSON.stringify(mediaDir)} + '/seg' + i + '.wav' })`,
    `console.log('RESULT=' + JSON.stringify({ ok: true, segments, total: 60, pitch: 0, style: '', adlibs: 0 }))`,
  ].join('\n'),
  'utf8',
)

// ── 假桥：第 1、2 条成功，第 3 条起报「每小时」限流 ────────────────────────────
let sends = 0
const said = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    const payload = body ? JSON.parse(body) : {}
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/voice/send') {
      sends += 1
      if (sends <= 2) {
        res.end(JSON.stringify({ ok: true, messageId: 1000 + sends, verified: true }))
      } else {
        res.end(JSON.stringify({ ok: false, error: '语音发送频率超限（每小时最多 30 条），请稍后再试' }))
      }
      return
    }
    if (req.url === '/api/test-send') {
      said.push(String(payload.message ?? ''))
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.end(JSON.stringify({ ok: true }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const jobFile = path.join(jobDir, 'job.json')
await writeFile(
  jobFile,
  JSON.stringify(
    {
      jobId: 'sing-partial-test',
      home,
      jobDir,
      song: SONG,
      requester: REQUESTER,
      whitelisted: false,
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
      announce: true,
      exposePaths: false,
    },
    null,
    2,
  ),
  'utf8',
)
await writeFile(
  path.join(home, 'cooldown.json'),
  JSON.stringify({ [REQUESTER]: { at: Date.now(), song: SONG, target: 'group:1' } }),
  'utf8',
)

const startedAt = Date.now()
let stderr = ''
const exitCode = await new Promise((resolve) => {
  const child = spawn(process.execPath, [WORKER, jobFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  child.stdout.on('data', () => {})
  child.on('exit', (code) => resolve(code ?? -1))
  child.on('error', () => resolve(-1))
})
const elapsedMs = Date.now() - startedAt

try {
  // 退出码要干净地是 1：以前直接 process.exit() 会撞 libuv 断言，落成 0xC0000409
  assert.equal(exitCode, 1, `失败任务应当退出码 1，实际 ${exitCode}${stderr ? `\nstderr: ${stderr}` : ''}`)
  assert.equal(stderr.trim(), '', `worker 不该往 stderr 写东西：${stderr}`)
  const state = JSON.parse(await readFile(path.join(home, 'state.json'), 'utf8'))
  assert.equal(state.stage, 'partial', `部分发送应当是 partial，实际 ${state.stage}；stderr: ${stderr}`)
  assert.equal(state.sent, 2)
  assert.equal(state.total, SEGMENTS)
  assert.match(String(state.stageText ?? ''), new RegExp(`第 2/${SEGMENTS} 段`), 'stageText 要写明唱到第几段')
  console.log('PASS', `partial state: ${state.stageText}`)

  assert.ok(elapsedMs < 60_000, `撞上每小时限流应当立刻判死，实际用了 ${elapsedMs}ms`)
  console.log('PASS', `hourly rate limit fails fast (${elapsedMs}ms)`)

  const cd = JSON.parse(await readFile(path.join(home, 'cooldown.json'), 'utf8'))
  assert.ok(cd[REQUESTER], '已经发出去 2 段，CD 不该退')
  console.log('PASS', 'partial send keeps cooldown')

  const text = said.join('\n')
  assert.match(text, new RegExp(`第 2/${SEGMENTS} 段`), `播报里要有段数，实际：${text}`)
  console.log('PASS', 'announcement names the progress')

  const lock = await readFile(path.join(home, 'busy.lock'), 'utf8').catch(() => '')
  assert.equal(lock, '', '失败收尾要清掉 busy.lock')
  console.log('PASS', 'busy.lock released')

  console.log('\nworker partial OK')
} finally {
  await new Promise((resolve) => server.close(resolve))
  if (KEEP) {
    console.log('kept:', tmp)
    console.log('stderr:', stderr || '(empty)')
  } else {
    await rm(tmp, { recursive: true, force: true })
  }
}
