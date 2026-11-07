/**
 * OneBot v11 适配器：走 HTTP API 拉最近历史（get_group_list / get_friend_list /
 * get_*_msg_history）。适合 NapCat / LLOneBot / Lagrange 这类实现了历史查询的桥。
 *
 * 局限：HTTP 历史接口只能往回拿固定条数，第一次全量同步会有上限（每个会话
 * HISTORY_COUNT 条）。真要完整历史，优先用 SnowLuma 的 messages.db。
 */
import { normalizeOneBot } from '../normalize.mjs'

const HISTORY_COUNT = 200
const MAX_CHATS = 60
const LIST_TTL = 5 * 60 * 1000

export function openOneBot({ baseUrl, accessToken, timeoutMs = 20000 } = {}) {
  if (!baseUrl) throw new Error('onebot 数据源需要配置 onebot.baseUrl')
  const base = String(baseUrl).replace(/\/+$/, '')
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
  let cachedChats = { at: 0, chats: [] }

  async function call(action, params = {}) {
    const url = new URL(base + '/' + action)
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`OneBot ${action} HTTP ${res.status}`)
    const body = await res.json()
    if (body?.status === 'failed' || Number(body?.retcode) > 0) {
      throw new Error(`OneBot ${action} 失败：${body?.message || body?.wording || body?.retcode}`)
    }
    return body?.data
  }

  async function listChats(force = false) {
    if (!force && Date.now() - cachedChats.at < LIST_TTL) return cachedChats.chats
    const chats = []
    try {
      for (const g of (await call('get_group_list')) || []) {
        chats.push({ chatKey: `group:${g.group_id}`, chatType: 'group', chatId: String(g.group_id), chatName: g.group_name || '' })
      }
    } catch {
      /* 有的桥没开群列表，跳过 */
    }
    try {
      for (const f of (await call('get_friend_list')) || []) {
        chats.push({
          chatKey: `private:${f.user_id}`,
          chatType: 'private',
          chatId: String(f.user_id),
          chatName: f.remark || f.nickname || String(f.user_id),
        })
      }
    } catch {
      /* 同上 */
    }
    cachedChats = { at: Date.now(), chats }
    return chats
  }

  return {
    kind: 'onebot',
    baseUrl: base,
    /** 拉所有会话最近的一批历史，过滤游标后按时间返回前 limit 条。 */
    async readPage(cursor, limit) {
      const sinceTs = Number(cursor?.ts) || 0
      const sinceHash = cursor?.hash == null ? Number.MIN_SAFE_INTEGER : Number(cursor.hash)
      const chats = await listChats()
      const rows = []
      for (const c of chats.slice(0, MAX_CHATS)) {
        try {
          const action = c.chatType === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history'
          const params =
            c.chatType === 'group'
              ? { group_id: c.chatId, count: HISTORY_COUNT }
              : { user_id: c.chatId, count: HISTORY_COUNT }
          const data = await call(action, params)
          for (const m of data?.messages || []) {
            const ts = Number(m.time) || 0
            const id = Number(m.message_id) || 0
            if (ts < sinceTs) continue
            if (ts === sinceTs && id <= sinceHash) continue
            rows.push({ chat: c, m })
          }
        } catch {
          /* 单个会话失败不影响其他 */
        }
      }
      rows.sort((a, b) => Number(a.m.time) - Number(b.m.time) || Number(a.m.message_id) - Number(b.m.message_id))
      const page = rows.slice(0, limit)

      const records = []
      let lastTs = sinceTs
      let lastHash = sinceHash
      for (const { chat, m } of page) {
        lastTs = Number(m.time) || lastTs
        lastHash = Number(m.message_id) || lastHash
        const sender = m.sender || { user_id: m.user_id, nickname: chat.chatName }
        const rec = normalizeOneBot({
          source: 'onebot',
          sourceKey: `${chat.chatKey}:${m.message_id}`,
          data: {
            ...m,
            post_type: 'message',
            message_type: chat.chatType,
            group_id: chat.chatType === 'group' ? chat.chatId : undefined,
            group_name: chat.chatName,
            sender,
            user_id: sender.user_id,
          },
        })
        if (rec) records.push(rec)
      }
      return { records, scanned: rows.length, lastTs, lastHash }
    },
    maxTs() {
      return 0
    },
    count() {
      return 0
    },
    close() {},
  }
}
