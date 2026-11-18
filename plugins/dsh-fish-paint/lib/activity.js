// dsh-fish-paint · 正在画 / 排队中的请求
//
// 悬浮球面板要知道「现在有几张在画、卡在哪一步」。jobId 在 draw_image 入口生成
// （一张 draw_image 出多张变体也只算一个 job），中止时按它回报给面板。
export function createActivity({ now = Date.now } = {}) {
  const items = new Map()
  const listeners = new Set()
  let seq = 0

  function list() {
    return [...items.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((item) => ({ ...item }))
  }

  function emit() {
    const snapshot = list()
    for (const listener of listeners) {
      try {
        listener(snapshot)
      } catch {
        // 面板那边的监听坏了不该影响画画
      }
    }
  }

  function begin({ prompt = '', requester = '', rating = 'sfw', note = '' } = {}) {
    seq += 1
    const jobId = `draw-${now().toString(36)}-${seq}`
    items.set(jobId, {
      jobId,
      prompt: shorten(prompt, 120),
      requester: String(requester || ''),
      rating: rating === 'nsfw' ? 'nsfw' : 'sfw',
      note: String(note || '').slice(0, 80),
      phase: 'waiting',
      position: 0,
      startedAt: now(),
      updatedAt: now(),
    })
    emit()
    return jobId
  }

  function mark(jobId, patch = {}) {
    const item = items.get(jobId)
    if (!item) return null
    Object.assign(item, patch, { updatedAt: now() })
    emit()
    return { ...item }
  }

  function get(jobId) {
    const item = items.get(jobId)
    return item ? { ...item } : null
  }

  function end(jobId) {
    const had = items.delete(jobId)
    if (had) emit()
    return had
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return {
    begin,
    mark,
    get,
    end,
    list,
    subscribe,
    size: () => items.size,
    ids: () => [...items.keys()],
  }
}

function shorten(text, max = 120) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}
