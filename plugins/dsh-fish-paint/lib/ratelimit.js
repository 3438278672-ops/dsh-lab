// dsh-fish-paint · 画画限流
//
// 「一个人 N 分钟只能请求画一次，vip 名单除外」——和唱歌插件那套一样的规矩。
// 状态落在 data/state/draw-cooldown.json：
//   { version: 1, entries: { "<QQ号>": { hits: [毫秒时间戳…], lastAt, lastSession } } }
//
// 设计要点：
// - 以 QQ 号为准（跨群、跨私聊都算一个人），所以 QQ 会话里 agent 必须把点图人的 QQ 号
//   通过 draw_image 的 requester 参数带进来；没有 requester 就不限流（本地/主会话直接用）。
// - vip 名单里的号完全不记账，不限次数。
// - 先占位再生成（reserve → 生成 → 失败 release），避免同一瞬间两条请求都穿过去。
// - 状态文件读写失败一律放行（不影响画画本身），只在 stderr 留一行警告。
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_COOLDOWN_MINUTES = 60
export const DEFAULT_COOLDOWN_MAX = 1
export const DEFAULT_VIP_LIST = ['2220222310']

const STATE_VERSION = 1

/** 把「2220222310」「private:2220222310」「 QQ 2220222310 」都归一成纯数字；不合法返回 ''。 */
export function normalizeRequester(value) {
  if (value === undefined || value === null) return ''
  const text = String(value).trim()
  if (!text) return ''
  const digits = text.replace(/\D+/g, '')
  if (digits.length < 5 || digits.length > 12) return ''
  return digits
}

/** 接受数组或 `1,2 3` 这类字符串；去重、保序、丢掉不合法的。 */
export function parseVipList(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,，、;；]+/)
      : []
  const out = []
  for (const item of list) {
    const qq = normalizeRequester(item)
    if (qq && !out.includes(qq)) out.push(qq)
  }
  return out
}

export function isVip(requester, vipList) {
  const qq = normalizeRequester(requester)
  if (!qq) return false
  const list = Array.isArray(vipList) ? vipList : []
  return list.some((item) => normalizeRequester(item) === qq)
}

function emptyState() {
  return { version: STATE_VERSION, entries: {} }
}

export function readDrawState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      return { version: STATE_VERSION, entries: parsed.entries }
    }
  } catch {
    // 文件不存在 / 坏了都当空状态：限流宁可放行，不要因为一个坏 JSON 把画画卡死。
  }
  return emptyState()
}

function writeDrawState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = `${JSON.stringify(state, null, 2)}\n`
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text)
  try {
    fs.renameSync(tmp, file) // Windows 上 rename 会覆盖旧文件，相当于原子替换
  } catch {
    fs.writeFileSync(file, text)
    try {
      fs.unlinkSync(tmp)
    } catch {
      // 忽略
    }
  }
}

function hitsOf(entry, now, windowMs) {
  const hits = Array.isArray(entry?.hits) ? entry.hits : []
  return hits
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value <= now && now - value < windowMs)
}

/**
 * 占一个画画名额。
 * @returns {{ok:true, requester:string, reservedAt:number, resetAt:number, remaining:number}
 *   | {ok:false, requester:string, retryAfterSec:number, resetAt:number, limit:number, windowMinutes:number}
 *   | {ok:true, skipped:true, requester:''}}
 */
export function reserveDraw({ file, requester, windowMs, max = 1, now = Date.now(), session = '' }) {
  const qq = normalizeRequester(requester)
  if (!qq) return { ok: true, skipped: true, requester: '' }
  if (!(Number(windowMs) > 0)) return { ok: true, skipped: true, requester: qq }

  const limit = Math.max(1, Math.trunc(Number(max) || 1))
  const state = readDrawState(file)
  const hits = hitsOf(state.entries[qq], now, windowMs)

  if (hits.length >= limit) {
    const oldest = Math.min(...hits)
    const resetAt = oldest + windowMs
    const retryAfterSec = Math.max(1, Math.ceil((resetAt - now) / 1000))
    state.entries[qq] = { ...state.entries[qq], hits }
    writeDrawState(file, state)
    return {
      ok: false,
      requester: qq,
      retryAfterSec,
      resetAt,
      limit,
      windowMinutes: Math.round(windowMs / 60000),
    }
  }

  hits.push(now)
  state.entries[qq] = {
    hits,
    lastAt: now,
    ...(session ? { lastSession: String(session) } : {}),
  }
  writeDrawState(file, state)
  return {
    ok: true,
    requester: qq,
    reservedAt: now,
    resetAt: now + windowMs,
    remaining: Math.max(0, limit - hits.length),
  }
}

/** 生成失败时把这个名额退掉（只退指定那次的时间戳，别误删别人的）。 */
export function releaseDraw({ file, requester, at, windowMs = 0, now = Date.now() }) {
  const qq = normalizeRequester(requester)
  if (!qq) return false
  const state = readDrawState(file)
  const entry = state.entries[qq]
  if (!entry) return false
  const reservedAt = Number(at)
  const hits = Array.isArray(entry.hits) ? entry.hits.filter((value) => Number(value) !== reservedAt) : []
  const kept = windowMs > 0 ? hits.filter((value) => Number.isFinite(Number(value)) && now - Number(value) < windowMs) : hits
  if (kept.length > 0) state.entries[qq] = { ...entry, hits: kept }
  else delete state.entries[qq]
  writeDrawState(file, state)
  return true
}

/** 只读查询：某人还要等多少秒（0 = 可以画）。draw_status 用。 */
export function cooldownStatus({ file, requester, windowMs, max = 1, now = Date.now() }) {
  const qq = normalizeRequester(requester)
  if (!qq || !(Number(windowMs) > 0)) return { requester: qq, remaining: 0, retryAfterSec: 0 }
  const limit = Math.max(1, Math.trunc(Number(max) || 1))
  const state = readDrawState(file)
  const hits = hitsOf(state.entries[qq], now, windowMs)
  if (hits.length < limit) return { requester: qq, remaining: limit - hits.length, retryAfterSec: 0 }
  const resetAt = Math.min(...hits) + windowMs
  return {
    requester: qq,
    remaining: 0,
    retryAfterSec: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    resetAt,
  }
}
