/**
 * qq_find 搜索结果导出：Markdown / 单文件 HTML（午夜墨配色，可直接双击打开）。
 *
 * result 就是 qq_find 返回的对象：{ summary, hits, coverage, mode, count, filters? }。
 * 兼容两种 hit 形状：qq_find 的增强版（time/chat/sender/context）和 db 原始行
 * （ts/chatKey/senderName）。筛选条件优先读 result.filters，也认顶层的 query/chat/from/to。
 *
 * HTML 里的数据用 JSON.stringify 内联，并把所有 '<' 换成 \u003c，防止消息正文里的
 * </script> 之类把页面脚本提前截断；静态列表本身逐字段转义，JS 关掉也能看。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stamp } from './util.mjs'

const MODE_LABEL = {
  chars: '精确',
  fts: '分词',
  'fts-or': '相关',
  like: '模糊',
  scan: '扫描',
  semantic: '语义',
  none: '无',
}

const KIND_LABEL = {
  text: '文字',
  image: '图片',
  voice: '语音',
  video: '视频',
  forward: '合并转发',
  file: '文件',
  card: '卡片',
  link: '链接',
}

const DEFAULT_TITLE = 'QQ 搜索导出'

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function oneLine(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 保留正文里的 http(s) 链接（先转义再加 a 标签，链接里不会出现裸引号/尖括号）。 */
function linkify(text) {
  return esc(text).replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  )
}

function asDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return new Date(n)
  return new Date()
}

/** 文件名用的本地时间戳：20261111-193000。 */
function fileStamp(date) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

/** 筛选值可能是 '7d' 这种原样字符串，也可能是 unix 秒。 */
function whenLabel(value) {
  const s = String(value ?? '').trim()
  if (!s) return ''
  const n = Number(s)
  if (Number.isFinite(n) && n > 1e9) return stamp(n * 1000)
  return s
}

function hitTime(hit) {
  if (hit?.time) return String(hit.time)
  const ts = Number(hit?.ts)
  return Number.isFinite(ts) && ts > 0 ? stamp(ts * 1000) : '时间未知'
}

function hitChat(hit) {
  if (hit?.chat) return String(hit.chat)
  if (hit?.chatName) return String(hit.chatName)
  const key = String(hit?.chatKey || hit?.chat_key || '')
  if (!key) return '未知会话'
  const [type, id] = key.split(':')
  if (type === 'group') return `群 ${id}`
  if (type === 'private') return `私聊 ${id}`
  return key
}

function hitSender(hit) {
  const who = hit?.sender || hit?.senderName || hit?.sender_name || hit?.senderId || hit?.sender_id
  return who ? String(who) : '匿名'
}

function hitText(hit) {
  const text = String(hit?.text ?? '')
  if (text) return text
  const kind = hit?.kind || 'text'
  return `[${KIND_LABEL[kind] || kind}]`
}

function normalizeContext(list) {
  if (!Array.isArray(list)) return []
  return list.map((item) => {
    const ts = Number(item?.ts)
    return {
      time: item?.time ? String(item.time) : Number.isFinite(ts) && ts > 0 ? stamp(ts * 1000) : '',
      sender: String(item?.sender || item?.senderName || item?.sender_name || item?.senderId || ''),
      text: String(item?.text ?? ''),
    }
  })
}

function normalizeHit(hit) {
  return {
    time: hitTime(hit),
    chat: hitChat(hit),
    sender: hitSender(hit),
    kind: hit?.kind || 'text',
    text: hitText(hit),
    context: normalizeContext(hit?.context),
  }
}

/** 筛选条件：优先 result.filters，再退回顶层同名字段；kind='all' / semantic=false 不算条件。 */
function findFilters(result) {
  const res = result && typeof result === 'object' ? result : {}
  const filters = res.filters && typeof res.filters === 'object' ? res.filters : {}
  const pick = (...keys) => {
    for (const key of keys) {
      const inFilters = filters[key]
      if (inFilters !== undefined && inFilters !== null && inFilters !== '') return inFilters
      const top = res[key]
      if (top !== undefined && top !== null && top !== '') return top
    }
    return ''
  }

  const out = []
  const query = pick('query', 'q')
  const chat = pick('chat', 'chatKey')
  const sender = pick('sender')
  const from = pick('from', 'fromTs')
  const to = pick('to', 'toTs')
  const kind = pick('kind')
  const semantic = filters.semantic ?? res.semantic
  if (query) out.push({ label: '关键词', value: String(query) })
  if (chat) out.push({ label: '会话', value: String(chat) })
  if (sender) out.push({ label: '发送者', value: String(sender) })
  if (from) out.push({ label: '起始时间', value: whenLabel(from) })
  if (to) out.push({ label: '结束时间', value: whenLabel(to) })
  if (kind && kind !== 'all') out.push({ label: '类型', value: KIND_LABEL[kind] || String(kind) })
  if (semantic === true || semantic === 'true') out.push({ label: '语义检索', value: '开' })
  return out
}

function summarizeHits(hits) {
  const chats = new Set()
  const senders = new Set()
  for (const hit of hits) {
    if (hit.chat) chats.add(hit.chat)
    if (hit.sender) senders.add(hit.sender)
  }
  return { chats: chats.size, senders: senders.size }
}

/** 把 qq_find 的返回整理成导出用的稳定结构（两种 hit 形状都在这里抹平）。 */
function buildFindModel(result, { title = DEFAULT_TITLE, generatedAt } = {}) {
  const res = result && typeof result === 'object' ? result : {}
  const hits = (Array.isArray(res.hits) ? res.hits : []).map(normalizeHit)
  const at = asDate(generatedAt)
  const listed = hits.length
  const countNum = Number(res.count)
  const count = Number.isFinite(countNum) && countNum >= 0 ? Math.trunc(countNum) : listed
  const mode = String(res.mode || 'none')
  return {
    title: String(title || DEFAULT_TITLE),
    exportedAt: stamp(at.getTime()),
    count,
    listed,
    mode,
    modeLabel: MODE_LABEL[mode] || mode,
    coverage: res.coverage ? String(res.coverage) : '',
    filters: findFilters(res),
    hits,
    stats: summarizeHits(hits),
  }
}

function filterLine(filters) {
  if (!filters.length) return '无（全库最近消息）'
  return filters.map((f) => `${f.label}：${oneLine(f.value)}`).join(' · ')
}

/** Markdown 导出：标题 + 筛选 + 统计 + 每条 `- 时间 · 群 · 发送者：正文`（上下文缩进一行）。 */
export function renderFindMarkdown(result, { title = DEFAULT_TITLE, generatedAt } = {}) {
  const model = buildFindModel(result, { title, generatedAt })
  const lines = [`# ${oneLine(model.title)}`, '']
  lines.push(`- 导出时间：${model.exportedAt}`)
  lines.push(`- 筛选条件：${filterLine(model.filters)}`)
  lines.push(
    `- 命中：${model.count} 条` +
      (model.count !== model.listed ? `（本次导出 ${model.listed} 条）` : '') +
      ` · 检索模式：${oneLine(model.modeLabel)}`,
  )
  lines.push(`- 涉及：${model.stats.chats} 个会话 · ${model.stats.senders} 位发送者`)
  if (model.coverage) lines.push(`- 索引覆盖：${oneLine(model.coverage)}`)
  lines.push('', '## 命中', '')

  if (!model.hits.length) {
    lines.push('没有命中。换个关键词，或去掉会话/时间限制再试。')
  } else {
    for (const hit of model.hits) {
      lines.push(`- ${hit.time} · ${oneLine(hit.chat)} · ${oneLine(hit.sender)}：${oneLine(hit.text)}`)
      for (const ctx of hit.context) {
        const who = oneLine([ctx.time, ctx.sender].filter(Boolean).join(' '))
        lines.push(`  - 上下文：${who ? `${who}：` : ''}${oneLine(ctx.text)}`)
      }
    }
  }
  lines.push('')
  return lines.join('\n')
}

function renderContextHtml(context) {
  if (!context.length) return ''
  const rows = context
    .map((ctx) => {
      const who = esc([ctx.time, ctx.sender].filter(Boolean).join(' '))
      return `<div>${who}${ctx.text ? `：${linkify(ctx.text)}` : ''}</div>`
    })
    .join('')
  return `<div class="ctx">${rows}</div>`
}

function renderHitHtml(hit) {
  return (
    '<li class="hit">' +
    '<div class="hit-head">' +
    `<span class="hit-time">${esc(hit.time)}</span>` +
    `<span class="hit-chat">${esc(hit.chat)}</span>` +
    `<span class="hit-sender">${esc(hit.sender)}</span>` +
    '</div>' +
    `<p class="hit-text">${linkify(hit.text)}</p>` +
    renderContextHtml(hit.context) +
    '</li>'
  )
}

const CSS = `
:root{
  --paper:#0e0d0c; --paper-2:#1a1714; --paper-3:#211d19;
  --ink:#ece2cf; --body:#d5ccbb; --muted:#9a8c75;
  --accent:#d4a04a; --accent-soft:#3a2a14; --accent-dim:#875c00;
  --line:#373430; --line-subtle:#23211f;
  --serif:'Source Serif 4','Noto Serif SC','Source Han Serif SC','Songti SC',Georgia,serif;
  --sans:'Noto Sans SC','PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,'SF Mono',Menlo,monospace;
  color-scheme:dark;
}
*{box-sizing:border-box}
body{
  margin:0; background:var(--paper); color:var(--body);
  font-family:var(--sans); font-size:15px; line-height:1.75;
  -webkit-font-smoothing:antialiased;
  background-image:
    radial-gradient(1200px 600px at 82% -10%, rgba(212,160,74,.09), transparent 60%),
    radial-gradient(900px 500px at -10% 20%, rgba(212,160,74,.05), transparent 55%);
  background-attachment:fixed;
}
.wrap{max-width:980px;margin:0 auto;padding:64px 32px 96px}
.kicker{font-family:var(--mono);font-size:11px;letter-spacing:.42em;color:var(--accent);text-transform:uppercase;margin:0 0 18px}
h1{font-family:var(--serif);font-weight:500;font-size:clamp(32px,5vw,54px);line-height:1.1;color:var(--ink);margin:0 0 16px;letter-spacing:.02em}
.lede{font-family:var(--serif);font-size:14.5px;color:var(--muted);margin:0;max-width:42em}
.strip{display:flex;gap:44px;flex-wrap:wrap;margin:26px 0 0}
.strip b{display:block;font-family:var(--serif);font-weight:500;font-size:28px;line-height:1.2;color:var(--ink);font-variant-numeric:tabular-nums}
.strip span{font-family:var(--mono);font-size:10.5px;letter-spacing:.16em;color:var(--muted)}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0 0}
.chip{font-family:var(--mono);font-size:11px;letter-spacing:.04em;color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent-dim);border-radius:2px;padding:5px 9px}
.chip.plain{color:var(--muted);background:var(--paper-2);border-color:var(--line-subtle)}
.rule{height:1px;background:linear-gradient(90deg,var(--line),var(--line-subtle) 70%,transparent);margin:28px 0 0}
.toolbar{display:flex;gap:12px;align-items:center;margin:26px 0 6px}
.toolbar input{flex:1;background:var(--paper-2);border:1px solid var(--line-subtle);color:var(--ink);border-radius:2px;padding:9px 12px;font:inherit;outline:none}
.toolbar input:focus{border-color:var(--accent-dim)}
#shown{font-family:var(--mono);font-size:11px;letter-spacing:.08em;color:var(--muted);white-space:nowrap}
ol.hits{list-style:none;margin:0;padding:0}
.hit{position:relative;padding:16px 0 16px 22px;border-bottom:1px solid var(--line-subtle)}
.hit::before{content:"";position:absolute;left:0;top:20px;bottom:20px;width:2px;background:var(--accent);opacity:.35}
.hit-head{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline;font-family:var(--mono);font-size:11.5px;line-height:1.6;color:var(--muted)}
.hit-time{color:var(--accent)}
.hit-chat{color:var(--accent-dim)}
.hit-sender{color:var(--ink);font-family:var(--serif);font-size:13.5px}
.hit-text{margin:6px 0 0;white-space:pre-wrap;word-break:break-word;color:var(--body)}
.hit-text a{color:var(--accent);text-decoration:none;border-bottom:1px solid var(--accent-dim)}
.ctx{margin:10px 0 0;padding:8px 12px;background:var(--paper-2);border-left:1px solid var(--line);color:var(--muted);font-size:13px}
.ctx div{margin:2px 0}
.empty{padding:52px 0;color:var(--muted);font-family:var(--serif);font-size:17px;text-align:center}
footer{margin-top:48px;color:var(--muted);font-family:var(--mono);font-size:11px;letter-spacing:.08em}
@media (max-width:640px){.wrap{padding:40px 18px 60px}.strip{gap:26px}}
`

/**
 * 单文件 HTML 导出（午夜墨配色）。
 * 静态列表用服务端转义直接渲染，内联 JSON 只给「在当前结果里再筛」的输入框用；
 * JSON 里的 '<' 全部转成 \u003c，消息正文写 </script> 也不会截断页面脚本。
 */
export function renderFindHtml(result, { title = DEFAULT_TITLE, generatedAt } = {}) {
  const model = buildFindModel(result, { title, generatedAt })
  const payload = JSON.stringify(model).replace(/</g, '\\u003c')
  const filterChips = model.filters.length
    ? model.filters.map((f) => `<span class="chip">${esc(f.label)} ${esc(f.value)}</span>`).join('')
    : '<span class="chip plain">无筛选 · 全库最近消息</span>'
  const coverageChip = model.coverage ? `<span class="chip plain">${esc(model.coverage)}</span>` : ''
  const hitsHtml = model.hits.map(renderHitHtml).join('')
  const countExtra =
    model.count !== model.listed
      ? `<div><b>${model.listed}</b><span>本次导出</span></div>`
      : ''
  const listHtml = hitsHtml
    ? `<div class="toolbar">
    <input id="q" type="search" placeholder="在当前结果里再筛…">
    <span id="shown">${model.listed} / ${model.listed} 条</span>
  </div>
  <ol class="hits" id="hits">${hitsHtml}</ol>`
    : '<div class="empty">这次检索没有命中。</div>'

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(model.title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <p class="kicker">QQ Archive · Search Export</p>
  <h1>${esc(model.title)}</h1>
  <p class="lede">从 QQ 群聊档案馆的索引里导出的检索结果，保留命中统计、筛选条件与上下文，可离线保存。</p>
  <div class="strip">
    <div><b>${model.count}</b><span>命中条数</span></div>
    <div><b>${esc(model.modeLabel)}</b><span>检索模式</span></div>
    <div><b>${model.stats.chats}</b><span>涉及会话</span></div>
    <div><b>${model.stats.senders}</b><span>涉及发送者</span></div>
    ${countExtra}
  </div>
  <div class="chips">${filterChips}${coverageChip}</div>
  <div class="rule"></div>
  ${listHtml}
  <footer>导出时间 ${esc(model.exportedAt)} · 来源：QQ 群聊档案馆 qq_find</footer>
</div>
<script>
const DATA = ${payload};
const base = DATA.hits || [];
const input = document.getElementById('q');
const list = document.getElementById('hits');
const shown = document.getElementById('shown');
function esc(s){return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function linkify(t){return esc(t).replace(/(https?:\\/\\/[^\\s<]+)/g, function(u){return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>'})}
function ctxHtml(hit){
  if (!hit.context || !hit.context.length) return '';
  return '<div class="ctx">' + hit.context.map(function(c){
    var who = esc([c.time, c.sender].filter(Boolean).join(' '));
    return '<div>' + who + (c.text ? '：' + linkify(c.text) : '') + '</div>';
  }).join('') + '</div>';
}
function hitHtml(hit){
  return '<li class="hit"><div class="hit-head">'
    + '<span class="hit-time">' + esc(hit.time) + '</span>'
    + '<span class="hit-chat">' + esc(hit.chat) + '</span>'
    + '<span class="hit-sender">' + esc(hit.sender) + '</span>'
    + '</div><p class="hit-text">' + linkify(hit.text) + '</p>' + ctxHtml(hit) + '</li>';
}
function apply(){
  if (!input || !list) return;
  var q = input.value.trim().toLowerCase();
  var rows = q ? base.filter(function(h){
    return (h.text + ' ' + h.sender + ' ' + h.chat).toLowerCase().indexOf(q) >= 0;
  }) : base;
  list.innerHTML = rows.map(hitHtml).join('');
  if (shown) shown.textContent = rows.length + ' / ' + base.length + ' 条';
}
if (input) input.addEventListener('input', apply);
</script>
</body>
</html>`
}

/**
 * 写导出文件。
 * md 默认 home/exports/search-<时间戳>.md，html 同理；outPath 给了就写到指定位置。
 * @returns {{path:string, bytes:number}}
 */
export function exportFind({ home, result, format = 'md', outPath, title = DEFAULT_TITLE, generatedAt } = {}) {
  if (!home) throw new Error('exportFind 需要 home（归档目录）')
  const wanted = String(format || 'md').toLowerCase()
  const ext = wanted === 'md' ? 'md' : wanted === 'html' ? 'html' : ''
  if (!ext) throw new Error(`不支持的导出格式：${format}（只支持 md / html）`)

  const at = asDate(generatedAt)
  const out = outPath ? String(outPath) : join(String(home), 'exports', `search-${fileStamp(at)}.${ext}`)
  const text = ext === 'md' ? renderFindMarkdown(result, { title, generatedAt: at }) : renderFindHtml(result, { title, generatedAt: at })

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, text, 'utf8')
  return { path: out, bytes: Buffer.byteLength(text) }
}
