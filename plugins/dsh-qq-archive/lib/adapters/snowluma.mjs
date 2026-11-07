/**
 * SnowLuma 适配器：只读打开它自己的 messages.db。
 *
 * 只认 schema（messages 表的列），不 import 它的任何代码；换一个实现
 * 只要给出同样的列就能用。WAL 库只读打开实测可用（-shm 已存在时）。
 */
import { DatabaseSync } from 'node:sqlite'
import { normalizeOneBot } from '../normalize.mjs'

const REQUIRED_COLUMNS = ['message_hash', 'is_group', 'session_id', 'timestamp', 'data']

export function openSnowluma(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  const cols = new Set(db.prepare('pragma table_info(messages)').all().map((c) => c.name))
  const missing = REQUIRED_COLUMNS.filter((c) => !cols.has(c))
  if (missing.length) {
    db.close()
    throw new Error(`这个 messages.db 不像 SnowLuma 的库，缺列：${missing.join(', ')}`)
  }

  return {
    kind: 'snowluma',
    path,
    /**
     * 按 (timestamp, message_hash) 游标分批读，返回统一记录。
     * cursor = { ts, hash }；hash 允许是负的（SnowLuma 的 message_hash 可为负）。
     */
    readPage(cursor, limit) {
      const sinceTs = Number(cursor?.ts) || 0
      const sinceHash = cursor?.hash == null ? Number.MIN_SAFE_INTEGER : Number(cursor.hash)
      const rows = db
        .prepare(
          `select message_hash, is_group, session_id, event_name, timestamp, data, media_data
             from messages
            where timestamp > ? or (timestamp = ? and message_hash > ?)
            order by timestamp, message_hash
            limit ?`,
        )
        .all(sinceTs, sinceTs, sinceHash, limit)

      const records = []
      let lastTs = sinceTs
      let lastHash = sinceHash
      for (const row of rows) {
        lastTs = Number(row.timestamp) || lastTs
        lastHash = Number(row.message_hash) || lastHash
        let data
        try {
          data = JSON.parse(row.data)
        } catch {
          continue
        }
        const rec = normalizeOneBot({
          source: 'snowluma',
          sourceKey: String(row.message_hash),
          data,
          mediaData: row.media_data,
        })
        if (rec) records.push(rec)
      }
      return { records, scanned: rows.length, lastTs, lastHash }
    },
    maxTs() {
      const row = db.prepare('select max(timestamp) m from messages').get()
      return Number(row?.m) || 0
    },
    count() {
      const row = db.prepare('select count(*) c from messages').get()
      return Number(row?.c) || 0
    },
    close() {
      db.close()
    },
  }
}
