/**
 * 看板快照：缓存「上一份 dashboard.html 是用什么数据拼出来的」。
 *
 * 打开页面时只要确认数据库指纹没变，就直接发旧文件——不再靠「距上次构建
 * 超过 5 分钟」这种和时间赛跑的判断。变了的话，构建过程拿这份快照做增量：
 * 没变的群、没变的人原样复用。
 */
import { createHash } from 'node:crypto'
import { existsSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CACHE_VERSION = 1
export const CACHE_FILE = 'dashboard.cache.json'
export const HTML_FILE = 'dashboard.html'

export function htmlPath(home) {
  return join(home, HTML_FILE)
}

/**
 * 全局指纹：库里的东西一变就变。约 3 ms。
 * 消息只插不改（source_key 唯一），所以 count/max(id)/max(ts) 足以覆盖新增与删除。
 */
export function dbFingerprint(db) {
  const m = db.prepare('select count(*) c, max(id) mx, max(ts) ts from messages').get()
  const md = db.prepare('select count(*) c, max(id) mx from media').get()
  const pr = db.prepare('select count(*) c, max(impression_at) at, sum(length(impression)) n from profiles').get()
  const rp = db.prepare('select count(*) c, max(created_at) at, sum(length(text)) n from reports').get()
  const ch = db.prepare('select count(*) c, sum(msg_count) n, max(last_ts) lt from chats').get()
  const names = db.prepare('select chat_key, name from chats order by chat_key').all()
  const nameHash = createHash('sha1')
    .update(names.map((r) => `${r.chat_key}\u0000${r.name || ''}`).join('\u0001'))
    .digest('hex')
    .slice(0, 12)
  return [
    m.c, m.mx || 0, m.ts || 0,
    md.c, md.mx || 0,
    pr.c, pr.at || 0, pr.n || 0,
    rp.c, rp.at || 0, rp.n || 0,
    ch.c, ch.n || 0, ch.lt || 0,
    nameHash,
  ].join('|')
}

/**
 * 每个会话的指纹：消息数 / 最大 id / 最大时间 + 媒体数。
 * @returns {Map<string, {sig: string}>}
 */
export function chatFingerprints(db) {
  const out = new Map()
  for (const r of db.prepare('select chat_key, count(*) c, max(id) mx, max(ts) ts from messages group by chat_key').all()) {
    out.set(r.chat_key, { sig: `${r.c}:${r.mx || 0}:${r.ts || 0}:0`, count: r.c })
  }
  for (const r of db.prepare('select chat_key, count(*) c from media group by chat_key').all()) {
    const cur = out.get(r.chat_key) || { sig: '0:0:0:0', count: 0 }
    const parts = cur.sig.split(':')
    parts[3] = String(r.c)
    out.set(r.chat_key, { sig: parts.join(':'), count: cur.count })
  }
  return out
}

/**
 * 某个群里每个人的指纹：[消息数, 最后时间, 媒体数]。
 * @returns {Map<string, [number, number, number]>}
 */
export function userFingerprints(db, chatKey) {
  const map = new Map()
  for (const r of db
    .prepare("select sender_id, count(*) c, max(ts) ts from messages where chat_key = ? and sender_id <> '' group by sender_id")
    .all(chatKey)) {
    map.set(String(r.sender_id), [r.c, r.ts || 0, 0])
  }
  for (const r of db.prepare('select sender_id, count(*) c from media where chat_key = ? group by sender_id').all(chatKey)) {
    const id = String(r.sender_id || '')
    if (!id) continue
    const cur = map.get(id) || [0, 0, 0]
    cur[2] = r.c
    map.set(id, cur)
  }
  return map
}

/** 人指纹拼成签名字符串。 */
export function userSig(fp) {
  return `${fp[0] || 0}:${fp[1] || 0}:${fp[2] || 0}`
}

/** 把各群的人指纹合计成「跨群」指纹。 */
export function aggregateUsers(userMaps) {
  const agg = new Map()
  for (const map of userMaps.values()) {
    for (const [id, fp] of map) {
      const cur = agg.get(id) || [0, 0, 0]
      cur[0] += fp[0] || 0
      cur[1] = Math.max(cur[1], fp[1] || 0)
      cur[2] += fp[2] || 0
      agg.set(id, cur)
    }
  }
  return agg
}

export function serializeUsers(map) {
  const obj = {}
  for (const [id, fp] of map) obj[id] = fp
  return obj
}

export function restoreUsers(obj) {
  const map = new Map()
  for (const [id, fp] of Object.entries(obj || {})) {
    if (Array.isArray(fp)) map.set(id, [fp[0] || 0, fp[1] || 0, fp[2] || 0])
  }
  return map
}

/**
 * 把 data 发布到 path，尽量保住「要么旧、要么新」：
 * 1) 先写 .tmp 再 rename —— 正常路径下这是原子的；
 * 2) Windows 上目标文件如果正被别的进程打开、且对方没给「删除共享」
 *    （实测 DSH 自己预览过 dashboard.html 就会这样），rename 会一直 EPERM。
 *    这时退化成原地覆盖：内容照样换新，只是少了原子替换这一层。
 * @returns {'rename' | 'inplace'}
 */
export function writeFileAtomic(path, data) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data, 'utf8')
  let renameErr = null
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      renameSync(tmp, path)
      return 'rename'
    } catch (e) {
      renameErr = e
      if (!RETRYABLE_RENAME.has(e.code)) {
        cleanupTmp(tmp)
        throw e
      }
      if (attempt < 5) sleepMs(40 * (attempt + 1))
    }
  }

  try {
    const fd = openSync(path, 'w')
    try {
      writeFileSync(fd, data, 'utf8')
    } finally {
      closeSync(fd)
    }
    return 'inplace'
  } finally {
    cleanupTmp(tmp)
  }
}

const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES'])

function cleanupTmp(tmp) {
  try {
    unlinkSync(tmp)
  } catch {
    /* tmp 可能已经被 rename 掉了 */
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function htmlStat(path) {
  const st = statSync(path)
  return { bytes: st.size, mtimeMs: st.mtimeMs }
}

/**
 * 读快照。版本不符 / 损坏 / 对应的 dashboard.html 不在或对不上，一律当作没有。
 * @returns {object|null}
 */
export function loadSnapshot(home) {
  try {
    const cachePath = join(home, CACHE_FILE)
    const file = htmlPath(home)
    if (!existsSync(cachePath) || !existsSync(file)) return null
    const snap = JSON.parse(readFileSync(cachePath, 'utf8'))
    if (!snap || snap.version !== CACHE_VERSION) return null
    if (!snap.chats || !snap.global || typeof snap.fp !== 'string') return null
    const st = statSync(file)
    if (!snap.html) return null
    if (snap.html.bytes !== st.size) return null
    if (Math.abs((snap.html.mtimeMs || 0) - st.mtimeMs) > 1) return null
    return snap
  } catch {
    return null
  }
}

export function saveSnapshot(home, snapshot) {
  writeFileAtomic(join(home, CACHE_FILE), JSON.stringify(snapshot))
}

/** 空快照：等价于「全量重建，但结果要缓存下来」。 */
export function emptySnapshot() {
  return { version: CACHE_VERSION, builtAt: 0, fp: '', html: null, chats: {}, global: { people: [] } }
}
