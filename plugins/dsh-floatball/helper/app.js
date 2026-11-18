/**
 * 悬浮球面板（渲染进程）。
 *
 * 只做三件事：读三个本机服务、画、把按钮点下去。
 * 写操作都带 token（x-control-token），token 由 preload 从主进程环境变量带过来。
 */
import {
  formatClock,
  formatLeft,
  holderText,
  jobProgress,
  queueStrip,
  short,
  workerText,
} from './format.js'

const env = window.ball?.env ?? {}
const TOKENS = {
  qqsing: env.tokenQqsing || '',
  paint: env.tokenPaint || '',
  queue: env.tokenQueue || '',
}

const POLL_MS = 2500
const FETCH_TIMEOUT = 2000

const el = (id) => document.getElementById(id)
const ui = {
  ball: el('ball'),
  dot: el('dot'),
  panel: el('panel'),
  btnQuit: el('btnQuit'),
  btnCollapse: el('btnCollapse'),
  gpuStrip: el('gpuStrip'),
  gpuToggle: el('gpuToggle'),
  gpuHolder: el('gpuHolder'),
  gpuWaiting: el('gpuWaiting'),
  gpuBody: el('gpuBody'),
  tabSing: el('tabSing'),
  tabPaint: el('tabPaint'),
  paneSing: el('paneSing'),
  panePaint: el('panePaint'),
  btnSingPause: el('btnSingPause'),
  btnSingCancel: el('btnSingCancel'),
  singLimits: el('singLimits'),
  singActive: el('singActive'),
  singQueue: el('singQueue'),
  singCooldowns: el('singCooldowns'),
  singRecent: el('singRecent'),
  btnPaintPause: el('btnPaintPause'),
  btnPaintAbort: el('btnPaintAbort'),
  paintWorker: el('paintWorker'),
  paintFlight: el('paintFlight'),
  paintCooldowns: el('paintCooldowns'),
  health: el('health'),
  toast: el('toast'),
}

const state = {
  expanded: false,
  tab: 'sing',
  data: { qqsing: null, paint: null, queue: null },
  errors: { qqsing: '', paint: '', queue: '' },
  busy: false,
  pollTimer: null,
  toastTimer: null,
}

// ---------- 小工具 ----------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function toast(text, ms = 3200) {
  ui.toast.textContent = text || ''
  clearTimeout(state.toastTimer)
  if (text) state.toastTimer = setTimeout(() => { ui.toast.textContent = '' }, ms)
}

async function request(url, { method = 'GET', token = '', by = '悬浮球', timeout = FETCH_TIMEOUT, body } = {}) {
  const headers = {}
  if (token) headers['x-control-token'] = token
  if (by && method !== 'GET') headers['x-control-by'] = encodeURIComponent(by)
  if (body !== undefined) headers['content-type'] = 'application/json'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await response.text()
    let value = null
    try {
      value = text ? JSON.parse(text) : null
    } catch {
      value = { raw: text }
    }
    return { ok: response.ok, status: response.status, value }
  } finally {
    clearTimeout(timer)
  }
}

function endpoint(name) {
  const base = name === 'qqsing' ? env.qqsingUrl : name === 'paint' ? env.paintUrl : env.queueUrl
  return String(base || '').replace(/\/+$/, '')
}

// ---------- 拉数据 ----------

async function readOne(name) {
  const url = endpoint(name) + (name === 'qqsing' ? '/qqsing.json' : name === 'paint' ? '/paint.json' : '/gpu/state')
  try {
    const { ok, value } = await request(url)
    if (!ok) throw new Error((value && value.error) || `HTTP ${ok}`)
    state.data[name] = value
    state.errors[name] = ''
  } catch (error) {
    state.data[name] = null
    state.errors[name] = String(error?.message || error)
  }
}

async function refresh() {
  await Promise.all([readOne('qqsing'), readOne('paint'), readOne('queue')])
  render()
}

// ---------- 渲染 ----------

function healthOf() {
  const broken = ['qqsing', 'paint', 'queue'].filter((name) => state.errors[name])
  if (broken.length === 3) return { text: '三个服务都连不上', state: 'bad', dot: 'bad' }
  if (broken.length) return { text: `连不上：${broken.map(label).join('、')}`, state: 'bad', dot: 'bad' }
  const queue = state.data.queue
  if (queue?.holder) return { text: `显卡正给${holderText(queue.holder.kind)}用`, state: 'busy', dot: 'busy' }
  const pausedSing = state.data.qqsing?.paused
  const pausedPaint = state.data.paint?.paused
  if (pausedSing || pausedPaint) return { text: '有暂停开着', state: 'busy', dot: 'busy' }
  return { text: '都正常', state: 'ok', dot: 'ok' }
}

function label(name) {
  return name === 'qqsing' ? '点歌' : name === 'paint' ? '画画' : '显卡队列'
}

function render() {
  const health = healthOf()
  ui.health.textContent = health.text
  ui.health.dataset.state = health.state
  ui.dot.dataset.state = health.dot

  renderGpu()
  renderSing()
  renderPaint()
}

function renderGpu() {
  const queue = state.data.queue
  const strip = queueStrip(queue)
  ui.gpuHolder.textContent = state.errors.queue
    ? `连不上（${state.errors.queue.slice(0, 40)}）`
    : strip.holder
      ? holderText(strip.holder)
      : '空闲'
  ui.gpuWaiting.textContent = queue ? `排 ${strip.waiting}` : '—'
  ui.gpuWaiting.dataset.busy = strip.waiting > 0 ? '1' : '0'
  ui.gpuStrip.dataset.open = ui.gpuBody.hidden ? '0' : '1'

  if (ui.gpuBody.hidden) return
  const rows = []
  if (queue?.holder) {
    rows.push(`<li><span class="grow">占着：${esc(holderText(queue.holder.kind))} · ${esc(short(queue.holder.label, 42))}</span></li>`)
  }
  for (const item of queue?.queue ?? []) {
    rows.push(
      `<li><span class="idx">${item.index}</span><span class="grow">${esc(item.kind === 'draw' ? '画画' : item.kind === 'voice' ? '语音' : '唱歌')} · ${esc(short(item.label, 34))}</span>` +
        `<button class="mini" data-cancel-gpu="${esc(item.id)}">撤</button></li>`,
    )
  }
  if (!rows.length) rows.push('<li class="empty">没有人在排队</li>')
  ui.gpuBody.innerHTML = rows.join('')
}

function renderSing() {
  const data = state.data.qqsing
  const paused = Boolean(data?.paused)
  ui.btnSingPause.dataset.on = paused ? '1' : '0'
  ui.btnSingPause.textContent = paused ? '恢复接单' : '暂停接新单'
  if (state.errors.qqsing) {
    ui.singLimits.textContent = '点歌服务连不上'
    ui.singActive.textContent = state.errors.qqsing
    ui.singQueue.innerHTML = '<li class="empty">—</li>'
    ui.singCooldowns.innerHTML = '<li class="empty">—</li>'
    ui.singRecent.innerHTML = '<li class="empty">—</li>'
    ui.btnSingCancel.disabled = true
    return
  }
  const limits = data?.limits ?? {}
  ui.singLimits.textContent = `每人 ${Math.round((limits.cooldownMs ?? 0) / 60000)} 分钟一首 · 排单上限 ${limits.maxQueue ?? 5}`

  const active = data?.active
  if (active) {
    const progress = jobProgress(active)
    ui.singActive.innerHTML =
      `<div><strong>${esc(short(active.title || active.song, 30))}</strong></div>` +
      `<div class="muted">${esc(active.requesterName || active.requester || '')}${active.targetName ? ' · ' + esc(active.targetName) : ''}</div>` +
      `<div class="muted">${esc(progress.text)}</div>` +
      (progress.ratio === null ? '' : `<div class="progress"><i style="width:${Math.round(progress.ratio * 100)}%"></i></div>`)
  } else {
    ui.singActive.innerHTML = '<span class="muted">空闲</span>'
  }
  ui.btnSingCancel.disabled = !active
  const queue = data?.queue ?? []
  ui.singQueue.innerHTML = queue.length
    ? queue
        .map(
          (item, index) =>
            `<li><span class="idx">${index + 1}</span><span class="grow">${esc(short(item.song, 26))}</span>` +
            `<span class="who">${esc(short(item.requesterName || item.requester || '', 8))}</span>` +
            `<span class="where">${esc(short(item.targetName || '', 10))}</span></li>`,
        )
        .join('')
    : '<li class="empty">没有排队</li>'

  const cooldowns = data?.cooldowns ?? []
  ui.singCooldowns.innerHTML = cooldowns.length
    ? cooldowns
        .map(
          (item) =>
            `<li><span class="grow">${esc(short(item.requester, 12))}</span>` +
            `<span class="where">${esc(formatLeft(item.leftMs))}</span></li>`,
        )
        .join('')
    : '<li class="empty">没人还在冷却</li>'

  const recent = data?.recent ?? []
  ui.singRecent.innerHTML = recent.length
    ? recent
        .map(
          (item) =>
            `<li><span class="grow">${esc(short(item.title || item.song, 26))}</span>` +
            `<span class="where">${item.ok ? (item.stage === 'done' ? '唱完' : '停了') : '失败'}</span>` +
            `<span class="where">${esc(formatClock(item.finishedAt))}</span></li>`,
        )
        .join('')
    : '<li class="empty">还没唱过</li>'
}

function renderPaint() {
  const data = state.data.paint
  const paused = Boolean(data?.paused)
  ui.btnPaintPause.dataset.on = paused ? '1' : '0'
  ui.btnPaintPause.textContent = paused ? '恢复接图' : '暂停接新图'
  if (state.errors.paint) {
    ui.paintWorker.textContent = `画画服务连不上：${state.errors.paint}`
    ui.paintFlight.innerHTML = '<li class="empty">—</li>'
    ui.paintCooldowns.innerHTML = '<li class="empty">—</li>'
    ui.btnPaintAbort.disabled = true
    return
  }
  ui.paintWorker.innerHTML =
    `<div>${esc(workerText(data?.worker))}</div>` +
    (data?.worker?.modelKey ? `<div class="muted">模型 ${esc(data.worker.modelKey)}</div>` : '')

  const flight = data?.inFlight ?? []
  ui.btnPaintAbort.disabled = flight.length === 0
  ui.paintFlight.innerHTML = flight.length
    ? flight
        .map((job) => {
          const extra = job.phase === 'queued' && job.position ? ` · 队列第 ${job.position}` : ''
          return `<li><span class="grow">${esc(short(job.prompt || job.jobId, 34))}</span><span class="where">${esc(phaseText(job.phase) + extra)}</span></li>`
        })
        .join('')
    : '<li class="empty">现在没在画</li>'

  const cooldowns = data?.cooldowns ?? []
  ui.paintCooldowns.innerHTML = cooldowns.length
    ? cooldowns
        .map(
          (item) =>
            `<li><span class="grow">${esc(short(item.requester, 12))}</span>` +
            `<span class="where">${esc(formatLeft(item.retryAfterSec * 1000))}</span></li>`,
        )
        .join('')
    : '<li class="empty">没人还在冷却</li>'
}

function phaseText(phase) {
  return phase === 'queued' ? '排队中' : phase === 'drawing' ? '画着' : '等显卡'
}

// ---------- 动作 ----------

async function act(fn) {
  if (state.busy) return
  state.busy = true
  try {
    await fn()
  } catch (error) {
    toast(String(error?.message || error))
  } finally {
    state.busy = false
    await refresh()
  }
}

function failureText(result) {
  const value = result?.value ?? {}
  return value.error || value.message || value.reason || `HTTP ${result?.status}`
}

async function toggleSingPause() {
  const want = !state.data.qqsing?.paused
  const result = await request(`${endpoint('qqsing')}/qqsing/pause?on=${want ? 1 : 0}`, {
    method: 'POST',
    token: TOKENS.qqsing,
  })
  if (!result.ok) toast(`改不了：${failureText(result)}`)
  else toast(want ? '已暂停接新单（在唱的会唱完）' : '已恢复接单')
}

async function cancelSing() {
  const result = await request(`${endpoint('qqsing')}/qqsing/cancel?alsoQueue=0`, { method: 'POST', token: TOKENS.qqsing })
  if (!result.ok) toast(`掐不掉：${failureText(result)}`)
  else if (result.value?.cancelled) toast(`掐了：${result.value.song || ''}`)
  else toast('当前没在唱')
}

async function togglePaintPause() {
  const want = !state.data.paint?.paused
  const result = await request(`${endpoint('paint')}/paint/pause?on=${want ? 1 : 0}`, { method: 'POST', token: TOKENS.paint })
  if (!result.ok) toast(`改不了：${failureText(result)}`)
  else toast(want ? '已暂停接新点图' : '已恢复接图')
}

async function abortPaint() {
  const result = await request(`${endpoint('paint')}/paint/abort`, { method: 'POST', token: TOKENS.paint })
  if (!result.ok) toast(`中止失败：${failureText(result)}`)
  else toast(result.value?.aborted?.length ? `中止了 ${result.value.aborted.length} 张` : '没在画')
}

async function cancelGpu(id) {
  const result = await request(`${endpoint('queue')}/gpu/cancel`, { method: 'POST', token: TOKENS.queue, body: { id } })
  if (!result.ok) toast(`撤不掉：${failureText(result)}`)
  else toast('撤了')
}

// ---------- 窗口交互 ----------

const DRAG_THRESHOLD = 5

function setExpanded(want) {
  state.expanded = Boolean(want)
  ui.panel.hidden = !state.expanded
  window.ball?.expand(state.expanded)
  if (state.expanded) refresh()
}

function bindBall() {
  let down = null
  ui.ball.addEventListener('pointerdown', (event) => {
    down = { x: event.screenX, y: event.screenY, moved: false, id: event.pointerId }
    // 抓住指针：手指/鼠标移出 96px 的球之后仍然能收到 pointermove，拖到别的屏幕才不会断
    try {
      ui.ball.setPointerCapture(event.pointerId)
    } catch {
      /* 某些指针类型不支持捕获，退回原来的行为 */
    }
  })
  ui.ball.addEventListener('pointermove', (event) => {
    if (!down) return
    const dx = event.screenX - down.x
    const dy = event.screenY - down.y
    if (!down.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    if (!down.moved) {
      down.moved = true
      ui.ball.classList.add('dragging')
      window.ball?.dragStart({ x: event.screenX - dx, y: event.screenY - dy })
    }
    window.ball?.dragMove({ x: event.screenX, y: event.screenY })
  })
  const finish = () => {
    if (!down) return
    const wasDrag = down.moved
    try {
      if (ui.ball.hasPointerCapture?.(down.id)) ui.ball.releasePointerCapture(down.id)
    } catch {
      /* 已经释放了 */
    }
    down = null
    ui.ball.classList.remove('dragging')
    if (wasDrag) window.ball?.dragEnd()
    else if (!state.expanded) setExpanded(true)
  }
  ui.ball.addEventListener('pointerup', finish)
  ui.ball.addEventListener('pointercancel', finish)

  ui.ball.addEventListener('pointerenter', () => window.ball?.ignoreMouse(false))
  ui.ball.addEventListener('pointerleave', () => {
    if (!state.expanded && !down) window.ball?.ignoreMouse(true)
  })
}

function bindPanel() {
  ui.btnCollapse.addEventListener('click', () => setExpanded(false))
  ui.btnQuit.addEventListener('click', () => window.ball?.quit())
  ui.gpuToggle.addEventListener('click', () => {
    ui.gpuBody.hidden = !ui.gpuBody.hidden
    renderGpu()
  })
  ui.tabSing.addEventListener('click', () => switchTab('sing'))
  ui.tabPaint.addEventListener('click', () => switchTab('paint'))
  ui.btnSingPause.addEventListener('click', () => act(toggleSingPause))
  ui.btnPaintPause.addEventListener('click', () => act(togglePaintPause))
  ui.btnPaintAbort.addEventListener('click', () => act(abortPaint))
  ui.paneSing.addEventListener('click', (event) => {
    if (event.target?.id === 'btnSingCancel') act(cancelSing)
  })
  ui.gpuBody.addEventListener('click', (event) => {
    const id = event.target?.dataset?.cancelGpu
    if (id) act(() => cancelGpu(id))
  })
}

function switchTab(tab) {
  state.tab = tab
  ui.tabSing.dataset.active = tab === 'sing' ? '1' : '0'
  ui.tabPaint.dataset.active = tab === 'paint' ? '1' : '0'
  ui.paneSing.hidden = tab !== 'sing'
  ui.panePaint.hidden = tab !== 'paint'
}

function startPolling() {
  clearInterval(state.pollTimer)
  state.pollTimer = setInterval(() => {
    if (document.hidden) return
    refresh().catch(() => {})
  }, POLL_MS)
}

bindBall()
bindPanel()
switchTab('sing')
refresh().catch(() => {})
startPolling()
