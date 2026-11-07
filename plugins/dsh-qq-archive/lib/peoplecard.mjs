/**
 * 群友熟人卡：从档案库里挑每个会话最常说话的人，连同人物印象，
 * 导出一份 people.json，给 QQ 桥接读（让那边的大肥鱼在群里认人）。
 *
 * 为什么单独导一份 JSON 而不是让桥直接读 SQLite：
 * - 桥和档案库是两个项目，一个 JSON 文件是最松的耦合；
 * - 桥每次唤醒只要读一个小文件（带 mtime 缓存），不用碰 SQLite；
 * - 档案库换存储、换位置，桥只要改一个路径。
 *
 * 导出的内容刻意压得很小：每个人的名字、总条数、一句话印象、几个标签。
 * 上千条原始消息不该进 prompt——那是档案库自己的事。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { splitStoredImpression } from './impression.mjs'
import { join } from 'node:path'

export const PEOPLE_FILE = 'people.json'
const DEFAULT_PER_CHAT = 24
const DEFAULT_MIN_MSGS = 3
const IMPRESSION_CHARS = 180

function parseTags(raw) {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 6) : []
  } catch {
    return []
  }
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

// 早期生成的印象里混进过「整段 JSON 当正文」的记录（模型输出没被拆干净就落了库）。
// 有的 JSON 里还夹着没转义的引号，JSON.parse 会失败，所以先正规解析、再用正则兜底。
function cleanImpression(raw) {
  // 老数据可能把整段 JSON 存进了 impression 列，统一从这里拆
  const { text } = splitStoredImpression(raw)
  return clip(text, IMPRESSION_CHARS)
}

// 群的系统消息（「X 邀请 Y 加入」「撤回了一条消息」）也会占用 sender_name，
// 拿它当人名会拼出「某某 邀请“某位群友”加入了群聊（123456789）」。这类一律退回 QQ 号。
const SYSTEM_NAME_RE = /邀请|加入|撤回|禁言|红包|群公告|改名为|退群|踢出|移出/
function cleanName(name, id) {
  const raw = String(name ?? '').trim()
  if (!raw || SYSTEM_NAME_RE.test(raw) || /[\u0000-\u001f\u007f]/.test(raw)) return `QQ ${id}`
  const s = raw.replace(/\s+/g, ' ')
  return s.length > 24 ? s.slice(0, 24) + '…' : s
}

/** 一个会话里最常说话的人（按条数倒序），带印象与标签。 */
function peopleOfChat(db, chatKey, impressions, perChat, minMsgs) {
  // 一次拿全群成员的最近名字，避免每人一条 SQL。
  const names = new Map()
  for (const row of db
    .prepare(
      `select sender_id, sender_name, max(ts) as last_ts
         from messages
        where chat_key = ? and sender_id <> ''
        group by sender_id`,
    )
    .all(chatKey)) {
    names.set(String(row.sender_id), { name: row.sender_name || '', lastTs: row.last_ts || 0 })
  }

  const rows = db
    .prepare(
      `select sender_id, count(*) as n
         from messages
        where chat_key = ? and sender_id <> ''
        group by sender_id
       having n >= ?
        order by n desc
        limit ?`,
    )
    .all(chatKey, minMsgs, perChat)

  return rows.map((row) => {
    const id = String(row.sender_id)
    const info = names.get(id) || {}
    const im = impressions.get(id) || {}
    return {
      id,
      name: cleanName(info.name, id),
      total: row.n,
      impression: cleanImpression(im.impression),
      tags: im.tags || [],
    }
  })
}

/**
 * 导出熟人卡数据（不落盘）。
 * @returns {{generatedAt:number, perChat:number, chats:Record<string,{name:string,people:object[]}>}}
 */
export function buildPeopleCard(db, { perChat = DEFAULT_PER_CHAT, minMsgs = DEFAULT_MIN_MSGS } = {}) {
  const impressions = new Map()
  for (const r of db.prepare("select user_id, impression, tags from profiles where chat_key = '*'").all()) {
    impressions.set(String(r.user_id), { impression: r.impression || '', tags: parseTags(r.tags) })
  }

  const chats = db.prepare('select chat_key, name, msg_count from chats order by msg_count desc').all()
  const out = { generatedAt: Date.now(), perChat, chats: {} }
  for (const c of chats) {
    const people = peopleOfChat(db, c.chat_key, impressions, perChat, minMsgs)
    if (people.length) out.chats[c.chat_key] = { name: c.name || '', people }
  }
  return out
}

/** 写进 home/people.json，返回 {path, bytes, chats, people}。 */
export function exportPeopleCard(db, { home, perChat = DEFAULT_PER_CHAT, minMsgs = DEFAULT_MIN_MSGS } = {}) {
  const card = buildPeopleCard(db, { perChat, minMsgs })
  const path = join(home, PEOPLE_FILE)
  mkdirSync(home, { recursive: true })
  const text = JSON.stringify(card)
  writeFileSync(path, text, 'utf8')
  let people = 0
  for (const k of Object.keys(card.chats)) people += card.chats[k].people.length
  return { path, bytes: Buffer.byteLength(text, 'utf8'), chats: Object.keys(card.chats).length, people }
}
