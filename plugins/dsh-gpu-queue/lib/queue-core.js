/**
 * dsh-gpu-queue · 纯状态机
 *
 * 这里只做「谁在占卡 / 谁在排队 / 谁该被回收」，不碰 IO、不碰时钟：所有函数都要求传 now，
 * 进程存活判断由调用方注入（isPidAlive）。这样单测不用起服务、不用等真实时间。
 *
 * 语义（和设计文档 §6.3 对齐）：
 *   - 同一时刻最多一个 holder。
 *   - 排队顺序：voice 排在所有排队项之前；draw / sing 同优先级，按 seq FIFO。
 *   - holder 心跳超时（默认 60s）或进程死了 → 自动回收进 recent（how=stale / owner-dead）。
 *   - 排队项 90s 没有任何轮询、或进程死了 → 丢掉（how=dropped / owner-dead）。
 */

export const KINDS = ['draw', 'sing', 'voice']

/** 排队优先级：数字小的先上。voice 抢先但不抢占 holder。 */
export function priorityOf(entry) {
  return entry && entry.kind === 'voice' ? 0 : 1
}

export function createState() {
  return { version: 1, seq: 0, holder: null, queue: [], recent: [] }
}

function rand4() {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0')
}

function makeId(state, kind) {
  state.seq += 1
  return `${kind}-${state.seq}-${rand4()}`
}

function clipLabel(label, fallback) {
  const text = String(label ?? '').replace(/\s+/g, ' ').trim()
  return (text || fallback || 'task').slice(0, 80)
}

export function recentPush(state, entry) {
  state.recent.unshift(entry)
  if (state.recent.length > 20) state.recent.length = 20
}

/** 排队视图：voice 优先，其余按入队顺序。 */
export function order(state) {
  return [...state.queue].sort((a, b) => {
    const pa = priorityOf(a)
    const pb = priorityOf(b)
    if (pa !== pb) return pa - pb
    return a.seq - b.seq
  })
}

export function positionOf(state, id) {
  const list = order(state)
  const index = list.findIndex((item) => item.id === id)
  return index < 0 ? 0 : index + 1
}

/** 下一个该被发牌的排队项（不搬动队列）。 */
export function peek(state) {
  return order(state)[0] ?? null
}

export function enqueue(state, { kind, label, ownerPid, now }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown kind: ${kind}`)
  const entry = {
    id: makeId(state, kind),
    kind,
    label: clipLabel(label, kind),
    ownerPid: Number(ownerPid) || 0,
    seq: state.seq,
    enqueuedAt: now,
    lastPollAt: now,
  }
  state.queue.push(entry)
  return entry
}

/** 发牌：把排队项挪成 holder。已有 holder 时不发（返回 null）。 */
export function grant(state, id, now, extra = {}) {
  if (state.holder) return null
  const index = state.queue.findIndex((item) => item.id === id)
  if (index < 0) return null
  const [entry] = state.queue.splice(index, 1)
  state.holder = {
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    ownerPid: entry.ownerPid,
    seq: entry.seq,
    enqueuedAt: entry.enqueuedAt,
    grantedAt: now,
    heartbeatAt: now,
    yieldWarning: extra.yieldWarning ? String(extra.yieldWarning).slice(0, 200) : null,
  }
  return state.holder
}

export function heartbeat(state, id, now) {
  if (!state.holder || state.holder.id !== id) return false
  state.holder.heartbeatAt = now
  return true
}

export function markPoll(state, id, now) {
  const entry = state.queue.find((item) => item.id === id)
  if (!entry) return false
  entry.lastPollAt = now
  return true
}

/** 释放 holder（正常结束 / 主动放弃）。 */
export function release(state, id, now, how = 'released') {
  if (!state.holder || state.holder.id !== id) return false
  const holder = state.holder
  state.holder = null
  recentPush(state, {
    id: holder.id,
    kind: holder.kind,
    label: holder.label,
    ownerPid: holder.ownerPid,
    enqueuedAt: holder.enqueuedAt ?? holder.grantedAt,
    grantedAt: holder.grantedAt,
    endedAt: now,
    how,
  })
  return true
}

/** 撤销排队项（holder 不能用这个撤，得由业务端中止）。 */
export function cancel(state, id, now) {
  const index = state.queue.findIndex((item) => item.id === id)
  if (index < 0) return false
  const [entry] = state.queue.splice(index, 1)
  recentPush(state, {
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    ownerPid: entry.ownerPid,
    enqueuedAt: entry.enqueuedAt,
    grantedAt: null,
    endedAt: now,
    how: 'cancelled',
  })
  return true
}

function dropEntry(state, index, now, how) {
  const [entry] = state.queue.splice(index, 1)
  recentPush(state, {
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    ownerPid: entry.ownerPid,
    enqueuedAt: entry.enqueuedAt,
    grantedAt: null,
    endedAt: now,
    how,
  })
  return entry
}

/**
 * 回收：holder 心跳超时/进程死、排队项没人轮询/进程死。
 * 返回 { holderReleased, dropped }，调用方负责落盘与推 pump。
 */
export function reap(state, { now, isPidAlive = () => true, holderTtlMs = 60000, queueIdleDropMs = 90000 } = {}) {
  const out = { holderReleased: null, dropped: [] }

  if (state.holder) {
    const holder = state.holder
    const alive = holder.ownerPid ? Boolean(isPidAlive(holder.ownerPid)) : true
    if (!alive) {
      release(state, holder.id, now, 'owner-dead')
      out.holderReleased = { id: holder.id, how: 'owner-dead' }
    } else if (now - Number(holder.heartbeatAt || holder.grantedAt || 0) > holderTtlMs) {
      release(state, holder.id, now, 'stale')
      out.holderReleased = { id: holder.id, how: 'stale' }
    }
  }

  for (let i = state.queue.length - 1; i >= 0; i -= 1) {
    const entry = state.queue[i]
    const alive = entry.ownerPid ? Boolean(isPidAlive(entry.ownerPid)) : true
    if (!alive) {
      out.dropped.push(dropEntry(state, i, now, 'owner-dead').id)
      continue
    }
    if (now - Number(entry.lastPollAt || entry.enqueuedAt || 0) > queueIdleDropMs) {
      out.dropped.push(dropEntry(state, i, now, 'dropped').id)
    }
  }

  return out
}

/** 客户端轮询拿到的东西。 */
export function ticketOf(state, id) {
  if (state.holder && state.holder.id === id) {
    return { id, state: 'granted', position: 0, holder: publicHolder(state.holder) }
  }
  const entry = state.queue.find((item) => item.id === id)
  if (entry) {
    return { id, state: 'queued', position: positionOf(state, id), ahead: aheadOf(state, id), kind: entry.kind, label: entry.label }
  }
  const done = state.recent.find((item) => item.id === id)
  if (done) {
    return { id, state: done.how === 'cancelled' ? 'cancelled' : 'lost', how: done.how, endedAt: done.endedAt }
  }
  return { id, state: 'unknown' }
}

export function aheadOf(state, id) {
  const list = order(state)
  const index = list.findIndex((item) => item.id === id)
  if (index <= 0) return []
  return list.slice(0, index).map((item) => ({ kind: item.kind, label: item.label }))
}

export function publicHolder(holder) {
  if (!holder) return null
  return {
    id: holder.id,
    kind: holder.kind,
    label: holder.label,
    ownerPid: holder.ownerPid,
    grantedAt: holder.grantedAt,
    heartbeatAt: holder.heartbeatAt,
    yieldWarning: holder.yieldWarning ?? null,
  }
}

export function snapshot(state) {
  return {
    version: state.version,
    holder: publicHolder(state.holder),
    queue: order(state).map((item, index) => ({
      id: item.id,
      kind: item.kind,
      label: item.label,
      ownerPid: item.ownerPid,
      position: index + 1,
      enqueuedAt: item.enqueuedAt,
    })),
    recent: state.recent.map((item) => ({ ...item })),
  }
}

/**
 * 热重载/重启后恢复：进程还活着的排队项和 holder 都退回队列（按原 seq 排队），
 * 死掉的直接丢进 recent。返回恢复了几个。
 */
export function restore(state, { now, isPidAlive = () => true } = {}) {
  const restored = []
  if (state.holder) {
    const holder = state.holder
    state.holder = null
    if (holder.ownerPid && isPidAlive(holder.ownerPid)) {
      state.queue.push({
        id: holder.id,
        kind: holder.kind,
        label: holder.label,
        ownerPid: holder.ownerPid,
        seq: holder.seq,
        enqueuedAt: holder.enqueuedAt ?? holder.grantedAt,
        lastPollAt: now,
      })
      restored.push(holder.id)
    } else {
      recentPush(state, {
        id: holder.id,
        kind: holder.kind,
        label: holder.label,
        ownerPid: holder.ownerPid,
        enqueuedAt: holder.enqueuedAt ?? holder.grantedAt,
        grantedAt: holder.grantedAt,
        endedAt: now,
        how: 'owner-dead',
      })
    }
  }
  for (let i = state.queue.length - 1; i >= 0; i -= 1) {
    const entry = state.queue[i]
    if (entry.ownerPid && !isPidAlive(entry.ownerPid)) {
      dropEntry(state, i, now, 'owner-dead')
      continue
    }
    entry.lastPollAt = now
  }
  const seqs = [
    Number(state.seq) || 0,
    ...state.queue.map((item) => Number(item.seq) || 0),
    ...state.recent.map((item) => Number(item.seq) || 0),
  ].filter((n) => Number.isFinite(n))
  state.seq = Math.max(...seqs, 0)
  return restored
}
