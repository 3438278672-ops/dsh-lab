// 孵化完成反馈的 Host 半边。
//
// 两件事：
//   1. 把「开工」开出的对话与灵感条目绑起来（idea.session_id）。
//      - 网页在开工前先 POST /idea-log/api/starting，这里记一个几秒的时间窗；
//        Host 收到 session/created 就把窗口里的那条灵感绑上去。
//      - 用户真把任务发出去后，首条 user/message 里带着「【灵感账本 #N ·」标记，
//        这个标记是权威的：即使时间窗绑错了，也以它为准改绑。
//   2. 盯住绑过的对话：agent 跑完一轮变空闲（api-session/status false），
//      就把条目置成「等确认」（awaiting_done=1），网页据此显示「对话已结束 · 标为已做？」。
//
// 只写 DB，不碰页面状态；页面通过 /api/list、/api/awaiting 读。
import {
  bindIdeaSession,
  clearIdeaSession,
  ideaBySession,
  listIdeas,
  markTurnDone,
  openIdeas,
} from './db.mjs'

/** 「【灵感账本 #15 · 改进点】」里的 15 */
export const MARKER_RE = /【灵感账本\s*#(\d+)\s*·/

export function parseIdeaMarker(text) {
  const m = String(text || '').match(MARKER_RE)
  return m ? Number(m[1]) : null
}

/** 从 session/event 里取用户手打的消息文本；runtime-context / developer 之类不算 */
export function userMessageText(event) {
  if (!event || event.type !== 'user/message') return ''
  const d = event.data || {}
  const src = d.source && d.source.kind
  if (src && src !== 'user') return ''
  if (!Array.isArray(d.content)) return ''
  return d.content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
}

/**
 * 挂上两个 Host 事件监听，返回 { startPending, dispose }。
 * @param {object} ctx DSH 插件上下文
 * @param {{home: string, log?: (m: string) => void, createdWindowMs?: number}} opts
 */
export function createCompletionWatcher(ctx, { home, log = () => {}, createdWindowMs = 8000 } = {}) {
  const pending = new Map() // ideaId -> 时间戳：刚点了开工、还没看到新对话
  const bound = new Map() // sessionId(string) -> ideaId
  const running = new Set() // 见过 running=true 的 sessionId
  const responded = new Set() // 绑上之后已经出过 assistant/message 的 sessionId
  const markerCache = new Map() // sessionId(string) -> ideaId | null（从历史消息里认出来的标记）
  const disposers = []
  let disposed = false

  const withDb = (fn) => {
    const archive = openIdeas(home)
    try {
      return fn(archive.db)
    } finally {
      try {
        archive.db.close()
      } catch {}
    }
  }
  const agentsService = () => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 从会话已经发生过的事件里认「【灵感账本 #N ·」。
   * 用来补绑功能上线前就开着的对话：用户下一条消息进来时，
   * 历史里的首条任务书仍然能证明这条对话属于哪条灵感。
   * 只在第一次需要时扫一遍，结果（含没认出来）按 sessionId 缓存。
   */
  function markerFromHistory(sess, sid) {
    if (markerCache.has(sid)) return markerCache.get(sid)
    let found = null
    try {
      const events = typeof sess?.ownEvents === 'function' ? sess.ownEvents() : []
      for (const ev of events) {
        if (ev?.type !== 'user/message') continue
        const id = parseIdeaMarker(userMessageText(ev))
        if (id != null) {
          found = id
          break
        }
      }
    } catch (e) {
      log(`读会话历史失败：${e?.message || e}`)
    }
    markerCache.set(sid, found)
    return found
  }

  // 重启/热重载后接着盯：孵化中、记过 session_id 的条目重新入表。
  try {
    for (const it of withDb((db) => listIdeas(db, { status: 'incubating', limit: 500 }))) {
      if (it.sessionId) bound.set(String(it.sessionId), it.id)
    }
  } catch (e) {
    log(`恢复绑定失败：${e?.message || e}`)
  }

  function bind(ideaId, sessionId, source) {
    const sid = String(sessionId || '')
    const iid = Number(ideaId)
    if (!sid || !Number.isFinite(iid)) return false
    const cur = bound.get(sid)
    if (cur !== undefined && cur !== iid) return false
    const updated = withDb((db) => {
      const row = db.prepare('select * from ideas where id = ?').get(iid)
      if (!row || row.status !== 'incubating') return null
      // 已经绑了别的对话：只有对话里真发出来的标记能改绑，时间窗绑定不许抢。
      if (row.session_id && String(row.session_id) !== sid && source !== 'marker') return null
      return bindIdeaSession(db, iid, sid)
    })
    if (!updated) return false
    for (const [s, i] of [...bound]) if (i === iid && s !== sid) bound.delete(s)
    bound.set(sid, iid)
    pending.delete(iid)
    try {
      if (agentsService()?.get?.(sessionId)?.status === 'running') running.add(sid)
    } catch {}
    log(`绑定 #${iid} ↔ ${sid}（${source}）`)
    return true
  }

  // 对话里发出了「【灵感账本 #N ·」：以它为准（时间窗可能绑错，也可能没绑上）。
  function bindByMarker(ideaId, sessionId) {
    const sid = String(sessionId || '')
    const iid = Number(ideaId)
    if (!sid || !Number.isFinite(iid)) return false
    const cur = bound.get(sid)
    if (cur === iid) {
      pending.delete(iid)
      return true
    }
    const updated = withDb((db) => {
      const row = db.prepare('select * from ideas where id = ?').get(iid)
      if (!row || row.status !== 'incubating') return null
      if (cur !== undefined) clearIdeaSession(db, cur)
      // 标记是权威的：这条灵感之前绑在别的对话（时间窗绑错、或复制了同一份任务书）也让位
      if (row.session_id && String(row.session_id) !== sid) clearIdeaSession(db, iid)
      return bindIdeaSession(db, iid, sid)
    })
    if (!updated) return false
    if (cur !== undefined) bound.delete(sid)
    for (const [s, i] of [...bound]) if (i === iid && s !== sid) bound.delete(s)
    bound.set(sid, iid)
    pending.delete(iid)
    log(`按标记绑定 #${iid} ↔ ${sid}`)
    return true
  }

  const on = (name, listener) => {
    try {
      disposers.push(ctx.on(name, listener))
    } catch (e) {
      log(`监听 ${name} 失败：${e?.message || e}`)
    }
  }

  on('session/created', (session) => {
    if (disposed) return
    const sid = String(session?.id || '')
    if (!sid) return
    const now = Date.now()
    for (const [id, ts] of [...pending]) if (now - ts > 30000) pending.delete(id)
    let pick = null
    for (const [id, ts] of pending) if (now - ts <= createdWindowMs) pick = id
    if (pick != null && !bound.has(sid)) bind(pick, sid, 'created')
  })

  on('session/event', (session, event) => {
    if (disposed) return
    const sid = String(session?.id || '')
    if (!sid) return
    if (event?.type === 'assistant/message') {
      if (bound.has(sid)) responded.add(sid)
      return
    }
    if (event?.type !== 'user/message') return
    const text = userMessageText(event)
    if (!text) return
    const direct = parseIdeaMarker(text)
    // 新消息里没带标记时（旧对话，或用户改写了开头那条任务书），翻历史认；
    // 认出来就按它绑定 / 纠正时间窗的误绑——标记始终是权威。
    const ideaId = direct ?? markerFromHistory(session, sid)
    if (ideaId == null) return
    bindByMarker(ideaId, sid)
  })

  on('api-session/status', (sessionId, isRunning) => {
    if (disposed) return
    const sid = String(sessionId || '')
    if (!sid || !bound.has(sid)) return
    if (isRunning) {
      running.add(sid)
      return
    }
    const sawRun = running.delete(sid)
    const sawReply = responded.delete(sid)
    if (!sawRun && !sawReply) return
    const ideaId = bound.get(sid)
    const marked = withDb((db) => {
      const it = ideaBySession(db, sid)
      if (!it || it.id !== ideaId) return null
      return markTurnDone(db, ideaId, Date.now())
    })
    if (marked) log(`#${ideaId} 的对话跑完一轮，等确认`)
  })

  return {
    /** 网页点开工前调一下：接下来的新对话属于这条灵感 */
    startPending(ideaId) {
      const iid = Number(ideaId)
      if (!Number.isFinite(iid)) return
      const now = Date.now()
      for (const [id, ts] of [...pending]) if (now - ts > 30000) pending.delete(id)
      pending.set(iid, now)
    },
    dispose() {
      disposed = true
      for (const d of disposers.splice(0)) {
        try {
          if (typeof d === 'function') d()
        } catch {}
      }
      pending.clear()
      bound.clear()
      running.clear()
      responded.clear()
    },
  }
}
