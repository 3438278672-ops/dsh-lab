/**
 * 媒体缓存（增强层）。
 *
 * QQ 的图片/语音 URL 带 rkey，会过期（实测约一周）。所以只能对「同步之后
 * 新到的消息」边到边下；历史消息的 URL 已经 400，下载不下来就标 dead，
 * 不反复重试。下载只是缓存，删掉也不影响索引。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_VOICE_BYTES = 4 * 1024 * 1024

export function mediaDir(home) {
  return join(home, 'media')
}

function guessExt(row, contentType) {
  const name = String(row.file_name || '').toLowerCase()
  const m = /\.([a-z0-9]{2,5})(?:$|\?)/.exec(name)
  if (m) return '.' + m[1]
  const type = String(contentType || '').toLowerCase()
  if (type.includes('png')) return '.png'
  if (type.includes('gif')) return '.gif'
  if (type.includes('webp')) return '.webp'
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg'
  if (type.includes('amr')) return '.amr'
  if (type.includes('silk')) return '.silk'
  return row.kind === 'voice' ? '.amr' : '.jpg'
}

async function downloadOne(db, row, dir) {
  const cap = row.kind === 'voice' ? MAX_VOICE_BYTES : MAX_IMAGE_BYTES
  const res = await fetch(row.url, { signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('空文件')
  if (buf.length > cap) throw new Error(`太大（${buf.length} 字节）`)
  const name = createHash('sha1').update(String(row.source_key)).digest('hex') + guessExt(row, res.headers.get('content-type'))
  const path = join(dir, name)
  writeFileSync(path, buf)
  db.prepare("update media set local_path = ?, status = 'cached' where source_key = ?").run(path, row.source_key)
  return { path, bytes: buf.length }
}

/**
 * 把 status='meta' 的媒体尽量下下来。
 * @param {{db: object, home: string}} archive  openArchive 的返回 + home
 * @returns {Promise<{cached:number, dead:number, skipped:number, bytes:number, failed:object[], reason?:string}>}
 */
export async function downloadPending(archive, { kinds = ['image', 'voice'], limit = 50, maxCount = 2000, onProgress } = {}) {
  const db = archive.db
  const home = archive.home
  if (!home) throw new Error('downloadPending 需要 archive.home')
  const dir = mediaDir(home)
  mkdirSync(dir, { recursive: true })

  const cachedCount = db.prepare("select count(*) as n from media where status = 'cached'").get().n
  if (cachedCount >= maxCount) {
    return { cached: 0, dead: 0, skipped: cachedCount, bytes: 0, failed: [], reason: `已到缓存上限 ${maxCount}，不再下载` }
  }

  const placeholders = kinds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `select source_key, kind, file_name, url, ts from media
        where status = 'meta' and url is not null and url <> '' and kind in (${placeholders})
        order by ts desc limit ?`,
    )
    .all(...kinds, Math.min(limit, maxCount - cachedCount))

  let cached = 0
  let dead = 0
  let bytes = 0
  const failed = []
  for (const row of rows) {
    try {
      const r = await downloadOne(db, row, dir)
      cached++
      bytes += r.bytes
      onProgress?.({ kind: row.kind, cached, total: rows.length })
    } catch (e) {
      dead++
      db.prepare("update media set status = 'dead' where source_key = ?").run(row.source_key)
      failed.push({ sourceKey: row.source_key, kind: row.kind, error: String(e?.message || e) })
    }
  }
  return { cached, dead, skipped: 0, bytes, failed }
}
