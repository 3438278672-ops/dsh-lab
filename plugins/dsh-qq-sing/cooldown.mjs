/**
 * 点歌冷却：每个点歌人（QQ 号）默认 1 小时只能点一首。
 *
 * 存 <home>/cooldown.json = { "<uid>": { at: <ms>, song, target } }
 * - 记在「起唱成功」那一刻；歌没唱成（worker 失败）会清掉，不算点过。
 * - 只做乐观锁，读改写都在单进程里，冲突概率可忽略。
 */
import { readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const COOLDOWN_DEFAULT_MS = 60 * 60 * 1000
const KEEP_MS = 48 * 60 * 60 * 1000

export function parseRequester(raw) {
  const text = String(raw ?? '').trim()
  return /^\d{5,12}$/.test(text) ? text : null
}

function cooldownPath(home) {
  return join(home, 'cooldown.json')
}

export async function readCooldowns(home) {
  try {
    const raw = await readFile(cooldownPath(home), 'utf8')
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeCooldowns(home, map) {
  const file = cooldownPath(home)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(map, null, 2), 'utf8')
    await rename(tmp, file)
  } catch {
    await writeFile(file, JSON.stringify(map, null, 2), 'utf8').catch(() => {})
    await unlink(tmp).catch(() => {})
  }
}

/** 返回毫秒数，0 表示没在冷却。 */
export function remainingMs(map, uid, now, cooldownMs = COOLDOWN_DEFAULT_MS) {
  const entry = map?.[uid]
  const at = Number(entry?.at ?? entry ?? 0)
  if (!Number.isFinite(at) || at <= 0) return 0
  const left = at + cooldownMs - now
  return left > 0 ? left : 0
}

export async function checkCooldown(home, uid, now = Date.now(), cooldownMs = COOLDOWN_DEFAULT_MS) {
  const map = await readCooldowns(home)
  const left = remainingMs(map, uid, now, cooldownMs)
  return { blocked: left > 0, left, last: map?.[uid] ?? null }
}

export async function markCooldown(home, uid, song, target, now = Date.now()) {
  const map = await readCooldowns(home)
  for (const [key, entry] of Object.entries(map)) {
    const at = Number(entry?.at ?? entry ?? 0)
    if (!Number.isFinite(at) || now - at > KEEP_MS) delete map[key]
  }
  map[uid] = { at: now, song: String(song ?? ''), target: String(target ?? '') }
  await writeCooldowns(home, map)
  return map[uid]
}

export async function clearCooldown(home, uid) {
  const map = await readCooldowns(home)
  if (!(uid in map)) return false
  delete map[uid]
  await writeCooldowns(home, map)
  return true
}

/** 给播报用：还剩多少分钟（向上取整，最少 1 分钟）。 */
export function formatLeft(leftMs) {
  const minutes = Math.max(1, Math.ceil(leftMs / 60000))
  return minutes >= 60 ? '1 小时' : `${minutes} 分钟`
}

/**
 * 点歌白名单：<home>/allowlist.txt，一行一个 QQ 号，支持 `#` 注释、逗号/空格分隔。
 * 白名单里的人不计时（不查 CD、不记账），但照样受“同一时间只唱一首”的全局锁限制。
 */
export async function readAllowlist(home) {
  const ids = new Set()
  try {
    const raw = await readFile(join(home, 'allowlist.txt'), 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const text = line.replace(/#.*$/, '').trim()
      if (!text) continue
      for (const token of text.split(/[\s,，;；]+/)) {
        const id = parseRequester(token)
        if (id) ids.add(id)
      }
    }
  } catch {
    /* 没有白名单文件＝空名单 */
  }
  return ids
}
