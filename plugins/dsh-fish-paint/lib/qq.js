// 鱼鱼画画 · QQ 投递 + R18 硬闸
//
// 发图这条路必须和 qq-bridge 现有的两个发图 MCP 完全同一套规则，否则模型只要换个工具
// 就能绕过 R18 白名单。所以这里不复制规则，而是：
//   1. 直接读 bridge 的 config.json（allow / deny / r18 / ownerQQ / snowluma 连接信息）；
//   2. 直接 import bridge 的 src/r18-guard.js 做 checkR18Send（sidecar 契约是同一份源码）。
// 守卫模块读不到时 fail-closed：宁可拒发，也不放行没经过白名单判定的图。
//
// 对外只有两个入口（见 CONTRACT.md §4）：
//   bridgeStatus(bridgeDir)  → 同步，给 draw_status 看桥接状态
//   sendImages({key,paths,text,bridgeDir,tmpDir}) → 异步，真正发送
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── 本机环境解析：不写死任何绝对路径，优先级「工具 config > 环境变量 > 自动探测」 ──
export const ENV_KEYS = {
  bridgeDir: 'FISH_PAINT_BRIDGE_DIR',
  qqBridgeDir: 'QQ_BRIDGE_DIR',
  ffmpegPath: 'FISH_PAINT_FFMPEG',
}

/**
 * 桥目录的判定：不只是「有 config.json」——还要长得像 qq-bridge 的配置
 * （allow 名单 + snowluma/consolePort/ownerQQ 这些字段）。只看文件名会误认
 * 任何带 config.json 的目录（本机就被 `C:\Users\...\.ai_completion` 骗过一次）。
 */
export function isBridgeDir(dir) {
  if (!dir) return false
  try {
    const file = path.join(String(dir), 'config.json')
    if (!fs.statSync(file).isFile()) return false
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false
    const allow = cfg.allow
    const allowOk =
      allow && typeof allow === 'object' && !Array.isArray(allow) &&
      (Array.isArray(allow.groups) || Array.isArray(allow.private))
    const bridgeOk = 'snowluma' in cfg || 'consolePort' in cfg || 'ownerQQ' in cfg
    return Boolean(allowOk && bridgeOk)
  } catch {
    return false
  }
}

function listDirs(root, limit = 200) {
  try {
    const out = []
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      out.push(path.join(root, entry.name))
      if (out.length >= limit) break
    }
    return out
  } catch {
    return []
  }
}

const QQ_BRIDGE_NAME = /qq[-_ ]?bridge/i

function defaultRoots() {
  const roots = []
  const pushRoot = (value) => {
    if (!value) return
    try {
      const normalized = path.resolve(String(value))
      if (!roots.includes(normalized)) roots.push(normalized)
    } catch { /* 坏路径直接忽略 */ }
  }
  pushRoot(path.parse(PLUGIN_ROOT).root)
  pushRoot(path.parse(process.cwd()).root)
  pushRoot(os.homedir())
  pushRoot(process.env.LOCALAPPDATA)
  pushRoot(process.env.ProgramData)
  return roots
}

/**
 * 自动探测 QQ 桥目录。只认**名字像 qq-bridge** 的目录（`qq-bridge-*` / `qqbridge` 等），
 * 允许它自己直接是桥，也允许它下面再套一层（很多整合/绿色包是
 * `...\qq-bridge-0.2.1-r1\qq-bridge-0.2.1-r1\config.json` 这种双层结构）。
 *
 * options.roots 仅供测试注入；生产不传。
 */
export function detectBridgeDir(options = {}) {
  const roots = Array.isArray(options.roots) && options.roots.length ? options.roots : defaultRoots()
  for (const root of roots) {
    const level1 = listDirs(root)
    for (const dir of level1) {
      if (QQ_BRIDGE_NAME.test(path.basename(dir)) && isBridgeDir(dir)) return dir
    }
    for (const dir of level1) {
      const level2 = listDirs(dir, 300)
      for (const child of level2) {
        if (!QQ_BRIDGE_NAME.test(path.basename(child))) continue
        if (isBridgeDir(child)) return child
        for (const grand of listDirs(child, 100)) {
          if (isBridgeDir(grand)) return grand
        }
      }
    }
  }
  return ''
}

/** 配置里给了就用配置；没给才看环境变量 / 自动探测。 */
export function resolveBridgeDir(explicit) {
  const given = typeof explicit === 'string' ? explicit.trim() : ''
  if (given) return path.normalize(given)
  for (const key of [ENV_KEYS.bridgeDir, ENV_KEYS.qqBridgeDir]) {
    const value = String(process.env[key] || '').trim()
    if (value && isBridgeDir(value)) return path.normalize(value)
  }
  return detectBridgeDir()
}

function findOnPath(name) {
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  const dirs = String(process.env.PATH || '').split(path.delimiter)
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch { /* 继续找下一个 */ }
    }
  }
  return ''
}

/** ffmpeg：config > 环境变量 > PATH。找不到返回 ''（超 10MB 的图会给明确报错）。 */
export function resolveFfmpeg(explicit) {
  const given = typeof explicit === 'string' ? explicit.trim() : ''
  if (given) return given
  const fromEnv = String(process.env[ENV_KEYS.ffmpegPath] || '').trim()
  if (fromEnv) return fromEnv
  return findOnPath('ffmpeg')
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
// QQ 一次塞太多图容易触发静默风控，和 mcp-qq-image.js 的上限保持一致。
const MAX_IMAGES_PER_BATCH = 3
// OneBot 请求超时；发送大图（几 MB base64）慢一点，给 60 秒。
const ONEBOT_TIMEOUT_MS = 60000

function normalizeIdList(value) {
  if (!Array.isArray(value)) return []
  // 与 bridge 的 normalizeIdList 同口径：只留纯数字，避免 " 123 " / "abc" 混进名单。
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v))
}

function readJsonTolerant(file) {
  let text = fs.readFileSync(file, 'utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // 别人用 PowerShell 写出来的 BOM 不要当损坏
  return JSON.parse(text)
}

export function readBridgeConfig(bridgeDir = '') {
  const dir = resolveBridgeDir(bridgeDir)
  if (!dir) {
    throw new Error(
      '没找到 QQ 桥目录：请在插件 config 里填 bridgeDir，或设环境变量 FISH_PAINT_BRIDGE_DIR（指向有 config.json 的 qq-bridge 目录）。',
    )
  }
  const configPath = path.join(dir, 'config.json')
  if (!fs.existsSync(configPath)) {
    throw new Error(`找不到 QQ 桥配置：${configPath}（检查插件 config 的 bridgeDir）`)
  }
  let cfg
  try {
    cfg = readJsonTolerant(configPath)
  } catch (error) {
    throw new Error(`QQ 桥配置读不出来：${configPath}（${error.message}）`)
  }
  const snowluma = cfg.snowluma && typeof cfg.snowluma === 'object' ? cfg.snowluma : {}
  const allow = cfg.allow && typeof cfg.allow === 'object' ? cfg.allow : {}
  const deny = cfg.deny && typeof cfg.deny === 'object' ? cfg.deny : {}
  const r18 = cfg.r18 && typeof cfg.r18 === 'object' ? cfg.r18 : {}
  return {
    dir,
    configPath,
    httpUrl: String(snowluma.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: snowluma.accessToken == null ? '' : String(snowluma.accessToken),
    allowGroups: normalizeIdList(allow.groups),
    allowPrivate: normalizeIdList(allow.private),
    denyGroups: normalizeIdList(deny.groups),
    denyPrivate: normalizeIdList(deny.private),
    allowAllWhenEmpty: cfg.allowAllWhenEmpty === true,
    ownerQQ: cfg.ownerQQ == null ? null : String(cfg.ownerQQ).trim(),
    r18: { groups: normalizeIdList(r18.groups), private: normalizeIdList(r18.private) },
  }
}

// draw_status 用的同步摘要：只读配置，不发网络请求。
export function bridgeStatus(bridgeDir = '') {
  const c = readBridgeConfig(bridgeDir)
  return {
    dir: c.dir,
    configPath: c.configPath,
    httpUrl: c.httpUrl,
    hasToken: c.token !== '',
    allow: { groups: c.allowGroups, private: c.allowPrivate },
    deny: { groups: c.denyGroups, private: c.denyPrivate },
    allowAllWhenEmpty: c.allowAllWhenEmpty,
    r18: c.r18,
    ownerQQ: c.ownerQQ,
  }
}

function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const sid = String(id)
  if (denyList.includes(sid)) return false
  if (allowList.length > 0) return allowList.includes(sid)
  return allowAllWhenEmpty
}

function parseKey(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim())
  if (!m) return { error: 'key 格式错误，应为 group:群号 或 private:QQ号' }
  return { kind: m[1], id: m[2] }
}

// ── R18 守卫：动态 import bridge 源码，加载失败一律 fail-closed ──────────────
const guardCache = new Map()

async function loadGuard(bridgeDir) {
  const dir = resolveBridgeDir(bridgeDir)
  if (!dir) {
    throw new Error(
      '没找到 QQ 桥目录：请在插件 config 里填 bridgeDir，或设环境变量 FISH_PAINT_BRIDGE_DIR；没有它无法做 R18 判定，本次发送已拒绝。',
    )
  }
  if (guardCache.has(dir)) return guardCache.get(dir)
  const guardPath = path.join(dir, 'src', 'r18-guard.js')
  const promise = (async () => {
    if (!fs.existsSync(guardPath)) {
      throw new Error(`R18 守卫模块缺失：${guardPath}；为避免绕过白名单，本次发送已拒绝（fail-closed）。`)
    }
    try {
      return await import(pathToFileURL(guardPath).href)
    } catch (error) {
      throw new Error(`R18 守卫模块加载失败：${guardPath}（${error.message}）；本次发送已拒绝（fail-closed）。`)
    }
  })()
  guardCache.set(dir, promise)
  // 加载失败不要把坏结果永久缓存，修好文件后下一次还能重试。
  promise.catch(() => guardCache.delete(dir))
  return promise
}

// 发送前的同步可判定项：会话 key / allow 名单 / 文件存在与大小。R18 判定在 sendImages 里异步做。
function checkBasics(key, paths, c) {
  const k = parseKey(key)
  if (k.error) return { ok: false, error: k.error }
  if (k.kind === 'group' && !isAllowed(c.allowGroups, c.denyGroups, k.id, c.allowAllWhenEmpty)) {
    return { ok: false, error: `拒绝：群 ${k.id} 不在 QQ 桥的 allow.groups 白名单里，不能发图。` }
  }
  if (k.kind === 'private' && !isAllowed(c.allowPrivate, c.denyPrivate, k.id, c.allowAllWhenEmpty)) {
    return { ok: false, error: `拒绝：QQ ${k.id} 不在 QQ 桥的 allow.private 白名单里，不能发图。` }
  }
  const list = Array.isArray(paths) ? paths.map(String).filter(Boolean) : []
  if (list.length === 0) return { ok: false, error: '没有可发送的图片路径' }
  for (const p of list) {
    let stat
    try {
      stat = fs.statSync(p)
    } catch {
      return { ok: false, error: `图片不存在：${p}` }
    }
    if (!stat.isFile()) return { ok: false, error: `不是文件：${p}` }
    if (stat.size === 0) return { ok: false, error: `图片是空文件：${p}` }
  }
  return { ok: true, kind: k.kind, id: k.id, list }
}

// ── 超 10MB 的图转 JPEG（OneBot base64 传大图容易失败/被风控） ─────────────
function toJpeg(source, tmpDir, ffmpegPath) {
  return new Promise((resolve) => {
    const ffmpeg = resolveFfmpeg(ffmpegPath)
    if (!ffmpeg) {
      resolve({
        ok: false,
        error: '图片超过 10MB，但本机没找到 ffmpeg：装一个并加进 PATH，或在插件 config 里填 ffmpegPath / 设环境变量 FISH_PAINT_FFMPEG。',
      })
      return
    }
    fs.mkdirSync(tmpDir, { recursive: true })
    const target = path.join(tmpDir, `${path.basename(source, path.extname(source))}-${Date.now()}.jpg`)
    const child = spawn(ffmpeg, ['-y', '-loglevel', 'error', '-i', source, '-q:v', '3', target], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', () => resolve({ ok: false, error: 'ffmpeg 启动失败，无法压缩超过 10MB 的图片' }))
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(target)) resolve({ ok: true, path: target, temp: true })
      else resolve({ ok: false, error: `ffmpeg 压缩失败：${stderr.trim().slice(0, 200) || `退出码 ${code}`}` })
    })
  })
}

async function prepareImage(imagePath, tmpDir, ffmpegPath) {
  const stat = fs.statSync(imagePath)
  if (stat.size <= MAX_IMAGE_BYTES) return { ok: true, path: imagePath, temp: false }
  return toJpeg(imagePath, tmpDir, ffmpegPath)
}

function sendErrorText(prefix, error) {
  const msg = String(error?.message ?? error)
  const hint = /delivery was not confirmed|no message receipt/i.test(msg)
    ? '（QQ 没给回执，疑似内容被静默风控；别马上重试，等一会儿或改发私聊）'
    : ''
  return `${prefix}：${msg}${hint}`
}

async function onebot(c, action, params) {
  const headers = { 'content-type': 'application/json' }
  if (c.token) headers.authorization = `Bearer ${c.token}`
  const res = await fetch(`${c.httpUrl}/${action}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(ONEBOT_TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`OneBot 返回非 JSON：${text.slice(0, 200)}`)
  }
  if (body.status !== 'ok' || (body.retcode ?? 0) !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`)
  }
  return body.data
}

/**
 * 把本地图片发到 QQ 会话（一轮最多 3 张，多了自动分批）。
 * 返回 { ok:true, kind, id, sent:[{path,messageId}], batches }
 * 失败抛 Error，message 可直接给模型/群友看。
 */
export async function sendImages({ key, paths, text = '', bridgeDir = '', ffmpegPath = '', tmpDir } = {}) {
  const c = readBridgeConfig(bridgeDir)
  const check = checkBasics(key, paths, c)
  if (!check.ok) throw new Error(check.error)

  // R18 硬闸：与 bridge 的 qq_send_image / qq_send_images 用同一份判定。
  // 注意：判定用的是**原始路径**的 sidecar；转 JPEG 发生在判定之后，不影响评级。
  let guard
  try {
    guard = await loadGuard(bridgeDir)
  } catch (error) {
    throw new Error(error.message)
  }
  const policy = guard.policyFromConfig(readJsonTolerant(c.configPath))
  const blocked = guard.checkR18Send(`${check.kind}:${check.id}`, check.list, policy)
  if (blocked) throw new Error(blocked.error)

  const workDir = String(tmpDir || path.join(os.tmpdir(), 'dsh-fish-paint'))
  const prepared = []
  const temps = []
  for (const p of check.list) {
    const item = await prepareImage(p, workDir, ffmpegPath)
    if (!item.ok) throw new Error(item.error)
    if (item.temp) temps.push(item.path)
    prepared.push({ source: p, send: item.path })
  }

  const batches = []
  for (let i = 0; i < prepared.length; i += MAX_IMAGES_PER_BATCH) {
    batches.push(prepared.slice(i, i + MAX_IMAGES_PER_BATCH))
  }

  const sent = []
  try {
    let batchIndex = 0
    for (const batch of batches) {
      const message = []
      // 说明文字只放在第一批，免得每批都重复一遍。
      const say = batchIndex === 0 && String(text || '').trim()
      if (say) message.push({ type: 'text', data: { text: String(text).trim() } })
      for (const item of batch) {
        const buffer = fs.readFileSync(item.send)
        message.push({ type: 'image', data: { file: 'base64://' + buffer.toString('base64') } })
      }
      const action = check.kind === 'group' ? 'send_group_msg' : 'send_private_msg'
      const params = check.kind === 'group'
        ? { group_id: Number(check.id), message }
        : { user_id: Number(check.id), message }
      const data = await onebot(c, action, params)
      const messageId = data?.message_id ?? null
      for (const item of batch) sent.push({ path: item.source, messageId })
      batchIndex += 1
    }
  } catch (error) {
    throw new Error(sendErrorText('发送图片失败', error))
  } finally {
    // 临时 JPEG 无论成败都清掉（bridge 只读一次）。
    for (const temp of temps) {
      try { fs.rmSync(temp, { force: true }) } catch { /* 清理失败不影响发送结果 */ }
    }
  }

  return { ok: true, kind: check.kind, id: check.id, sent, batches: batches.length }
}

// 给单元测试/排障用：只跑规则判定，不发送。
export async function checkSendable({ key, paths, bridgeDir = '' } = {}) {
  const c = readBridgeConfig(bridgeDir)
  const check = checkBasics(key, paths, c)
  if (!check.ok) return { ok: false, error: check.error }
  const guard = await loadGuard(bridgeDir)
  const blocked = guard.checkR18Send(`${check.kind}:${check.id}`, check.list, guard.policyFromConfig(readJsonTolerant(c.configPath)))
  if (blocked) return { ok: false, error: blocked.error, blocked: blocked.blocked }
  return { ok: true, kind: check.kind, id: check.id }
}
