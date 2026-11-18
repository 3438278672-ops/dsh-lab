/** 面板里的文案拼装：纯函数，浏览器和 node 测试共用。 */

export function short(text, max = 24) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!value) return ''
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** 冷却剩余：给「还差 X」这种一眼能读的说法。 */
export function formatLeft(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return '可点'
  const minutes = Math.ceil(value / 60_000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `还差 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `还差 ${hours} 小时 ${rest} 分` : `还差 ${hours} 小时`
}

export function formatClock(ts) {
  const value = Number(ts)
  if (!Number.isFinite(value) || value <= 0) return ''
  const date = new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 在唱那一首的进度：文字 + 0..1 的比例。 */
export function jobProgress(active) {
  const sent = Number(active?.sent) || 0
  const total = Number(active?.total) || 0
  if (!total) return { text: sent ? `已发 ${sent} 段` : '准备中', ratio: 0 }
  return { text: `${sent}/${total} 段`, ratio: Math.max(0, Math.min(1, sent / total)) }
}

const KIND_LABEL = { sing: '唱歌', draw: '画画', voice: '语音' }

export function holderText(holder) {
  if (!holder) return '空闲'
  const kind = KIND_LABEL[holder.kind] || holder.kind || '任务'
  return `${kind}占着（${short(holder.label, 18) || '没写说明'}）`
}

export function workerText(worker) {
  if (!worker) return '未知'
  if (worker.running) {
    const model = (worker.modelKey || '').replace(/^.*[\\/]/, '') || 'SDXL'
    return `在跑 · ${model}${worker.ready === false ? '（还没热）' : ''}`
  }
  return worker.note ? `没起 · ${short(worker.note, 16)}` : '没起'
}

/** 排单列表：一眼看清「谁的什么歌、去哪个群」。 */
export function queueLines(queue, limit = 8) {
  const list = Array.isArray(queue) ? queue : []
  return list.slice(0, limit).map((item, index) => ({
    key: `${item.song || ''}|${item.queuedAt || index}`,
    index: index + 1,
    title: short(item.song || '（没写歌名）', 18),
    who: short(item.requesterName || item.requester || '谁', 12),
    where: short(item.targetName || item.target || '', 16),
  }))
}

/** 队列条：显卡正被谁占着，后面还有几个。 */
export function queueStrip(gpuState) {
  const holder = gpuState?.holder || null
  const queue = Array.isArray(gpuState?.queue) ? gpuState.queue : []
  return {
    holder: holder ? { kind: holder.kind || '', label: short(holder.label, 16), since: formatClock(holder.since) } : null,
    waiting: queue.length,
    waitingText: queue.length ? `后面排了 ${queue.length} 个` : '没人等',
  }
}
