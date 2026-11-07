import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeOneBot } from '../lib/normalize.mjs'

const base = {
  time: 1760000000,
  self_id: 999,
  post_type: 'message',
  message_type: 'group',
  group_id: 123,
  group_name: '测试群',
  user_id: 111,
  message_id: 555,
  sender: { user_id: 111, nickname: '阿猫' },
}

function ev(message, extra = {}) {
  return { ...base, message, raw_message: message.map((s) => s.data?.text || '').join(''), ...extra }
}

test('文字 + @ + 图片：text 里保留可读占位，at 提取到 mentions', () => {
  const { message } = normalizeOneBot({
    source: 'json',
    sourceKey: 'k1',
    data: ev([
      { type: 'text', data: { text: '你看这个 ' } },
      { type: 'at', data: { qq: '222' } },
      { type: 'image', data: { file: 'a.jpg', url: 'https://example.com/a.jpg' } },
    ]),
  })
  assert.equal(message.chatKey, 'group:123')
  assert.equal(message.chatType, 'group')
  assert.equal(message.senderId, '111')
  assert.equal(message.senderName, '阿猫')
  assert.ok(message.text.includes('你看这个'))
  assert.ok(message.text.includes('@222'))
  assert.ok(message.text.includes('[图片'))
  assert.equal(message.kind, 'image')
})

test('record 段识别成 voice，而不是 text', () => {
  const { message, media } = normalizeOneBot({
    source: 'json',
    sourceKey: 'k2',
    data: ev([
      { type: 'record', data: { file: 'v.amr', url: 'https://example.com/v.amr' } },
    ]),
  })
  assert.equal(message.kind, 'voice')
  assert.equal(media[0].kind, 'voice')
  assert.equal(media[0].file, 'v.amr')
})

test('reply 段提取被回复的消息 id', () => {
  const { message } = normalizeOneBot({
    source: 'json',
    sourceKey: 'k3',
    data: ev([
      { type: 'reply', data: { id: '123456' } },
      { type: 'text', data: { text: '同意' } },
    ]),
  })
  assert.equal(message.replyTo, '123456')
  assert.equal(message.text, '同意')
})

test('mediaData 按文件名补尺寸和 md5', () => {
  const { media } = normalizeOneBot({
    source: 'json',
    sourceKey: 'k4',
    data: ev([{ type: 'image', data: { file: 'b.jpg' } }]),
    mediaData: JSON.stringify([{ fileName: 'B.JPG', fileSize: 2048, width: 100, height: 50, md5Hex: 'abc' }]),
  })
  assert.equal(media.length, 1)
  assert.equal(media[0].size, 2048)
  assert.equal(media[0].width, 100)
  assert.equal(media[0].height, 50)
  assert.equal(media[0].md5, 'abc')
})

test('私聊会话 key 用 private:<对方QQ>', () => {
  const { message } = normalizeOneBot({
    source: 'json',
    sourceKey: 'k5',
    data: {
      ...base,
      message_type: 'private',
      group_id: undefined,
      group_name: undefined,
      sender: { user_id: 222, nickname: '朋友' },
      user_id: 222,
      message: [{ type: 'text', data: { text: '在吗' } }],
    },
  })
  assert.equal(message.chatKey, 'private:222')
  assert.equal(message.chatType, 'private')
})
