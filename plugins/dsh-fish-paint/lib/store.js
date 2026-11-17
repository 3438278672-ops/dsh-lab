// dsh-fish-paint · 出图落盘与元数据
//
// 输出契约（CONTRACT.md §4）：
//   PNG 在 data/out/YYYY-MM-DD/<YYYYmmdd-HHMMSS>-<seed>.png（文件名由 worker 决定）
//   同名 .json 元数据：prompt/negative/preset/width/height/steps/cfg/seed/model/engine/rating/target/note/createdAt
//   rating sidecar：必须是 <PNG 绝对路径>.meta.json（qq-bridge 的 r18-guard 只认这个路径）
//   追加 data/state/index.jsonl，每行一条记录
import fs from 'node:fs'
import path from 'node:path'

export const INDEX_FILE = 'index.jsonl'
export const RATING_SOURCE = 'dsh-fish-paint'

// index.jsonl 只追加大文件也无所谓，但读的时候只取尾部，避免越用越慢。
const INDEX_TAIL_BYTES = 1536 * 1024

/** 建 data/、data/out/、data/state/ 并返回路径。 */
export function ensureDirs(dataDir) {
  const root = path.resolve(dataDir)
  const dirs = {
    data: root,
    out: path.join(root, 'out'),
    state: path.join(root, 'state'),
  }
  fs.mkdirSync(dirs.out, { recursive: true })
  fs.mkdirSync(dirs.state, { recursive: true })
  return dirs
}

/** 本地时区的 YYYY-MM-DD。 */
export function dateKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 今天的出图目录 data/out/YYYY-MM-DD（不存在就建）。 */
export function todayDir(dataDir, date = new Date()) {
  const dir = path.join(path.resolve(dataDir), 'out', dateKey(date))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 记一张生成的图：写同名 .json、rating sidecar、追加 index.jsonl。
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {{path:string,seed?:number,width?:number,height?:number}} options.image worker done 行里的图片对象
 * @param {object} [options.meta] prompt/negative/preset/steps/cfg/model/engine/rating/target/note/elapsedSec
 * @returns {object} 写进 .json 的那份记录（含最终 path/width/height/rating）
 */
export function recordImage({ dataDir, image, meta = {} } = {}) {
  if (!image || typeof image.path !== 'string' || !image.path) {
    throw new Error('recordImage 需要 image.path（worker 返回的 PNG 绝对路径）')
  }
  const dirs = ensureDirs(dataDir)
  const pngPath = path.resolve(image.path)
  fs.mkdirSync(path.dirname(pngPath), { recursive: true })

  // worker 可能没回尺寸（比如异常路径）；PNG 头里能读出来，读不出就留 null，不瞎编。
  const pngInfo = readPngInfo(pngPath)
  const width = Number(image.width) || pngInfo?.width || null
  const height = Number(image.height) || pngInfo?.height || null

  const parsed = path.parse(pngPath)
  const metaBase = path.join(parsed.dir, parsed.name)
  const createdAt = new Date().toISOString()
  // 插件层用 sfw/nsfw 表达口径，落盘统一成 all/r18（sidecar 契约）；两种写法都认。
  const rating = meta.rating === 'r18' || meta.rating === 'nsfw' ? 'r18' : 'all'
  const seed = Number.isFinite(Number(image.seed))
    ? Number(image.seed)
    : Number.isFinite(Number(meta.seed))
      ? Number(meta.seed)
      : -1

  const record = {
    path: pngPath,
    prompt: typeof meta.prompt === 'string' ? meta.prompt : '',
    negative: typeof meta.negative === 'string' ? meta.negative : '',
    preset: typeof meta.preset === 'string' && meta.preset ? meta.preset : 'anime',
    width,
    height,
    steps: Number.isFinite(Number(meta.steps)) ? Number(meta.steps) : null,
    cfg: Number.isFinite(Number(meta.cfg)) ? Number(meta.cfg) : null,
    seed,
    model: typeof meta.model === 'string' ? meta.model : '',
    engine:
      meta.engine && typeof meta.engine === 'object'
        ? { vramMode: meta.engine.vramMode ?? null, loadSec: Number(meta.engine.loadSec) || 0 }
        : { vramMode: null, loadSec: 0 },
    rating,
    target: typeof meta.target === 'string' && meta.target ? meta.target : null,
    note: typeof meta.note === 'string' ? meta.note : '',
    createdAt,
  }
  if (Number.isFinite(Number(meta.elapsedSec))) record.elapsedSec = Number(meta.elapsedSec)

  writeJsonAtomic(`${metaBase}.json`, record)
  // sidecar 路径必须是 <png 绝对路径>.meta.json —— bridge 的 r18-guard 按这个约定判定尺度。
  writeJsonAtomic(`${pngPath}.meta.json`, {
    rating,
    source: RATING_SOURCE,
    createdAt,
  })
  appendJsonl(path.join(dirs.state, INDEX_FILE), record)
  return record
}

/**
 * 列出最近的生成记录（新 → 旧）。
 *
 * @param {string} dataDir
 * @param {{limit?:number,date?:string,target?:string}} [options]
 *   limit 1–50 默认 5；date 形如 2026-11-17；target 形如 group:1104418054
 * @returns {object[]}
 */
export function listRecent(dataDir, options = {}) {
  const limit = Math.min(50, Math.max(1, Math.trunc(Number(options.limit)) || 5))
  const date = typeof options.date === 'string' ? options.date.trim() : ''
  const target = typeof options.target === 'string' ? options.target.trim() : ''

  let records = readIndexRecords(dataDir)
  // index.jsonl 丢了（手动删/第一次用）就退回去扫元数据文件，功能不能因为索引没了就废。
  if (records.length === 0) records = scanOutRecords(dataDir)

  const filtered = records.filter((record) => {
    if (!record || typeof record !== 'object' || typeof record.path !== 'string') return false
    if (date && recordDateKey(record) !== date) return false
    if (target && record.target !== target) return false
    return true
  })
  return filtered.slice(-limit).reverse()
}

/** index.jsonl 的绝对路径（draw_status / 排障用）。 */
export function indexPath(dataDir) {
  return path.join(path.resolve(dataDir), 'state', INDEX_FILE)
}

// ── 内部工具 ────────────────────────────────────────────────────────────

function recordDateKey(record) {
  if (record.createdAt) {
    const time = Date.parse(record.createdAt)
    if (Number.isFinite(time)) return dateKey(new Date(time))
  }
  const fromPath = /[\\/](\d{4}-\d{2}-\d{2})[\\/]/.exec(String(record.path || ''))
  return fromPath ? fromPath[1] : ''
}

function readIndexRecords(dataDir) {
  const file = indexPath(dataDir)
  let text
  let truncatedHead = false
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size === 0) return []
    const start = stat.size > INDEX_TAIL_BYTES ? stat.size - INDEX_TAIL_BYTES : 0
    truncatedHead = start > 0
    const length = stat.size - start
    const buffer = Buffer.alloc(length)
    const fd = fs.openSync(file, 'r')
    try {
      fs.readSync(fd, buffer, 0, length, start)
    } finally {
      fs.closeSync(fd)
    }
    text = buffer.toString('utf8')
  } catch {
    return []
  }
  const lines = text.split('\n')
  if (truncatedHead) lines.shift() // 从文件中间截断，第一行可能只有半条
  const records = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const record = JSON.parse(trimmed)
      if (record && typeof record === 'object') records.push(record)
    } catch {
      /* 一行坏掉不能让整个列表失效 */
    }
  }
  return records
}

/** 没索引时扫 out/ 下的同名 .json 元数据。 */
function scanOutRecords(dataDir) {
  const outDir = path.join(path.resolve(dataDir), 'out')
  let dayDirs
  try {
    dayDirs = fs
      .readdirSync(outDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, 30)
  } catch {
    return []
  }
  const found = []
  for (const day of dayDirs) {
    const dir = path.join(outDir, day)
    let files
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!/\.json$/i.test(file) || /\.meta\.json$/i.test(file)) continue
      const metaPath = path.join(dir, file)
      try {
        const record = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
        if (!record || typeof record !== 'object') continue
        if (typeof record.path !== 'string' || !record.path) {
          record.path = path.join(dir, file.replace(/\.json$/i, '.png'))
        }
        found.push({ record, mtime: fs.statSync(metaPath).mtimeMs })
      } catch {
        /* 坏文件跳过 */
      }
    }
  }
  found.sort((a, b) => a.mtime - b.mtime)
  return found.slice(-200).map((item) => item.record)
}

/** 读 PNG 的 IHDR 拿宽高（签名不对/读不到返回 null）。 */
export function readPngInfo(file) {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const header = Buffer.alloc(24)
      const read = fs.readSync(fd, header, 0, 24, 0)
      if (read < 24) return null
      if (header.readUInt32BE(0) !== 0x89504e47) return null
      if (header.toString('ascii', 12, 16) !== 'IHDR') return null
      return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

function appendJsonl(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
}
