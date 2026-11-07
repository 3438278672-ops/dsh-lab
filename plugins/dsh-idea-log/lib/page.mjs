import { START_BLOCKED_REASON, START_BLOCKED_STATUSES } from './start.mjs'

export const KIND_LABEL = { idea: '插件点子', pitfall: '踩坑', improve: '改进点' }
export const STATUS_LABEL = { new: '待看', incubating: '孵化中', done: '已做', parked: '搁置', dropped: '丢弃' }

const CSS = `
:root{
  --paper:#0e0d0c;--paper-2:#161311;--paper-3:#1c1815;
  --ink:#ece2cf;--body:#d5ccbb;--muted:#9a8c75;
  --accent:#d4a04a;--accent-soft:#3a2a14;
  --line:#373430;--line-subtle:#23211f;
  --red:#c0604f;--teal:#6f9e8f;
  --font-serif:"Playfair Display","Noto Serif SC","Songti SC",serif;
  --font-sans:"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;
  --font-mono:"JetBrains Mono","Cascadia Code",monospace;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--paper);color:var(--body);font-family:var(--font-sans);font-size:14px;line-height:1.75;
  -webkit-font-smoothing:antialiased;background-image:radial-gradient(circle at 18% 0%,rgba(212,160,74,.07),transparent 46%),
  radial-gradient(circle at 82% 12%,rgba(192,96,79,.05),transparent 40%)}
a{color:var(--accent)}
.wrap{max-width:1180px;margin:0 auto;padding:56px 40px 96px}
.kicker{font-family:var(--font-mono);font-size:10px;letter-spacing:.42em;color:var(--muted);text-transform:uppercase}
h1{font-family:var(--font-serif);font-size:54px;line-height:1.12;color:var(--ink);margin:14px 0 10px;font-weight:600;letter-spacing:.01em}
.sub{color:var(--muted);font-size:13.5px;margin:0}
.stats{display:flex;gap:44px;margin:34px 0 30px;padding:20px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.stat b{display:block;font-family:var(--font-serif);font-size:34px;color:var(--accent);line-height:1.1}
.stat span{font-family:var(--font-mono);font-size:10px;letter-spacing:.16em;color:var(--muted)}
.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:22px}
.tab{font-family:var(--font-mono);font-size:11.5px;letter-spacing:.1em;color:var(--muted);background:transparent;
  border:1px solid var(--line);padding:7px 14px;cursor:pointer;border-radius:2px;transition:.22s cubic-bezier(.22,1,.36,1)}
.tab:hover{color:var(--ink);border-color:var(--muted)}
.tab.on{color:var(--ink);border-color:var(--accent);background:var(--accent-soft)}
.tab i{font-style:normal;opacity:.6;margin-left:6px}
select,input[type=text]{background:var(--paper-2);border:1px solid var(--line);color:var(--body);
  font-family:var(--font-mono);font-size:12px;padding:7px 10px;border-radius:2px;outline:none}
input[type=text]{flex:1;min-width:180px}
input[type=text]:focus{border-color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px;align-items:start}
.card{position:relative;background:var(--paper-2);border:1px solid var(--line-subtle);padding:18px 20px 16px 22px;
  border-radius:3px;transition:.24s cubic-bezier(.22,1,.36,1);cursor:pointer}
.card:hover{border-color:var(--line);background:var(--paper-3);transform:translateY(-1px)}
.card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent)}
.card[data-kind=pitfall]::before{background:var(--red)}
.card[data-kind=improve]::before{background:var(--teal)}
.card .meta{display:flex;gap:10px;align-items:center;font-family:var(--font-mono);font-size:10px;color:var(--muted);letter-spacing:.1em}
.card .kind{color:var(--accent)}
.card[data-kind=pitfall] .kind{color:var(--red)}
.card[data-kind=improve] .kind{color:var(--teal)}
.card h3{font-family:var(--font-serif);font-size:18px;color:var(--ink);margin:8px 0 6px;font-weight:600;line-height:1.45}
.card p{margin:0;font-size:13px;color:var(--body);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.card.open p{-webkit-line-clamp:unset;display:block}
.tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
.tag{font-family:var(--font-mono);font-size:10px;color:var(--muted);border:1px solid var(--line-subtle);padding:2px 7px;border-radius:999px}
.acts{display:flex;gap:6px;margin-top:14px;flex-wrap:wrap;align-items:center}
.act{font-family:var(--font-mono);font-size:10px;letter-spacing:.06em;color:var(--muted);background:transparent;
  border:1px solid var(--line-subtle);padding:3px 8px;border-radius:2px;cursor:pointer;transition:.2s}
.act:hover{color:var(--ink);border-color:var(--muted)}
.act[data-on]{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
.act.go{color:var(--accent);border-color:var(--accent)}
.act.go:hover{background:var(--accent-soft);color:var(--ink)}
.go-wrap{display:inline-flex;margin-right:4px}
.act.go[disabled],.act.go[disabled]:hover{opacity:.42;cursor:not-allowed;background:transparent;color:var(--accent);border-color:var(--accent)}
.note{min-height:20px;font-family:var(--font-mono);font-size:11px;letter-spacing:.04em;color:var(--muted);
  opacity:0;transition:opacity .2s}
.note.on{opacity:1;color:var(--accent)}
.note.bad{color:var(--red)}
.empty{color:var(--muted);font-family:var(--font-serif);font-style:italic;padding:60px 0;text-align:center}
.foot{margin-top:64px;padding-top:22px;border-top:1px solid var(--line-subtle);
  font-family:var(--font-mono);font-size:10.5px;color:var(--muted);letter-spacing:.06em;line-height:2}
`

const CLIENT_JS = (startPolicy) => `
const KIND_LABEL={idea:'插件点子',pitfall:'踩坑',improve:'改进点'};
const STATUS=[['new','待看'],['incubating','孵化中'],['done','已做'],['parked','搁置'],['dropped','丢弃']];
const START={request:'dsh-idea-log:start',started:'dsh-idea-log:started',failed:'dsh-idea-log:start-failed'};
const START_POLICY=${JSON.stringify(startPolicy).replace(/</g, '\\u003c')};
const START_HINT='在 DSH 里新开一个对话，把这条当成任务（只预填到输入框，不自动发送）';
let state={kind:'',status:'',q:''};
let items=new Map();
let waiting=null;
let noteTimer=null;
const grid=document.getElementById('grid');
const statsBox=document.getElementById('stats');
const noteBox=document.getElementById('note');

function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function fmt(ts){const d=new Date(ts);const p=function(n){return String(n).padStart(2,'0')};
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())}

async function api(path,opts){
  const r=await fetch(path,opts);
  if(!r.ok) throw new Error(await r.text());
  return r.json();
}

function renderStats(s){
  statsBox.innerHTML=
    '<div class="stat"><b>'+s.total+'</b><span>全部</span></div>'+
    '<div class="stat"><b>'+s.byKind.idea+'</b><span>插件点子</span></div>'+
    '<div class="stat"><b>'+s.byKind.pitfall+'</b><span>踩坑</span></div>'+
    '<div class="stat"><b>'+s.byKind.improve+'</b><span>改进点</span></div>'+
    '<div class="stat"><b>'+s.fresh+'</b><span>待看</span></div>';
}

function showNote(text,bad){
  noteBox.textContent=text;
  noteBox.classList.toggle('bad',!!bad);
  noteBox.classList.add('on');
  clearTimeout(noteTimer);
  noteTimer=setTimeout(function(){noteBox.classList.remove('on')},bad?7000:5000);
}

function startBlocked(status){return START_POLICY.blocked.indexOf(status)>=0}
function blockedReason(status){return startBlocked(status)?START_POLICY.reason:''}

// 开工按钮：孵化中的置灰禁用，原因挂在包一层的 span 上。
// （disabled 的按钮在 Chromium 里不弹 title，所以提示放在外层 span。）
function goHTML(it){
  const blocked=startBlocked(it.status);
  return '<span class="go-wrap" title="'+esc(blocked?START_POLICY.reason:START_HINT)+'">'+
    '<button class="act go" type="button" data-id="'+it.id+'"'+(blocked?' disabled aria-disabled="true"':'')+'>开工 →</button></span>';
}

function syncGo(card,status){
  if(!card) return;
  const wrap=card.querySelector('.go-wrap');
  const btn=wrap&&wrap.querySelector('.act.go');
  if(!wrap||!btn) return;
  const blocked=startBlocked(status);
  btn.disabled=blocked;
  if(blocked) btn.setAttribute('aria-disabled','true'); else btn.removeAttribute('aria-disabled');
  wrap.title=blocked?START_POLICY.reason:START_HINT;
}

function cardHTML(it){
  const tags=(it.tags||[]).map(function(t){return '<span class="tag">'+esc(t)+'</span>'}).join('');
  const acts=STATUS.map(function(pair){
    return '<button class="act" data-id="'+it.id+'" data-status="'+pair[0]+'"'+(it.status===pair[0]?' data-on':'')+'>'+pair[1]+'</button>';
  }).join('');
  return '<article class="card" data-kind="'+it.kind+'" data-id="'+it.id+'" data-status="'+it.status+'">'+
    '<div class="meta"><span class="kind">'+KIND_LABEL[it.kind]+'</span><span>'+fmt(it.createdAt)+'</span>'+
    (it.source==='digest'?'<span>· 自动提炼</span>':'')+'</div>'+
    '<h3>'+esc(it.title)+'</h3>'+
    (it.body?'<p>'+esc(it.body)+'</p>':'')+
    (tags?'<div class="tags">'+tags+'</div>':'')+
    '<div class="acts">'+goHTML(it)+acts+'</div>'+
  '</article>';
}

async function load(){
  const qs=new URLSearchParams();
  if(state.kind) qs.set('kind',state.kind);
  if(state.status) qs.set('status',state.status);
  if(state.q) qs.set('q',state.q);
  const data=await api('api/list?'+qs.toString());
  renderStats(data.stats);
  const list=data.items||[];
  items=new Map();
  list.forEach(function(it){items.set(Number(it.id),it)});
  grid.innerHTML=list.length?list.map(cardHTML).join(''):'<div class="empty">这里还空着。遇到坑、冒出点子的时候记一句，它就在这儿了。</div>';
  bind();
}

function bind(){
  grid.querySelectorAll('.card').forEach(function(card){
    card.addEventListener('click',function(e){
      if(e.target.closest('.act')||e.target.closest('.go-wrap')) return;
      card.classList.toggle('open');
    });
  });
  grid.querySelectorAll('.act.go').forEach(function(btn){
    btn.addEventListener('click',function(e){
      e.stopPropagation();
      start(btn);
    });
  });
  grid.querySelectorAll('.act[data-status]').forEach(function(btn){
    btn.addEventListener('click',async function(e){
      e.stopPropagation();
      const id=btn.getAttribute('data-id'),status=btn.getAttribute('data-status');
      try{
        await api('api/update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:Number(id),status:status})});
        const card=btn.closest('.card');
        const rec=items.get(Number(id));
        if(rec) rec.status=status;
        card.querySelectorAll('.act').forEach(function(b){b.removeAttribute('data-on')});
        btn.setAttribute('data-on','');
        card.setAttribute('data-status',status);
        syncGo(card,status);
        const st=await api('api/stats');
        renderStats(st);
      }catch(err){showNote('没保存上：'+err.message,true)}
    });
  });
}

// 开工：把这条交给 DSH 网页半边去开新对话（只预填，不自动发送）。
function start(btn){
  const id=Number(btn.getAttribute('data-id'));
  const it=items.get(id);
  if(!it||!it.startPrompt){showNote('这条没有开工文案，刷新一下页面再试。',true);return}
  const why=blockedReason(it.status);
  if(why){showNote(why,true);return}
  if(waiting) return;
  if(window.parent===window){copyPrompt(it.startPrompt);return}
  btn.disabled=true;
  waiting={id:id,btn:btn};
  waiting.timer=setTimeout(function(){
    if(!waiting) return;
    const b=waiting.btn;
    const card=b?b.closest('.card'):null;
    waiting=null;
    syncGo(card,card?card.getAttribute('data-status'):'');
    showNote('DSH 那边没回话——插件可能刚更新，刷新页面再点一次。',true);
  },5000);
  window.parent.postMessage({type:START.request,id:id,prompt:it.startPrompt},location.origin);
}

async function copyPrompt(prompt){
  try{
    await navigator.clipboard.writeText(prompt);
    showNote('这个页面是单独打开的，开不了新对话——任务描述已复制，去 DSH 里新建对话粘上就行。');
  }catch(err){
    showNote('这个页面是单独打开的，得在 DSH 侧栏里点开才能一键开工。',true);
  }
}

async function settle(ok,id,error){
  if(!waiting||waiting.id!==id) return;
  const btn=waiting.btn;
  const card=btn?btn.closest('.card'):null;
  clearTimeout(waiting.timer);
  waiting=null;
  if(!ok){
    syncGo(card,card?card.getAttribute('data-status'):'');
    showNote('没开成：'+(error||'未知原因'),true);return
  }
  showNote('已开新对话，任务写进输入框了——看一眼就能发。');
  const it=items.get(id);
  if(it&&it.status!=='incubating'){
    try{
      await api('api/update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,status:'incubating'})});
      it.status='incubating';
      if(card) card.setAttribute('data-status','incubating');
    }catch(err){
      syncGo(card,it.status);
      showNote('对话开了，但状态没改成孵化中：'+err.message,true);return
    }
  }
  syncGo(card,it?it.status:(card?card.getAttribute('data-status'):''));
  load();
}

window.addEventListener('message',function(e){
  if(e.origin!==location.origin) return;
  const d=e.data||{};
  if(d.type===START.started) settle(true,Number(d.id));
  else if(d.type===START.failed) settle(false,Number(d.id),d.error);
});

document.querySelectorAll('.tab[data-kind]').forEach(function(t){
  t.addEventListener('click',function(){
    document.querySelectorAll('.tab[data-kind]').forEach(function(x){x.classList.remove('on')});
    t.classList.add('on');
    state.kind=t.getAttribute('data-kind');
    load();
  });
});
document.getElementById('status').addEventListener('change',function(e){state.status=e.target.value;load()});
let timer=null;
document.getElementById('q').addEventListener('input',function(e){
  clearTimeout(timer);
  timer=setTimeout(function(){state.q=e.target.value.trim();load()},260);
});

load();
`

export function renderPage({ title = '灵感账本', generatedAt = Date.now() } = {}) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${CSS}</style>
</head><body>
<div class="wrap">
  <div class="kicker">IDEA · LOG</div>
  <h1>灵感账本</h1>
  <p class="sub">干活时冒出来的插件点子、绕不过去的坑、还有对现有工具的改进点——先记下来，再慢慢挑着做。</p>
  <div class="stats" id="stats"></div>
  <div class="bar">
    <button class="tab on" data-kind="">全部</button>
    <button class="tab" data-kind="idea">插件点子</button>
    <button class="tab" data-kind="pitfall">踩坑</button>
    <button class="tab" data-kind="improve">改进点</button>
    <select id="status">
      <option value="">所有状态</option>
      <option value="new">待看</option>
      <option value="incubating">孵化中</option>
      <option value="done">已做</option>
      <option value="parked">搁置</option>
      <option value="dropped">丢弃</option>
    </select>
    <input id="q" type="text" placeholder="搜标题、正文、标签……">
  </div>
  <div class="note" id="note"></div>
  <div class="grid" id="grid"></div>
  <div class="foot">由 dsh-idea-log 生成 · ${new Date(generatedAt).toLocaleString('zh-CN')}<br>
  点卡片看全文 · 状态按钮直接落库 · 「开工」把这条交给新对话（只预填，不自动发送）· 每天自动从会话里提炼一次新点子</div>
</div>
<script>${CLIENT_JS({ blocked: START_BLOCKED_STATUSES, reason: START_BLOCKED_REASON })}</script>
</body></html>`
}
