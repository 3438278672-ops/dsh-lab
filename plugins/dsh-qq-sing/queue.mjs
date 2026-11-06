/**
 * 点歌排单：忙的时候把请求排进 queue.json，后台空闲时由插件自己的小调度器按顺序起唱。
 * 一行一个待唱请求（song/target/requester），最老的排最前面。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 排单上限：再多就不接了（每人 CD + 这首也要唱几分钟，别让队列无限涨）。 */
export const QUEUE_LIMIT = 5

const stripBom = (value) => (value.charCodeAt(0) === 0xfeff ? value.slice(1) : value)

const queuePath = (home) => join(home, 'queue.json')

export async function readQueue(home) {
  try {
    const list = JSON.parse(stripBom(await readFile(queuePath(home), 'utf8')))
    return Array.isArray(list) ? list.filter((item) => item && item.song && item.target) : []
  } catch {
    return []
  }
}

export async function writeQueue(home, list) {
  await mkdir(home, { recursive: true }).catch(() => {})
  const file = queuePath(home)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
  await rename(tmp, file)
}

/** 排到队尾。返回 { ok, position, size }；满了就 ok:false。 */
export async function enqueue(home, entry, limit = QUEUE_LIMIT) {
  const list = await readQueue(home)
  if (list.length >= limit) return { ok: false, size: list.length }
  list.push({ ...entry, queuedAt: Date.now() })
  await writeQueue(home, list)
  return { ok: true, position: list.length, size: list.length }
}

/** 取队头（取走后从队列删除）。 */
export async function shiftQueue(home) {
  const list = await readQueue(home)
  const first = list.shift() ?? null
  if (first) await writeQueue(home, list)
  return first
}

/** 把一项插回队头（调度起唱失败时用——不能把人家点的歌弄丢）。 */
export async function unshiftQueue(home, entry) {
  const list = await readQueue(home)
  list.unshift({ ...entry, requeuedAt: Date.now() })
  await writeQueue(home, list)
  return { ok: true, size: list.length }
}

/** 清空排单（取消当前任务或人工干预时用）。 */
export async function clearQueue(home) {
  await writeQueue(home, [])
}
