/**
 * 日报主动送达：把生成的日报通过本机 qq-bridge 的「控制台测试发送」接口私聊发给本人。
 *
 * 为什么是 /api/test-send 而不是 /api/send/private：
 * - /api/send/private 属于仿真群友（socialV2）通道，reserved2 模式下要求 body 带会话级
 *   agent token，且受 socialV2.send.maxMessageChars（默认 500 字）限制；
 * - /api/test-send 是控制台/操作者通道，只需 x-console-token，走的是 bot 自己的发送能力，
 *   没有会话 agent token 和 500 字上限，正是「我给自己发一条日报」该用的口子。
 *
 * 只发私聊（往群里发总结是另一种打扰）。开关和目标可以用 meta 覆盖 config，
 * 这样在 QQ 里改完立刻生效，不用重启插件。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { getMeta, setMeta } from './db.mjs'
import { stripBom } from './util.mjs'

/** 本机 qq-bridge 控制台默认端口（config.json 的 consolePort，默认 3100）。 */
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:3100'
/** 单条消息上限：设计按 ~1800 字切；桥接若配了更小的 maxMessageChars，可用 cfg.push.maxChars 调小。 */
export const MAX_PART_CHARS = 1800
/** 一条日报最多拆几条，避免刷屏。 */
export const MAX_PARTS = 3

/** target 统一成 'private:<id>' / 'group:<id>'；纯数字按私聊。认不出来的原样保留（报错时能看见用户填了什么）。 */
export function normalizeTarget(target) {
  const raw = String(target ?? '').trim()
  if (!raw) return ''
  const hit = /^(private|group):(\d+)$/i.exec(raw)
  if (hit) return `${hit[1].toLowerCase()}:${hit[2]}`
  if (/^\d+$/.test(raw)) return `private:${raw}`
  return raw
}

function readTokenFile(tokenFile, cfg) {
  const raw = String(tokenFile || '').trim()
  if (!raw) return ''
  const path = isAbsolute(raw) ? raw : resolve(cfg?.home || process.cwd(), raw)
  let text = ''
  try {
    text = stripBom(readFileSync(path, 'utf8')).trim()
  } catch {
    return ''
  }
  if (!text) return ''
  if (text.startsWith('{')) {
    try {
      const json = JSON.parse(text)
      return String(json.token || json.consoleToken || '').trim()
    } catch {
      return ''
    }
  }
  return text
}

/**
 * 探测本机 qq-bridge 安装目录（只做只读检查，不猜密码）：
 * 依次看 QQ_BRIDGE_HOME、~/DPQQ、D:\DPQQ，也支持下两层的
 * qq-bridge-<版本>\qq-bridge-<版本>\config.json 结构。
 */
function findBridgeHomes() {
  const roots = [process.env.QQ_BRIDGE_HOME, join(homedir(), 'DPQQ'), 'D:\\DPQQ'].filter(Boolean)
  const homes = []
  for (const root of roots) {
    // QQ_BRIDGE_HOME 直接指向桥接目录时，root 本身就是一个 home
    if (existsSync(join(root, 'config.json'))) {
      homes.push(root)
      continue
    }
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const direct = join(root, entry.name)
      if (existsSync(join(direct, 'config.json'))) {
        homes.push(direct)
        continue
      }
      let subs = []
      try {
        subs = readdirSync(direct, { withFileTypes: true })
      } catch {
        continue
      }
      for (const sub of subs) {
        if (!sub.isDirectory()) continue
        const nested = join(direct, sub.name)
        if (existsSync(join(nested, 'config.json'))) homes.push(nested)
      }
    }
  }
  return homes
}

/** 从一个桥接目录读 consolePort / 白名单私聊号 / state/console-token。 */
function readBridgeHome(home) {
  try {
    const cfgFile = JSON.parse(stripBom(readFileSync(join(home, 'config.json'), 'utf8')))
    const port = Number(cfgFile.consolePort) || 3100
    const privates = Array.isArray(cfgFile.allow?.private)
      ? cfgFile.allow.private.map((v) => String(v).replace(/\D/g, '')).filter(Boolean)
      : []
    let token = ''
    const tokenPath = join(home, 'state', 'console-token')
    if (existsSync(tokenPath)) token = stripBom(readFileSync(tokenPath, 'utf8')).trim()
    if (!token && typeof cfgFile.consoleToken === 'string') token = cfgFile.consoleToken.trim()
    return { home, port, privates, token }
  } catch {
    return null
  }
}

/**
 * 读桥接连接信息：cfg.push 显式配置优先；discover=true（默认配置里开着）时再探测本机
 * qq-bridge，从 config.json 取端口与白名单里的第一个私聊号、从 state/console-token 取令牌。
 * 显式关掉 discover 就只认真实配置，测试和「不想自动找一个桥」的场景都用得上。
 */
export function readBridgeConfig(cfg) {
  const push = cfg?.push && typeof cfg.push === 'object' ? cfg.push : {}
  let baseUrl = String(push.baseUrl || '').trim().replace(/\/+$/, '')
  let token = String(push.token || '').trim()
  if (!token) token = readTokenFile(push.tokenFile, cfg)
  let target = normalizeTarget(push.target)

  if (push.discover === true && (!token || !target || !baseUrl)) {
    for (const home of findBridgeHomes()) {
      const info = readBridgeHome(home)
      if (!info) continue
      if (!baseUrl) baseUrl = `http://127.0.0.1:${info.port}`
      if (!token && info.token) token = info.token
      if (!target && info.privates.length) target = `private:${info.privates[0]}`
      if (token && target && baseUrl) break
    }
  }

  return { baseUrl: baseUrl || DEFAULT_BRIDGE_URL, token, target }
}

/**
 * 发一条私聊消息（POST {baseUrl}/api/test-send，控制台操作者通道）。
 * 网络错误不抛，返回 {ok:false,error}；桥接返回 4xx/5xx 时把状态码和 JSON 带回来。
 * @returns {Promise<{ok:boolean, status?:number, data?:any, error?:string}>}
 */
export async function sendPrivate({ baseUrl, token, userId, message, fetchImpl = fetch } = {}) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) return { ok: false, error: '没有配置 qq-bridge 地址（push.baseUrl）' }
  const uid = String(userId ?? '').replace(/^private:/i, '').trim()
  if (!/^\d+$/.test(uid)) return { ok: false, error: `私聊目标 userId 不是数字：${userId ?? ''}` }
  if (!token) return { ok: false, error: '没有找到 qq-bridge 控制台令牌（push.token / push.tokenFile / state/console-token）' }
  try {
    const res = await fetchImpl(`${base}/api/test-send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': String(token) },
      body: JSON.stringify({ kind: 'private', id: Number(uid), message: String(message ?? '') }),
    })
    let data = null
    try {
      data = await res.json()
    } catch {
      data = null
    }
    if (!res.ok || (data && data.ok === false)) {
      return { ok: false, status: res.status, data, error: String(data?.error || `HTTP ${res.status}`) }
    }
    return { ok: true, status: res.status, data }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/** 'private:2220222310' → '2220222310'；不是私聊返回 ''。 */
function privateUserId(target) {
  const hit = /^private:(\d+)$/.exec(String(target || ''))
  return hit ? hit[1] : ''
}

function partLimit(cfg) {
  const n = Number(cfg?.push?.maxChars)
  if (!Number.isFinite(n) || n <= 0) return MAX_PART_CHARS
  return Math.max(100, Math.min(MAX_PART_CHARS, Math.trunc(n)))
}

/**
 * 把全文切成不超过 limit 的若干条：优先在段落边界断开，段落太碎装不下再按字数均匀硬切。
 * 最多 maxParts 条；总长超过 maxParts*limit 时最后一条加省略号，不悄悄丢尾巴。
 */
export function splitPushText(text, limit = MAX_PART_CHARS, maxParts = MAX_PARTS) {
  const full = String(text ?? '').trim()
  if (!full) return []
  if (full.length <= limit) return [full]

  // 1) 先拆成「段落」；单段超过 limit 的硬切成不超过 limit 的段
  const segments = []
  for (const block of full
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (block.length <= limit) {
      segments.push(block)
      continue
    }
    for (let i = 0; i < block.length; i += limit) segments.push(block.slice(i, i + limit))
  }

  // 2) 贪心打包：尽量少条数，也就是尽量在段落边界断开
  const groups = []
  let current = ''
  for (const seg of segments) {
    const candidate = current ? `${current}\n\n${seg}` : seg
    if (candidate.length <= limit) {
      current = candidate
    } else {
      if (current) groups.push(current)
      current = seg
    }
  }
  if (current) groups.push(current)
  if (groups.length <= maxParts) return groups

  // 3) 段落边界导致的条数超了，但总长装得下：按字数均匀硬切，内容不丢
  if (full.length <= limit * maxParts) {
    const size = Math.ceil(full.length / maxParts)
    const parts = []
    for (let i = 0; i < full.length; i += size) parts.push(full.slice(i, i + size).trim())
    return parts.filter(Boolean)
  }

  // 4) 实在太长：最多 maxParts 条，最后一条省略号提示被截断
  const parts = []
  for (let i = 0; i < maxParts; i += 1) parts.push(full.slice(i * limit, (i + 1) * limit))
  parts[maxParts - 1] = parts[maxParts - 1].slice(0, Math.max(0, limit - 1)).replace(/\s+$/, '') + '…'
  return parts
}

function buildPushText({ date, chatName, chatKey, text }) {
  const who = String(chatName || chatKey || '群聊').trim()
  const head = date ? `📊 ${date} · ${who} 日报` : `📊 ${who} 日报`
  const body = String(text ?? '').trim()
  return body ? `${head}\n\n${body}` : head
}

/**
 * 把一份日报私聊推送给本人。
 *
 * 标题行（日期 · 群名 日报）+ 正文，超过单条上限按段落切成最多 3 条逐条发送；
 * 任一条失败立即停，parts 是已经成功发出的条数。
 * @returns {Promise<{ok:boolean, target:string, parts:number, error?:string}>}
 */
export async function pushReport(cfg, { date = '', chatKey = null, chatName = '', text = '', target = '', fetchImpl = null } = {}) {
  const bridge = readBridgeConfig(cfg)
  const dest = normalizeTarget(target) || bridge.target
  const userId = privateUserId(dest)
  if (!userId) {
    return {
      ok: false,
      target: dest,
      parts: 0,
      error: dest
        ? `推送目标只支持私聊（private:<QQ号>），收到：${dest}`
        : '没有配置推送目标（push.target 或 meta push_target）',
    }
  }

  const doFetch = fetchImpl || cfg?.push?.fetchImpl || fetch
  const messages = splitPushText(buildPushText({ date, chatName, chatKey, text }), partLimit(cfg))
  let sent = 0
  for (const message of messages) {
    const r = await sendPrivate({
      baseUrl: bridge.baseUrl,
      token: bridge.token,
      userId,
      message,
      fetchImpl: doFetch,
    })
    if (!r.ok) {
      const detail = r.error || r.data?.error || `HTTP ${r.status}`
      return { ok: false, target: `private:${userId}`, parts: sent, error: `第 ${sent + 1} 条没发出去：${detail}` }
    }
    sent += 1
  }
  return { ok: true, target: `private:${userId}`, parts: sent }
}

function parseBool(value) {
  const s = String(value ?? '').trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

/** 当前生效的推送设置：meta 写了就覆盖 config，没写用 config（再没配就是关）。 */
export function effectivePushSettings(db, cfg) {
  const bridge = readBridgeConfig(cfg)
  const push = cfg?.push && typeof cfg.push === 'object' ? cfg.push : {}
  const metaEnabled = getMeta(db, 'push_enabled', null)
  const metaTarget = getMeta(db, 'push_target', null)
  const metaScope = getMeta(db, 'push_scope', null)
  const scope = String(metaScope ?? push.scope ?? 'digest')
  return {
    enabled: metaEnabled === null ? Boolean(push.enabled) : parseBool(metaEnabled),
    target: metaTarget === null ? bridge.target : normalizeTarget(metaTarget),
    baseUrl: bridge.baseUrl,
    tokenReady: Boolean(bridge.token),
    scope: scope === 'all' ? 'all' : 'digest',
  }
}

/** 改推送开关/目标/范围（写 meta，立即生效）；不传的字段保持原样。 */
export function setPushSettings(db, { enabled, target, scope } = {}) {
  if (enabled !== undefined && enabled !== null) setMeta(db, 'push_enabled', enabled ? '1' : '0')
  if (target !== undefined && target !== null) setMeta(db, 'push_target', normalizeTarget(target))
  if (scope !== undefined && scope !== null) {
    const s = String(scope).trim() === 'all' ? 'all' : 'digest'
    setMeta(db, 'push_scope', s)
  }
  const enabledRaw = getMeta(db, 'push_enabled', null)
  return {
    enabled: enabledRaw === null ? false : parseBool(enabledRaw),
    target: normalizeTarget(getMeta(db, 'push_target', '')),
    scope: String(getMeta(db, 'push_scope', '') || 'digest') === 'all' ? 'all' : 'digest',
  }
}

/** 当前开关状态 + 上一次推送结果（看板开关和只读 API 共用）。 */
export function pushStatus(db, cfg) {
  const at = Number(getMeta(db, 'push_last_at', 0)) || 0
  return {
    ...effectivePushSettings(db, cfg),
    lastAt: at,
    lastResult: String(getMeta(db, 'push_last_result', '') || ''),
  }
}

/** 记一次推送结果（成功/失败都记，看板据此显示「上次」）。 */
export function recordPushResult(db, { ok, text } = {}) {
  setMeta(db, 'push_last_at', String(Math.floor(Date.now() / 1000)))
  setMeta(db, 'push_last_result', `${ok ? 'ok' : 'fail'} ${String(text || '').trim()}`)
}

/**
 * 校验并写入看板/API 传来的推送设置。
 * 非法输入抛错（调用方转 400），合法时返回最新的 pushStatus。
 * 收件人只允许私聊：往群里推总结是另一种打扰，这个口子不开放。
 */
export function applyPushUpdate(db, cfg, input = {}) {
  const patch = {}
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new Error('enabled 要传 true / false')
    patch.enabled = input.enabled
  }
  if (input.scope !== undefined) {
    const s = String(input.scope).trim()
    if (s !== 'digest' && s !== 'all') throw new Error('scope 只能是 digest 或 all')
    patch.scope = s
  }
  if (input.target !== undefined) {
    const t = normalizeTarget(input.target)
    if (t && !/^private:\d+$/.test(t)) throw new Error('收件人只支持私聊 private:<QQ号>')
    patch.target = t
  }
  if (!Object.keys(patch).length) throw new Error('没有要改的字段（enabled / scope / target）')
  setPushSettings(db, patch)
  return pushStatus(db, cfg)
}
