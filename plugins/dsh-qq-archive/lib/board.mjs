/**
 * 看板构建器。
 *
 * 「什么时候该重建」由数据决定，不由时钟决定：每次打开页面先算一遍库指纹
 * （~3 ms），指纹和上一份 HTML 对得上就直接发旧文件，变了才在后台重建。
 *
 * 重建本身是增量的：没变的会话、没变的人从快照里原样搬过来，只算新消息。
 * 同一时间只允许一个构建在跑（单飞）；构建失败时旧 HTML 原封不动。
 */
import { existsSync } from 'node:fs'
import { exportDashboard } from './dashboard.mjs'
import { dbFingerprint, htmlPath, loadSnapshot, saveSnapshot } from './snapshot.mjs'

const WARM_DEBOUNCE_MS = 1500

/**
 * @param {object} opts
 * @param {string} opts.home 数据家目录（dashboard.html 与 dashboard.cache.json 都在这里）
 * @param {() => import('node:sqlite').DatabaseSync} opts.getDb 取数据库连接（插件持有，懒开）
 * @param {(msg: string) => void} [opts.log]
 */
export function createBoard({ home, getDb, log = () => {} } = {}) {
  if (!home) throw new Error('createBoard 需要 home')
  if (typeof getDb !== 'function') throw new Error('createBoard 需要 getDb')

  let snapshot = null
  let loaded = false
  let running = null
  let warmTimer = null
  let last = null

  function ensureLoaded() {
    if (loaded) return
    loaded = true
    snapshot = loadSnapshot(home)
    if (snapshot) log(`看板快照已加载（构建于 ${new Date(snapshot.builtAt || 0).toLocaleString('zh-CN')}）`)
    else log('没有可用的看板快照，下次构建走全量')
  }

  function htmlExists() {
    return existsSync(htmlPath(home))
  }

  /** 指纹对得上、HTML 也在 → 不用重建。 */
  function isFresh() {
    ensureLoaded()
    if (!snapshot || !htmlExists()) return false
    return snapshot.fp === dbFingerprint(getDb())
  }

  function build({ force = false, outPath, title } = {}) {
    if (running) return running
    ensureLoaded()
    running = (async () => {
      const started = Date.now()
      const db = getDb()
      if (!force && snapshot && htmlExists() && snapshot.fp === dbFingerprint(db)) {
        return { skipped: true, path: htmlPath(home), builtAt: snapshot.builtAt, ms: Date.now() - started }
      }
      const res = exportDashboard(db, { home, outPath, title, snapshot })
      if (res.snapshot) {
        snapshot = res.snapshot
        saveSnapshot(home, snapshot)
        last = res
        log(
          `看板已更新：${res.chats} 个会话 / ${Math.round(res.bytes / 1024)} KB / ${res.stats.ms} ms` +
            `（重算 ${res.stats.rebuiltChats} 群 ${res.stats.rebuiltProfiles} 人，复用 ${res.stats.reusedChats} 群 ${res.stats.reusedProfiles} 人）` +
            (res.publish === 'inplace' ? '｜目标文件被占用，已原地覆盖' : ''),
        )
      } else {
        log(`看板已另存：${res.path}（${res.stats.ms} ms，不进缓存）`)
      }
      return { ...res, skipped: false }
    })().finally(() => {
      running = null
    })
    return running
  }

  /** 后台补一次；不 await、不抛错。返回是否真的触发了。 */
  function ensureFresh() {
    if (isFresh()) return false
    build().catch((err) => log(`看板重建失败（继续用旧文件）：${err?.message || err}`))
    return true
  }

  /** 写库之后预热：防抖合并连续写入，别每次同步都重建一遍。 */
  function prewarm({ delayMs = WARM_DEBOUNCE_MS } = {}) {
    if (warmTimer) clearTimeout(warmTimer)
    warmTimer = setTimeout(() => {
      warmTimer = null
      build().catch((err) => log(`看板预热失败：${err?.message || err}`))
    }, delayMs)
    warmTimer.unref?.()
  }

  /** 库被删掉重建 / 快照不能再信了。 */
  function invalidate() {
    ensureLoaded()
    snapshot = null
    last = null
  }

  function status() {
    ensureLoaded()
    let fresh = null
    try {
      fresh = isFresh()
    } catch {
      fresh = null
    }
    return {
      html: htmlExists(),
      snapshot: Boolean(snapshot),
      builtAt: snapshot?.builtAt || 0,
      fresh,
      building: Boolean(running),
      last: last ? { path: last.path, bytes: last.bytes, ms: last.stats?.ms ?? null } : null,
    }
  }

  return { isFresh, build, ensureFresh, prewarm, invalidate, status }
}
