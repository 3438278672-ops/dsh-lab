// CommonJS：插件包是 type=module，preload 用 .cjs 才稳（ESM preload 限制多）
const { contextBridge, ipcRenderer } = require('electron')

// 面板只拿这些：三个服务的地址与令牌、窗口操作。渲染进程碰不到 node。
contextBridge.exposeInMainWorld('ball', {
  env: {
    qqsingUrl: process.env.BALL_QQSING_URL || 'http://127.0.0.1:31877',
    paintUrl: process.env.BALL_PAINT_URL || 'http://127.0.0.1:31878',
    queueUrl: process.env.BALL_QUEUE_URL || 'http://127.0.0.1:31879',
    tokenQqsing: process.env.BALL_TOKEN_QQSING || '',
    tokenPaint: process.env.BALL_TOKEN_PAINT || '',
    tokenQueue: process.env.BALL_TOKEN_QUEUE || '',
  },
  expand: (want) => ipcRenderer.send('ball:expand', Boolean(want)),
  ignoreMouse: (ignore) => ipcRenderer.send('ball:ignore-mouse', Boolean(ignore)),
  dragStart: (point) => ipcRenderer.send('ball:drag-start', point),
  dragMove: (point) => ipcRenderer.send('ball:drag-move', point),
  dragEnd: () => ipcRenderer.send('ball:drag-end'),
  quit: () => ipcRenderer.send('ball:quit'),
})
