/**
 * 单文件 HTML 浏览页。
 *
 * 生成的 viewer.html 直接双击打开就能用：数据内联成一份 JS 常量，
 * 图片走同目录的 media/（相对路径，file:// 下也能显示）。
 * 消息多的时候也不卡：先渲染最近一屏，往上滚再加载更早的。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const PAGE_SIZE = 200

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 把绝对路径换成 media/ 下的相对名，方便 file:// 直接看。 */
function relMediaPath(home, p) {
  if (!p) return ''
  const abs = String(p)
  const base = basename(abs)
  const dir = dirname(abs)
  if (join(home, 'media') === dir) return 'media/' + base
  return abs.replace(/\\/g, '/')
}

export function buildViewerData(db, home) {
  const chats = db
    .prepare(
      `select c.chat_key, c.name, c.msg_count, c.last_ts,
              (select min(m.ts) from messages m where m.chat_key = c.chat_key) as first_ts
         from chats c order by c.msg_count desc`,
    )
    .all()
    .map((c) => ({
      key: c.chat_key,
      name: c.name || '',
      type: String(c.chat_key || '').startsWith('private:') ? 'private' : 'group',
      count: c.msg_count,
      first: c.first_ts,
      last: c.last_ts,
    }))

  const chatNames = new Map(chats.map((c) => [c.key, c.name]))

  const rows = db
    .prepare(
      `select id, source_key, ts, chat_key, sender_id, sender_name, kind, text, reply_to
         from messages order by ts asc, id asc`,
    )
    .all()

  const mediaByKey = new Map()
  for (const m of db
    .prepare("select message_key, kind, local_path, size, width, height from media where local_path is not null and local_path <> '' order by message_key, id")
    .all()) {
    const arr = mediaByKey.get(m.message_key) || []
    arr.push({ kind: m.kind, path: relMediaPath(home, m.local_path), size: m.size || 0, w: m.width || 0, h: m.height || 0 })
    mediaByKey.set(m.message_key, arr)
  }

  const messages = rows.map((r) => [
    r.ts || 0,
    r.chat_key,
    r.sender_id || '',
    r.sender_name || '',
    r.kind || 'text',
    r.text || '',
    mediaByKey.get(r.source_key) || [],
    r.reply_to || '',
  ])

  const profiles = {}
  for (const p of db.prepare("select user_id, impression, impression_at from profiles where chat_key = '*' and impression is not null and impression <> ''").all()) {
    profiles[p.user_id] = { impression: p.impression, at: p.impression_at }
  }

  return { chats, messages, profiles, chatNames: [...chatNames.entries()] }
}

export function renderViewerHtml(data, { title = 'QQ 归档', generatedAt = '' } = {}) {
  const payload = JSON.stringify(data).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { color-scheme: dark; --bg:#141619; --panel:#1c1f24; --line:#2a2f37; --text:#e6e8eb; --dim:#8b939e; --accent:#4da3ff; --warn:#ffb454; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font: 14px/1.6 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; display: flex; flex-direction: column; }
header { display: flex; gap: 10px; align-items: center; padding: 10px 14px; background: var(--panel); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
header h1 { font-size: 15px; margin: 0 6px 0 0; font-weight: 600; }
input[type=search], select { background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px; font: inherit; }
input[type=search] { flex: 1 1 240px; }
#meta { color: var(--dim); font-size: 12px; margin-left: auto; }
main { flex: 1; display: flex; min-height: 0; }
aside { width: 240px; border-right: 1px solid var(--line); overflow: auto; background: var(--panel); flex: none; }
.chat { padding: 8px 12px; cursor: pointer; border-bottom: 1px solid var(--line); }
.chat:hover { background: #242932; }
.chat.active { background: #1d3550; }
.chat .n { font-weight: 600; }
.chat .s { color: var(--dim); font-size: 12px; }
#feed { flex: 1; overflow: auto; padding: 14px 18px 60vh; }
.msg { padding: 6px 0 10px; border-bottom: 1px dashed #232830; }
.msg .head { display: flex; gap: 8px; align-items: baseline; font-size: 12px; color: var(--dim); flex-wrap: wrap; }
.msg .who { color: var(--accent); font-weight: 600; cursor: pointer; }
.msg .who:hover { text-decoration: underline; }
.msg .chat { color: var(--warn); opacity: .75; }
.msg .body { white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
.msg .body a { color: var(--accent); }
.msg .media { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
.msg .media img { max-width: 220px; max-height: 220px; border-radius: 6px; border: 1px solid var(--line); cursor: zoom-in; background: #0e0f11; }
.tag { display: inline-block; padding: 1px 7px; border-radius: 10px; background: #2a2f37; color: var(--dim); font-size: 12px; }
#empty { color: var(--dim); padding: 40px; text-align: center; }
.imp { background: #1c2530; border: 1px solid #2b3a4d; border-radius: 8px; padding: 10px 12px; margin: 10px 0 4px; color: #cfe3f7; font-size: 13px; }
.imp b { color: var(--accent); }
</style>
</head>
<body>
<header>
  <h1>${esc(title)}</h1>
  <input id="q" type="search" placeholder="搜索消息、昵称、群名…（回车）">
  <select id="chatsel"><option value="">全部会话</option></select>
  <button id="reset" class="tag" style="cursor:pointer">清除筛选</button>
  <span id="meta"></span>
</header>
<main>
  <aside id="chatlist"></aside>
  <section id="feed"></section>
</main>
<script>
const DATA = ${payload};
const MSG = DATA.messages;
const CHATS = DATA.chats;
const CHATNAME = new Map(DATA.chatNames);
const PROFILES = DATA.profiles;
const $ = (s) => document.querySelector(s);
const feed = $('#feed');
let filter = { chat: '', q: '', sender: '' };
let shown = ${PAGE_SIZE};
let lastRenderKey = '';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function linkify(text) {
  return esc(text).replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
}
function kindTag(kind) {
  const m = { image: '图片', voice: '语音', video: '视频', forward: '合并转发', file: '文件', card: '卡片' };
  return m[kind] || kind;
}
function matches(m) {
  const [ts, chatKey, sid, sender, kind, text] = m;
  if (filter.chat && chatKey !== filter.chat) return false;
  if (filter.sender && sid !== filter.sender) return false;
  if (filter.q) {
    const q = filter.q.toLowerCase();
    if (!(String(text).toLowerCase().includes(q) || String(sender).toLowerCase().includes(q) || String(CHATNAME.get(chatKey) || '').toLowerCase().includes(q) || String(sid).includes(q))) return false;
  }
  return true;
}
function filtered() {
  if (!filter.chat && !filter.q && !filter.sender) return MSG;
  return MSG.filter(matches);
}
function row(m) {
  const [ts, chatKey, sid, sender, kind, text, media] = m;
  const who = esc(sender || sid);
  const chat = esc(CHATNAME.get(chatKey) || chatKey);
  const body = kind === 'text' ? linkify(text) : '<span class="tag">' + esc(kindTag(kind)) + '</span> ' + linkify(text || '');
  let mediaHtml = '';
  for (const md of media || []) {
    if (md.kind === 'image' && md.path) {
      mediaHtml += '<img loading="lazy" src="' + esc(md.path) + '" data-full="' + esc(md.path) + '" alt="">';
    }
  }
  return '<div class="msg" data-sid="' + esc(sid) + '">' +
    '<div class="head"><span class="who" data-who="' + esc(sid) + '">' + who + '</span>' +
    '<span class="chat">' + chat + '</span><span>' + fmtTime(ts) + '</span></div>' +
    '<div class="body">' + body + '</div>' + (mediaHtml ? '<div class="media">' + mediaHtml + '</div>' : '') + '</div>';
}
function paint(keepScroll) {
  const list = filtered();
  const start = Math.max(0, list.length - shown);
  const slice = list.slice(start);
  let html = '';
  const impSender = filter.sender && PROFILES[filter.sender];
  if (impSender) html += '<div class="imp"><b>人物印象</b> ' + esc(PROFILES[filter.sender].impression) + '</div>';
  if (!slice.length) html += '<div id="empty">没有匹配的消息</div>';
  else if (start > 0) html += '<div id="empty">往上滚加载更早的（还有 ' + start + ' 条）</div>';
  html += slice.map(row).join('');
  const atTop = feed.scrollTop <= 2;
  feed.innerHTML = html;
  if (!keepScroll) feed.scrollTop = feed.scrollHeight;
  else if (atTop) feed.scrollTop = 40;
  $('#meta').textContent = list.length + ' / ' + MSG.length + ' 条';
}
function renderChats() {
  $('#chatlist').innerHTML = CHATS.map((c) =>
    '<div class="chat' + (filter.chat === c.key ? ' active' : '') + '" data-chat="' + esc(c.key) + '">' +
    '<div class="n">' + esc(c.name || c.key) + '</div>' +
    '<div class="s">' + c.count + ' 条 · ' + fmtTime(c.last).slice(0, 10) + '</div></div>').join('');
  const sel = $('#chatsel');
  if (!sel.options.length) sel.innerHTML = '<option value="">全部会话</option>' + CHATS.map((c) => '<option value="' + esc(c.key) + '">' + esc(c.name || c.key) + '</option>').join('');
}
function apply() {
  shown = ${PAGE_SIZE};
  paint(false);
  renderChats();
}
$('#chatlist').addEventListener('click', (e) => {
  const el = e.target.closest('[data-chat]');
  if (!el) return;
  filter.chat = filter.chat === el.dataset.chat ? '' : el.dataset.chat;
  $('#chatsel').value = filter.chat;
  apply();
});
$('#chatsel').addEventListener('change', (e) => { filter.chat = e.target.value; apply(); });
$('#q').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  filter.q = e.target.value.trim();
  filter.sender = '';
  apply();
});
$('#reset').addEventListener('click', () => {
  filter = { chat: '', q: '', sender: '' };
  $('#q').value = ''; $('#chatsel').value = '';
  apply();
});
feed.addEventListener('scroll', () => {
  if (feed.scrollTop <= 2 && shown < filtered().length) {
    shown += ${PAGE_SIZE};
    paint(true);
  }
});
feed.addEventListener('click', (e) => {
  const img = e.target.closest('img[data-full]');
  if (img) { window.open(img.dataset.full, '_blank'); return; }
  const who = e.target.closest('[data-who]');
  if (who) {
    filter.sender = filter.sender === who.dataset.who ? '' : who.dataset.who;
    shown = ${PAGE_SIZE};
    paint(false);
    renderChats();
  }
});
apply();
</script>
</body>
</html>`
}

export function exportViewer(db, { home, title, outPath }) {
  const data = buildViewerData(db, home)
  const out = outPath || join(home, 'viewer.html')
  mkdirSync(dirname(out), { recursive: true })
  const html = renderViewerHtml(data, { title: title || 'QQ 归档', generatedAt: new Date().toISOString() })
  writeFileSync(out, html, 'utf8')
  return { path: out, bytes: Buffer.byteLength(html), chats: data.chats.length, messages: data.messages.length, profiles: Object.keys(data.profiles).length }
}
