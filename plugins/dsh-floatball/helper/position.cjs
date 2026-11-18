/**
 * 悬浮球摆位（纯函数，CommonJS）。
 *
 * 为什么单独拎出来：窗口位置最容易出「球不见了」的 bug——
 * 换分辨率、拔掉副屏、DPI 缩放变了，存下来的坐标就可能落在屏幕外，
 * 而球一旦跑到看不见的地方，用户也没法拖回来。
 *
 * 规则：
 *   1. 没有历史位置 → 主屏右下角（离右边 32、离底边 96，避开任务栏）；
 *   2. 历史位置落在某块屏幕上 → 夹进那块屏的工作区；
 *   3. 历史位置不在任何屏幕上（副屏拔了 / 分辨率变小了）→ 回主屏右下角。
 *
 * 坐标全部是 Electron 的 DIP（逻辑像素），不是物理像素。
 */
'use strict'

const COLLAPSED = { width: 96, height: 96 }
const EXPANDED = { width: 392, height: 572 }
const MARGIN_RIGHT = 32
const MARGIN_BOTTOM = 96
const FALLBACK_AREA = { x: 0, y: 0, width: 1920, height: 1080 }

function defaultPosition(workArea = FALLBACK_AREA, size = COLLAPSED) {
  return {
    x: Math.round(workArea.x + workArea.width - size.width - MARGIN_RIGHT),
    y: Math.round(workArea.y + workArea.height - size.height - MARGIN_BOTTOM),
  }
}

function clampPosition(point, workArea = FALLBACK_AREA, size = COLLAPSED, slack = 0) {
  const minX = workArea.x - slack
  const minY = workArea.y - slack
  const maxX = workArea.x + workArea.width - size.width + slack
  const maxY = workArea.y + workArea.height - size.height + slack
  return {
    x: Math.round(Math.min(Math.max(point.x, minX), maxX)),
    y: Math.round(Math.min(Math.max(point.y, minY), maxY)),
  }
}

/**
 * 这个点落在哪块屏上（按工作区算）。
 * gap 允许点稍微露在工作区外（球被拖到一半、或者窗口只露出小半截）仍算这块屏；
 * 完全不在任何屏附近时才返回 null。
 */
function displayForPoint(displays, point, gap = 0) {
  for (const display of displays ?? []) {
    const area = display?.workArea
    if (!area) continue
    const left = area.x - gap
    const top = area.y - gap
    const right = area.x + area.width + gap
    const bottom = area.y + area.height + gap
    if (point.x >= left && point.x < right && point.y >= top && point.y < bottom) {
      return display
    }
  }
  return null
}

/**
 * @param {{ saved?: {x:number,y:number}|null, displays?: Array<{workArea:{x:number,y:number,width:number,height:number}}>, size?: {width:number,height:number} }} input
 *   displays 的第一个当作主屏（Electron 的 getAllDisplays() 顺序不保证，调用方自己保证主屏在前）。
 */
function resolvePosition({ saved, displays, size = COLLAPSED } = {}) {
  const list = Array.isArray(displays) && displays.length ? displays : [{ workArea: FALLBACK_AREA }]
  const primary = list[0]
  const point =
    saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? { x: Number(saved.x), y: Number(saved.y) } : null
  if (!point) return defaultPosition(primary.workArea, size)
  // 球可能被拖到贴边、只露出小半截：允许一点点超出仍算那块屏，然后夹进可见区
  const host = displayForPoint(list, point, Math.max(size.width, size.height))
  if (!host) return defaultPosition(primary.workArea, size)
  return clampPosition(point, host.workArea, size)
}

module.exports = {
  COLLAPSED,
  EXPANDED,
  MARGIN_RIGHT,
  MARGIN_BOTTOM,
  defaultPosition,
  clampPosition,
  displayForPoint,
  resolvePosition,
}
