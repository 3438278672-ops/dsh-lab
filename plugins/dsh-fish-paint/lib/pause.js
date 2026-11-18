// dsh-fish-paint · 画画暂停开关
//
// 用户在悬浮球上按「暂停」，语义是「别再接新的点图」：已经在出图的那张照常画完
// （想停就在同一面板按「中止」）。状态落在 data/state/paint-paused.json，插件重载、
// DSH 重启都不会丢；全局一个开关，不分主会话/QQ 群（用户 2026-11-18 拍板）。
import fs from 'node:fs'
import path from 'node:path'

export function createPauseStore(file) {
  function read() {
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      // 文件不存在 / 坏了都当「没暂停」：暂停是安全阀，不该因为坏 JSON 把画画彻底卡死。
    }
    return {
      paused: raw?.paused === true,
      updatedAt: Number(raw?.updatedAt) || 0,
      updatedBy: typeof raw?.updatedBy === 'string' ? raw.updatedBy : '',
    }
  }

  function write(paused, by = '面板') {
    const value = {
      paused: paused === true,
      updatedAt: Date.now(),
      updatedBy: String(by || '面板').slice(0, 40),
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      fs.renameSync(tmp, file)
    } catch (error) {
      console.warn(`[fish-paint] 暂停状态写不进去（${file}）：${error.message}`)
    }
    return value
  }

  return {
    file,
    read,
    isPaused: () => read().paused,
    write,
    toggle: (on, by) => write(on, by),
  }
}
