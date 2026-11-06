/**
 * 会话/昵称解析：把 "group:343762857" 变成群名、把 QQ 号变成昵称。
 * 走 QQ 桥 config.json 里配的 SnowLuma OneBot HTTP；拿不到就返回空对象（只是锦上添花）。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const stripBom = (value) => (value.charCodeAt(0) === 0xfeff ? value.slice(1) : value)

export async function resolveNames({ bridgeDir, target, requester, timeoutMs = 8000 }) {
  const patch = {}
  try {
    const raw = await readFile(join(bridgeDir, 'config.json'), 'utf8')
    const cfg = JSON.parse(stripBom(raw))
    const base = String(cfg?.snowluma?.httpUrl ?? '').trim().replace(/\/+$/, '')
    if (!base) return patch
    const token = String(cfg?.snowluma?.accessToken ?? '').trim()
    const call = async (action, params) => {
      const res = await fetch(`${base}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const body = await res.json().catch(() => null)
      return body?.data ?? null
    }

    const [kind, id] = String(target ?? '').split(':')
    const bare = /^\d+$/.test(id ?? '') ? id : ''

    if (kind === 'group' && bare) {
      const info = await call('get_group_info', { group_id: Number(bare) })
      if (info?.group_name) patch.targetName = String(info.group_name)
    }
    if (requester && /^\d+$/.test(String(requester))) {
      const member =
        kind === 'group' && bare
          ? await call('get_group_member_info', { group_id: Number(bare), user_id: Number(requester) })
          : await call('get_stranger_info', { user_id: Number(requester) })
      const nickname = member?.card || member?.nickname
      if (nickname) patch.requesterName = String(nickname)
    }
  } catch {
    /* 名字丢了不影响点歌 */
  }
  return patch
}
