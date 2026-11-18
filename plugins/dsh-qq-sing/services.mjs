// dsh-qq-sing · 本机服务约定（令牌 / 状态文件）
//
// 和 dsh-gpu-queue / dsh-fish-paint 共用一套约定：本机 HTTP 服务把令牌和状态放在
// ~/.dsh/dsh-services/（DSH_SERVICES_DIR 可覆盖）：
//   <name>.token        48 位 hex；写端点的 X-Control-Token
//   <name>.status.json  { service, port, pid, startedAt, updatedAt, tokenFile, error }
// 悬浮球只认这个目录，不需要知道每个插件的内部路径。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'

export function expandHome(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (text === '~') return os.homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2))
  return text
}

export function resolveServicesDir(value) {
  const raw =
    typeof value === 'string' && value.trim()
      ? value
      : process.env.DSH_SERVICES_DIR || path.join(os.homedir(), '.dsh', 'dsh-services')
  return path.normalize(expandHome(raw))
}

export function tokenPath(dir, name) {
  return path.join(dir, `${name}.token`)
}

export function statusPath(dir, name) {
  return path.join(dir, `${name}.status.json`)
}

/** 读令牌；不存在返回 ''。 */
export function readToken(dir, name) {
  try {
    return fs.readFileSync(tokenPath(dir, name), 'utf8').trim()
  } catch {
    return ''
  }
}

/** 拿到令牌；没有就生成一个（多进程同时启动时用 'wx' 抢，抢输的读别人的）。 */
export function ensureToken(dir, name) {
  const existing = readToken(dir, name)
  if (existing) return existing
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    // 目录建不出来就让下面的写文件报错，调用方决定怎么处理
  }
  const token = randomBytes(24).toString('hex')
  try {
    fs.writeFileSync(tokenPath(dir, name), `${token}\n`, { encoding: 'utf8', flag: 'wx' })
    return token
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const again = readToken(dir, name)
      if (again) return again
    }
    throw error
  }
}

export function tokensMatch(expected, actual) {
  const a = Buffer.from(String(expected ?? ''), 'utf8')
  const b = Buffer.from(String(actual ?? ''), 'utf8')
  if (a.length === 0 || a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function writeStatus(dir, name, value) {
  const file = statusPath(dir, name)
  const tmp = `${file}.tmp-${process.pid}`
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // 忽略
    }
    return false
  }
}

export function readStatus(dir, name) {
  try {
    return JSON.parse(fs.readFileSync(statusPath(dir, name), 'utf8'))
  } catch {
    return null
  }
}
