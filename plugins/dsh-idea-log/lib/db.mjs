import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const KINDS = ['idea', 'pitfall', 'improve']
export const STATUSES = ['new', 'incubating', 'done', 'parked', 'dropped']

export const KIND_LABEL = { idea: '插件点子', pitfall: '踩坑', improve: '改进点' }
export const STATUS_LABEL = {
  new: '待看',
  incubating: '孵化中',
  done: '已做',
  parked: '搁置',
  dropped: '丢弃',
}

const SCHEMA = `
create table if not exists ideas (
  id integer primary key autoincrement,
  kind text not null default 'idea',
  title text not null,
  body text not null default '',
  tags text not null default '[]',
  source text not null default 'manual',
  status text not null default 'new',
  created_at integer not null,
  updated_at integer not null
);
create index if not exists ideas_kind on ideas(kind);
create index if not exists ideas_status on ideas(status);
create index if not exists ideas_created on ideas(created_at);
create table if not exists meta (key text primary key, value text);
`

export function ideasHome(home) {
  const dir = home || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'idea-log')
  mkdirSync(dir, { recursive: true })
  return dir
}

// 老库升级：后加的列在这里补，别在 SCHEMA 里硬塞（create table if not exists 不会改已有表）。
// session_id 记「开工」开出的对话；awaiting_done 是「这一轮跑完了，等人确认」；
// turn_done_at 是最近一次跑完的时间（展示用）。
function ensureIdeaColumns(db) {
  const have = new Set(db.prepare('pragma table_info(ideas)').all().map((r) => r.name))
  const add = [
    ['session_id', 'text'],
    ['awaiting_done', 'integer not null default 0'],
    ['turn_done_at', 'integer'],
  ]
  for (const [name, decl] of add) {
    if (!have.has(name)) db.exec(`alter table ideas add column ${name} ${decl}`)
  }
}

export function openIdeas(home) {
  const dir = ideasHome(home)
  const path = join(dir, 'ideas.db')
  const db = new DatabaseSync(path)
  db.exec('pragma journal_mode = wal;')
  db.exec(SCHEMA)
  ensureIdeaColumns(db)
  return { db, path, dir }
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('select value from meta where key = ?').get(key)
  return row ? row.value : fallback
}

export function setMeta(db, key, value) {
  db.prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(
    key,
    String(value),
  )
}

function parseTags(raw) {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 8) : []
  } catch {
    return []
  }
}

export function normalizeKind(kind) {
  return KINDS.includes(kind) ? kind : 'idea'
}

export function normalizeStatus(status) {
  return STATUSES.includes(status) ? status : 'new'
}

/**
 * 记一条。24 小时内同名（忽略空白与大小写）直接返回已有那条，不重复写。
 * @returns {{id:number, duplicate:boolean, row:object}}
 */
export function addIdea(db, { kind = 'idea', title, body = '', tags = [], source = 'manual', status = 'new' } = {}) {
  const clean = String(title || '').trim()
  if (!clean) throw new Error('标题不能为空')
  const now = Date.now()
  const since = now - 24 * 3600 * 1000
  const same = db
    .prepare('select * from ideas where lower(trim(title)) = lower(trim(?)) and created_at >= ? limit 1')
    .get(clean, since)
  if (same) return { id: same.id, duplicate: true, row: hydrate(same) }

  const info = db
    .prepare(
      `insert into ideas (kind, title, body, tags, source, status, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      normalizeKind(kind),
      clean.slice(0, 200),
      String(body || '').slice(0, 4000),
      JSON.stringify(tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 24)).slice(0, 8)),
      source === 'digest' ? 'digest' : 'manual',
      normalizeStatus(status),
      now,
      now,
    )
  const row = db.prepare('select * from ideas where id = ?').get(info.lastInsertRowid)
  return { id: Number(info.lastInsertRowid), duplicate: false, row: hydrate(row) }
}

function hydrate(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    kind: row.kind,
    title: row.title,
    body: row.body,
    tags: parseTags(row.tags),
    source: row.source,
    status: row.status,
    sessionId: row.session_id || null,
    awaitingDone: Number(row.awaiting_done || 0) === 1,
    turnDoneAt: row.turn_done_at == null ? null : Number(row.turn_done_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export function listIdeas(db, { kind = null, status = null, q = '', limit = 100 } = {}) {
  const where = []
  const args = []
  if (kind && KINDS.includes(kind)) {
    where.push('kind = ?')
    args.push(kind)
  }
  if (status && STATUSES.includes(status)) {
    where.push('status = ?')
    args.push(status)
  }
  const term = String(q || '').trim()
  if (term) {
    where.push('(title like ? or body like ? or tags like ?)')
    const like = `%${term.replace(/[%_]/g, (m) => '\\' + m)}%`
    args.push(like, like, like)
  }
  const sql = `select * from ideas ${where.length ? 'where ' + where.join(' and ') : ''} order by created_at desc, id desc limit ?`
  return db
    .prepare(sql)
    .all(...args, Math.min(Math.max(Number(limit) || 100, 1), 500))
    .map(hydrate)
}

export function updateIdea(db, { id, status = null, title = null, body = null, tags = null } = {}) {
  const row = db.prepare('select * from ideas where id = ?').get(Number(id))
  if (!row) throw new Error(`第 ${id} 条不存在`)
  const sets = []
  const args = []
  if (status) {
    sets.push('status = ?')
    args.push(normalizeStatus(status))
    // 手动改状态就当作已经看过「跑完了」提示，别让旧提醒挂着。
    sets.push('awaiting_done = 0')
  }
  if (title !== null && String(title).trim()) {
    sets.push('title = ?')
    args.push(String(title).trim().slice(0, 200))
  }
  if (body !== null) {
    sets.push('body = ?')
    args.push(String(body).slice(0, 4000))
  }
  if (tags !== null) {
    sets.push('tags = ?')
    args.push(JSON.stringify(Array.isArray(tags) ? tags.slice(0, 8) : []))
  }
  if (!sets.length) return hydrate(row)
  sets.push('updated_at = ?')
  args.push(Date.now())
  db.prepare(`update ideas set ${sets.join(', ')} where id = ?`).run(...args, Number(id))
  return hydrate(db.prepare('select * from ideas where id = ?').get(Number(id)))
}

/**
 * 把一条灵感绑到它开出的对话上。重新开工时以最后一次绑定为准，顺便清掉旧的完成提示。
 * 只绑「孵化中」的条目：别的状态不该再占着对话。
 * @returns {object|null} 更新后的条目；不存在或状态不对返回 null
 */
export function bindIdeaSession(db, id, sessionId) {
  const row = db.prepare('select * from ideas where id = ?').get(Number(id))
  if (!row || row.status !== 'incubating') return null
  const sid = String(sessionId || '').trim()
  if (!sid) return null
  db.prepare('update ideas set session_id = ?, awaiting_done = 0, turn_done_at = null where id = ?').run(sid, Number(id))
  return hydrate(db.prepare('select * from ideas where id = ?').get(Number(id)))
}

/** 解开绑定（改绑到另一条灵感前先摘干净） */
export function clearIdeaSession(db, id) {
  db.prepare('update ideas set session_id = null, awaiting_done = 0, turn_done_at = null where id = ?').run(Number(id))
  return hydrate(db.prepare('select * from ideas where id = ?').get(Number(id)))
}

/** 这个对话绑的是哪条灵感（只看孵化中的） */
export function ideaBySession(db, sessionId) {
  const sid = String(sessionId || '').trim()
  if (!sid) return null
  const row = db
    .prepare('select * from ideas where session_id = ? and status = ? order by updated_at desc limit 1')
    .get(sid, 'incubating')
  return hydrate(row)
}

/** 对话跑完一轮：打上「等确认」。只对孵化中、且绑定对得上的条目生效。 */
export function markTurnDone(db, id, at = Date.now()) {
  const row = db.prepare('select * from ideas where id = ?').get(Number(id))
  if (!row || row.status !== 'incubating') return null
  db.prepare('update ideas set awaiting_done = 1, turn_done_at = ? where id = ?').run(Number(at), Number(id))
  return hydrate(db.prepare('select * from ideas where id = ?').get(Number(id)))
}

/** 人点了「标为已做」：结束孵化 */
export function confirmIdeaDone(db, id) {
  const row = db.prepare('select * from ideas where id = ?').get(Number(id))
  if (!row) return null
  db.prepare('update ideas set status = ?, awaiting_done = 0, updated_at = ? where id = ?').run('done', Date.now(), Number(id))
  return hydrate(db.prepare('select * from ideas where id = ?').get(Number(id)))
}

/** 人点了「先不标」：只收起提示，继续孵化 */
export function dismissIdeaDone(db, id) {
  db.prepare('update ideas set awaiting_done = 0 where id = ?').run(Number(id))
  return hydrate(db.prepare('select * from ideas where id = ?').get(Number(id)))
}

/** 现在有哪几条在等确认（孵化中 + awaiting_done） */
export function awaitingIdeas(db) {
  return db
    .prepare('select * from ideas where status = ? and awaiting_done = 1 order by turn_done_at desc, id desc')
    .all('incubating')
    .map(hydrate)
}

export function deleteIdea(db, id) {
  return db.prepare('delete from ideas where id = ?').run(Number(id)).changes > 0
}

export function ideaStats(db) {
  const byKind = {}
  for (const k of KINDS) byKind[k] = db.prepare('select count(*) as n from ideas where kind = ?').get(k).n
  const byStatus = {}
  for (const s of STATUSES) byStatus[s] = db.prepare('select count(*) as n from ideas where status = ?').get(s).n
  const total = db.prepare('select count(*) as n from ideas').get().n
  const fresh = db.prepare('select count(*) as n from ideas where status = ?').get('new').n
  return { total, byKind, byStatus, fresh }
}

/** 最近一段时间已有的标题，给提炼去重用 */
export function recentTitles(db, sinceTs = 0) {
  return db
    .prepare('select title from ideas where created_at >= ?')
    .all(sinceTs)
    .map((r) => r.title)
}
