// dsh-coser-fish — 鱼鱼找鸡：一张图 → 反查 coser 的社媒账号。
//
// 上游是一个零依赖的普通 Node 包（coser-image-search v1.0.0，src/fish-find-chicken.js 一整个
// 反查内核 + 八个引擎 + 账号抽取 + 人话格式化）。这里只做三件事：
//   1. 把它包成 Cordis Host 插件，暴露 fish_find / fish_check 两个工具；
//   2. 补上「QQ 里被引用的图」这条入口 —— 直接向本机 qq-bridge 取原图 base64，
//      不依赖调用方先把图落盘（MCP 只把图塞进视觉上下文，不给本地路径）；
//   3. 给反查结果加一层本地缓存（同一张图重复问不会把 SauceNAO 的免费额度烧光）。
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cacheGet,
  cachePut,
  closeBrowser,
  engineLabels,
  ENGINES_VERSION,
  ENGINE_IDS,
  extractAccounts,
  formatReply,
  readJsonFile,
  reverseSearch,
  sha256Hex,
  writeJsonFileAtomic,
} from './src/fish-find-chicken.js'
import { safeFetchBuffer } from './src/safe-fetch.js'

export const name = 'dsh-coser-fish'
export const inject = ['tools', 'systemPrompt']

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const STATE_DIR = path.join(ROOT, 'state')
const CACHE_FILE = path.join(STATE_DIR, 'cache.json')
const BRIDGE_DEFAULT_DIR = 'D:\\DPQQ\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1'
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

const DEFAULTS = {
  engines: ['saucenao', 'tracemoe'],
  timeoutMs: 45000,
  maxAccounts: 3,
  strict: true,
  proxy: '',
  browserExe: '',
  cacheDays: 30,
  cacheMax: 300,
  qqBridgeDir: BRIDGE_DEFAULT_DIR,
  // 反查只产出画作账号（pixiv）时，再按作者名去网上捞一遍 X（推特）—— coser 真身基本都在 X。
  xSearch: true,
}

const text = (value) => [{ type: 'text', text: String(value) }]

// 反查会占用一个 headless 浏览器单例，并发跑两个只会互相抢 page：这里串成队列。
// 但队列只等「这次调用有结论或到点」—— 浏览器引擎一旦卡死，队列不能跟着一起卡死，
// 所以队头是 Promise.race(任务, 截止时间)，到点就放行下一次调用。
let queue = Promise.resolve()
function enqueue(task, deadlineMs) {
  const run = queue.then(task, task)
  const release = new Promise((resolve) => {
    const timer = setTimeout(resolve, deadlineMs)
    timer.unref?.()
    const settle = () => {
      clearTimeout(timer)
      resolve()
    }
    run.then(settle, settle)
  })
  queue = release
  return run
}

/** 到点就放弃等待；底层任务可能还在跑，调用方负责收尾（关浏览器）。 */
function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('__fish_timeout__')
      error.code = 'FISH_TIMEOUT'
      reject(error)
    }, ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function mergeConfig(config) {
  const merged = { ...DEFAULTS }
  if (config && typeof config === 'object') {
    for (const [key, value] of Object.entries(config)) {
      if (value === undefined || value === null || value === '') continue
      merged[key] = value
    }
  }
  merged.engines = Array.isArray(merged.engines) ? merged.engines.filter((id) => ENGINE_IDS.includes(id)) : [...DEFAULTS.engines]
  if (!merged.engines.length) merged.engines = [...DEFAULTS.engines]
  merged.maxAccounts = Math.min(5, Math.max(1, Number(merged.maxAccounts) || DEFAULTS.maxAccounts))
  merged.timeoutMs = Math.min(180000, Math.max(5000, Number(merged.timeoutMs) || DEFAULTS.timeoutMs))
  merged.cacheDays = Math.max(0, Number(merged.cacheDays ?? DEFAULTS.cacheDays))
  merged.cacheMax = Math.max(1, Number(merged.cacheMax) || DEFAULTS.cacheMax)
  merged.qqBridgeDir = String(merged.qqBridgeDir || BRIDGE_DEFAULT_DIR)
  return merged
}

// ── 图片入口 ───────────────────────────────────────────────────────────────

/** 按文件头认格式，不信扩展名 —— 有人把 png 存成 .jpg，反查接口会直接拒。 */
function sniffMime(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes.length > 12 && bytes.slice(0, 4).toString('ascii') === 'RIFF' && bytes.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (bytes.length > 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  return 'image/jpeg'
}

function mimeFromBase64Payload(declared, bytes) {
  const guessed = sniffMime(bytes)
  const value = String(declared || '').toLowerCase()
  if (/^image\/(png|jpe?g|webp|gif)$/.test(value)) return value === 'image/jpg' ? 'image/jpeg' : value
  return guessed
}

// 输入层面的错（图找不到、消息没图、引擎全不可用）：直接把原因说给用户，别包成「没跑起来」。
function inputError(message) {
  const error = new Error(message)
  error.code = 'FISH_INPUT'
  return error
}

function skippedNoteOf(failures) {
  const skipped = (failures || []).filter((item) => String(item?.reason || '').startsWith('跳过'))
  if (!skipped.length) return ''
  return `\n\n（没跑的引擎：${skipped.map((item) => `${engineLabels([item.engine])[0] ?? item.engine} — ${String(item.reason).replace(/^跳过：/, '')}`).join('；')}）`
}

async function readImageTarget(target) {
  const raw = String(target ?? '').trim()
  if (!raw) throw inputError('没给图片')
  if (/^https?:\/\//i.test(raw)) {
    const got = await safeFetchBuffer(raw, MAX_IMAGE_BYTES)
    if (!got?.buffer?.length) throw inputError(`这个地址没取到图：${raw}`)
    return { bytes: got.buffer, mimeType: sniffMime(got.buffer), source: raw }
  }
  const file = path.resolve(raw.replace(/^file:\/\//i, ''))
  if (!fs.existsSync(file)) throw inputError(`找不到这个文件：${file}`)
  const stat = fs.statSync(file)
  if (!stat.isFile()) throw inputError(`这不是文件：${file}`)
  if (stat.size > MAX_IMAGE_BYTES) throw inputError(`图太大了（${(stat.size / 1048576).toFixed(1)}MB，上限 20MB）`)
  const bytes = fs.readFileSync(file)
  return { bytes, mimeType: sniffMime(bytes), source: file }
}

// ── QQ 桥（被引用的图） ────────────────────────────────────────────────────

function normalizeQQKey(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const hit = /^(group|private):(\d+)$/i.exec(raw)
  if (hit) return `${hit[1].toLowerCase()}:${hit[2]}`
  if (/^\d+$/.test(raw)) return `group:${raw}`
  return ''
}

let bridgeCache = { dir: '', mtime: 0, conversations: null }

function bridgeConsoleToken(dir, cfgFile) {
  const configured = String(cfgFile?.consoleToken ?? '').trim()
  // 与桥接校验口径一致：不合法的令牌桥接会忽略并回退 state/console-token。
  if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured
  try {
    return fs.readFileSync(path.join(dir, 'state', 'console-token'), 'utf8').trim()
  } catch {
    return ''
  }
}

function bridgeInfo(dir) {
  const bridgeDir = path.resolve(dir || BRIDGE_DEFAULT_DIR)
  const cfgFile = readJsonFile(path.join(bridgeDir, 'config.json'), {}) || {}
  const port = Number(cfgFile.consolePort) || 3100
  const consoleToken = bridgeConsoleToken(bridgeDir, cfgFile)
  const stateFile = path.join(bridgeDir, 'state', 'social-v2.json')
  let mtime = 0
  try {
    mtime = fs.statSync(stateFile).mtimeMs
  } catch {
    mtime = 0
  }
  let conversations = bridgeCache.conversations
  if (!conversations || bridgeCache.dir !== bridgeDir || bridgeCache.mtime !== mtime) {
    const state = readJsonFile(stateFile, {}) || {}
    conversations = state.conversations && typeof state.conversations === 'object' ? state.conversations : {}
    bridgeCache = { dir: bridgeDir, mtime, conversations }
  }
  const mode = String((readJsonFile(path.join(bridgeDir, 'state', 'mode.json'), {}) || {}).mode || '')
  return { bridgeDir, port, consoleToken, conversations, mode }
}

function httpGetJson(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > 60 * 1024 * 1024) {
          req.destroy(new Error('桥接返回的图片数据过大'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body = null
        try {
          body = JSON.parse(raw)
        } catch {
          body = null
        }
        if (res.statusCode !== 200) {
          reject(new Error(body?.error ? String(body.error) : `桥接 HTTP ${res.statusCode}`))
          return
        }
        if (!body) {
          reject(new Error('桥接返回了非 JSON 内容'))
          return
        }
        if (body.ok === false) {
          reject(new Error(String(body.error || '桥接拒绝了这个请求')))
          return
        }
        resolve(body)
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`桥接 ${Math.round(timeoutMs / 1000)} 秒没回话（bridge 是不是没开？）`)))
    req.on('error', (error) => reject(new Error(`连不上 qq-bridge（${url}）：${error?.message ?? error}`)))
    req.end()
  })
}

async function readQQImage({ qqKey, qqMessageId, agentToken }, cfg) {
  const key = normalizeQQKey(qqKey)
  if (!key) throw inputError(`qqKey 格式应为 group:群号 或 private:QQ号（收到「${qqKey ?? ''}」）`)
  const messageId = String(qqMessageId ?? '').trim()
  if (!messageId) throw inputError('缺 qqMessageId：被引用那条消息的 messageId 或本地 seq')

  const info = bridgeInfo(cfg.qqBridgeDir)
  const conversation = info.conversations[key]
  const token = String(agentToken ?? '').trim() || String(conversation?.agentToken ?? '').trim()
  if (info.mode === 'reserved2' && !token) {
    throw inputError(`二代会话 ${key} 没有可用的会话令牌（state/social-v2.json 里没有这条会话）`)
  }
  const headers = { accept: 'application/json' }
  if (info.consoleToken) headers['x-console-token'] = info.consoleToken
  if (token) headers['x-agent-token'] = token

  const query = new URLSearchParams({ key, messageId })
  const body = await httpGetJson(`http://127.0.0.1:${info.port}/api/images/message?${query.toString()}`, headers, 180000)
  const images = Array.isArray(body?.images) ? body.images : []
  const pictures = images.filter((item) => item?.kind !== 'face' && item?.data)
  const picked = pictures[0] || null
  if (!picked) {
    const faces = images.filter((item) => item?.kind === 'face').length
    const note = String(body?.note || '').trim()
    throw inputError(
      images.length
        ? `消息 ${messageId} 里没有可反查的图片${faces ? `（只有 ${faces} 个表情）` : ''}`
        : `消息 ${messageId} 没有图片${note ? `：${note}` : ''}`,
    )
  }
  const bytes = Buffer.from(String(picked.data), 'base64')
  if (!bytes.length) throw inputError(`消息 ${messageId} 的图片是空的`)
  return {
    bytes,
    mimeType: mimeFromBase64Payload(picked.mimeType, bytes),
    source: `qq:${key}#${messageId}`,
  }
}

// ── 缓存 ──────────────────────────────────────────────────────────────────

function cacheKeyOf(bytes, engines) {
  return `${sha256Hex(bytes)}:${ENGINES_VERSION}:${[...engines].sort().join(',')}`
}

function readCache() {
  return readJsonFile(CACHE_FILE, {}) || {}
}

function saveCache(cache, cfg) {
  try {
    writeJsonFileAtomic(CACHE_FILE, cache)
  } catch {
    /* 缓存写不进去不影响这次结果 */
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────

// 浏览器引擎跑之前先问一句「外网通不通」：lens 在连不上谷歌的机器上会一直等下去，
// 与其干等到超时，不如跳过并说清原因 —— 想用就传 proxy，别让整次反查陪葬。
const BROWSER_ENGINE_HOSTS = {
  lens: 'lens.google.com',
  google: 'www.google.com',
  yandex: 'yandex.com',
  bing: 'cn.bing.com',
  baidu: 'graph.baidu.com',
}

async function splitByReachability(engines, proxy) {
  const browserEngines = engines.filter((id) => BROWSER_ENGINE_HOSTS[id])
  const directEngines = engines.filter((id) => !BROWSER_ENGINE_HOSTS[id])
  // 有代理时探针测的是直连，跟浏览器实际走的路不一样，所以交给浏览器自己试。
  if (!browserEngines.length || proxy) return { usable: engines, skipped: [] }
  const checks = await Promise.all(
    browserEngines.map(async (id) => ({ id, ok: await tcpReachable(BROWSER_ENGINE_HOSTS[id], 443, 4000) })),
  )
  const usable = [...directEngines, ...checks.filter((item) => item.ok).map((item) => item.id)]
  const skipped = checks
    .filter((item) => !item.ok)
    .map((item) => ({ engine: item.id, reason: `跳过：${BROWSER_ENGINE_HOSTS[item.id]} 直连连不上（要用它请传 proxy）` }))
  return { usable: ENGINE_IDS.filter((id) => usable.includes(id)), skipped }
}

// ── 名字 → X（推特） ─────────────────────────────────────────────────────
// SauceNAO / trace.moe 只索引画作和动画截图，coser 本人的 X 主页基本不在里头 ——
// 命中往往是「同名的画」或者粉丝站。唯一能落到 X 上的路是：先从候选里拿作者名，
// 再用宿主的 ctx.web.search 按名字搜（这类页面标题常直接写「名字（@handle）」），
// 把 handle 捞回来。这一层只能算「推断」，报的时候必须带未核实标记。

let webSearch = null // apply() 里接到宿主的 ctx.web

const X_HOST_RE = /^https?:\/\/(?:www\.|mobile\.|m\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{2,20})(?:[/?#]|$)/i
const X_AT_RE = /[（(]\s*@([A-Za-z0-9_]{2,20})\s*[）)]/
// x.com 路径里有一堆不是人名的保留段，别把 /i/status/... 当成 handle。
const X_RESERVED = new Set([
  'i', 'intent', 'share', 'home', 'search', 'hashtag', 'status', 'explore', 'notifications',
  'messages', 'settings', 'login', 'signup', 'tos', 'privacy', 'rules', 'help', 'about',
  'jobs', 'verify', 'account', 'download', 'communities', 'lists', 'bookmarks', 'compose',
  'en', 'ja', 'zh', 'ko', 'es', 'fr', 'de',
])

const SOCIAL_RES = [
  { platform: 'twitter', re: X_HOST_RE, url: (handle) => `https://x.com/${handle}` },
  { platform: 'weibo', re: /^https?:\/\/(?:www\.|m\.|mobile\.)?weibo\.(?:com|cn)\/u\/(\d{5,})/i, url: (handle) => `https://weibo.com/u/${handle}` },
  { platform: 'weibo', re: /^https?:\/\/(?:www\.|m\.|mobile\.)?weibo\.(?:com|cn)\/([A-Za-z0-9_]{3,30})(?:[/?#]|$)/i, reserved: true, url: (handle) => `https://weibo.com/${handle}` },
  { platform: 'bilibili', re: /^https?:\/\/space\.bilibili\.com\/(\d{4,})/i, url: (handle) => `https://space.bilibili.com/${handle}` },
  { platform: 'instagram', re: /^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{2,30})(?:[/?#]|$)/i, url: (handle) => `https://instagram.com/${handle}` },
]
// weibo.com/<path> 里同样有一堆功能页，别把 /login /signup 当成人名。
const WEIBO_RESERVED = new Set([
  'login', 'signup', 'u', 'n', 'p', 'tv', 'search', 'help', 'about', 'setting', 'messages',
  'attitude', 'aj', 'sign', 'mp', 's', 'fav', 'like', 'comment', 'detail', 'weibo', 'hot',
])

function socialFromSource(source) {
  const url = String(source?.url ?? '')
  for (const rule of SOCIAL_RES) {
    const hit = url.match(rule.re)
    if (!hit) continue
    const handle = hit[1]
    if (rule.platform === 'twitter' && X_RESERVED.has(handle.toLowerCase())) continue
    if (rule.platform === 'weibo' && WEIBO_RESERVED.has(handle.toLowerCase())) continue
    return { platform: rule.platform, handle, url: rule.url(handle) }
  }
  // 粉丝站（twfan / twiman / claps 等）的标题常直接写「名字（@handle）」。
  for (const field of [source?.title, source?.snippet]) {
    const hit = String(field ?? '').match(X_AT_RE)
    if (hit && !X_RESERVED.has(hit[1].toLowerCase())) {
      return { platform: 'twitter', handle: hit[1], url: `https://x.com/${hit[1]}` }
    }
  }
  return null
}

/** 拿去搜的名字：pixiv 作者名比作品标题更像「这个人叫什么」。 */
function xSearchNames(accounts, candidates, max = 2) {
  const out = []
  const seen = new Set()
  const pool = [
    ...(Array.isArray(accounts) ? accounts.map((item) => item?.authorName) : []),
    ...(Array.isArray(candidates) ? candidates.map((item) => item?.authorName) : []),
  ]
  for (const raw of pool) {
    const name = String(raw ?? '').trim()
    if (name.length < 2 || name.length > 40) continue
    if (/^[\d\s:./-]+$/.test(name)) continue
    if (/^(creator|member|author|unknown|untitled)$/i.test(name)) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= max) break
  }
  return out
}

/** 名字上的装饰（☆ ★ ・ 括号、全角空格、表情）会把搜索结果带偏，搜之前先削一版。 */
function xNameVariants(name) {
  const out = []
  const push = (value) => {
    const text = String(value ?? '').replace(/[\u3000\s]+/g, ' ').trim()
    if (text.length < 2 || text.length > 32) return
    if (/^[\d\s:./-]+$/.test(text)) return
    if (!out.includes(text)) out.push(text)
  }
  push(name)
  push(name.replace(/[☆★♪♡♥・･|｜/\\]+/g, ' '))
  push(String(name).split(/[☆★♪♡♥【\[（(]/)[0])
  return out.slice(0, 2)
}

async function searchSocialByName(names, { timeoutMs = 20000 } = {}) {
  if (!webSearch || !names.length) return []
  const budget = Date.now() + timeoutMs
  const found = []
  const seen = new Set()
  for (const name of names) {
    const queries = []
    const variants = xNameVariants(name)
    const tails = ['Twitter 账号', 'コスプレ twitter', '微博 账号']
    for (const variant of variants.slice(0, 1)) {
      for (const tail of tails) queries.push(`${variant} ${tail}`)
    }
    for (const query of queries) {
      const left = Math.min(10000, budget - Date.now())
      if (left < 2000) break
      let result
      try {
        result = await withTimeout(webSearch(query, 8), left)
      } catch {
        continue
      }
      const sources = Array.isArray(result?.sources) ? result.sources : []
      let hit = null
      for (const source of sources) {
        const social = socialFromSource(source)
        if (!social || seen.has(`${social.platform}:${social.handle.toLowerCase()}`)) continue
        // 「同名」必须能在标题/摘要里看到，否则就是撞了别人的号（宁缺毋滥）。
        const text = `${source?.title ?? ''} ${source?.snippet ?? ''}`
        const looksSame = variants.some((variant) => text.includes(variant))
        if (!looksSame) continue
        hit = { ...social, source }
        break
      }
      if (!hit) continue
      seen.add(`${hit.platform}:${hit.handle.toLowerCase()}`)
      found.push({
        platform: hit.platform,
        handle: hit.handle,
        url: hit.url,
        authorName: name,
        // 名字搜出来的号是推断，不是这张图直接命中的账号 —— 格式化层会标「（推断，未核实）」。
        confidence: 'inferred',
        evidence: {
          engine: 'name-search',
          similarity: null,
          sourceUrl: String(hit.source?.url ?? ''),
          note: `按名字「${name}」搜到的账号，没跟这张图逐条核实`,
        },
      })
      break // 这个名字找到就够了，不再换 query
    }
  }
  return found.slice(0, 2)
}

async function runFind(args, cfg) {
  const engines = Array.isArray(args.engines) && args.engines.length
    ? args.engines.filter((id) => ENGINE_IDS.includes(id))
    : cfg.engines
  if (!engines.length) throw inputError(`engines 里没有可用的引擎（可选：${ENGINE_IDS.join(' / ')}）`)

  const timeoutMs = Math.min(180000, Math.max(5000, (Number(args.timeoutSec) || Math.round(cfg.timeoutMs / 1000)) * 1000))
  const maxAccounts = Math.min(5, Math.max(1, Number(args.max) || cfg.maxAccounts))
  const strict = args.strict === false ? false : cfg.strict
  const proxy = String(args.proxy ?? cfg.proxy ?? '').trim()
  const started = Date.now()

  const image = args.qqMessageId
    ? await readQQImage(args, cfg)
    : await readImageTarget(args.image)

  const reach = await splitByReachability(engines, proxy)
  if (!reach.usable.length) {
    throw inputError(`这些引擎现在都用不了：${reach.skipped.map((item) => `${item.engine}（${item.reason}）`).join('；')}`)
  }

  const key = cacheKeyOf(image.bytes, reach.usable)
  const cache = readCache()
  const hit = args.noCache ? null : cacheGet(cache, key, Date.now(), { cacheDays: cfg.cacheDays })
  if (hit) {
    const accounts = Array.isArray(hit.accounts) ? hit.accounts : []
    return {
      summary:
        formatReply({
          accounts,
          enginesUsed: hit.enginesUsed ?? [],
          failures: hit.failures ?? [],
          cached: true,
        }) + skippedNoteOf(hit.failures),
      accounts,
      enginesUsed: hit.enginesUsed ?? [],
      failures: hit.failures ?? [],
      cached: true,
      elapsedMs: Date.now() - started,
      image: { source: image.source, bytes: image.bytes.length, mimeType: image.mimeType },
    }
  }

  const result = await reverseSearch(image.bytes, image.mimeType, {
    engines: reach.usable,
    timeoutMs,
    proxy,
    browserExe: cfg.browserExe || '',
  })
  const failures = [...result.failures, ...reach.skipped]
  const imageAccounts = extractAccounts(result.candidates, { max: maxAccounts, strictNames: strict })
  // 只翻到画作账号（pixiv）时，再按作者名去网上捞社媒：coser 的真身基本都在推特/微博/B站。
  const xEnabled = args.xSearch === false ? false : cfg.xSearch !== false
  const xAccounts = xEnabled && !imageAccounts.some((item) => item?.platform === 'twitter')
    ? await searchSocialByName(xSearchNames(imageAccounts, result.candidates), { timeoutMs: Math.min(25000, timeoutMs) })
    : []
  const accounts = (xAccounts.length ? [...xAccounts, ...imageAccounts] : imageAccounts).slice(0, 5)
  const summary = formatReply({
    accounts,
    candidates: result.candidates,
    enginesUsed: result.enginesUsed,
    failures,
    cached: false,
  }) + skippedNoteOf(failures)

  // 只缓存「结论」，不缓存整坨候选页面 —— 缓存文件要小，读起来要快。
  // 也不缓存「跳过某引擎」这类本次网络状况，免得 30 天后还在说 lens 连不上。
  const next = cachePut(
    cache,
    key,
    { accounts, enginesUsed: result.enginesUsed, failures: result.failures },
    Date.now(),
    { cacheMax: cfg.cacheMax },
  )
  saveCache(next, cfg)

  return {
    summary,
    accounts,
    enginesUsed: result.enginesUsed,
    failures,
    cached: false,
    elapsedMs: Date.now() - started,
    image: { source: image.source, bytes: image.bytes.length, mimeType: image.mimeType },
  }
}

// ── 自检 ──────────────────────────────────────────────────────────────────

function tcpReachable(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (ok) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.on('connect', () => done(true))
    socket.on('error', () => done(false))
  })
}

function findBrowser() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]
  return candidates.find((file) => fs.existsSync(file)) || ''
}

async function runCheck(cfg) {
  const lines = []
  const cache = readCache()
  const engines = cfg.engines
  lines.push(`引擎：${engineLabels(engines).join(' / ') || '（空）'}`)
  lines.push(`单引擎超时：${Math.round(cfg.timeoutMs / 1000)} 秒 · 最多报 ${cfg.maxAccounts} 个账号 · ${cfg.strict ? '名字对不上不报' : '名字对不上也报'}`)
  lines.push(`代理：${cfg.proxy || '直连'}`)
  const browser = findBrowser()
  lines.push(`浏览器（Lens/百度/必应/Yandex 要用）：${browser || '没找到 Edge/Chrome'}`)
  lines.push(`缓存：${Object.keys(cache).length} 条 · ${CACHE_FILE}`)

  const info = bridgeInfo(cfg.qqBridgeDir)
  const conversationCount = Object.keys(info.conversations).length
  lines.push(
    `QQ 桥：${info.bridgeDir} · 端口 ${info.port} · 模式 ${info.mode || '未知'} · 控制台令牌${info.consoleToken ? '已找到' : '缺失'} · ${conversationCount} 个会话（${conversationCount ? '被引用的图可以直接反查' : '还没跑过二代会话，取图会失败'}）`,
  )

  const [saucenaoOk, lensOk] = await Promise.all([tcpReachable('saucenao.com', 443), tcpReachable('lens.google.com', 443)])
  lines.push(`直连 SauceNAO：${saucenaoOk ? '通' : '不通'}`)
  lines.push(`直连 谷歌 Lens：${lensOk ? '通' : '不通'}${lensOk ? '' : '（不通就传 proxy，或只用 saucenao/tracemoe/iqdb）'}`)
  return lines.join('\n')
}

// ── 插件 ──────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const cfg = mergeConfig(config)

  // 「名字 → X」靠宿主的 web 服务（与 web_search 工具同源，不需要 API key）。
  // 不 hard-inject：拿不到就只是少一层 X 搜索，不影响反查本身。
  webSearch = (query, maxResults = 8) => {
    const web = typeof ctx.get === 'function' ? ctx.get('web') : undefined
    if (!web || typeof web.search !== 'function') throw new Error('宿主没有 ctx.web 服务')
    return web.search({ query, maxResults })
  }

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'coser-fish',
      order: 900,
      text:
        '本插件提供 fish_find 与 fish_check（鱼鱼找鸡）：给一张图反查这个 coser 的社媒账号（推特/微博/B站/Instagram/Pixiv）。' +
        '本机或网上的图传 image；QQ 会话里「被引用的那张图」传 qqKey（group:群号 / private:QQ号）+ qqMessageId，插件自己向本机 qq-bridge 取原图，不用先落盘。' +
        '默认引擎 saucenao+tracemoe（直连、几秒出结果）；要更准可加 lens 并配代理（本机直连 lens 不通，插件会自动跳过并说明）。' +
        '这两个引擎只索引画作/动画截图，只命中 pixiv 很常见；这时插件会按作者名去网上再搜一遍推特 / 微博 / B 站，给的是「推断，未核实」的号。' +
        '同一张图 30 天内命中本地缓存会秒回。要判断环境能不能跑（外网、浏览器、QQ 桥令牌、缓存）用 fish_check。',
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'fish_find',
      description:
        '鱼鱼找鸡：用一张图反查 coser 的社媒账号（推特/微博/B站/Instagram/Pixiv）。' +
        '图片二选一：image=本机绝对路径或 http(s) 图片地址；或者 qqKey（如 group:123456789 / private:100000002）+ qqMessageId（被引用那条消息的 messageId 或本地 seq），插件直接向本机 qq-bridge 取原图。' +
        'saucenao/tracemoe 只索引画作和动画截图，所以只命中 pixiv 是常态；这时插件会自动按作者名再搜一遍外网，捞推特 / 微博 / B 站 / Instagram 的号，给的是「推断，未核实」（xSearch:false 可关）。' +
        'engines 默认 saucenao+tracemoe（直连，几秒出结果）；要更准就加 lens：engines:["lens","saucenao","tracemoe"] 并传 proxy=http://127.0.0.1:10090（lens 要外网；直连不通时插件会跳过它并说明原因）。动漫截图可用 tracemoe/iqdb，同人图用 saucenao。' +
        '单次约 10–60 秒，内部串行排队；同一张图 30 天内命中缓存会秒回（cached=true）。' +
        '返回 summary（能直接发给人看的人话）与 accounts（结构化账号）。环境先自检用 fish_check。',
      parameters: {
        type: 'object',
        properties: {
          image: { type: 'string', description: '本机图片绝对路径或 http(s) 图片地址（与 qqMessageId 二选一）' },
          qqKey: { type: 'string', description: 'QQ 会话 key：group:群号 或 private:QQ号；只写群号按群处理' },
          qqMessageId: { type: 'string', description: 'QQ 消息 id 或本地 seq（被引用/转发那条带图的消息）；数字会被转成字符串处理' },
          engines: {
            type: 'array',
            items: { type: 'string', enum: ENGINE_IDS },
            description: '引擎，默认 [' + DEFAULTS.engines.join(', ') + ']；可选 ' + ENGINE_IDS.join(' / '),
          },
          max: { type: 'integer', description: '最多报几个账号，1-5，默认 3' },
          timeoutSec: { type: 'integer', description: '单个引擎超时（秒），5-180，默认 45' },
          proxy: { type: 'string', description: '只给浏览器（Lens/百度/必应/Yandex）用的代理，如 http://127.0.0.1:10090；空=直连' },
          strict: { type: 'boolean', description: 'true（默认）=名字对不上的别人的号不报；false=全报出来自己挑' },
          xSearch: { type: 'boolean', description: 'true（默认）=只翻到画作账号时，再按作者名去网上搜推特/微博/B站/Instagram，给出「推断，未核实」的号；false=只要图直接命中的账号' },
          noCache: { type: 'boolean', description: 'true=跳过本地缓存重新查' },
          agentToken: { type: 'string', description: '可选：QQ 二代会话令牌；不传时自动从 qq-bridge 的 state/social-v2.json 里按会话取' },
        },
        additionalProperties: false,
      },
      timeoutMs: 300000,
      output: {
        schema: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            accounts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  platform: { type: 'string' },
                  handle: { type: 'string' },
                  url: { type: 'string' },
                  authorName: { type: 'string' },
                  confidence: { type: 'string' },
                },
                additionalProperties: true,
              },
            },
            enginesUsed: { type: 'array', items: { type: 'string' } },
            failures: {
              type: 'array',
              items: {
                type: 'object',
                properties: { engine: { type: 'string' }, reason: { type: 'string' } },
                additionalProperties: true,
              },
            },
            cached: { type: 'boolean' },
            elapsedMs: { type: 'integer' },
            image: {
              type: 'object',
              properties: {
                source: { type: 'string' },
                bytes: { type: 'integer' },
                mimeType: { type: 'string' },
              },
              additionalProperties: true,
            },
          },
          required: ['summary'],
          additionalProperties: false,
        },
        render: (_args, value) => text(value?.summary ?? JSON.stringify(value)),
      },
      async execute(args) {
        if (!args.image && !args.qqMessageId) return { summary: '缺图片：传 image（本机路径/网址），或 qqKey + qqMessageId 指向 QQ 里那条带图的消息。' }
        const perEngineSec = Math.min(180, Math.max(5, Number(args.timeoutSec) || Math.round(cfg.timeoutMs / 1000)))
        const engineCount = Math.max(1, (Array.isArray(args.engines) && args.engines.length ? args.engines : cfg.engines).length)
        const deadlineMs = Math.max(90000, engineCount * perEngineSec * 1000 + 60000)
        try {
          return await withTimeout(enqueue(() => runFind(args, cfg), deadlineMs), deadlineMs)
        } catch (error) {
          if (error?.code === 'FISH_TIMEOUT') {
            // 卡住的浏览器会一直占着单例，掐掉它换下次干净启动。
            try {
              await closeBrowser()
            } catch {
              /* 掐不掉也只能让超时兜着 */
            }
            return {
              summary: `反查超时：${Math.round(deadlineMs / 1000)} 秒还没出结论（多半是浏览器引擎卡住，已经掐掉）。改用引擎 saucenao+tracemoe 重试会快很多；要用 lens 请先确认外网/代理通。`,
            }
          }
          if (error?.code === 'FISH_INPUT') return { summary: String(error.message) }
          return { summary: `鱼鱼找鸡没跑起来：${error?.message ?? error}` }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'fish_check',
      description:
        '鱼鱼找鸡环境自检：当前引擎与超时、有没有可用 Edge/Chrome、外网（SauceNAO/谷歌 Lens）通不通、缓存条数、以及本机 qq-bridge 的控制台令牌和会话（QQ 取图依赖它）。' +
        '反查失败、怀疑代理/浏览器/QQ 桥有问题时先跑这个，不要猜。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: 60000,
      output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
      async execute() {
        try {
          return await runCheck(cfg)
        } catch (error) {
          return `自检失败：${error?.message ?? error}`
        }
      },
    }),
  )
}

// 给 test/social.mjs 用的内部钩子：不联网就能验证「搜索结果 → 社媒账号」这一层的规则。
export const __internals = {
  socialFromSource,
  xNameVariants,
  xSearchNames,
  searchSocialByName,
  setWebSearch(fn) {
    webSearch = fn
  },
}
