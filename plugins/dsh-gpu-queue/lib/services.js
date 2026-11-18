/**
 * dsh-gpu-queue · 本机服务之间的约定（令牌文件 + 状态文件）
 *
 * 三个会互相说话的本机服务（gpu-queue / fish-paint / qq-sing）都在
 * `<服务目录>/<名字>.token` 放一枚控制令牌，写端点必须带 `x-control-token`。
 * 服务目录默认 `~/.dsh/dsh-services/`（可用 config.servicesDir 改）。
 *
 * 为什么不在各插件各自 data/ 下：接入方（悬浮球、别的插件、python 客户端）要知道路径才能
 * 发请求；一个公共目录比「按包名猜路径」稳，也不用把令牌塞进命令行/环境变量。
 */
import { timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function expandHome(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

export function resolveServicesDir(custom) {
  const given = expandHome(custom)
  if (given) return given
  const fromEnv = expandHome(process.env.DSH_SERVICES_DIR)
  if (fromEnv) return fromEnv
  return join(homedir(), '.dsh', 'dsh-services')
}

export function tokenPath(servicesDir, name) {
  return join(servicesDir, `${name}.token`)
}

export function statusPath(servicesDir, name) {
  return join(servicesDir, `${name}.status.json`)
}

/** 读已有令牌；没有（或太短）就生成一枚 48 位 hex 写进去。 */
export async function ensureToken(servicesDir, name) {
  await mkdir(servicesDir, { recursive: true })
  const file = tokenPath(servicesDir, name)
  try {
    const existing = String(await readFile(file, 'utf8')).trim()
    if (existing.length >= 16) return existing
  } catch {
    /* 没文件，下面生成 */
  }
  const token = randomBytes(24).toString('hex')
  await writeFile(file, token, { encoding: 'utf8', mode: 0o600 })
  return token
}

export async function readToken(servicesDir, name) {
  try {
    return String(await readFile(tokenPath(servicesDir, name), 'utf8')).trim()
  } catch {
    return ''
  }
}

export function tokensMatch(expected, given) {
  const a = Buffer.from(String(expected ?? ''), 'utf8')
  const b = Buffer.from(String(given ?? ''), 'utf8')
  if (!a.length || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 服务状态（谁在哪个端口、有没有绑定失败）——悬浮球用它区分「没启用」和「端口被占」。 */
export async function writeStatus(servicesDir, name, patch) {
  await mkdir(servicesDir, { recursive: true }).catch(() => {})
  const file = statusPath(servicesDir, name)
  let previous = {}
  try {
    previous = JSON.parse(String(await readFile(file, 'utf8')))
  } catch {
    previous = {}
  }
  const next = { ...previous, ...patch, updatedAt: Date.now() }
  await writeFile(file, JSON.stringify(next, null, 2), 'utf8').catch(() => {})
  return next
}
