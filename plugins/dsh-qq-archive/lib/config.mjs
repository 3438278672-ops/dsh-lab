/**
 * 配置 + 数据源自动探测。
 *
 * 开源版不能写死本机路径，所以这里按「显式配置 → 环境变量 → 常见位置扫描」
 * 的顺序找 SnowLuma 的 messages.db。找到哪个用哪个，找不到就明确报错。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { defaultHome } from './util.mjs'

export const DEFAULTS = {
  // auto | snowluma | onebot | json
  source: 'auto',
  // 显式指定 messages.db 或 SnowLuma 根目录；空 = 自动探测
  sourcePath: '',
  // OneBot v11：http 地址 + token（拉历史用）
  onebot: { baseUrl: '', accessToken: '' },
  // 插件家目录
  home: '',
  // 增量同步间隔（分钟）
  syncIntervalMin: 10,
  // 单批事务条数
  batchSize: 1000,
  // 单次查询最多返回条数上限
  maxHits: 200,
  // 增强层（默认全关）
  enhance: {
    voice: false,
    image: false,
    semantic: false,
    impression: false,
  },
  // 媒体缓存上限（张/条）；到上限就不再下新图
  media: { maxCount: 2000 },
  // 人物印象用的模型；空 = 自动选第一个可用 provider
  llm: { provider: '', model: '' },
  // 人物印象：每晚到点批量生成（schedule 为空 = 不自动跑，只能手动）
  impression: {
    schedule: '',
    minMsgs: 20,
    limit: 30,
    sample: 60,
  },
  // 群聊日报：每天到点自动生成「昨天」的（schedule 为空 = 只手动）
  report: {
    schedule: '00:30',
    maxChats: 12,
  },
  // 日报主动送达：日报写完后私聊给主人（总开关默认关，在群里让 DSH 打开即可）
  // 实际是否发送还会被 DB meta 里的 push_enabled 覆盖（action=push 改的就是它）
  push: {
    enabled: false,
    // 收件人：private:<QQ号> 或纯 QQ 号；空 = 自动取本机桥接白名单里的第一个私聊号
    target: '',
    // qq-bridge 控制台地址；token 空则从 tokenFile 读，再不行自动探测桥接 state/console-token
    baseUrl: 'http://127.0.0.1:3100',
    token: '',
    tokenFile: '',
    // 自动探测本机 qq-bridge（config.json 的 consolePort/allow.private + state/console-token）
    discover: true,
    // digest = 只推「所有会话」的汇总日报；all = 每个群各推一份（较吵）
    scope: 'digest',
  },
}

export function mergeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const out = { ...DEFAULTS }
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = raw[key]
    if (value === undefined || value === null || value === '') continue
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
      const given = value && typeof value === 'object' ? value : {}
      const merged = { ...fallback, ...given }
      // 二级对象（onebot/llm/enhance/impression）也要合默认值
      for (const [k2, v2] of Object.entries(fallback)) {
        if (!v2 || typeof v2 !== 'object' || Array.isArray(v2)) continue
        const given2 = given[k2] && typeof given[k2] === 'object' ? given[k2] : {}
        merged[k2] = { ...v2 }
        for (const [k3, v3] of Object.entries(v2)) {
          if (given2[k3] === undefined || given2[k3] === null) continue
          merged[k2][k3] = typeof v3 === 'number' ? Number(given2[k3]) : given2[k3]
        }
      }
      out[key] = merged
    } else {
      out[key] = typeof fallback === 'number' ? Number(value) : value
    }
  }
  if (!out.home) out.home = defaultHome()
  return out
}

function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** 在 root/data/<uin>/messages.db 这一层找，按文件大小取最大的。 */
function scanDataRoot(root) {
  const found = []
  const collect = (base) => {
    const dataDir = join(base, 'data')
    if (!isDir(dataDir)) return
    let uins
    try {
      uins = readdirSync(dataDir, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      return
    }
    for (const uin of uins) {
      const dbPath = join(dataDir, uin.name, 'messages.db')
      if (!isFile(dbPath)) continue
      try {
        found.push({ path: dbPath, uin: uin.name, size: statSync(dbPath).size })
      } catch {
        /* 读不到就算了 */
      }
    }
  }
  collect(root)
  // 常见布局：D:\DPQQ\SnowLuma-v2.1.1-win-x64\data\<uin>\messages.db，下探一层
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (/snowluma/i.test(entry.name)) collect(join(root, entry.name))
    }
  } catch {
    /* 权限不足就跳过 */
  }
  return found
}

function candidateRoots() {
  const roots = []
  const push = (p) => {
    if (p && !roots.includes(p) && isDir(p)) roots.push(p)
  }
  const env = process.env
  push(env.SNOWLUMA_HOME)
  push(env.SNOWLUMA_DIR)
  // 用户目录
  for (const base of [env.APPDATA, env.LOCALAPPDATA, homedir()]) {
    if (!base || !isDir(base)) continue
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (/snowluma/i.test(entry.name)) push(join(base, entry.name))
      }
    } catch {
      /* 权限问题跳过 */
    }
  }
  // 各盘根目录下常见的 SnowLuma / DPQQ 目录（浅层，不递归扫盘）
  const drives = []
  if (process.platform === 'win32') {
    for (let i = 65; i <= 90; i++) drives.push(String.fromCharCode(i) + ':\\')
  } else {
    drives.push('/')
  }
  for (const drive of drives) {
    if (!isDir(drive)) continue
    for (const name of ['DPQQ', 'SnowLuma', 'snowluma']) {
      push(join(drive, name))
    }
    try {
      for (const entry of readdirSync(drive, { withFileTypes: true })) {
        if (entry.isDirectory() && /snowluma/i.test(entry.name)) push(join(drive, entry.name))
      }
    } catch {
      /* C:\ 下可能权限不足 */
    }
  }
  return roots
}

/** 返回按大小倒序的候选 messages.db。 */
export function findSnowlumaDbs(explicitPath) {
  const out = []
  if (explicitPath) {
    const p = resolve(explicitPath)
    if (isFile(p)) out.push({ path: p, uin: '', size: statSync(p).size })
    else if (isDir(p)) {
      // 可能是 SnowLuma 根目录，也可能是 data/<uin> 目录
      out.push(...scanDataRoot(p))
      const direct = join(p, 'messages.db')
      if (isFile(direct)) out.push({ path: direct, uin: '', size: statSync(direct).size })
    }
  }
  if (!out.length) {
    for (const root of candidateRoots()) {
      for (const hit of scanDataRoot(root)) {
        if (!out.some((x) => x.path === hit.path)) out.push(hit)
      }
    }
  }
  out.sort((a, b) => b.size - a.size)
  return out
}

/** 解析成 { kind, path } 或抛错。 */
export function resolveSource(cfg) {
  const explicit = cfg.sourcePath || process.env.QQ_ARCHIVE_SOURCE || ''
  if (cfg.source === 'json') {
    if (!explicit || !isFile(explicit)) throw new Error(`source=json 需要 sourcePath 指向 JSON/JSONL 文件（当前：${explicit || '空'}）`)
    return { kind: 'json', path: resolve(explicit) }
  }
  if (cfg.source === 'onebot') {
    if (!cfg.onebot?.baseUrl) throw new Error('source=onebot 需要 onebot.baseUrl（如 http://127.0.0.1:3000）')
    return { kind: 'onebot', baseUrl: cfg.onebot.baseUrl.replace(/\/+$/, ''), accessToken: cfg.onebot.accessToken || '' }
  }
  const dbs = findSnowlumaDbs(explicit)
  if (!dbs.length) {
    throw new Error(
      '没找到 SnowLuma 的 messages.db。请在 config 里给 sourcePath（指向 messages.db 或 SnowLuma 根目录），' +
        '或设置环境变量 QQ_ARCHIVE_SOURCE。',
    )
  }
  return { kind: 'snowluma', path: dbs[0].path, uin: dbs[0].uin, candidates: dbs }
}
