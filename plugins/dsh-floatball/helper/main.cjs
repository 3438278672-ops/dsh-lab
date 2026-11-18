/**
 * 悬浮球窗口（Electron 主进程，CommonJS）。
 *
 * 用自己那份 Electron 运行时跑，不依赖 dsh-orb：
 *   - 收起态 96×96 透明小窗，只画一颗球；鼠标移开时整窗穿透，不挡桌面点击；
 *   - 展开态 392×572，球还在原位（左上角），面板往右下长，不会「跳一下」；
 *   - 位置存在 state/window.json，下次开在同一个地方；
 *   - 父进程（DSH）没了就自己退，避免留个孤儿球。
 *
 * 为什么是 .cjs：Electron 的 `electron` 模块是 CJS，ESM 下 named import 拿不到
 * （会报 does not provide an export named 'BrowserWindow'），这里用 require 最稳。
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const { mkdir, readFile, writeFile } = require('node:fs/promises')
const { dirname, join } = require('node:path')
const { COLLAPSED, EXPANDED, resolvePosition } = require('./position.cjs')

const HERE = __dirname

/** 位置被纠正时留一句日志（会经 supervisor 进 ball.log），方便以后查「球怎么跑到别处」 */
function notePositionChange(from, to) {
  const before = from ? `${from.x},${from.y}` : '无'
  console.log(`[floatball] 窗口位置：${before} → ${to.x},${to.y}`)
}

const ENV = process.env
const STATE_PATH = ENV.BALL_STATE_PATH || join(app.getPath('userData'), 'window.json')
const HOST_PID = Number(ENV.BALL_HOST_PID) || 0

app.setName('dsh-floatball')
// 裸 electron.exe 的默认 userData 是 %APPDATA%\Electron，会和别的 Electron 抢单实例锁
app.setPath('userData', ENV.BALL_USER_DATA || join(HERE, '..', 'data', 'electron'))
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

let win = null
let expanded = false
let ignored = null
let position = { x: 0, y: 0 }
let drag = null

/** 主屏排最前，其余照 Electron 给的顺序 */
function allDisplays() {
  const primary = screen.getPrimaryDisplay()
  return [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)]
}

async function loadPosition() {
  let saved = null
  try {
    const raw = JSON.parse(await readFile(STATE_PATH, 'utf8'))
    if (Number.isFinite(raw?.x) && Number.isFinite(raw?.y)) saved = { x: raw.x, y: raw.y }
  } catch {
    /* 首次启动没有这个文件 */
  }
  // 存的坐标可能落在副屏、或者超出所有屏（换分辨率/缩放过），解析器会收回可见区
  const displays = allDisplays().map((d) => ({ id: d.id, workArea: d.workArea }))
  const position = resolvePosition({ saved, displays, size: COLLAPSED })
  if (!saved || saved.x !== position.x || saved.y !== position.y) notePositionChange(saved, position)
  return position
}

/**
 * 把位置夹进「离这个点最近的那块屏」的工作区。
 * 拖动时点是光标位置——所以光标挪到副屏，球就跟到副屏。
 */
function clampToPoint(point, size) {
  const display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) })
  const area = display.workArea
  const x = Math.min(Math.max(point.x, area.x), area.x + area.width - size.width)
  const y = Math.min(Math.max(point.y, area.y), area.y + area.height - size.height)
  return { x: Math.round(x), y: Math.round(y) }
}

/** 窗口中心是否落在某块屏的工作区里 */
function isOnSomeDisplay(bounds) {
  const cx = bounds.x + bounds.width / 2
  const cy = bounds.y + bounds.height / 2
  return allDisplays().some(({ workArea: a }) => cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height)
}

async function savePosition() {
  await mkdir(dirname(STATE_PATH), { recursive: true }).catch(() => {})
  await writeFile(STATE_PATH, JSON.stringify({ ...position, savedAt: Date.now() }, null, 2), 'utf8').catch(() => {})
}

function applyBounds({ expanded: wantExpanded }) {
  if (!win || win.isDestroyed()) return
  const size = wantExpanded ? EXPANDED : COLLAPSED
  // 展开面板时以球的位置为基准夹，避免面板长出屏幕
  position = clampToPoint({ x: position.x, y: position.y }, size)
  win.setBounds({ x: position.x, y: position.y, width: size.width, height: size.height })
}

function setIgnore(ignore) {
  if (!win || win.isDestroyed()) return
  if (ignored === ignore) return
  ignored = ignore
  // forward:true 让 mousemove 仍然进窗口（万一有人依赖 hover）
  win.setIgnoreMouseEvents(ignore, { forward: true })
}

/**
 * 「指到球就给交互、离开就穿透」由主进程自己按光标位置判断，不信渲染进程的
 * pointerenter/pointerleave——窗口被挪走、被拖出屏幕边缘时那对事件经常不再成对出现，
 * 一旦卡在「ignore」状态，球就变成点不动的死物（实测点下去一点反应都没有）。
 */
function watchHover() {
  const timer = setInterval(() => {
    if (!win || win.isDestroyed()) return
    if (expanded || drag) {
      setIgnore(false)
      return
    }
    const cursor = screen.getCursorScreenPoint()
    const [x, y] = win.getPosition()
    const inside =
      cursor.x >= x && cursor.x < x + COLLAPSED.width && cursor.y >= y && cursor.y < y + COLLAPSED.height
    setIgnore(!inside)
  }, 120)
  timer.unref?.()
  return timer
}

async function createWindow() {
  position = await loadPosition()
  win = new BrowserWindow({
    ...COLLAPSED,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  if (typeof win.setVisibleOnAllWorkspaces === 'function') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  setIgnore(true)
  watchHover()
  win.once('ready-to-show', () => {
    win.showInactive()
  })
  win.on('closed', () => {
    win = null
  })
  win.on('moved', () => {
    if (!win || win.isDestroyed()) return
    const [x, y] = win.getPosition()
    if (isOnSomeDisplay({ x, y, width: expanded ? EXPANDED.width : COLLAPSED.width, height: expanded ? EXPANDED.height : COLLAPSED.height })) {
      position = { x, y }
      return
    }
    // 落到任何屏幕之外（混合 DPI 下确实会发生）：按最近屏夹回来
    const snapped = clampToPoint({ x, y }, expanded ? EXPANDED : COLLAPSED)
    position = snapped
    win.setPosition(snapped.x, snapped.y)
    notePositionChange({ x, y }, snapped)
  })
  await win.loadFile(join(HERE, 'index.html'))
  // 首次启动就把位置落盘，别等用户拖过一次才有 window.json
  savePosition().catch(() => {})
  // 再兜一层：窗口稳定后确认它真的在屏幕上（不在就摆回主屏右下角）
  setTimeout(() => {
    if (!win || win.isDestroyed()) return
    const [x, y] = win.getPosition()
    if (isOnSomeDisplay({ x, y, width: COLLAPSED.width, height: COLLAPSED.height })) return
    position = resolvePosition({ saved: null, displays: allDisplays().map((d) => ({ id: d.id, workArea: d.workArea })) })
    win.setPosition(position.x, position.y)
    savePosition().catch(() => {})
    notePositionChange({ x, y }, position)
  }, 1500)
}

ipcMain.on('ball:expand', (_event, want) => {
  expanded = Boolean(want)
  // 展开时一定要能点；收起后交给 watchHover 按光标位置接管
  if (expanded) setIgnore(false)
  applyBounds({ expanded })
})

// 渲染进程不再管穿透：watchHover 按光标位置自己切，避免两边抢着 setIgnoreMouseEvents
ipcMain.on('ball:ignore-mouse', () => {})

/**
 * 拖动完全用「主进程自己读光标位置」来算，不信渲染进程的 screenX/screenY。
 *
 * 原因：这台机器主屏 1.0、副屏 1.5，渲染进程里的 screenX 是它所在那块屏的 CSS 像素，
 * 窗口跨屏时这个比值会变，用「光标 - 抓取偏移」算出来的原点就会漂。
 * screen.getCursorScreenPoint() 和 setPosition() 都由 Electron 统一换算，跨屏最稳。
 *
 * 而且这里用「主进程每 16ms 跟一次光标」而不是等渲染进程的 pointermove：
 * 光标一旦跑出 96px 的球，渲染进程就收不到 move 了，窗口被落后一个身位就再也追不上
 * （实测拖到 2294,904 就卡住）。自己按帧跟光标，窗口始终贴着指针，跨屏也不会断。
 */
let dragTimer = null
let dragOutsideSince = 0
let dragLogAt = 0

function windowSize() {
  return expanded ? EXPANDED : COLLAPSED
}

/** 所有屏工作区的外接矩形：拖动时只夹这个，免得被单块屏的边界钉住 */
function unionArea() {
  const areas = allDisplays().map((d) => d.workArea)
  const left = Math.min(...areas.map((a) => a.x))
  const top = Math.min(...areas.map((a) => a.y))
  const right = Math.max(...areas.map((a) => a.x + a.width))
  const bottom = Math.max(...areas.map((a) => a.y + a.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function clampToUnion(point, size) {
  const area = unionArea()
  const x = Math.min(Math.max(point.x, area.x), area.x + area.width - size.width)
  const y = Math.min(Math.max(point.y, area.y), area.y + area.height - size.height)
  return { x: Math.round(x), y: Math.round(y) }
}

function stopDrag(save) {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
  }
  if (!drag) return
  drag = null
  dragOutsideSince = 0
  if (!save) return
  // 松手时再收进最近的一块屏：拖动过程中允许跨在缝上，但不能让它停在两块屏之间
  if (win && !win.isDestroyed() && !isOnSomeDisplay({ x: position.x, y: position.y, ...windowSize() })) {
    position = clampToPoint(position, windowSize())
    win.setPosition(position.x, position.y)
  }
  savePosition().catch(() => {})
}

function dragTick() {
  if (!drag || !win || win.isDestroyed()) {
    stopDrag(false)
    return
  }
  const cursor = screen.getCursorScreenPoint()
  const [wx, wy] = win.getPosition()
  const size = windowSize()
  const near = 160
  const inside =
    cursor.x >= wx - near && cursor.x < wx + size.width + near && cursor.y >= wy - near && cursor.y < wy + size.height + near
  if (inside) {
    dragOutsideSince = 0
  } else if (!dragOutsideSince) {
    dragOutsideSince = Date.now()
  } else if (Date.now() - dragOutsideSince > 600) {
    // 指针离窗口老远而且持续了半秒多：多半是鼠标已经在别处松开（捕获丢了收不到 pointerup）
    stopDrag(true)
    return
  }
  // 拖动期间只夹所有屏的外接矩形，跨屏才不会被某一块屏的边界钉住
  const next = clampToUnion({ x: cursor.x - drag.grabX, y: cursor.y - drag.grabY }, size)
  position = next
  win.setPosition(next.x, next.y)
  if (Date.now() - (dragLogAt || 0) > 200) {
    dragLogAt = Date.now()
    console.log('[drag] cursor=%o pos=%o scale=%o', cursor, next, screen.getDisplayNearestPoint(cursor).scaleFactor)
  }
}

ipcMain.on('ball:drag-start', () => {
  if (!win || win.isDestroyed() || drag) return
  const cursor = screen.getCursorScreenPoint()
  const [x, y] = win.getPosition()
  drag = { grabX: cursor.x - x, grabY: cursor.y - y }
  dragOutsideSince = 0
  dragTimer = setInterval(dragTick, 16)
})

// 位置由 dragTick 跟光标算，渲染进程给的坐标只在 1.5 倍屏上会漂，直接不用
ipcMain.on('ball:drag-move', () => {})

ipcMain.on('ball:drag-end', () => stopDrag(true))

ipcMain.on('ball:quit', () => {
  app.quit()
})

/** 接上/拔掉显示器、分辨率或 DPI 变了：把球收回可见区，别卡在屏幕外 */
function reflow() {
  if (!win || win.isDestroyed()) return
  position = clampToPoint(position, windowSize())
  win.setPosition(position.x, position.y)
  savePosition().catch(() => {})
}

// 父进程没了就退：app.on('quit') 只在自己退出时触发，靠不住
if (HOST_PID) {
  const timer = setInterval(() => {
    try {
      process.kill(HOST_PID, 0)
    } catch {
      clearInterval(timer)
      app.quit()
    }
  }, 5000)
  timer.unref?.()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.showInactive()
  })
  app.whenReady().then(async () => {
    await createWindow()
    // 显示器插拔/分辨率变化后，球可能落在新布局之外，重新夹一次
    const safeReflow = () => {
      try {
        reflow()
      } catch {
        /* 显示器状态抖动时别把主进程带崩 */
      }
    }
    screen.on('display-added', safeReflow)
    screen.on('display-removed', safeReflow)
    screen.on('display-metrics-changed', safeReflow)
  })
  app.on('window-all-closed', () => {
    app.quit()
  })
  app.on('before-quit', () => {
    savePosition().catch(() => {})
  })
}
