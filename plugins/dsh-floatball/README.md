# dsh-floatball · 悬浮球

桌面上一颗透明小窗里的球。点一下展开，就是个「点歌 + 画画」的监视台兼控制台；再点一下收起，鼠标移开时整窗穿透，不挡桌面点击。

这颗球是我们自己的（不是给 `dsh-orb` 打补丁）：Electron 运行时、窗口、面板、数据读取全在本插件里，orb 升级掉东西也不会牵连到它。

## 面板里有什么

- **点歌**：在唱的歌与进度（第 N/M 段）、排单、谁还在冷却、暂停/恢复接新单、掐掉当前这首。
- **画画**：暂停/恢复接新点图、中止正在画的那张（会停掉常驻 SDXL worker）、worker 是否在跑、在飞的图、谁还在冷却。
- **显卡队列**（顶部一条）：画画与唱歌共用一块卡，这里能看到现在被谁占着、后面排了几个，排队中的可以撤。

所有按钮都打本机 HTTP 服务，不经过模型、不需要开会话。

## 依赖的三个本机服务

| 服务 | 端口 | 谁提供 | 面板用途 |
| --- | --- | --- | --- |
| 点歌 | 31877 | `dsh-qq-sing` | 读 `/qqsing.json`；`POST /qqsing/pause`、`POST /qqsing/cancel` |
| 画画 | 31878 | `dsh-fish-paint` | 读 `/paint.json`；`POST /paint/pause`、`POST /paint/abort` |
| 显卡队列 | 31879 | `dsh-gpu-queue` | 读 `/gpu/state`；`POST /gpu/cancel` |

三个服务的写操作都要令牌，令牌由各插件写进 `~/.dsh/dsh-services/<name>.token`（`DSH_SERVICES_DIR` 可改目录）。球启动时把令牌读出来，通过环境变量交给 helper，面板再加到 `x-control-token` 头上。

服务没起的时候面板不会装死：对应那一栏会写「连不上」，其余照常。

## 装上

```powershell
extend_install("D:\\新建文件夹\\DSK\\dsh-lab\\plugins\\dsh-floatball")
```

或者用 `plugin_manager install_bundle` 指向这个目录。装好后浮球随 DSH 起（`autostart: true`）。

第一次启动会下一份自己的 Electron 运行时。**注意：Electron（Chromium）从含中文的路径启动会直接崩**（`STATUS_BREAKPOINT`，脚本一行都跑不到），所以运行时不放在插件目录里，默认落在：

- `%LOCALAPPDATA%\dsh-floatball\runtime\<版本>\`（目录名里没有中文时，也可以用 `data/engine/runtime/`）；
- 想指定别的位置就配 `runtimeRoot`，但必须是纯 ASCII 路径，否则 `install` 会直接报错而不是装作装好了。

下载策略：

- 先试 npmmirror 二进制镜像（国内快），失败再走 GitHub releases；
- 用系统自带的 `tar.exe` 解压，失败退回 `Expand-Archive`；
- 解压出来的 `electron.exe` 得大于 10MB 且写下 `.complete-<版本>` 才算装好，半截的下载下次重来；
- 旧位置（`data/engine/runtime/<版本>/`）如果已经有下好的运行时，会**直接复制过去复用**，不重新下载。

## 工具

- `floatball_status`：只读。运行时装没装、球在不在跑（pid、崩溃次数）、三个服务通不通、在唱什么、在画什么、显卡被谁占着。
- `floatball_control`：`action=install|start|stop|restart|status`。改完代码想重起球就用 `restart`。

## 配置

插件配置全在 `cordis.patch.yml` 里那片 `config` 下，改完重启插件生效。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `version` | `44.0.0` | 用哪个 Electron 版本 |
| `mirror` | npmmirror 二进制目录 | 下载镜像 |
| `electronPath` | 空 | 指定现成的 `electron.exe`（调试用，跳过下载；同样不能有中文） |
| `runtimeRoot` | 空 | 运行时放哪；空 = 自动挑 ASCII 目录（见上） |
| `dataDir` | `<插件>/data` | 状态、日志、Electron userData 都在这下面 |
| `servicesDir` | `~/.dsh/dsh-services` | 令牌目录 |
| `autostart` | `true` | 随 DSH 起球 |
| `restartLimit` / `restartWindowMs` | 5 / 10 分钟 | 崩了最多重拉几次 |
| `qqsingUrl` / `paintUrl` / `queueUrl` | 31877 / 31878 / 31879 | 三个服务的地址 |

## 文件都在哪

- `data/state/ball.json`：上次起停记录（pid、崩溃、最后一次退出）。
- `data/state/ball.log`：本插件的日志（起球、崩溃、重拉、下载进度、位置被纠正的记录）。
- `data/state/window.json`：球停的位置，下次开在同一个地方。

### 球待在哪

球**固定在主屏**，默认右下角（离右 32、离底 96，避开任务栏），可以拖，位置记住。

为什么要钉死主屏：这台机器是混合 DPI（主屏 1.0、副屏 1.5）。窗口坐标切屏时会被 Windows 按比例换算，`getBounds()` 换块屏就代表另一个物理位置——之前「球不见了」就是拖到副屏后落在两块屏之间的死区。现在的规矩：

- 启动时若 `window.json` 里的坐标不在主屏（换了分辨率、缩放过、以前停在副屏）→ 回主屏右下角，并在 `ball.log` 记一行「窗口位置：旧 → 新」；
- 拖动时只夹在主屏内；
- 系统把窗口挪走（`moved` 事件）会立刻拽回来；启动 1.5 秒后再核一次，跑偏就摆回右下角。

- `data/electron/`：Electron 的 userData（单实例锁、缓存）。

## 排障

- **球不见了**：`floatball_status` 看 `supervisor.running`；没在跑就 `floatball_control action=start`，日志在 `data/state/ball.log`。
- **按钮点了 403**：对应服务的令牌文件没读到（服务没起过），先确认那个插件在跑。
- **Electron 下不来**：日志里会有两个 URL 的失败原因；也可以手动把 `electron-v44.0.0-win32-x64.zip` 放进运行时目录（不用解压，删掉旧的再 `action=install`）。
- **球起来就退，日志只有 `code=1`**：先看 `[electron err]` 那几行——stdout/stderr 已经接进日志了。两个经典原因：`Cannot find module 'electron'`（继承来的 `ELECTRON_RUN_AS_NODE=1`，插件已自动剔除）和路径带中文（见上）。
- **球收不干净**：`supervisor` 用 `taskkill /T /F` 杀进程树，Electron 的 renderer 子进程一起收；如果还有残留，`floatball_control action=stop` 再来一次。
- **和 dsh-orb 同时开着**：两个都会置顶，视觉上会打架。验完这颗球就可以把 orb 卸了（`plugin_manager remove_bundle dsh-orb`）——本插件不依赖它。

## 测试

```powershell
npm test
```

`node --test test/format.test.mjs test/position.test.mjs test/runtime.test.mjs test/supervisor.test.mjs test/snapshot.test.mjs`，覆盖文案拼装、窗口摆位（越界/副屏/脏坐标/DIP 变化）、运行时安装判定、子进程起停与崩溃重拉上限、快照抓取与摘要。

另有一个真实点一遍的端到端脚本（需要一个空闲的调试端口和三个服务在跑）：

```powershell
node tools/e2e-ui.mjs        # 起一个带 --remote-debugging-port=9333 的临时实例，用 CDP 真点面板
```

它验的是：球渲染、单击展开、队列条/限流文案、切 tab、暂停与恢复画画（会回读 `/paint.json` 确认服务端真的变了）、暂停与恢复点歌、掐歌按钮在空闲时禁用。
