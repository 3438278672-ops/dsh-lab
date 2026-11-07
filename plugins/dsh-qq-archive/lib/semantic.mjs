/**
 * 语义检索后端（可选增强层）。
 *
 * 真正的编码在 scripts/embed.py 里（transformers + bge-small-zh），
 * 这里只负责找 Python、起子进程、把结果换成消息行。没装/没建索引时
 * 返回 null，调用方降级回关键词检索，不报错。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'scripts', 'embed.py')

const PY_CANDIDATES = () => [
  process.env.QQ_ARCHIVE_PYTHON,
  'python',
  'python3',
  'py',
]

let cachedPython

export function findPython() {
  if (cachedPython !== undefined) return cachedPython
  for (const p of PY_CANDIDATES()) {
    if (!p) continue
    try {
      const r = spawnSync(p, ['-c', 'import sys,json;print(json.dumps(list(sys.version_info[:2])))'], {
        timeout: 8000,
        encoding: 'utf8',
        windowsHide: true,
      })
      if (r.status === 0) {
        cachedPython = p
        return p
      }
    } catch {
      /* 试下一个 */
    }
  }
  cachedPython = null
  return null
}

function runPython(args, { timeoutMs = 10 * 60 * 1000, onLine } = {}) {
  const py = findPython()
  if (!py) return Promise.reject(new Error('找不到 Python（装一个，或用 QQ_ARCHIVE_PYTHON 指定可执行文件）'))
  return new Promise((resolve, reject) => {
    const child = spawn(py, [SCRIPT, ...args], { windowsHide: true })
    let out = ''
    let err = ''
    let timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Python 超时（>${Math.round(timeoutMs / 1000)} 秒）`))
    }, timeoutMs)
    child.stdout.on('data', (b) => {
      out += b.toString('utf8')
      if (onLine) for (const line of out.split(/\r?\n/)) if (line.trim()) onLine(line.trim())
    })
    child.stderr.on('data', (b) => {
      err += b.toString('utf8')
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`Python 退出码 ${code}：${(err || out).trim().slice(-400)}`))
        return
      }
      const lines = out.split(/\r?\n/).filter((l) => l.trim())
      let parsed = null
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          parsed = JSON.parse(lines[i])
          break
        } catch {
          /* 继续往上找 */
        }
      }
      if (!parsed) {
        reject(new Error(`Python 没返回 JSON：${(out || err).trim().slice(-300)}`))
        return
      }
      resolve(parsed)
    })
  })
}

export function semanticDir(home) {
  return join(home, 'semantic')
}

export function semanticReady(home) {
  return existsSync(join(semanticDir(home), 'ids.npy')) && existsSync(join(semanticDir(home), 'vectors.npy'))
}

/** 全量重建语义索引；返回 {count, dim}。 */
export async function buildSemantic(archive, { onProgress } = {}) {
  return runPython(['build', '--db', archive.path, '--out', semanticDir(archive.home)], { onLine: onProgress })
}

/** 语义检索：返回 [{id, score}]，按分数倒序。 */
export async function semanticSearch(archive, text, { k = 50, minScore = 0.35 } = {}) {
  if (!text || !semanticReady(archive.home)) return null
  const r = await runPython(['query', '--out', semanticDir(archive.home), '--text', text, '--k', String(k), '--min-score', String(minScore)], { timeoutMs: 120000 })
  if (r.error) throw new Error(r.error)
  return Array.isArray(r.hits) ? r.hits : []
}

/** 按 id 取消息，保持给定顺序。 */
export function messagesByIds(db, ids) {
  if (!ids.length) return []
  const marks = ids.map(() => '?').join(',')
  const rows = db
    .prepare(
      `select id, source_key, ts, chat_key, sender_id, sender_name, kind, text, reply_to
         from messages where id in (${marks})`,
    )
    .all(...ids)
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.map((id) => byId.get(id)).filter(Boolean)
}
