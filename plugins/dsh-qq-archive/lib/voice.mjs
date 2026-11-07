/**
 * 语音转写（可选增强层）。
 *
 * 历史语音 URL 绝大多数已过期（rkey 一周内就 400），所以这里只处理
 * 「同步之后边到边下载到本地」的那批 voice 文件（media.status = 'cached'）。
 * 转写文本回写到 messages.text 并刷新两张搜索表，让语音也能被 qq_find 搜到。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { charTokens, tokenize } from './segment.mjs'
import { findPython } from './semantic.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'scripts', 'transcribe.py')

export function pendingVoiceCount(db) {
  const row = db
    .prepare(
      `select count(*) c from media
        where kind = 'voice' and status = 'cached'
          and local_path is not null and transcript is null`,
    )
    .get()
  return row?.c || 0
}

/**
 * @param {object} archive openArchive() + home
 * @param {{limit?:number, onProgress?:Function, timeoutMs?:number}} options
 * @returns {Promise<{done:number, failed:number, skipped:number, python:string|null}>}
 */
export async function transcribePending(archive, { limit = 20, onProgress, timeoutMs = 10 * 60 * 1000 } = {}) {
  const db = archive.db
  const python = findPython()
  if (!python) throw new Error('没找到 Python。装了 Python 3 并确保 python 在 PATH 里，或设 QQ_ARCHIVE_PYTHON。')

  const rows = db
    .prepare(
      `select id, message_key, local_path from media
        where kind = 'voice' and status = 'cached'
          and local_path is not null and transcript is null
        order by id limit ?`,
    )
    .all(limit)
  if (!rows.length) return { done: 0, failed: 0, skipped: 0, python }

  const byPath = new Map(rows.map((r) => [r.local_path, r]))
  const listDir = mkdtempSync(join(tmpdir(), 'qq-voice-'))
  const listFile = join(listDir, 'list.txt')
  writeFileSync(listFile, rows.map((r) => r.local_path).join('\n') + '\n', 'utf8')
  const getMsg = db.prepare('select id, chat_key from messages where source_key = ? limit 1')
  const updMedia = db.prepare('update media set transcript = ? where id = ?')
  const updText = db.prepare('update messages set text = ? where id = ?')
  const getText = db.prepare('select text from messages where id = ?')
  const getChat = db.prepare('select name from chats where chat_key = ?')
  const delFts = db.prepare('delete from messages_fts where rowid = ?')
  const insFts = db.prepare('insert into messages_fts(rowid, body) values(?, ?)')
  const delChars = db.prepare('delete from messages_chars where rowid = ?')
  const insChars = db.prepare('insert into messages_chars(rowid, chars) values(?, ?)')

  const child = spawn(python, [SCRIPT, '--model', 'small', '--device', 'cpu', '--compute', 'int8', '--list', listFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const timer = setTimeout(() => child.kill(), timeoutMs)
  let stderr = ''
  child.stderr.on('data', (b) => {
    stderr += b.toString()
    if (stderr.length > 4000) stderr = stderr.slice(-4000)
  })

  let done = 0
  let failed = 0
  let skipped = 0
  const rl = createInterface({ input: child.stdout })
  for await (const line of rl) {
    let item
    try {
      item = JSON.parse(line)
    } catch {
      continue
    }
    const row = byPath.get(item.file)
    if (!row) continue
    if (item.error) {
      failed++
      db.prepare("update media set status = 'dead', extra = ? where id = ?").run(
        JSON.stringify({ transcribeError: String(item.error).slice(0, 300) }),
        row.id,
      )
      onProgress?.({ done, failed, skipped, total: rows.length })
      continue
    }
    const text = String(item.text || '').trim()
    if (!text) {
      skipped++
      db.prepare("update media set transcript = '' where id = ?").run(row.id)
      onProgress?.({ done, failed, skipped, total: rows.length })
      continue
    }
    updMedia.run(text, row.id)

    // 把转写塞回正文，顺手刷新 FTS / 字符表
    const msg = getMsg.get(row.message_key)
    if (msg) {
      const oldText = getText.get(msg.id)?.text || ''
      const merged = oldText.includes(text) ? oldText : `${oldText} ${text}`.trim()
      updText.run(merged, msg.id)
      if (archive.fts) {
        delFts.run(msg.id)
        const chatName = getChat.get(msg.chat_key)?.name || ''
        insFts.run(msg.id, [tokenize(merged), tokenize(chatName)].filter(Boolean).join(' '))
      }
      if (archive.chars) {
        delChars.run(msg.id)
        insChars.run(msg.id, charTokens(merged))
      }
    }
    done++
    onProgress?.({ done, failed, skipped, total: rows.length })
  }

  await new Promise((resolve) => child.on('close', resolve))
  clearTimeout(timer)
  try {
    if (stderr && !done && !failed) {
      throw new Error(`语音转写进程异常：${stderr.trim().split('\n').slice(-3).join(' | ')}`)
    }
    return { done, failed, skipped, python, stderr: stderr.trim() || undefined }
  } finally {
    try {
      rmSync(listDir, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉就算了 */
    }
  }
}
