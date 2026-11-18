/**
 * 端到端验证（临时脚本）：起一个带 CDP 的球，用真实点击验证面板与三个服务的按钮。
 *
 *   node _cdp-test.mjs
 *
 * 用的是第二份 userData（不抢正式那颗球的单实例锁），跑完自己杀掉。
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SERVICES = join(process.env.USERPROFILE || process.env.HOME, '.dsh', 'dsh-services')
const PORT = 9333
const log = (...args) => console.log(...args)

async function tokenOf(name) {
  try {
    return (await readFile(join(SERVICES, `${name}.token`), 'utf8')).trim()
  } catch {
    return ''
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitCdp(timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page' && /index\.html/.test(target.url || ''))
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* 还没起来 */
    }
    await sleep(300)
  }
  throw new Error('等 CDP 超时')
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let nextId = 1
    const pending = new Map()
    ws.addEventListener('open', () => resolve({ send, close: () => ws.close() }))
    ws.addEventListener('error', (event) => reject(new Error(`CDP 连接失败：${event?.message || event}`)))
    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data)
      const waiter = pending.get(data.id)
      if (!waiter) return
      pending.delete(data.id)
      if (data.error) waiter.reject(new Error(data.error.message))
      else waiter.resolve(data.result)
    })
    function send(method, params = {}) {
      const id = nextId++
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej })
        ws.send(JSON.stringify({ id, method, params }))
      })
    }
  })
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '页面里报错了')
  return result.result?.value
}

const electronExe = join(process.env.LOCALAPPDATA, 'dsh-floatball', 'runtime', '44.0.0', 'electron.exe')
const userData = await mkdtemp(join(tmpdir(), 'ball-cdp-'))
const env = {
  ...process.env,
  BALL_HOST_PID: '0',
  BALL_USER_DATA: userData,
  BALL_STATE_PATH: join(userData, 'window.json'),
  BALL_QQSING_URL: 'http://127.0.0.1:31877',
  BALL_PAINT_URL: 'http://127.0.0.1:31878',
  BALL_QUEUE_URL: 'http://127.0.0.1:31879',
  BALL_TOKEN_QQSING: await tokenOf('qq-sing'),
  BALL_TOKEN_PAINT: await tokenOf('fish-paint'),
  BALL_TOKEN_QUEUE: await tokenOf('gpu-queue'),
}
delete env.ELECTRON_RUN_AS_NODE

log('起调试实例 …')
const child = spawn(electronExe, [`--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, join(ROOT, 'helper', 'main.cjs')], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
let childOut = ''
child.stdout.on('data', (chunk) => (childOut += chunk))
child.stderr.on('data', (chunk) => (childOut += chunk))

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  const page = await waitCdp()
  const cdp = await connect(page.webSocketDebuggerUrl)

  // 1. 收起态：球在、面板关着
  await sleep(800)
  check('球渲染出来了', (await evaluate(cdp, `!!document.getElementById('ball')`)) === true)
  check('面板默认收起', (await evaluate(cdp, `document.getElementById('panel').hidden`)) === true)

  // 2. 点球展开
  await evaluate(
    cdp,
    `(() => { const b = document.getElementById('ball'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 40, pointerId: 1 })); b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 40, pointerId: 1 })); return true })()`,
  )
  await sleep(500)
  check('单击球展开面板', (await evaluate(cdp, `document.getElementById('panel').hidden`)) === false)

  // 3. 首轮数据（等一个轮询周期）
  await sleep(2800)
  const gpuText = await evaluate(cdp, `document.getElementById('gpuHolder').textContent.trim()`)
  check('队列条有内容', typeof gpuText === 'string', `gpuHolder="${gpuText}"`)
  const singLimits = await evaluate(cdp, `document.getElementById('singLimits').textContent.trim()`)
  check('点歌限流显示出来', singLimits.length > 0, singLimits.slice(0, 60))

  // 4. 切到画画 tab
  await evaluate(cdp, `document.getElementById('tabPaint').click()`)
  await sleep(200)
  check('画画 tab 能切', (await evaluate(cdp, `document.getElementById('panePaint').hidden`)) === false)

  // 5. 暂停画画 → 服务端真的 paused
  const before = await (await fetch('http://127.0.0.1:31878/paint.json')).json()
  await evaluate(cdp, `document.getElementById('btnPaintPause').click()`)
  await sleep(1200)
  const paused = await (await fetch('http://127.0.0.1:31878/paint.json')).json()
  check('点「暂停」后服务端 paused=true', paused.paused === true && before.paused === false, `${before.paused} → ${paused.paused}`)
  check('按钮文案跟着变', (await evaluate(cdp, `document.getElementById('btnPaintPause').textContent.trim()`)).includes('恢复'))

  // 6. 恢复
  await evaluate(cdp, `document.getElementById('btnPaintPause').click()`)
  await sleep(1200)
  const resumed = await (await fetch('http://127.0.0.1:31878/paint.json')).json()
  check('再点一次恢复', resumed.paused === false, `${resumed.paused}`)

  // 7. 点歌 tab：暂停/恢复（立刻恢复，别影响群里点歌）
  await evaluate(cdp, `document.getElementById('tabSing').click()`)
  await sleep(200)
  await evaluate(cdp, `document.getElementById('btnSingPause').click()`)
  await sleep(1200)
  const singPaused = await (await fetch('http://127.0.0.1:31877/qqsing.json')).json()
  check('点歌暂停生效', singPaused.paused === true)
  await evaluate(cdp, `document.getElementById('btnSingPause').click()`)
  await sleep(1200)
  const singResumed = await (await fetch('http://127.0.0.1:31877/qqsing.json')).json()
  check('点歌恢复', singResumed.paused === false)

  // 8. 掐歌按钮：没在唱时禁用（点了也不发请求）
  check('掐歌按钮在', (await evaluate(cdp, `!!document.getElementById('btnSingCancel')`)) === true)
  check('没在唱时掐歌按钮禁用', (await evaluate(cdp, `document.getElementById('btnSingCancel').disabled`)) === true)

  // 9. 状态点
  const dot = await evaluate(cdp, `(() => { const d = document.getElementById('dot'); return { cls: d.className, title: d.getAttribute('title') || '' } })()`)
  check('状态点有状态', Boolean(dot.cls || dot.title), JSON.stringify(dot))

  cdp.close()
} catch (error) {
  check('脚本执行', false, String(error?.message || error))
} finally {
  child.kill()
  await sleep(300)
  try {
    spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } catch {
    /* ignore */
  }
  const failed = checks.filter((item) => !item.ok)
  log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`)
  if (failed.length) {
    log('失败项：' + failed.map((item) => item.name).join('、'))
    if (childOut.trim()) log('--- electron 输出 ---\n' + childOut.slice(-3000))
    process.exitCode = 1
  }
}

