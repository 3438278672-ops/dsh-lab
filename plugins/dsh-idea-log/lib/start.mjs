// 「开工」：一条灵感 → 新对话里的一段任务描述。
//
// 文案只在这里生成（Host 侧，可单测），网页半边只负责把 startPrompt 转交给
// DSH 的 uiWorkspace.startSession —— 所以页面、客户端、提炼都别自己拼一份。
//
// 协议（iframe ⇄ DSH 网页半边，同源 postMessage）：
//   页面 → 父窗口  { type: START.request, id, prompt }
//   父窗口 → 页面  { type: START.started, id }
//                  { type: START.failed, id, error }

export const START = {
  request: 'dsh-idea-log:start',
  started: 'dsh-idea-log:started',
  failed: 'dsh-idea-log:start-failed',
}

export const KIND_LABEL = { idea: '插件点子', pitfall: '踩坑', improve: '改进点' }

// 「开工」只对还没被认领的条目开放。孵化中 = 已经有一个对话在做它了，
// 再点只会开出一份重复的对话，所以这一个状态直接锁住开工按钮。
// 页面（lib/page.mjs）在渲染时把这份规则注入浏览器，状态机和按钮共用同一条。
export const START_BLOCKED_STATUSES = ['incubating']

export const START_BLOCKED_REASON = '已经在孵化中了——先把它改成「待看」或「搁置」，才能重新开工。'

/**
 * 这个状态下能不能开工；不能就给出给用户看的原因。
 * @param {string} status
 * @returns {string} 空字符串 = 可以开工
 */
export function startBlockedReason(status) {
  return START_BLOCKED_STATUSES.includes(status) ? START_BLOCKED_REASON : ''
}

// 点「开工」到底是去创造、去更新，还是去修坑
export const KIND_INTENT = {
  idea: '把这个点子做成插件',
  improve: '对相关插件或流程做这个改进',
  pitfall: '把这个坑修掉',
}

// 交给新对话的收尾要求：先对齐，再从机制上做
const CLOSING = {
  idea: '动手前先跟我确认范围与做法；确认后按机制实现，不做打补丁式的最小改动。',
  improve: '动手前先跟我确认范围与做法；确认后按机制实现，不做打补丁式的最小改动。',
  pitfall:
    '动手前先跟我确认复现步骤与根因；修就修根上——改机制/契约/不变量，不许单点特判、临时绕过，也不许只改表象。',
}

const TITLE_MAX = 200
const BODY_MAX = 2000

/**
 * 把一条灵感排成新对话的任务描述。
 * @param {{id?:number, kind?:string, title?:string, body?:string, tags?:string[]}} item
 * @returns {string}
 */
export function buildStartPrompt(item = {}) {
  const kind = KIND_LABEL[item.kind] ? item.kind : 'idea'
  const id = Number(item.id)
  const title = String(item.title || '').trim().slice(0, TITLE_MAX) || '（未命名）'
  const body = String(item.body || '').trim().slice(0, BODY_MAX)
  const tags = (Array.isArray(item.tags) ? item.tags : [])
    .filter((t) => typeof t === 'string' && t.trim())
    .map((t) => t.trim())
    .slice(0, 8)

  const lines = [`【灵感账本 #${Number.isFinite(id) && id > 0 ? id : '?'} · ${KIND_LABEL[kind]}】`, '', `标题：${title}`]
  if (body) lines.push(`正文：${body}`)
  if (tags.length) lines.push(`标签：${tags.join('、')}`)
  lines.push('', `我要做的事：${KIND_INTENT[kind]}。`, '', CLOSING[kind])
  return lines.join('\n')
}

/**
 * 开工后该落到哪个状态。已被开工锁住的状态返回 null（不写库，省一次 updated_at 抖动），
 * 其余（待看/已做/搁置/丢弃）一律认领为孵化中 —— 点开工就是「我现在要做它」。
 * 与 startBlockedReason 共用 START_BLOCKED_STATUSES，两边不会漂。
 * @returns {'incubating'|null}
 */
export function nextStatusAfterStart(status) {
  return startBlockedReason(status) ? null : 'incubating'
}
