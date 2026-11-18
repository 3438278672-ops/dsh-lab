import { homedir } from 'node:os'
import { join } from 'node:path'

/** 本机三个服务共用一套令牌目录（dsh-gpu-queue / fish-paint / qq-sing 都往这写）。 */
export function expandHome(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

export function resolveServicesDir(value) {
  return expandHome(value) || expandHome(process.env.DSH_SERVICES_DIR) || join(homedir(), '.dsh', 'dsh-services')
}

export function tokenPath(dir, name) {
  return join(dir, `${name}.token`)
}

export async function readToken(dir, name) {
  try {
    const { readFile } = await import('node:fs/promises')
    return String(await readFile(tokenPath(dir, name), 'utf8')).trim()
  } catch {
    return ''
  }
}
