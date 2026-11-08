/**
 * 增量同步：从 adapter 读 → 写 archive.db。
 *
 * 游标是 (last_ts, last_hash)；启动/手动同步回溯 300 秒，防止写入顺序和
 * timestamp 不一致时漏消息。source_key 幂等去重，所以回溯不会写重。
 */
import { getMeta, insertBatch, setMeta, transact } from './db.mjs'

const LOOKBACK = 300
const MIN_HASH = Number.MIN_SAFE_INTEGER

function readCursor(db) {
  return {
    ts: Number(getMeta(db, 'last_ts', '0')) || 0,
    hash: getMeta(db, 'last_hash', '') === '' ? MIN_HASH : Number(getMeta(db, 'last_hash', '0')) || 0,
  }
}

function writeCursor(db, ts, hash) {
  setMeta(db, 'last_ts', String(ts))
  setMeta(db, 'last_hash', String(hash))
}

/**
 * @param {object} p
 * @param {{db: any, fts: any, chars: any}} p.archive
 * @param {any} p.adapter       有 readPage(cursor, limit) 的适配器
 * @param {object} p.cfg        合并后的配置
 * @param {(s: object) => void=} p.onProgress
 */
export async function syncFromAdapter({ archive, adapter, cfg, onProgress, full = false }) {
  const { db } = archive
  const saved = readCursor(db)
  let cursor = {
    ts: full ? 0 : Math.max(0, saved.ts - LOOKBACK),
    hash: full ? MIN_HASH : saved.hash,
  }
  let scanned = 0
  let inserted = 0
  let mediaAdded = 0
  const startedAt = Date.now()

  for (let guard = 0; guard < 100000; guard++) {
    const page = await adapter.readPage(cursor, cfg.batchSize)
    const records = page.records || []
    const rawCount = Number(page.scanned) || 0
    if (!rawCount && !records.length) break

    let wrote = { inserted: 0, media: 0 }
    if (records.length) {
      wrote = transact(db, () => insertBatch(db, archive, records))
    }
    scanned += rawCount
    inserted += wrote.inserted || 0
    mediaAdded += wrote.media || 0

    // 游标只在时间戳真正前进时推进；整批都是同一秒的旧消息时 +1 秒跳过，防止卡死
    if (Number(page.lastTs) > cursor.ts) {
      cursor = { ts: Number(page.lastTs), hash: Number(page.lastHash) }
    } else if (rawCount >= cfg.batchSize && !wrote.inserted) {
      cursor = { ts: cursor.ts + 1, hash: MIN_HASH }
    }
    writeCursor(db, cursor.ts, cursor.hash)

    if (onProgress && (scanned % (cfg.batchSize * 10) === 0 || rawCount < cfg.batchSize)) {
      onProgress({ scanned, inserted, lastTs: cursor.ts, tookMs: Date.now() - startedAt })
    }
    if (rawCount < cfg.batchSize) break
  }

  setMeta(db, 'last_sync_at', String(Math.floor(Date.now() / 1000)))
  setMeta(db, 'last_sync_took_ms', String(Date.now() - startedAt))
  return { scanned, inserted, mediaAdded, lastTs: cursor.ts, tookMs: Date.now() - startedAt }
}

/** 全局串行：同一时间只跑一个同步，调用方共享同一个 Promise。
 *  卡死的同步（读写锁、外部库被占用）五分钟后自动放弃，不然之后每一轮定时同步都会直接复用那个永不结算的 Promise，索引就永远停在那一天。 */
let inflight = null
const SYNC_TIMEOUT_MS = 5 * 60 * 1000

export function syncOnce({ archive, adapter, cfg, onProgress, full = false }) {
  if (inflight) return inflight
  let timer = null
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('这一轮同步超过 5 分钟还没结束，先放弃，下一轮再说')), SYNC_TIMEOUT_MS)
    timer.unref?.()
  })
  inflight = (async () => {
    try {
      return await Promise.race([syncFromAdapter({ archive, adapter, cfg, onProgress, full }), guard])
    } finally {
      if (timer) clearTimeout(timer)
      inflight = null
    }
  })()
  return inflight
}

export function isSyncing() {
  return Boolean(inflight)
}
