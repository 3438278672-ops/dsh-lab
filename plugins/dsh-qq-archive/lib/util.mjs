/**
 * 小工具：时间解析、JSON、文件。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const DAY = 86400
export const HOUR = 3600

export function stamp(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function isoDate(sec) {
  if (!Number.isFinite(sec)) return ''
  const d = new Date(sec * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 把 '7d' / '2h' / '2026-10' / '2026-10-01' / ISO / 秒 解析成 unix 秒。返回 null 表示没给。 */
export function parseWhen(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  const s = String(raw).trim()
  if (!s) return null
  const rel = /^(\d+)\s*(m|h|d|w|mo|y)$/i.exec(s)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2].toLowerCase()
    const mult = unit === 'm' ? 60 : unit === 'h' ? HOUR : unit === 'd' ? DAY : unit === 'w' ? 7 * DAY : unit === 'mo' ? 30 * DAY : 365 * DAY
    return Math.floor(Date.now() / 1000) - n * mult
  }
  if (/^\d{9,11}$/.test(s)) return Number(s)
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (m) return Math.floor(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0).getTime() / 1000)
  m = /^(\d{4})-(\d{1,2})$/.exec(s)
  if (m) return Math.floor(new Date(Number(m[1]), Number(m[2]) - 1, 1, 0, 0, 0).getTime() / 1000)
  m = /^(\d{4})$/.exec(s)
  if (m) return Math.floor(new Date(Number(m[1]), 0, 1, 0, 0, 0).getTime() / 1000)
  const t = Date.parse(s)
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}

/** 解析结束时间：'2026-10' 应该覆盖整月，所以给的是「下个月初一」前一刻。 */
export function parseWhenEnd(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  const s = String(raw).trim()
  const m = /^(\d{4})-(\d{1,2})$/.exec(s)
  if (m) return Math.floor(new Date(Number(m[1]), Number(m[2]), 1, 0, 0, 0).getTime() / 1000) - 1
  const m2 = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (m2) return Math.floor(new Date(Number(m2[1]), Number(m2[2]) - 1, Number(m2[3]) + 1, 0, 0, 0).getTime() / 1000) - 1
  return parseWhen(s)
}

export function stripBom(value) {
  return typeof value === 'string' && value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

export async function readJson(path) {
  try {
    return JSON.parse(stripBom(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
}

export function defaultHome() {
  return join(homedir(), '.dsh', 'qq-archive')
}

export function truncate(text, max = 120) {
  const s = String(text ?? '')
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

export function clampInt(v, min, max, fallback) {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
