/**
 * archive.db：插件自己的索引库。
 *
 * 只用 node:sqlite（Node 22.5+ 内置）；FTS5 不可用时降级为 LIKE 搜索。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tokenize, charTokens, charPhrases, ftsTerms, ftsAnd, ftsOr, escapeLike } from './segment.mjs'

/** 只用于覆盖率分母的虚词；查询构造仍用原词，避免改变语义。 */
export const STOP_WORDS = new Set([
  '的', '了', '是', '在', '和', '就', '都', '也', '吗', '呢', '啊', '吧', '呀', '哦', '嗯',
  '我', '你', '他', '她', '它', '这', '那', '有', '没', '很', '太', '会', '要', '把', '被',
  '给', '让', '对', '从', '到', '与', '及', '或', '而', '但', '又', '再', '还', '只', '才',
  '最', '更', '等', '个', '些', '什么', '怎么', '这个', '那个', '一个', '我们', '你们',
  '他们', '就是', '还是', '可以', '没有', '不是', '真的', '然后', '因为', '所以', '如果', '已经',
])

function meaningfulTokens(query) {
  const all = ftsTerms(query)
  const kept = all.filter((t) => !STOP_WORDS.has(t))
  return kept.length ? kept : all
}

function coverageOf(text, tokens) {
  if (!tokens.length) return 1
  const lower = String(text || '').toLowerCase()
  let hit = 0
  for (const t of tokens) if (lower.includes(t.toLowerCase())) hit++
  return hit / tokens.length
}

const SCHEMA = `
create table if not exists meta(key text primary key, value text);

create table if not exists chats(
  chat_key text primary key,
  type text not null,
  id text not null,
  name text,
  msg_count integer not null default 0,
  last_ts integer not null default 0,
  meta text
);

create table if not exists messages(
  id integer primary key autoincrement,
  source text not null,
  source_key text not null unique,
  chat_key text not null,
  chat_type text not null,
  chat_id text not null,
  sender_id text not null,
  sender_name text,
  ts integer not null,
  kind text not null,
  text text not null default '',
  reply_to text,
  raw text,
  meta text
);
create index if not exists idx_messages_chat_ts on messages(chat_key, ts);
create index if not exists idx_messages_sender_ts on messages(sender_id, ts);
create index if not exists idx_messages_ts on messages(ts);

create table if not exists members(
  chat_key text not null,
  user_id text not null,
  names text,
  first_seen integer not null default 0,
  last_seen integer not null default 0,
  msg_count integer not null default 0,
  primary key(chat_key, user_id)
);

create table if not exists media(
  id integer primary key autoincrement,
  source_key text not null unique,
  message_key text not null,
  chat_key text not null,
  sender_id text,
  ts integer,
  kind text not null,
  file_name text,
  url text,
  size integer,
  width integer,
  height integer,
  local_path text,
  thumb_path text,
  status text not null default 'meta',
  extra text
);
create index if not exists idx_media_message on media(message_key);

create table if not exists profiles(
  chat_key text not null,
  user_id text not null,
  stats text,
  impression text,
  impression_at integer,
  primary key(chat_key, user_id)
);

create table if not exists reports(
  date text not null,
  chat_key text not null,
  text text,
  stats text,
  model text,
  created_at integer not null default 0,
  primary key(date, chat_key)
);

-- 名场面（爆聊窗口 + 模型摘要）。同一段窗口只存一份，force 时覆盖。
create table if not exists highlights(
  id integer primary key autoincrement,
  chat_key text not null,
  from_ts integer not null,
  to_ts integer not null,
  msg_count integer not null default 0,
  stats text,
  summary text,
  model text,
  created_at integer not null default 0,
  unique(chat_key, from_ts, to_ts)
);

-- 周报 / 月报。range 由 kind + from_date 唯一确定，to_date 跟着算。
create table if not exists period_reports(
  kind text not null,
  from_date text not null,
  to_date text not null,
  chat_key text not null,
  text text,
  stats text,
  model text,
  created_at integer not null default 0,
  primary key(kind, from_date, chat_key)
);
`

function tryExec(db, sql) {
  try {
    db.exec(sql)
    return true
  } catch {
    return false
  }
}

/** 老库补列：后加的字段直接 alter 比要求重建成品库省事。 */
function migrate(db) {
  const pcols = new Set(db.prepare('pragma table_info(profiles)').all().map((r) => r.name))
  if (!pcols.has('tags')) db.exec('alter table profiles add column tags text')
  if (!pcols.has('model')) db.exec('alter table profiles add column model text')

  const mcols = new Set(db.prepare('pragma table_info(media)').all().map((r) => r.name))
  if (!mcols.has('transcript')) db.exec('alter table media add column transcript text')
}

export function openArchive(home) {
  mkdirSync(home, { recursive: true })
  const path = join(home, 'archive.db')
  const db = new DatabaseSync(path)
  db.exec('pragma journal_mode = wal')
  db.exec('pragma synchronous = normal')
  db.exec(SCHEMA)
  migrate(db)
  const fts = tryExec(db, `create virtual table if not exists messages_fts using fts5(body, tokenize='unicode61')`)
  const chars = tryExec(db, `create virtual table if not exists messages_chars using fts5(chars, tokenize='unicode61')`)
  return { db, path, fts, chars }
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('select value from meta where key = ?').get(key)
  return row ? row.value : fallback
}

export function setMeta(db, key, value) {
  db.prepare('insert into meta(key, value) values(?, ?) on conflict(key) do update set value = excluded.value').run(key, String(value))
}

/** 事务包一层；callback 里抛错则回滚。 */
export function transact(db, fn) {
  db.exec('begin')
  try {
    const out = fn()
    db.exec('commit')
    return out
  } catch (e) {
    try {
      db.exec('rollback')
    } catch {
      /* 回滚失败就交给上层 */
    }
    throw e
  }
}

function mergeNames(existingJson, name) {
  let names = []
  try {
    if (existingJson) names = JSON.parse(existingJson)
  } catch {
    names = []
  }
  if (!Array.isArray(names)) names = []
  if (name && !names.includes(name)) names.push(name)
  if (names.length > 20) names = names.slice(-20)
  return JSON.stringify(names)
}

/**
 * 把一批规范化记录写进库。返回 { inserted, media, chats, members }。
 * 调用方负责外面套事务（每批一次）。
 */
export function insertBatch(db, archive, records) {
  const fts = archive?.fts
  const chars = archive?.chars
  const insMsg = db.prepare(
    `insert into messages(source, source_key, chat_key, chat_type, chat_id, sender_id, sender_name, ts, kind, text, reply_to, raw, meta)
     values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(source_key) do nothing
     returning id`,
  )
  const insFts = fts ? db.prepare('insert into messages_fts(rowid, body) values(?, ?)') : null
  const insChars = chars ? db.prepare('insert into messages_chars(rowid, chars) values(?, ?)') : null
  const upsertChat = db.prepare(
    `insert into chats(chat_key, type, id, name, msg_count, last_ts)
     values(?, ?, ?, ?, 1, ?)
     on conflict(chat_key) do update set
       name = case when excluded.name is not null and excluded.name <> '' then excluded.name else chats.name end,
       msg_count = chats.msg_count + 1,
       last_ts = max(chats.last_ts, excluded.last_ts)`,
  )
  const getMember = db.prepare('select names from members where chat_key = ? and user_id = ?')
  const upsertMember = db.prepare(
    `insert into members(chat_key, user_id, names, first_seen, last_seen, msg_count)
     values(?, ?, ?, ?, ?, 1)
     on conflict(chat_key, user_id) do update set
       names = excluded.names,
       first_seen = min(members.first_seen, excluded.first_seen),
       last_seen = max(members.last_seen, excluded.last_seen),
       msg_count = members.msg_count + 1`,
  )
  const insMedia = db.prepare(
    `insert into media(source_key, message_key, chat_key, sender_id, ts, kind, file_name, url, size, width, height, status, extra)
     values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'meta', ?)
     on conflict(source_key) do nothing`,
  )

  let inserted = 0
  let mediaCount = 0
  const chats = new Map()
  const members = new Map()

  for (const rec of records) {
    const m = rec.message
    if (!m) continue
    const row = insMsg.get(
      m.source,
      m.sourceKey,
      m.chatKey,
      m.chatType,
      m.chatId,
      m.senderId,
      m.senderName,
      m.ts,
      m.kind,
      m.text || '',
      m.replyTo || null,
      m.raw || null,
      null,
    )
    if (!row) continue
    inserted++
    if (insFts || insChars) {
      if (insFts) {
        const body = [tokenize(m.text), tokenize(m.senderName), tokenize(m.chatName)].filter(Boolean).join(' ')
        insFts.run(row.id, body)
      }
      // 字符表只索引正文：搜「大肥鱼」不该因为群名里有个「肥」就命中
      if (insChars) insChars.run(row.id, charTokens(m.text))
    }
    upsertChat.run(m.chatKey, m.chatType, m.chatId, m.chatName || '', m.ts)
    chats.set(m.chatKey, m.chatName)
    const member = getMember.get(m.chatKey, m.senderId)
    upsertMember.run(m.chatKey, m.senderId, mergeNames(member?.names, m.senderName), m.ts, m.ts)
    members.set(m.chatKey + ':' + m.senderId, m.senderName)

    for (const md of rec.media || []) {
      const sk = `${m.sourceKey}#${md.index}`
      const r = insMedia.run(
        sk,
        m.sourceKey,
        m.chatKey,
        m.senderId,
        m.ts,
        md.kind,
        md.file || null,
        md.url || null,
        md.size || null,
        md.width || null,
        md.height || null,
        JSON.stringify({ summary: md.summary || '', md5: md.md5 || null, sha1: md.sha1 || null }),
      )
      if (r.changes) mediaCount++
    }
  }
  return { inserted, media: mediaCount, chats: chats.size, members: members.size }
}

function buildFilters(opts, params, conditions) {
  if (opts.chatKey) {
    conditions.push('m.chat_key = ?')
    params.push(opts.chatKey)
  }
  if (opts.senderId) {
    conditions.push('m.sender_id = ?')
    params.push(opts.senderId)
  } else if (opts.senderName) {
    conditions.push('m.sender_name like ? escape ?')
    params.push('%' + escapeLike(opts.senderName) + '%', '\\')
  }
  if (Number.isFinite(opts.fromTs)) {
    conditions.push('m.ts >= ?')
    params.push(opts.fromTs)
  }
  if (Number.isFinite(opts.toTs)) {
    conditions.push('m.ts <= ?')
    params.push(opts.toTs)
  }
  if (opts.kind && opts.kind !== 'all') {
    if (opts.kind === 'link') {
      conditions.push("m.text like '%http%'")
    } else {
      conditions.push('m.kind = ?')
      params.push(opts.kind)
    }
  }
}

function rowToHit(row) {
  return {
    id: row.id,
    ts: row.ts,
    chatKey: row.chat_key,
    chatId: row.chat_id,
    chatType: row.chat_type,
    senderId: row.sender_id,
    senderName: row.sender_name,
    kind: row.kind,
    text: row.text,
    replyTo: row.reply_to,
    rank: row.rank,
  }
}

/**
 * 搜索。优先级：字符短语（精确子串）→ 分词 AND → 分词 OR（按覆盖率过滤）→ LIKE。
 */
export function searchMessages(archive, opts) {
  const { db, fts, chars } = archive
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 20))
  const offset = Math.max(0, Number(opts.offset) || 0)
  const query = String(opts.query || '').trim()

  const runOn = (table, available, match) => {
    if (!available || !match) return []
    const conditions = []
    const params = [match]
    buildFilters(opts, params, conditions)
    const sql = `select m.*, bm25(${table}) as rank
                   from ${table}
                   join messages m on m.id = ${table}.rowid
                  where ${table} match ?
                    ${conditions.length ? 'and ' + conditions.join(' and ') : ''}
                  order by rank
                  limit ? offset ?`
    params.push(limit, offset)
    return db.prepare(sql).all(...params)
  }

  const runChars = (match) => runOn('messages_chars', chars, match)
  const runFts = (match) => runOn('messages_fts', fts, match)

  const runLike = () => {
    const conditions = []
    const params = []
    buildFilters(opts, params, conditions)
    if (query) {
      const term = tokens.length === 1 ? tokens[0] : query
      conditions.push("m.text like ? escape '\\'")
      params.push('%' + escapeLike(term) + '%')
    }
    const sql = `select m.* from messages m
                  ${conditions.length ? 'where ' + conditions.join(' and ') : ''}
                  order by m.ts desc
                  limit ? offset ?`
    params.push(limit, offset)
    return db.prepare(sql).all(...params)
  }

  const tokens = meaningfulTokens(query)
  const minCover = tokens.length <= 2 ? 1 : Math.ceil(tokens.length * 0.6)

  let rows = []
  let modeUsed = 'none'
  if (query) {
    // 1) 字符短语：原文里真的连续出现这个串（分词词典外的词也能精确命中）
    rows = runChars(charPhrases(query))
    if (rows.length) modeUsed = 'chars'
    else {
      // 2) 分词 AND：词都在（可能不连续）
      rows = runFts(ftsAnd(query))
      if (rows.length) modeUsed = 'fts'
      else {
        // 3) 分词 OR：只保留词覆盖率够的，避免「不存在 的 词 zzz」把含「的」的全捞出来
        const orRows = runFts(ftsOr(query))
        const filtered = orRows.filter((r) => coverageOf(r.text, tokens) >= minCover)
        if (filtered.length) {
          rows = filtered
          modeUsed = 'fts-or'
        } else if (tokens.length <= 1) {
          // 多词查询不做 LIKE 兜底：'%词1% or %词2%' 会把含常见词的消息全捞出来
          rows = runLike()
          if (rows.length) modeUsed = 'like'
        }
      }
    }
  } else {
    rows = runLike()
    if (rows.length) modeUsed = 'scan'
  }
  return { hits: rows.map(rowToHit), mode: modeUsed }
}

/** 取某条消息前后各 n 条（同会话，按 id）。 */
export function contextAround(db, hit, n = 2) {
  const before = db
    .prepare('select id, ts, sender_id, sender_name, kind, text from messages where chat_key = ? and id < ? order by id desc limit ?')
    .all(hit.chatKey, hit.id, n)
    .reverse()
  const after = db
    .prepare('select id, ts, sender_id, sender_name, kind, text from messages where chat_key = ? and id > ? order by id asc limit ?')
    .all(hit.chatKey, hit.id, n)
  return [...before, ...after].map((r) => ({
    id: r.id,
    ts: r.ts,
    senderId: r.sender_id,
    senderName: r.sender_name,
    kind: r.kind,
    text: r.text,
  }))
}

/** 会话列表（带条数和最后时间）。 */
export function listChats(db, limit = 100) {
  return db
    .prepare('select chat_key, type, id, name, msg_count, last_ts from chats order by msg_count desc limit ?')
    .all(limit)
    .map((r) => ({ key: r.chat_key, type: r.type, id: r.id, name: r.name, msgCount: r.msg_count, lastTs: r.last_ts }))
}

export function dbStats(db) {
  const total = db.prepare('select count(*) c from messages').get()?.c || 0
  const span = db.prepare('select min(ts) a, max(ts) b from messages').get()
  const chats = db.prepare('select count(*) c from chats').get()?.c || 0
  const members = db.prepare('select count(*) c from members').get()?.c || 0
  const media = db.prepare('select count(*) c from media').get()?.c || 0
  return { total, chats, members, media, fromTs: span?.a || 0, toTs: span?.b || 0 }
}
