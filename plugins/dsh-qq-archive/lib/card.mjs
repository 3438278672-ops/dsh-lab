/**
 * 群友档案卡：把一个人的档案渲染成一张图，直接发到群里。
 *
 * 为什么要服务端截图而不是前端 canvas：
 * - 卡片就是看板里那张详情页，HTML/CSS 已经调好了，重画一遍必然走样；
 * - headless Edge 在这台机器上截图稳定（看板截图一直用它），2~3 秒出图；
 * - 群里要的是「发出去就能看」的图片，不是链接，也不是一条几百字的文本。
 *
 * 渲染是只读的：不写库、不改状态，一张卡一个临时文件，用完就删。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

export function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (existsSync(p)) return p
  return ''
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtDate(ts) {
  if (!ts) return '—'
  const d = new Date(Number(ts) * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function hourBars(hours) {
  const arr = Array.isArray(hours) && hours.length === 24 ? hours : new Array(24).fill(0)
  const max = Math.max(1, ...arr)
  return arr
    .map((v) => `<i style="height:${Math.max(2, Math.round((v / max) * 34))}px"></i>`)
    .join('')
}

function chip(text, count) {
  return `<span class="chip">${esc(text)}${count === undefined ? '' : `<b>${count}</b>`}</span>`
}

const CARD_CSS = `
:root{--paper:#0e0d0c;--paper-2:#161311;--ink:#ece2cf;--body:#d5ccbb;--muted:#9a8c75;
--accent:#d4a04a;--line:#373430;--line-subtle:#23211f;
--font-serif:"Noto Serif SC","Songti SC",SimSun,Georgia,serif;
--font-sans:"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;
--font-mono:"JetBrains Mono",Consolas,"Courier New",monospace;}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0908;color:var(--body);font-family:var(--font-sans);-webkit-font-smoothing:antialiased;
  padding:26px;display:flex;justify-content:center}
.card{width:700px;background:var(--paper);border:1px solid var(--line-subtle);padding:34px 38px 30px;
  position:relative;box-shadow:0 30px 80px rgba(0,0,0,.6)}
.card::after{content:"";position:absolute;inset:0;pointer-events:none;opacity:.05;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)' opacity='.55'/%3E%3C/svg%3E")}
.kicker{font-family:var(--font-mono);font-size:9.5px;letter-spacing:.34em;color:var(--muted);text-transform:uppercase}
.head{display:flex;gap:18px;align-items:center;border-bottom:1px solid var(--line-subtle);padding:16px 0 20px;margin-bottom:4px}
.avatar{width:62px;height:62px;border-radius:50%;display:grid;place-items:center;flex:none;
  background:linear-gradient(145deg,#2a2116,#171310);border:1px solid #4a3a22;color:var(--accent);
  font-family:var(--font-serif);font-size:26px}
.name{font-family:var(--font-serif);font-size:27px;color:var(--ink);font-weight:500;letter-spacing:.02em}
.id{font-family:var(--font-mono);font-size:10.5px;color:var(--muted);letter-spacing:.1em;margin-top:6px}
.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:22px 0}
.stat{border:1px solid var(--line-subtle);padding:11px 12px;border-radius:2px}
.stat b{display:block;font-family:var(--font-display,var(--font-serif));font-size:21px;color:var(--accent);font-weight:400;letter-spacing:.01em}
.stat span{font-family:var(--font-mono);font-size:9px;color:var(--muted);letter-spacing:.12em}
h3{font-family:var(--font-mono);font-size:10.5px;color:var(--accent);letter-spacing:.18em;font-weight:400;
  display:flex;align-items:center;gap:12px;margin:20px 0 12px}
h3::after{content:"";flex:1;height:1px;background:var(--line-subtle)}
.quote{font-family:var(--font-serif);font-size:14.5px;line-height:1.95;color:#e6d8c2;
  border-left:2px solid var(--accent);padding:2px 0 2px 14px}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.tag{font-family:var(--font-mono);font-size:9.5px;color:var(--accent);border:1px solid #4a3a22;
  background:#1a1409;padding:2px 8px;border-radius:999px;letter-spacing:.06em}
.hours{display:flex;align-items:flex-end;gap:3px;height:36px;margin-top:6px}
.hours i{flex:1;background:#4a3a22;border-radius:1px;min-width:2px}
.hours-x{display:flex;justify-content:space-between;font-family:var(--font-mono);font-size:9px;color:var(--muted);margin-top:6px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font-family:var(--font-sans);font-size:11.5px;color:var(--body);border:1px solid var(--line);
  padding:3px 9px;border-radius:2px;background:#141110}
.chip b{font-family:var(--font-mono);font-size:9.5px;color:var(--accent);margin-left:6px;font-weight:400}
.muted{font-size:11.5px;color:var(--muted);font-style:italic}
.foot{margin-top:26px;padding-top:12px;border-top:1px solid var(--line-subtle);
  display:flex;justify-content:space-between;font-family:var(--font-mono);font-size:9px;color:var(--muted);letter-spacing:.12em}
`

/**
 * 一页档案卡的 HTML。数据形状与 buildProfile 的返回值一致。
 * @param {object} p buildProfile 的结果
 * @param {{chatName?:string, today?:string}} meta
 */
export function personCardHtml(p, meta = {}) {
  const name = (p.aliases && p.aliases[0]) || p.userId
  const aliasLine =
    p.aliases && p.aliases.length > 1 ? ` · 也叫 ${p.aliases.slice(1, 4).join('、')}` : ''
  const peak = p.peak && p.peak.length
    ? p.peak.map((x) => `${esc(x.label)}（${x.pct}%）`).join('、')
    : '还没有明显的高峰'
  const words = (p.topWords || []).slice(0, 10).map((w) => chip(w.word, w.count)).join('')
  const chats = (p.chats || []).slice(0, 8).map((c) => chip(c.name, c.msgCount)).join('')
  const label = (m) => chip(m.name || `QQ ${m.userId}`, m.count)
  const out = (p.mentionsOut || []).slice(0, 6).map(label).join('')
  const inn = (p.mentionedBy || []).slice(0, 6).map(label).join('')
  const tags = (p.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')
  const imp = p.impression
    ? `<p class="quote">${esc(p.impression)}</p>`
    : '<p class="muted">还没有人物印象。让群聊档案馆跑一次批量生成。</p>'

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${CARD_CSS}</style></head>
<body><main class="card">
  <div class="kicker">QQ · Archive${meta.chatName ? ' · ' + esc(meta.chatName) : ''}</div>
  <div class="head">
    <span class="avatar">${esc(String(name).slice(0, 1))}</span>
    <div><div class="name">${esc(name)}</div>
    <div class="id">QQ ${esc(p.userId)}${esc(aliasLine)}</div></div>
  </div>
  <div class="grid">
    <div class="stat"><b>${p.total}</b><span>发言条数</span></div>
    <div class="stat"><b>${(p.chats || []).length}</b><span>会话</span></div>
    <div class="stat"><b>${p.links || 0}</b><span>带链接</span></div>
    <div class="stat"><b>${esc(fmtDate(p.firstTs))}</b><span>第一次说话</span></div>
    <div class="stat"><b>${esc(fmtDate(p.lastTs))}</b><span>最近一次</span></div>
  </div>
  <h3>人物印象</h3>
  ${imp}
  ${tags ? `<div class="tags">${tags}</div>` : ''}
  <h3>一天里什么时候出现</h3>
  <div class="hours">${hourBars(p.hours)}</div>
  <div class="hours-x"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>
  <p class="muted" style="margin-top:10px">常出没：${peak}</p>
  ${words ? `<h3>常说的话</h3><div class="chips">${words}</div>` : ''}
  ${chats ? `<h3>在哪些会话</h3><div class="chips">${chats}</div>` : ''}
  ${out || inn ? '<h3>@ 的关系</h3>' : ''}
  ${out ? `<div class="chips" style="margin-bottom:8px"><span class="muted" style="margin-right:4px">@ 过</span>${out}</div>` : ''}
  ${inn ? `<div class="chips"><span class="muted" style="margin-right:4px">被</span>${inn}</div>` : ''}
  <div class="foot"><span>群聊档案馆 · dsh-qq-archive</span><span>${esc(meta.today || '')}</span></div>
</main></body></html>`
}

/**
 * 估个高度，让截图别在底下留一大块黑边。
 * 没有 CDP 就别测量，按内容行数够用了——差个二三十像素看不出来。
 */
export function estimateHeight(p) {
  const lines = (chars, perLine) => Math.max(1, Math.ceil((chars || 0) / perLine))
  let h = 120 // 外侧留白 + kicker
  h += 96 // 头像那一行
  h += 108 // 五格统计
  h += 34 + lines((p.impression || '').length, 44) * 29 + 20 // 印象
  if (p.tags && p.tags.length) h += 40
  h += 118 // 24 小时柱状 + 刻度 + 常出没
  const words = Math.min(10, (p.topWords || []).length)
  if (words) h += 36 + Math.ceil(words / 4) * 36
  const chats = Math.min(8, (p.chats || []).length)
  if (chats) h += 36 + Math.ceil(chats / 5) * 36
  if ((p.mentionsOut || []).length || (p.mentionedBy || []).length) h += 76
  h += 96 // footer + 底部留白
  return Math.max(720, Math.round(h))
}

/**
 * 把一段 HTML 渲染成 PNG（headless Edge/Chrome）。返回 PNG 字节。
 * 失败抛错，调用方决定怎么降级。
 */
export function htmlToPng(html, { width = 760, height = 1120, timeoutMs = 30000 } = {}) {
  const browser = findBrowser()
  if (!browser) throw new Error('找不到 Edge/Chrome，没法把档案卡渲染成图片')
  const dir = mkdtempSync(join(tmpdir(), 'qqa-card-'))
  const htmlPath = join(dir, 'card.html')
  const pngPath = join(dir, 'card.png')
  try {
    writeFileSync(htmlPath, html, 'utf8')
    execFileSync(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=2',
        `--virtual-time-budget=2500`,
        `--window-size=${width},${height}`,
        `--screenshot=${pngPath}`,
        'file:///' + htmlPath.replace(/\\/g, '/'),
      ],
      { timeout: timeoutMs, stdio: 'ignore' },
    )
    return readFileSync(pngPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

