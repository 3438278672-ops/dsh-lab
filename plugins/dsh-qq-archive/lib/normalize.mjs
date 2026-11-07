/**
 * OneBot v11 事件 → 统一消息记录。
 *
 * SnowLuma 的 messages.db、标准 OneBot 的 /get_group_msg_history、JSON 导入
 * 都走这一条规范化路径，核心层不认任何一家实现。
 */

function segLabel(seg) {
  const d = seg.data || {}
  switch (seg.type) {
    case 'text':
      return String(d.text ?? '')
    case 'at':
      return d.qq === 'all' ? '@全体成员' : `@${d.qq}`
    case 'image':
      return d.summary && d.summary !== '[图片]' ? `[图片:${d.summary}]` : '[图片]'
    case 'face':
    case 'mface':
      return '[表情]'
    case 'record':
      return '[语音]'
    case 'video':
      return '[视频]'
    case 'file':
      return `[文件:${d.name || d.file || ''}]`
    case 'forward':
      return '[合并转发]'
    case 'json':
      return '[卡片]'
    case 'markdown':
      return d.content ? `[Markdown]${d.content}` : '[Markdown]'
    case 'inline_keyboard':
      return '[按钮]'
    case 'reply':
      return ''
    default:
      return ''
  }
}

function pickKind(message) {
  const types = new Set(message.map((s) => s.type))
  if (types.has('record')) return 'voice'
  if (types.has('forward')) return 'forward'
  if (types.has('video')) return 'video'
  if (types.has('file')) return 'file'
  if (types.has('image') || types.has('mface')) return 'image'
  if (types.has('json') || types.has('markdown')) return 'card'
  return 'text'
}

function extractMedia(message, mediaDataJson) {
  const out = []
  let idx = 0
  for (const seg of message) {
    if (!['image', 'record', 'video', 'file'].includes(seg.type)) continue
    const d = seg.data || {}
    out.push({
      kind: seg.type === 'record' ? 'voice' : seg.type,
      file: d.file || d.name || '',
      url: d.url || d.path || '',
      size: Number(d.file_size || d.fileSize || 0) || null,
      width: Number(d.width || 0) || null,
      height: Number(d.height || 0) || null,
      summary: d.summary || '',
      index: idx++,
    })
  }
  if (mediaDataJson) {
    try {
      const arr = JSON.parse(mediaDataJson)
      if (Array.isArray(arr)) {
        const byFile = new Map()
        for (const m of arr) {
          const key = String(m.fileName || m.file || '').toLowerCase()
          if (key) byFile.set(key, m)
        }
        for (const m of out) {
          const hit = byFile.get(String(m.file || '').toLowerCase())
          if (!hit) continue
          if (!m.file && hit.fileName) m.file = hit.fileName
          if (!m.size && hit.fileSize) m.size = Number(hit.fileSize) || null
          if (!m.width && hit.width) m.width = Number(hit.width) || null
          if (!m.height && hit.height) m.height = Number(hit.height) || null
          m.md5 = hit.md5Hex || null
          m.sha1 = hit.sha1Hex || null
          if (!m.url && hit.url) m.url = hit.url
        }
      }
    } catch {
      /* media_data 坏了就只用 message 段里的信息 */
    }
  }
  return out
}

/**
 * @param {object} input
 * @param {string} input.source        'snowluma' | 'onebot' | 'json'
 * @param {string} input.sourceKey     去重键（SnowLuma = message_hash）
 * @param {object} input.data          原始 OneBot 事件
 * @param {string=} input.mediaData    SnowLuma 的 media_data 列（可选，补尺寸/md5）
 * @returns {{message: object, media: object[]} | null}
 */
export function normalizeOneBot({ source, sourceKey, data, mediaData }) {
  if (!data || typeof data !== 'object') return null
  const message = Array.isArray(data.message) ? data.message : []
  const chatType = data.message_type === 'group' || data.group_id ? 'group' : 'private'
  const chatId = String(chatType === 'group' ? data.group_id : data.user_id ?? '')
  if (!chatId) return null
  const sender = data.sender || {}
  const senderId = String(sender.user_id ?? data.user_id ?? '')
  const senderName = String(sender.card || sender.nickname || senderId || '')
  if (!senderId) return null

  let replyTo = null
  for (const seg of message) {
    if (seg.type === 'reply') {
      replyTo = String(seg.data?.id ?? '').replace(/^"|"$/g, '') || null
      break
    }
  }

  const text = message.map(segLabel).join('').trim()
  const kind = pickKind(message)
  const ts = Number(data.time) || 0
  const chatName = chatType === 'group' ? String(data.group_name || '') : senderName

  return {
    message: {
      source,
      sourceKey: String(sourceKey),
      chatKey: `${chatType}:${chatId}`,
      chatType,
      chatId,
      chatName,
      senderId,
      senderName,
      ts,
      kind,
      text,
      replyTo,
      raw: JSON.stringify(data),
    },
    media: extractMedia(message, mediaData),
  }
}
