// dsh-qq-sing 悬浮球排单卡片（由 tools/patch-orb.mjs 注入 dsh-orb 的 floating.html）。
// 每 5 秒拉一次只读端点；收起时球右上角红点，展开显示在唱 + 排单 + 最近 4 首。
// 卡片右上角的「暂停/恢复」控制新点歌开关（只挡新点歌，在唱和排单不动）。
// 只依赖 DOM，不引任何模块；数据源见 index.js 的 /qqsing.json 与 /qqsing/pause。
const ENDPOINT = 'http://127.0.0.1:31877/qqsing.json'
const CONTROL = 'http://127.0.0.1:31877/qqsing/pause'
const REFRESH_MS = 5000
const TICK_MS = 800

const STYLE = `
#qqsing-card{position:fixed;left:10px;right:10px;bottom:88px;max-height:46vh;overflow:auto;background:rgba(24,24,32,.92);color:#e8e8ee;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:10px 12px;font:12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;z-index:2147483000;box-shadow:0 8px 24px rgba(0,0,0,.45);backdrop-filter:blur(8px);}
.qqsing-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;color:#cfd3ff;font-weight:600;}
.qqsing-actions{display:flex;align-items:center;gap:6px;margin-left:auto;}
#qqsing-count{font-weight:400;color:#9aa0b5;font-size:11px;}
#qqsing-pause{appearance:none;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.06);color:#dfe3ff;border-radius:999px;padding:2px 8px;font-size:11px;line-height:16px;cursor:pointer;font-family:inherit;}
#qqsing-pause:hover{background:rgba(255,255,255,.12);}
#qqsing-pause.paused{border-color:rgba(255,184,90,.6);color:#ffcf8a;background:rgba(255,184,90,.12);}
#qqsing-pause:disabled{opacity:.5;cursor:default;}
.qqsing-hint{color:#9aa0b5;font-size:11px;padding:4px 0 2px;}
.qqsing-row{display:flex;gap:6px;padding:3px 0;border-top:1px solid rgba(255,255,255,.06);}
.qqsing-row:first-child{border-top:0;}
.qqsing-num{width:14px;flex:0 0 14px;color:#8d93a8;font-variant-numeric:tabular-nums;}
.qqsing-body{min-width:0;flex:1;}
.qqsing-song{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.qqsing-row.active .qqsing-song{color:#ff5c5c;font-weight:600;}
.qqsing-meta{color:#8d93a8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;}
.qqsing-stage{color:#ff9a9a;font-size:11px;margin-left:6px;}
#qqsing-dot{position:fixed;width:10px;height:10px;border-radius:50%;background:#ff4d4f;box-shadow:0 0 0 2px rgba(10,10,14,.85);z-index:2147483001;pointer-events:none;display:none;}
`

let lastData = null
let styleInjected = false

function text(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function truncate(s, n) {
  const t = text(s)
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

function metaLine(j) {
  const parts = []
  const where = text(j.targetName || j.target)
  if (where) parts.push(where)
  const name = text(j.requesterName)
  const qq = text(j.requester)
  if (name) parts.push(qq && !name.includes(qq) ? `${name}(${qq})` : name)
  else if (qq) parts.push(qq)
  return parts.join(' · ')
}

function ensureCard() {
  let card = document.getElementById('qqsing-card')
  if (card) return card
  if (!styleInjected) {
    const style = document.createElement('style')
    style.textContent = STYLE
    document.head.appendChild(style)
    styleInjected = true
  }
  card = document.createElement('div')
  card.id = 'qqsing-card'
  card.hidden = true
  const head = document.createElement('div')
  head.className = 'qqsing-head'
  const title = document.createElement('span')
  title.textContent = '🎤 点歌排单'
  const count = document.createElement('span')
  count.id = 'qqsing-count'
  const actions = document.createElement('span')
  actions.className = 'qqsing-actions'
  const pause = document.createElement('button')
  pause.id = 'qqsing-pause'
  pause.type = 'button'
  pause.textContent = '暂停'
  pause.title = '暂停/恢复新点歌（在唱和排单不受影响）'
  pause.addEventListener('click', (event) => {
    event.stopPropagation()
    togglePause()
  })
  actions.append(count, pause)
  head.append(title, actions)
  const list = document.createElement('div')
  list.id = 'qqsing-list'
  card.append(head, list)
  document.body.appendChild(card)
  return card
}

function ensureDot() {
  let dot = document.getElementById('qqsing-dot')
  if (dot) return dot
  dot = document.createElement('span')
  dot.id = 'qqsing-dot'
  document.body.appendChild(dot)
  return dot
}

function row(index, job, active) {
  const wrap = document.createElement('div')
  wrap.className = active ? 'qqsing-row active' : 'qqsing-row'
  const num = document.createElement('span')
  num.className = 'qqsing-num'
  num.textContent = index == null ? '' : String(index)
  const body = document.createElement('div')
  body.className = 'qqsing-body'
  const song = document.createElement('div')
  song.className = 'qqsing-song'
  song.textContent = truncate(job.title || job.song || '（无标题）', 64)
  const meta = document.createElement('div')
  meta.className = 'qqsing-meta'
  meta.textContent = metaLine(job)
  body.append(song)
  if (active && job.total > 1) {
    const stage = document.createElement('span')
    stage.className = 'qqsing-stage'
    stage.textContent = `发送 ${text(job.sent)}/${text(job.total)}`
    song.append(stage)
  }
  body.append(meta)
  wrap.append(num, body)
  return wrap
}

function render() {
  const data = lastData
  const card = ensureCard()
  const dot = ensureDot()
  const list = card.querySelector('#qqsing-list')
  const count = card.querySelector('#qqsing-count')
  const pause = card.querySelector('#qqsing-pause')
  const panel = document.getElementById('panel')
  const expanded = panel ? !panel.hidden : true

  if (!data) {
    card.hidden = true
    dot.style.display = 'none'
    return
  }

  const active = data.active || null
  const queue = Array.isArray(data.queue) ? data.queue : []
  const recent = Array.isArray(data.recent) ? data.recent : []
  const paused = Boolean(data.paused)
  const hasWork = Boolean(active) || queue.length > 0

  if (!paused && !hasWork && recent.length === 0) {
    card.hidden = true
    dot.style.display = 'none'
    return
  }

  pause.textContent = paused ? '恢复' : '暂停'
  pause.classList.toggle('paused', paused)

  count.textContent = paused
    ? '已暂停'
    : active
      ? `在唱 1 首${queue.length ? ` · 排 ${queue.length}` : ''}`
      : queue.length
        ? `排 ${queue.length}`
        : '最近'

  list.replaceChildren()
  if (paused && !active && queue.length === 0 && recent.length === 0) {
    const hint = document.createElement('div')
    hint.className = 'qqsing-hint'
    hint.textContent = '点歌已暂停，点右上角「恢复」继续接单。'
    list.append(hint)
  } else if (active) {
    list.append(row(1, active, true))
    queue.forEach((job, i) => list.append(row(i + 2, job, false)))
  } else if (queue.length) {
    queue.forEach((job, i) => list.append(row(i + 1, job, false)))
  } else {
    recent.slice(0, 4).forEach((job) => list.append(row(null, job, false)))
  }

  card.hidden = !expanded
  if (!expanded && (hasWork || paused)) {
    const ball = document.getElementById('ball')
    if (ball) {
      const r = ball.getBoundingClientRect()
      dot.style.left = `${Math.round(r.right - 13)}px`
      dot.style.top = `${Math.round(r.top - 1)}px`
      dot.style.background = paused ? '#f5a623' : '#ff4d4f'
      dot.style.display = 'block'
    } else {
      dot.style.display = 'none'
    }
  } else {
    dot.style.display = 'none'
  }
}

async function togglePause() {
  const pause = document.getElementById('qqsing-pause')
  if (!pause || pause.disabled) return
  const next = !(lastData && lastData.paused)
  pause.disabled = true
  try {
    const res = await fetch(`${CONTROL}?on=${next ? 1 : 0}`, { method: 'POST', cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    if (!lastData) lastData = { paused: Boolean(body.paused) }
    else lastData.paused = Boolean(body.paused)
    render()
  } catch {
    // 改不动就等下一次轮询把真实状态拉回来
  } finally {
    pause.disabled = false
    refresh()
  }
}

async function refresh() {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 3500)
    const res = await fetch(ENDPOINT, { cache: 'no-store', signal: ctl.signal })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    lastData = await res.json()
  } catch {
    // 端点没起来/切歌瞬间失败：保留上一次数据，不闪
  }
  render()
}

function start() {
  ensureCard()
  ensureDot()
  const panel = document.getElementById('panel')
  if (panel) {
    new MutationObserver(() => render()).observe(panel, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] })
  }
  setInterval(render, TICK_MS)
  refresh()
  setInterval(refresh, REFRESH_MS)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true })
} else {
  start()
}
