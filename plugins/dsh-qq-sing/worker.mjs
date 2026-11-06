/**
 * dsh-qq-sing 的后台 worker（detached，独立于 DSH 进程）。
 *
 * 一个 job = 一首歌：
 *   1. fetch_song.py  去 B 站搜/挑/下载（输出 RESULT=JSON）
 *   2. pipeline.py    ffmpeg + UVR5 分离 + 静音切段 + RVC 批量翻唱 + 分段混音（输出 RESULT=JSON）
 *   3. 逐条 POST /api/voice/send（严格按 minIntervalMs 钉节奏，遇 429 等 61s 重试）
 *
 * 状态写进 <home>/state.json（插件用它判断忙不忙），跑完清 <home>/busy.lock。
 * 所有日志进 jobs/<jobId>/worker.log。
 */
import { spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveNames as lookupNames } from './names.mjs'
import { clearCooldown, readCooldowns } from './cooldown.mjs'

const jobFile = process.argv[2]
if (!jobFile) {
  console.error('usage: node worker.mjs <job.json>')
  process.exit(2)
}

const job = JSON.parse(await readFile(jobFile, 'utf8'))
const statePath = join(job.home, 'state.json')
const lockPath = join(job.home, 'busy.lock')
const logPath = join(job.jobDir, 'worker.log')
const JOB_DEADLINE_MS = 40 * 60 * 1000

let state = {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  await appendFile(logPath, line, 'utf8').catch(() => {})
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

async function saveState(patch) {
  state = { ...state, ...patch, updatedAt: Date.now() }
  const tmp = `${statePath}.${process.pid}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
    await rename(tmp, statePath)
  } catch {
    await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8').catch(() => {})
    await unlink(tmp).catch(() => {})
  }
}

async function releaseLock() {
  try {
    const raw = await readFile(lockPath, 'utf8')
    const lock = JSON.parse(stripBom(raw))
    if (!lock?.jobId || lock.jobId === job.jobId) await unlink(lockPath)
  } catch {
    /* lock 不在就算了 */
  }
}

const historyPath = join(job.home, 'history.json')

/** 往 history.json 追加一条（给悬浮球/状态卡片看），保留最近 30 条。 */
async function appendHistory(extra = {}) {
  try {
    const list = JSON.parse(stripBom(await readFile(historyPath, 'utf8').catch(() => '[]'))) || []
    const entry = {
      jobId: job.jobId,
      song: job.song || '',
      title: state.title || '',
      target: job.target || '',
      targetName: state.targetName || '',
      requester: job.requester || '',
      requesterName: state.requesterName || '',
      ok: state.ok === true,
      stage: state.stage || '',
      error: state.error || '',
      total: Number(state.total) || 0,
      sent: Number(state.sent) || 0,
      startedAt: Number(state.startedAt) || 0,
      finishedAt: Number(state.finishedAt) || Date.now(),
      ...extra,
    }
    list.unshift(entry)
    const tmp = `${historyPath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(list.slice(0, 30), null, 2), 'utf8')
    await rename(tmp, historyPath)
  } catch {
    /* 历史只是展示用，坏了不影响唱歌 */
  }
}

/**
 * 把群名 / 点歌人昵称补进 state（悬浮球上要看的是人话，不是号码）。
 * 走桥 config.json 里的 SnowLuma OneBot HTTP；拿不到就算了。
 */
async function resolveNames() {
  try {
    const patch = await lookupNames({ bridgeDir: job.bridgeDir, target: job.target, requester: job.requester })
    if (Object.keys(patch).length) await saveState(patch)
  } catch {
    /* 名字只是锦上添花 */
  }
}

async function resolveToken() {
  const explicit = String(job.consoleToken ?? '').trim()
  if (explicit) return explicit
  try {
    const bridgeCfg = JSON.parse(stripBom(await readFile(join(job.bridgeDir, 'config.json'), 'utf8')))
    const fromCfg = String(bridgeCfg?.consoleToken ?? '').trim()
    if (fromCfg) return fromCfg
  } catch {
    /* 落到 state/console-token */
  }
  const fromState = stripBom(await readFile(join(job.bridgeDir, 'state', 'console-token'), 'utf8')).trim()
  if (!fromState) throw new Error('拿不到 QQ 桥控制台令牌')
  return fromState
}

/** B 站标题去掉【】标签后的短歌名。 */
function cleanTitle(raw) {
  const text = String(raw ?? '')
    .replace(/【[^】]*】/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[\s|｜/]+/g, ' ')
    .trim()
  return (text || String(raw ?? '')).slice(0, 30)
}

/** 播报里用的歌名：优先用 B 站解析出的标题（直接报 BV 号点歌时更像个歌名）。 */
function label() {
  return job.displayTitle || job.song
}

async function bridgePost(token, pathname, body, timeoutMs = 120000) {
  const base = String(job.bridgeUrl || '').replace(/\/+$/, '')
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const data = await response.json().catch(() => ({}))
  return { status: response.status, data }
}

/** 用桥的测试发送补一句人话（失败就存起来，下次启动补发——不能让人干等）。 */
async function sendText(target, text, token) {
  const [kind, id] = String(target || '').split(':')
  if (!kind || !id) return false
  const tk = token ?? (await resolveToken().catch(() => null))
  if (!tk) return false
  try {
    const { status, data } = await bridgePost(tk, '/api/test-send', { kind, id: Number(id), message: String(text).slice(0, 400) }, 30000)
    return status < 400 && data?.ok !== false
  } catch (error) {
    await log(`say 请求失败：${error?.message ?? error}`)
    return false
  }
}

const pendingPath = join(job.home, 'pending_announce.jsonl')

async function say(token, text) {
  if (job.announce === false) return
  const ok = await sendText(job.target, text, token)
  if (ok) return
  // 播报失败 = 群里彻底没下文。落盘，下次 worker 起来先补发。
  await appendFile(pendingPath, JSON.stringify({ at: Date.now(), target: job.target, text: String(text).slice(0, 400) }) + '\n', 'utf8').catch(() => {})
  await log(`播报没发出去，已落盘等下次补发：${String(text).slice(0, 60)}`)
}

/** 补发上次没发出去的播报（超过 6 小时的丢掉，别翻旧账）。 */
async function flushAnnounce(token) {
  let raw = ''
  try {
    raw = await readFile(pendingPath, 'utf8')
  } catch {
    return
  }
  const lines = raw.split(/\r?\n/).filter((line) => {
    if (!line) return false
    try {
      const entry = JSON.parse(line)
      return Date.now() - Number(entry?.at || 0) < 6 * 3600 * 1000
    } catch {
      return false
    }
  })
  if (!lines.length) {
    await writeFile(pendingPath, '', 'utf8').catch(() => {})
    return
  }
  const rest = []
  for (const line of lines) {
    let entry = null
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!(await sendText(entry.target, entry.text, token))) rest.push(line)
  }
  await writeFile(pendingPath, rest.length ? `${rest.join('\n')}\n` : '', 'utf8').catch(() => {})
  await log(`补发播报：${lines.length - rest.length} 条成功，${rest.length} 条还压着`)
}

/** 群里不该看到本机路径和整条命令行。 */
function humanError(message) {
  return String(message ?? '')
    .replace(/命令失败\([^)]*\)[^：:]*[：:]?/g, '翻唱工具报错')
    .replace(/[A-Za-z]:\\[^\s"'，。]*/g, '本地文件')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 连子进程一起杀（timeout 只 kill 一层会留下占着显存的孤儿 RVC）。 */
function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false)
    try {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      child.on('error', () => resolve(false))
      child.on('exit', (code) => resolve(code === 0))
    } catch {
      resolve(false)
    }
  })
}

/**
 * 跑一个子进程，按行回调 stdout，stderr 记日志。
 * 不设 stdout 上限：pipeline 的输出里有几条体积很小的 STAGE / RESULT 行。
 */
function runProcess(command, args, { onLine, timeoutMs = 20 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      // RVC 的 CUDA Graph 对每种音频长度都要重新捕获（每段 ~55s），批量短音频反而慢 15 倍
      RVC_CUDA_GRAPH: '0',
    }
    const child = spawn(command, args, { windowsHide: true, env })
    let out = ''
    let errTail = ''
    let pending = ''
    const timer = setTimeout(() => {
      // 只 kill 一层会留下孤儿 python 占着显存，下一个 job 直接 OOM
      killTree(child.pid).then(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      })
      reject(new Error(`命令超时（${Math.round(timeoutMs / 60000)} 分钟），已杀掉进程树`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      out += text
      if (!onLine) return
      pending += text
      let index = pending.indexOf('\n')
      while (index >= 0) {
        const line = pending.slice(0, index).trim()
        pending = pending.slice(index + 1)
        if (line) {
          try {
            onLine(line)
          } catch (error) {
            log(`onLine 异常：${error?.message ?? error}`)
          }
        }
        index = pending.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk) => {
      errTail = (errTail + chunk.toString('utf8')).slice(-8000)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err: errTail })
    })
  })
}

function lastJsonLine(text, prefix) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index].slice(prefix.length))
    } catch {
      /* 继续往上找 */
    }
  }
  return null
}

/** 取 `ERROR=xxx` 那一行的正文（pipeline / fetch 都是纯文本，不是 JSON）。 */
function lastErrorLine(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('ERROR='))
  return lines.length ? lines[lines.length - 1].slice(6) : ''
}

async function cleanupOldJobs() {
  const jobsRoot = join(job.home, 'jobs')
  try {
    const entries = await readdir(jobsRoot, { withFileTypes: true })
    const cutoff = Date.now() - 3 * 24 * 3600 * 1000
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(jobsRoot, entry.name)
      const info = await stat(full).catch(() => null)
      if (info && info.mtimeMs < cutoff) await rm(full, { recursive: true, force: true }).catch(() => {})
    }
  } catch {
    /* 没有历史目录 */
  }
}

const STAGE_TEXT = {
  extract: '正在拆音轨',
  separate: '正在分离人声和伴奏',
  plan: '正在按静音切段',
  rvc: '正在用 RVC 翻唱',
  adlib: '正在踩点加怪叫',
  mix: '正在混音',
  slice: '正在切语音条',
}

let phase = 'fetch'
// 进度放到模块作用域：失败收尾时要说清楚"唱到第几段断的"，也要据此决定退不退 CD
let sent = 0
let total = 0

/**
 * 发一条语音。重试策略区分三种失败：
 *  - 桥那边超时（TimeoutError）：**绝不重试** —— 语音可能已经入队，重试就是群里两条一样的；
 *  - 连不上桥（拒连/断线）：5s 一次、最多等 3 分钟（桥重启 10~20s，得撑住），超了才判死；
 *  - 限流：只有"每分钟"的桶值得等 61s（最多 2 次）；"每小时"满桶等 61s 根本没用，直接失败。
 */
async function sendVoice(token, file) {
  let attempt = 0
  let rateLimitWaits = 0
  // 桥重启要 10~20s（杀 3s + 起进程 + 开端口），所以硬拒连的窗口按 3 分钟算：
  // 卡住的是「这一条语音」，不是整个任务；job 本身还有 40 分钟死线兜着。
  const NET_RETRY_WINDOW_MS = 3 * 60 * 1000
  let netDeadline = 0
  for (;;) {
    attempt += 1
    let result
    try {
      result = await bridgePost(token, '/api/voice/send', { target: job.target, file, verify: true }, 180000)
    } catch (error) {
      const name = String(error?.name ?? '')
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new Error(`等桥回执超时（语音可能已经发出去了，不重试）：${error?.message ?? error}`)
      }
      if (!netDeadline) netDeadline = Date.now() + NET_RETRY_WINDOW_MS
      if (Date.now() < netDeadline) {
        await log(`发送网络异常（第 ${attempt} 次）：${error?.message ?? error}，5s 后重试`)
        await sleep(5000)
        continue
      }
      // fetch failed 这种原文群里看不懂，换成人话
      throw new Error(`连不上桥（${error?.message ?? error}）—— 桥可能正在重启，试了 ${attempt} 次都不通`)
    }
    netDeadline = 0
    const { status, data } = result
    if (data?.ok === true) return data
    const message = String(data?.error ?? `HTTP ${status}`)
    if (/频率超限/.test(message)) {
      const perHour = /小时/.test(message)
      if (!perHour && rateLimitWaits < 2) {
        rateLimitWaits += 1
        await log(`语音限流（每分钟桶）：${message}，等 61s 重试`)
        await sleep(61000)
        continue
      }
      throw new Error(message)
    }
    throw new Error(message)
  }
}

async function main() {
  const startedAt = Date.now()
  await mkdir(job.jobDir, { recursive: true })
  await log(`job 开始：${job.jobId} song=${job.song} target=${job.target}`)
  await cleanupOldJobs()

  const previous = JSON.parse((await readFile(statePath, 'utf8').catch(() => 'null')) ?? 'null') || {}
  state = {
    ...previous,
    jobId: job.jobId,
    pid: process.pid,
    song: job.song,
    title: '',
    target: job.target,
    targetName: '',
    requester: job.requester || '',
    requesterName: '',
    stage: 'download',
    stageText: '正在 B 站找歌',
    total: Number(previous?.total) || 0,
    sent: 0,
    startedAt: previous?.startedAt ?? startedAt,
    updatedAt: Date.now(),
    finishedAt: null,
    ok: null,
    error: '',
  }
  await saveState({})
  await resolveNames()

  const token = await resolveToken()
  // 上次失败时没发出去的播报，先补上
  await flushAnnounce(token)

  // ── 1. 找歌 + 下载 ──────────────────────────────────────────────
  const audioDir = join(job.jobDir, 'audio')
  await mkdir(audioDir, { recursive: true })
  const fetchResult = await runProcess(
    job.pythonBili,
    [
      job.fetchScript,
      '--song',
      job.song,
      '--workdir',
      audioDir,
      '--credential',
      job.credentialFile,
      '--max-minutes',
      String(job.maxSongMinutes),
    ],
    { timeoutMs: 10 * 60 * 1000 },
  )
  const fetched = lastJsonLine(fetchResult.out, 'RESULT=')
  if (!fetched?.ok) {
    const detail = lastErrorLine(fetchResult.out) || fetchResult.err.slice(-600)
    throw new Error(detail || `找歌失败：退出码 ${fetchResult.code}`)
  }
  await log(`取到：${fetched.title} (${fetched.bvid}) ${fetched.duration}s → ${fetched.file}`)
  // 长歌在跑流水线之前就拒掉：不然烧十几分钟 GPU，最后才在发语音那一步失败
  const maxSegments = Number(job.maxSegments) || 12
  const roughSegments = Math.ceil((Number(fetched.duration) || 0) / 48)
  if (roughSegments > maxSegments) {
    throw new Error(
      `这首歌 ${Math.round((Number(fetched.duration) || 0) / 60)} 分钟，要发约 ${roughSegments} 条语音（上限 ${maxSegments}），太长了，点首短点的吧`,
    )
  }
  job.displayTitle = cleanTitle(fetched.title)
  await saveState({
    stage: 'separate',
    stageText: `找到了《${fetched.title}》，正在分离人声和伴奏`,
    bvid: fetched.bvid,
    title: fetched.title,
    duration: fetched.duration,
  })

  // ── 2. 翻唱流水线 ──────────────────────────────────────────────
  phase = 'pipeline'
  const pipelineDir = join(job.jobDir, 'pipeline')
  let segments = null
  const pipelineResult = await runProcess(
    job.pythonRvc,
    [job.pipelineScript, '--input', fetched.file, '--workdir', pipelineDir,
     '--title', fetched.title ?? '', '--song', job.song ?? ''],
    {
      timeoutMs: 20 * 60 * 1000,
      onLine(line) {
        if (line.startsWith('STAGE=')) {
          const stage = line.slice(6).split(' ')[0]
          const extra = line.slice(6).split(' ')[1]
          saveState({
            stage,
            stageText: `${STAGE_TEXT[stage] ?? '正在处理'}${extra ? `（${extra}）` : ''}`,
          }).catch(() => {})
        } else if (line.startsWith('SEGMENTS=')) {
          const total = Number(line.slice(9))
          if (Number.isFinite(total) && total > 0) saveState({ total }).catch(() => {})
        }
      },
    },
  )
  const pipelineJson = lastJsonLine(pipelineResult.out, 'RESULT=')
  if (!pipelineJson?.ok) {
    const detail = lastErrorLine(pipelineResult.out) || pipelineResult.err.slice(-600)
    throw new Error(detail || `翻唱失败：退出码 ${pipelineResult.code}`)
  }
  segments = pipelineJson.segments ?? []
  if (!segments.length) throw new Error('翻唱没有产出任何语音段')
  if (segments.length > maxSegments) {
    throw new Error(`这首歌要发 ${segments.length} 条语音（上限 ${maxSegments}），太长了，点首短点的吧`)
  }
  await log(`流水线完成：${segments.length} 段，总长 ${pipelineJson.total ?? '?'}s，变调 ${pipelineJson.pitch ?? 0}，风格 ${pipelineJson.style || '无'}，怪叫 ${pipelineJson.adlibs ?? 0} 处`)

  // ── 3. 逐条发语音 ──────────────────────────────────────────────
  phase = 'send'
  total = segments.length
  sent = 0
  await saveState({ stage: 'send', stageText: '正在发语音', total, sent: 0 })
  let lastSentAt = 0
  for (const segment of segments) {
    if (Date.now() - startedAt > JOB_DEADLINE_MS) throw new Error('整首歌唱太久了（超过 40 分钟），先停下')
    const wait = lastSentAt + Number(job.minIntervalMs || 31000) - Date.now()
    if (wait > 0) await sleep(wait)
    await sendVoice(token, segment.file)
    lastSentAt = Date.now()
    sent += 1
    await saveState({ sent, stage: 'send', stageText: `正在发第 ${sent}/${total} 条` })
    await log(`已发 ${sent}/${total}：${segment.file}`)
  }

  await saveState({ stage: 'done', stageText: '唱完了', ok: true, finishedAt: Date.now(), total, sent })
  await appendHistory()
  await say(token, `🎤 《${label()}》唱完啦，${sent} 条语音。`)
  await log(`job 完成：${sent} 条`)
}

/**
 * 收尾退出。
 * 这里**不能**直接 process.exit()：Windows 上刚有子进程/spawn 的 async 句柄在关闭时硬退，
 * 会撞 libuv 的 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（退出码 0xC0000409）。
 * 把退出码交给事件循环自然收尾即可；兜底 8 秒还没退（比如 undici keep-alive 挂着）再硬退一次。
 */
function finish(code) {
  process.exitCode = code
  setTimeout(() => process.exit(code), 8000).unref()
}

main()
  .then(async () => {
    await releaseLock()
    finish(0)
  })
  .catch(async (error) => {
    const message = String(error?.message ?? error)
    // 群播报和 state.error 都会被展示在聊天里，路径/命令行先洗干净
    const human = humanError(message) || message
    // 已经发出去若干段 = 部分成功：群里听得到的那些不用假装没发生，CD 也不该退
    const partial = sent > 0
    await log(`job 失败：${message}（已发 ${sent}/${total}）`)
    try {
      await saveState({
        stage: partial ? 'partial' : 'error',
        stageText: partial ? `唱到第 ${sent}/${total || '?'} 段断了` : '没唱成',
        ok: false,
        error: human.slice(0, 300),
        sent,
        total,
        finishedAt: Date.now(),
      })
      await appendHistory()
      const token = await resolveToken().catch(() => null)
      if (token) {
        if (phase === 'fetch') {
          const detail = human.slice(0, 90)
          await say(token, `🎤 没找到能唱的版本：《${label()}》—— ${detail}。换个歌名，或者直接贴个 BV 号给我。`)
        } else if (phase === 'pipeline') {
          await say(token, `🎤 这首没唱成：《${label()}》—— 翻唱出了点问题：${human.slice(0, 120)}`)
        } else if (partial) {
          await say(
            token,
            `🎤 《${label()}》唱到第 ${sent}/${total || '?'} 段断了 —— ${human.slice(0, 90)}。` +
              '后面的先不补了，想听完整版过一会儿再点。',
          )
        } else {
          await say(token, `🎤 这首没唱成：《${label()}》—— 发语音出了点问题：${human.slice(0, 120)}`)
        }
      }
    } catch (inner) {
      await log(`收尾也失败了：${inner?.message ?? inner}`)
    }
    // 只有「一段都没发出去」才算没点过、退 CD。
    // 已经发出几段还退 CD 的话，同一首会从第 1 段被重听一遍，额度也被白白吃回去。
    if (job.requester && !job.whitelisted) {
      if (partial) {
        await log(`已发出 ${sent} 段，算点过，不退 ${job.requester} 的 CD`)
      } else {
        try {
          const map = await readCooldowns(job.home)
          const entry = map?.[job.requester]
          if (entry && String(entry.song ?? '') === String(job.song ?? '')) {
            await clearCooldown(job.home, job.requester)
            await log(`没唱成，退还 ${job.requester} 的点歌 CD`)
          }
        } catch {
          /* CD 文件坏了也不影响收尾 */
        }
      }
    }
    await releaseLock()
    finish(1)
  })
