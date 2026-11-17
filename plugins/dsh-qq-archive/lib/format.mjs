/**
 * 工具输出共用的格式化 / 解析 helper。
 *
 * 从 index.js 下沉：工具模块直接 import 这些纯函数，不再依赖 apply 闭包。
 * 只放「怎么把数据变成人话」，不放业务查询。
 */
import { stamp, truncate } from './util.mjs'

export const MODE_LABEL = { chars: '精确', fts: '分词', 'fts-or': '相关', like: '模糊', scan: '扫描', semantic: '语义', none: '无' }

export const KIND_LABEL = {
  text: '文字',
  image: '图片',
  voice: '语音',
  video: '视频',
  forward: '合并转发',
  file: '文件',
  card: '卡片',
}

export function fmtTime(ts) {
  return Number.isFinite(ts) && ts > 0 ? stamp(ts * 1000) : '时间未知'
}

export function fmtChat(hit, names) {
  const key = hit.chatKey || ''
  const [type, id] = key.split(':')
  const name = names.get(key) || ''
  if (type === 'group') return name ? `群「${name}」` : `群 ${id}`
  return name ? `私聊「${name}」` : `私聊 ${id}`
}

export function fmtLine(hit, names) {
  const who = hit.senderName || hit.senderId
  return `${fmtTime(hit.ts)} · ${fmtChat(hit, names)} · ${who}：${truncate(hit.text || `[${KIND_LABEL[hit.kind] || hit.kind}]`, 300)}`
}

export function resolveChatKey(db, raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  if (/^(group|private):\d+$/.test(s)) return s
  if (/^\d{4,12}$/.test(s)) {
    // 群号和 QQ 号长得一样，先按库里真实存在的形态来，别默认成群
    for (const key of ['group:' + s, 'private:' + s]) {
      if (db.prepare('select 1 from chats where chat_key = ?').get(key)) return key
    }
    return 'group:' + s
  }
  const row = db.prepare('select chat_key from chats where name like ? order by msg_count desc limit 1').get('%' + s + '%')
  return row ? row.chat_key : null
}

export function resolveSender(raw) {
  const s = String(raw || '').trim()
  if (!s) return {}
  if (/^\d{4,12}$/.test(s)) return { senderId: s }
  return { senderName: s }
}

export function chatNameMap(db) {
  const map = new Map()
  for (const row of db.prepare('select chat_key, name from chats').all()) {
    map.set(row.chat_key, row.name || '')
  }
  return map
}

export function fmtImpression(imp) {
  if (!imp?.impression) return ''
  const tags = imp.tags?.length ? `\n标签：${imp.tags.join(' / ')}` : ''
  const meta = `${fmtTime(imp.at)}${imp.model ? ` · ${imp.model}` : ''}`
  return `\n\n【人物印象】（${meta}）\n${imp.impression}${tags}`
}
