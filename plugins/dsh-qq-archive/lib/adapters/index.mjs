/**
 * 数据源适配器入口。
 */
import { resolveSource } from '../config.mjs'
import { openSnowluma } from './snowluma.mjs'
import { openOneBot } from './onebot.mjs'

export function openSource(cfg) {
  const resolved = resolveSource(cfg)
  if (resolved.kind === 'snowluma') {
    return { ...resolved, adapter: openSnowluma(resolved.path) }
  }
  if (resolved.kind === 'onebot') {
    return { ...resolved, adapter: openOneBot(resolved) }
  }
  if (resolved.kind === 'json') {
    throw new Error('JSON 导入还没接（M5）')
  }
  throw new Error(`未知数据源：${resolved.kind}`)
}
