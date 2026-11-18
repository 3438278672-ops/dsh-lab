# 自己的悬浮球（dsh-floatball）+ 统一 GPU 队列（dsh-gpu-queue）设计

日期：2026-11-18（v2，合并「画画/唱歌共用一个 GPU 队列」需求 + builder check 修正）
状态：待批准（批准前不写代码）
规模：**项目级**——新建 2 个插件、改 4 个插件，预计 1500~2000 行 + 测试
相关：dsh-qq-sing、dsh-fish-paint、dsh-qq-voice、dsh-voice-dfy、dsh-orb（第三方，仅参照）

## 0. 一页摘要

做两件事：

1. **`dsh-gpu-queue`**：一个本机 GPU 令牌服务（HTTP 127.0.0.1:31879，单通道 FIFO）。唱歌的
   「分离 + 翻唱」段、画图的「生成一张」、语音的「合成一句」都先来领一张令牌，同一时刻只有一个
   活占卡。轮到**唱歌**时，服务先让 fish-paint 把常驻 SDXL worker 停掉（让出约 5~8GB），再发令牌；
   唱歌结束不主动回填，下次画图自己冷加载（10~30s）。
2. **`dsh-floatball`**：跟着 DSH 起停的 Electron 小球，点开是一个两页签面板（点歌 / 画画）+ 顶部一条
   队列条。它只做监视与控制：看状态、扳两个「暂停接新活」、按两个红按钮（取消在唱 / 中止在画）、
   撤掉队列里还没开始的任务。它不发起任何任务，也不碰业务代码，只会说 HTTP。

三个改动点（为把按钮落到真接口上）：

- qq-sing：本机 HTTP 加 `POST /qqsing/cancel`；`GET /qqsing.json` 补限流/白名单/冷却字段。
- fish-paint：新增控制口 31878（`GET /paint.json`、`POST /paint/pause`、`POST /paint/yield`、
  `POST /paint/abort`）+ 暂停闸 + 中止映射 + 排队。
- 语音：`dsh-qq-voice` / `dsh-voice-dfy` 在调 GPT-SoVITS 前领 `voice` 令牌。

第三方 `dsh-orb` 不动、不卸载，它的球保持关闭；`dsh-qq-sing/tools/patch-orb.mjs` 那套「往别人包里塞
卡片」的做法退居 legacy（新球上线后不再使用）。

## 1. 为什么

今天这些会自己动起来的东西（唱歌、画图、语音）各管各的：

- 状态散落：点歌进度只有 orb 球里那块**打补丁塞进去**的卡片看得到，orb 一升级就被冲掉（0.2.1 冲过一次）；
  画画根本没有本机入口。
- **它们会同时抢一张 8GB 的卡**：实测此刻 `nvidia-smi` = 8192MiB 里用了 7428MiB，常驻的是
  GPT-SoVITS（pid 31120）和 fish-paint 的 SDXL worker（pid 11424）。而 bench 记录显示 Illustrious-XL
  在 `offload` 模式 1024² 时 **reserved 7974MiB**——RVC 再来要 2~3GB，必炸。
  现在没炸只是因为两件事碰巧没撞上；老代码里 `D:\GSV\rvc\gpulock.py` 那把锁只管「翻唱之间互相排队」，
  画画完全不参与。

所以要的是两件东西，缺一不可：**一个真正的全局 GPU 队列**（串行 + 让位），和**一个始终在手边的遥控器**。

## 2. 目标 / 非目标 / 反目标

**目标**

1. 一张 8GB 卡上，画画 / 唱歌 / 语音互相不打架：排队、串行、按需让出显存。
2. 球随 DSH 起停，常驻开销可忽略（无轮询风暴、无 GPU 占用）。
3. 展开即看到：队列里现在谁在占卡、后面排着谁；点歌在唱进度与最近结果；画画引擎状态与最近出图。
4. 两个「停」立刻生效且语义清楚（见 §6.5）：暂停接新活不占限流；取消/中止带 CD 退还。
5. 都是我们自己的包，不受第三方升级影响。

**非目标（这一版不做）**

- 不在球上点歌、不发起画画；不做候选 3 选 1；不做排单增删改序（只读展示 + 撤掉排队项）。
- 不做最近出图缩略图墙（只出文字摘要）。
- 不做全局快捷键 / 托盘常驻 / 多显示器感知。
- 不复制 orb 的聊天、圈选、电脑操作。

**反目标**

- 不把 orb 源码搬进来改名。那等于把升级问题搬到我们自己仓库。
- 不在球里重写业务（不碰 B 站、RVC、diffusers）。球只会 HTTP。
- 不做「暂停时暂存新请求、恢复后补跑」（用户明确没选）。
- 不做「两套锁并存」的兜底：gpulock 文件锁的用法从 pipeline.py 里**移除**，队列服务是唯一机制；
  服务不可用时任务**明确失败**，不静默降级（见 §8）。

## 3. 约束与既有事实（已逐条核对代码）

**硬件**：RTX 3070，8192MiB。Illustrious-XL `offload` 模式实测（`data/state/bench-offload.json`）：
512² reserved 5428MiB / 19s；1024² reserved 7974MiB / 58s；832×1216 reserved 7698MiB / 40s。
即：**画画一张就把卡吃满**。

**qq-sing**（`D:\新建文件夹\DSK\dsh-qq-sing\index.js`）
- `DEFAULTS.queuePort: 31877`（`index.js:71`）；`startQueueServer(cfg)` 在 `index.js:366`；
  `QUEUE_CORS`（ACAO: `*`）在 `:354`。
- `POST /qqsing/pause?on=1|0`（`:378`）：校验 Origin ∈ `'' | 'null' | http://127.0.0.1:<port>`（`:383-388`），
  否则 403；写 `<home>/paused.json`（`{paused, updatedAt, updatedBy}`，helper 在 `:128-145`）。
- `GET /qqsing.json`（`:397-432`）：**不校验 Origin**，返回 `{ok,now,paused,active,queue,recent}`；
  `active` 需 `state.jobId && !state.finishedAt && pidAlive(state.pid)`。
- `server.on('error', () => {})`（`:437`）**吞掉** EADDRINUSE；关闭逻辑在 `:439-445`；`apply` 里用
  `ctx.effect` 挂载（`:726`）。
- 取消只有工具入口 `qq_sing_cancel`（`:1116` 起，含 alsoQueue / taskkill / 清锁 / 退 CD 分支）。
- 暂停后的调度：`runQueueTick`（`:691`）paused 直接 `return`，**排单也不会起唱**（在唱的唱完）。
- 已有一套跨进程锁 `D:\GSV\rvc\gpulock.py`（O_CREAT|O_EXCL + pid 存活 + 5s 轮询），只被
  `python\pipeline.py:360,378` 用来串行翻唱；**画画不参与**。
- 唱歌流水线（`python\pipeline.py`）：`separate()`（`:258`，UVR5，`device='cuda:0'`）→ `convert()`
  （`:358`，RVC，`:378` 拿 gpulock）→ 混音/切片/发送。分离和翻唱都吃显存，中间那几步是 CPU。

**fish-paint**（`…\dsh-lab\plugins\dsh-fish-paint`）
- 工具：`draw_image`（`index.js:224` 起，`executeDrawImage` 在 `:293`）、`draw_status`（`:465` 起）、
  `draw_setup`（`:611`）、`draw_recent`（`:779`）。
- `executeDrawImage`：校验 → `normalizeTarget` → rating → `buildArgs` → `beginRateLimit` →
  `runDrawGeneration`（`:336`）→ `engine.generate(...)`（`:342`）；失败 `rate.release()`（`:356-358`）。
- 失败映射 `failure()`（`:907-928`）：**原样透传 `error.code`**，非字符串则 `DRAW_FAILED`。
- 引擎公开 API（`lib/engine.js:801-809`）：`{generate, status, shutdown, dispose, isRunning,
  installState, paths}`。`startWorker`（`:333`）、`killProc`（`:467`）是内部函数；**没有 `stopWorker`**。
  `shutdown(reason)` 在 `:738-773`：先发 `shutdown` op（5s）→ `waitExit` 3s → `child.kill()` 兜底 2s。
- 引擎**自带串行链** `serial()`（`lib/engine.js:308-319`，`queueDepth` 在这里涨落）：同进程里多个
  `generate` 会排队，不是一个接一个立刻开跑。中止 worker 时，链上所有等待/在跑的 `generate` 都会被
  拒（`:451` → `WORKER_EXIT`；`wasStopping` 时是这个 code）。
- 落盘记录（`lib/store.js`）：`index.jsonl` 每行 = `{path, prompt, negative, preset, width, height,
  steps, cfg, seed, model, engine, rating, target, note, createdAt}`。**没有 `requester` 字段**；
  `rating` 已归一为 `all | r18`（`:71`）；`createdAt` 是 ISO 字符串（`:69`）；图片路径字段叫 `path`。
- 限流（`lib/ratelimit.js`）：`data/state/draw-cooldown.json` = `{version:1, entries:{"<qq>":
  {hits:[ms], lastAt, lastSession}}}`；VIP 默认 `['2220222310']`。
- `vramMode`：`auto | full | offload`（`index.js:41,116`）。

**语音**：`dsh-qq-voice` = `D:\新建文件夹\DSK\dsh-qq-voice`（link），`dsh-voice-dfy` =
`D:\GSV\dsh-plugin-voice`（link）——都是本地源码，可改。GPT-SoVITS 服务常驻 `127.0.0.1:9880`
（pid 31120，`api_v2.py`）。

**环境**：`~/.dsh/profiles/desktop/ball-enabled.json` = `{"enabled":false}`（orb 球当前关闭）。
本机无现成 Electron 可直接借：`D:\DP\DeepSeek Harness.exe` 是打包应用不能当通用 Electron；
`%LOCALAPPDATA%\electron\Cache` 不存在；orb 的 `~/.dsh/dsh-orb/electron-runtime`（44.0.0）是第三方目录，
不作为依赖。可用工具：`C:\Program Files\nodejs\node.exe`、`C:\Windows\system32\tar.exe`。

**窗口参数可参照 orb 的实践证明**（`dist/helper/lib/main.js:1178-1189`、`:925-927`）：
`frame:false, transparent:true, alwaysOnTop:true, skipTaskbar:true, hasShadow:false`，
`setAlwaysOnTop(true,'screen-saver')`。但注意：orb **没有**用 `requestSingleInstanceLock()`，
它靠 host socket 感知父进程存活（`:1811-1813`）；裸 `electron.exe` 的 app name 是 `Electron`、
userData 是 `%APPDATA%\Electron`，不显式改名会和别的 Electron 程序抢同一份用户目录。

## 4. 备选方案与选择

**A. 自研轻量球 + 独立 GPU 令牌服务（选中）**
- 球的代码 100% 我们的；GPU 队列是一个**独立插件**（不是塞进 fish-paint 或球里）：因为
  qq-sing 的 worker 是 detached 进程、语音在另外两个插件里、球只是观察者——只有独立服务才是
  所有角色都能中立接入的汇合点。
- 代价：多一个常驻插件、多三份薄客户端（约 40 行/份）。

**B. 继续给 orb 打补丁**：往第三方 HTML 塞面板。orb 升级即冲掉，画画/队列还要跨包嗅文件。否决。

**C. 队列塞进 fish-paint**：少一个插件，但 fish-paint 一禁用，唱歌就领不到令牌（或被逼兜底）。
把「显卡调度」绑在「画图引擎」上，等于让唱歌依赖画画，否决。

## 5. 用户已拍板（不再问）

- 架构 A：自研轻量球，只做管理。
- 点歌页签：限流/白名单状态、在唱进度 + 历史、暂停/恢复新点歌、取消当前这首。
- 画画页签：暂停接新的点图、限流状态、中止正在画的那一张、面板显示引擎状态。
- **统一 GPU 队列范围**：翻唱段 + 画一张 + 语音合成，全都排。
- **让位**：轮到唱歌时先把 SDXL worker 停掉；语音服务不动。
- **等太久**：画画最多等 10 分钟，超时回「排队超时」。
- **面板**：顶部一条队列条，可展开、可撤掉排队中的项。
- **画画暂停是全局开关**（2026-11-18 拍板）：主会话里我自己画的图也一起拦，没有 bypass 特例。
- **中止 = 停常驻 worker**（2026-11-18 拍板）：接受「这张没了 + CD 退 + 下次冷加载 10~30s」，
  也接受串行链上其它张被一并拒（面板文案必须写明）。
- **球随 DSH 自动启动**（2026-11-18 拍板）。
- **第三方 orb 卸掉**（2026-11-18 拍板）：新球验证通过后 `plugin_manager remove_bundle dsh-orb`，
  computer-use 预设随之下线；不再是「保留安装」。

## 6. 架构

### 6.1 进程与职责

```
DSH 主进程
 ├── dsh-gpu-queue   HTTP 127.0.0.1:31879   ← 唯一发牌者（FIFO + 让位策略）
 ├── dsh-qq-sing     HTTP 127.0.0.1:31877   → 唱歌任务；worker(python) 内领 sing 令牌
 ├── dsh-fish-paint  HTTP 127.0.0.1:31878   → 画图；generate 前领 draw 令牌；被 yield 时停 worker
 ├── dsh-qq-voice / dsh-voice-dfy            → TTS 前领 voice 令牌
 └── dsh-floatball(host) ──spawn──> electron.exe helper/  （球 + 面板，纯 HTTP 客户端）
```

球进程**不经过 DSH**：它直接 fetch 三个端口；host 只负责拉起/看住/收掉它 + 首次安装 Electron。

### 6.2 改动面（6 个包）

1. **新建 `dsh-gpu-queue`**：HTTP 服务 + 排队/让位/心跳/回收 + `data/state/queue.json` 快照。
   无工具（球直接读）；config：`port`、`yieldTargets.sing`（默认 `["http://127.0.0.1:31878/paint/yield"]`）、
   `tokenFile`、`holderTtlMs`(60s)、`queueIdleDropMs`(90s)。
2. **新建 `dsh-floatball`**：host（Electron 安装/拉起/看住、`floatball_status`、`floatball_control`）+
   helper（main/preload/渲染层）+ 首启下载 Electron。
3. **`dsh-fish-paint`**：`lib/control.js`（31878）+ 暂停闸 + `activeJobs` + 中止映射 + 排队 + `draw_status` 扩展。
4. **`dsh-qq-sing`**：`cancelCurrent()` 抽出（工具与 HTTP 共用）+ `POST /qqsing/cancel` + `/qqsing.json`
   补 `limits`/`cooldowns` + `pipeline.py` 换成 `gpuqueue.py`（领 `sing` 令牌，覆盖 separate+convert）。
5. **`dsh-qq-voice`**、6. **`dsh-voice-dfy`**：TTS 请求前领 `voice` 令牌（30s 上限）。

### 6.3 接口契约

**A. GPU 队列服务（31879）**

- `POST /gpu/acquire` `{kind:"draw"|"sing"|"voice", label, ownerPid}`
  → `{ok:true, id, state:"granted"}` 或 `{ok:true, id, state:"queued", position, ahead:[{kind,label}]}`
- `GET  /gpu/ticket?id=<id>` → `{ok, state:"queued"|"granted"|"lost"|"cancelled", position?}`
- `POST /gpu/heartbeat` `{id}` → `{ok, state:"granted"|"lost"}`
- `POST /gpu/release` `{id}` → `{ok:true}`
- `POST /gpu/cancel` `{id}` → `{ok:true, cancelled:true}`（只对**排队中**；持有者由业务端中止）
- `GET  /gpu/state` → `{ok, now, holder:{id,kind,label,ownerPid,grantedAt,heartbeatAt,yieldWarning}|null,
  queue:[{id,kind,label,ownerPid,position,enqueuedAt}], recent:[{id,kind,label,startedAt,endedAt,how}]}`
- 优先级：`voice` 排在**所有排队项**之前（但不抢占持有者）；`draw`/`sing` 同优先级，按 seq FIFO。
- 发 `sing` 令牌前：依次 POST `yieldTargets.sing`，等 ≤20s；成功/失败都继续发牌，失败写进
  `holder.yieldWarning` 并在 `queue.json` 里留痕（宁可让歌先唱、RVC 自己 OOM 报错，也不让点歌无声失败）。
- 回收：持有者 60s 无心跳、或 `ownerPid` 已死 → 自动释放并记 `recent.how="stale"`；排队项 90s 没有
  任何 `GET /gpu/ticket` 轮询、或进程已死 → 丢弃。

**B. fish-paint 控制口（31878，全部要求 `X-Control-Token`）**

- `GET /paint.json` →
  ```json
  {"ok":true,"now":1763450000000,"paused":false,
   "limits":{"windowMinutes":60,"max":1,"vipCount":1},
   "worker":{"running":true,"ready":true,"pid":11424,"modelKey":"base",
             "model":"Illustrious-XL-v2.0","vramMode":"offload","pendingOps":0,
             "crashStreak":0,"cooldownMsLeft":0},
   "inFlight":[{"jobId":"draw-m9x-1","requester":"2220222310","preset":"portrait",
                "rating":"all","promptHead":"1girl, solo, silver hair…",
                "startedAt":1763449990000,"count":1}],
   "recent":[{"path":"…png","prompt":"…","createdAt":"2026-11-18T09:20:41.123Z",
              "rating":"all","seed":123456,"target":"group:1104418054"}],
   "cooldowns":[{"requester":"123456789","leftMs":900000,"resetAt":1763450900000}]}
  ```
- `POST /paint/pause?on=1|0` → `{ok:true, paused:true}`
- `POST /paint/yield` → `{ok:true, alreadyStopped:false}`（`engine.shutdown('让位给唱歌')`；
  **只允许在无在飞任务时调用**，有在飞则回 409 `{ok:false, reason:"busy"}`）
- `POST /paint/abort` → `{ok:true, aborted:["draw-…"], workerStopped:true}`；
  `workerStopped` 语义锁死为「本次是否真的执行了 shutdown」（没有在跑时就是 `false`）

**C. qq-sing（31877）**

- `GET /qqsing.json`：既有字段 + `limits:{cooldownMs,bypassCount,allowlistCount}`、
  `cooldowns:[{requester,leftMs,resetAt}]`。
- `POST /qqsing/cancel?alsoQueue=0|1`（需 `X-Control-Token`）→
  200 `{ok:true, cancelled:true|false, jobId?, cdRefunded:false|true, clearedQueue:0..5}`；
  500 `{ok:false, error:"…"}`。**没在唱时 `cancelled:false` 且不是错误**（球按 `cancelled` 判断）。
- `POST /qqsing/pause?on=1|0`：保留现有 Origin 行为，追加 token 校验（旧卡片退役，见 §10）。

**D. 客户端薄封装**：Node 侧 `gpu-token.mjs`（acquire → 轮询 ticket 每 1.5s → 心跳 15s →
release；任何异常抛 `GpuQueueUnavailable`）；Python 侧 `gpuqueue.py`（同语义，urllib）。
三份重复是**有意**的：`link:` 布局下跨包 import 不可靠（各包解析到自己的真实路径）。

### 6.4 状态机

```
排队项: queued ──(轮到自己且让位完成)──> granted ──(release/心跳丢失/进程死)──> done
                                    └──(cancel)──> cancelled
持有者: granted ──(无心跳 60s / 进程死)──> stale-released
```

### 6.5 语义（界面必须与之一致）

| 动作 | 含义 | 谁受影响 | 恢复 |
| --- | --- | --- | --- |
| 点歌·暂停 | 拒绝**新**点歌 | 新来的回「暂停中」；**在唱照唱完**；排单原地不动、**不自动起唱**（`index.js:691`） | 恢复后 20s 内排单续上 |
| 点歌·取消 | 掐掉**正在唱**这首 | 该 job 的 worker 被 kill；未发出的退 CD | 排单下一首 20s 内起（=跳过） |
| 画画·暂停 | 拒绝**新**点图 | 新请求回 `PAUSED`，**不占 CD、不进队列**；在画的画完 | 恢复即接受 |
| 画画·中止 | 停 worker | 在飞那张 reject 成 `ABORTED`（映射见下），CD 自动退；**串行链上排队的其它 generate 一起被拒**（这是 `serial()` 的既有行为，界面必须说明「会一并中止排在后面的 N 张」） | 下次请求自动冷加载 |
| 画画·让位 | 队列为唱歌腾显存 | 只停**空闲** worker（有在飞则 409，队列改在画完后重试让位） | 下次画图冷加载 |
| 队列·撤销 | 撤掉还没开始的任务 | 该客户端下一次轮询拿到 `cancelled`，返回 `QUEUE_CANCELLED` | — |

`ABORTED` 的落地：`/paint/abort` 先置 `aborting=true` 再 `engine.shutdown()`；`failure()` 收到
`WORKER_EXIT` 且 `aborting` 为真时改写成 `ABORTED`（否则保持 `WORKER_EXIT`，别骗界面）。

### 6.6 数据与持久化

| 文件 | 归属 | 内容 |
| --- | --- | --- |
| `~/.dsh/qq-sing/paused.json` | qq-sing（已有） | `{paused, updatedAt, updatedBy}` |
| `…/dsh-fish-paint/data/state/paint-control.json` | fish-paint（新） | `{paused, updatedAt, updatedBy}` |
| `…/dsh-fish-paint/data/state/control-token` | fish-paint（新） | 32 hex，0600 |
| `…/dsh-gpu-queue/data/state/queue.json` | gpu-queue（新） | `{holder, queue, recent[20]}` 快照（崩溃后留证据，重启不恢复持有者） |
| `…/dsh-gpu-queue/data/state/control-token` | gpu-queue（新） | 同上 |
| `…/dsh-floatball/data/state/window.json` | floatball（新） | `{x, y, tab, collapsed}` |
| `…/dsh-floatball/data/engine/runtime/` | floatball（新） | 解压后的 Electron（gitignore） |

### 6.7 生命周期与打包

- 安装：`plugin_manager install_bundle` 三个 link 包；profile bundles 顺序：`dsh-gpu-queue` 放在
  `dsh-qq-sing` **前**（先有发牌的），`dsh-floatball` 放最后。
- 每个 host 插件都用 `ctx.effect(() => startXServer(...))` 拿到 close（照 `qq-sing/index.js:726`），
  **端口冲突要显式报**（不允许 `server.on('error', ()=>{})` 吞 EADDRINUSE）：冲突时该插件服务不启、
  状态里写 `EADDRINUSE`，球顶栏显示「31878 被占用」。
- 球进程：`electron.exe --user-data-dir=<dataDir>/electron <helper/main.cjs>`，`{stdio:['ignore','pipe','pipe'],
  windowsHide:true}`，stdout/stderr 按行进 `data/state/ball.log`（前缀 `[electron out]/[electron err]`）；
  env 传 `BALL_STATE_PATH / BALL_USER_DATA / BALL_HOST_PID / BALL_QQSING_URL / BALL_PAINT_URL /
  BALL_QUEUE_URL / BALL_TOKEN_{QQSING,PAINT,QUEUE}`（**必须剔除继承来的 `ELECTRON_RUN_AS_NODE`**，
  否则 electron.exe 以 Node 模式跑、`require('electron')` 直接 `Cannot find module`）。
  实测这套的崩溃退避是「窗口内崩溃 < restartLimit 才重拉」，默认 5 次/10 分钟。
- helper 主进程必须是 **CommonJS**（`helper/main.cjs`）：ESM 下 `import { BrowserWindow } from 'electron'`
  报 `does not provide an export named 'BrowserWindow'`；preload 同理用 `.cjs`。
  `app.setName('dsh-floatball')` + `app.setPath('userData', …)`（避免与其它 Electron 抢
  `%APPDATA%\Electron`）+ `requestSingleInstanceLock()`；每 5s 检查 `BALL_HOST_PID` 存活
  （`process.kill(pid,0)`），父进程没了就退。
- Electron 运行时（**硬约束**）：Chromium 从含中文的 exe 路径启动会直接 `STATUS_BREAKPOINT`
  （code `-2147483645`，stderr 空），所以运行时不能放在中文插件目录下；默认落
  `%LOCALAPPDATA%\dsh-floatball\runtime\<版本>\`（非 ASCII 则退 `~/.dsh/dsh-floatball/runtime`），
  `runtimeRoot` 可覆盖但必须 ASCII；`dataDir` 是 ASCII 时才用 `data/engine/runtime/`。
  下载优先 npmmirror `https://registry.npmmirror.com/-/binary/electron/v44.0.0/electron-v44.0.0-win32-x64.zip`，
  GitHub 兜底；`tar.exe -xf` 失败自动退 `Expand-Archive`；落 `.complete-44.0.0` marker；
  旧位置已有运行时则 `cp` 复用（省一次 250MB 下载）；`prepare()` 用 in-flight 去重防并发装。
- DSH 硬退/强杀：`ctx.effect` 的 dispose 未必跑完 → helper 的父进程轮询兜底自杀；host 侧再挂
  `process.on('exit')` 尝试 kill。

## 7. 界面

**收起态**：64px 圆球，置顶、无边框、不可缩放。右下两个状态点：唱歌中（红）/ 画图中（琥珀），空闲不显示点。
窗口 64×64，`setIgnoreMouseEvents(true,{forward:true})`，渲染层 `mousemove` 命中圆内时关掉穿透
（照 orb `main.js:1200` + `:704-708` 的做法）——否则方窗四角会挡住桌面点击。
**拖动**：手写 `mousedown/mousedown-move/up` + 5px 阈值（不用 `-webkit-app-region:drag`，它会吞掉 click，
导致「单击展开」失灵）。位置写 `window.json`。右键菜单：打开面板 / 暂停点歌 / 暂停画画 / 重开球 / 退出。

**展开态**：约 340×560，顶部一行状态球 + 两个页签 + ×。

- **队列条**（两个页签共用，永远可见）
  - 持有者：`画图 · 群「XXX」 · 已 0:42` 或 `唱歌 · 《歌名》 · 已 1:10` 或 `显卡空闲`。
  - 后面：`排队 2` → 点开展开列表：序号 + 类型 + 标签 + 等了多久；排队项右侧一个「撤」。
  - 让位警告（`yieldWarning`）用小字红字显示一行。
- **点歌页签**
  - 在唱：歌名（大）、点歌人 → 群名、`已发 n/m` + 阶段文本、已唱时长；「取消这首」（红，点一次变
    「确认取消？」2.5s 内再点才执行）。
  - 开关：「接新点歌」on/off，灰字「在唱不受影响，排单原地等」。
  - 排单：最多 5 条，序号 + 歌名 + 点歌人（只读；撤队不在这里，走队列条）。
  - 最近：4 条，✓/✗ + 歌名 + 相对时间 + 失败原因（截断）。
  - 限流：`1 小时 1 首 · 白名单 3 人 · 冷却中 2 人`，点开小列表（uid 后四位 + 剩几分钟）。
- **画画页签**
  - 引擎：`worker 运行中 · pid 11424 · Illustrious-XL-v2.0 · offload · 队列 0`（停着灰字「空闲待命」）。
  - 在画：提示词摘要 + `已画 0:42`；「中止」红按钮（二次确认，确认文案写明「会一并中止排在后面的 N 张」）。
  - 开关：「接新点图」on/off，灰字「这张会画完；新请求不占限流、不进队列」。
  - 限流：`1 小时 1 张 · VIP 1 人` + 冷却列表。
  - 最近：4 条，提示词摘要 + 时间 + `all/r18`（界面显示成 `sfw/nsfw` 的话由渲染层映射）。
- **陈旧态**：任一端点连续 3 次失败 → 该页签置灰 + 顶栏一行「画画服务没响应（31878）」；退到 5s 重试，
  不弹窗、不刷屏。端口被占用与「插件没启用」用不同的文案（读插件状态区分）。

## 8. 错误路径

- **GPU 队列服务没起**：唱歌/画画/语音的客户端在 acquire 阶段直接失败（`GpuQueueUnavailable`），
  画画回 `QUEUE_UNAVAILABLE`「显卡调度服务没响应（dsh-gpu-queue）」，唱歌的 worker 直接报错退出并退 CD。
  **不静默放行**——宁可这次不干活，也不要两张重度任务同时压 8GB 卡。
- **排队超时**：`QUEUE_TIMEOUT`，画画不占 CD；唱歌退 CD 并回「显卡忙」。
- **让位失败**（fish-paint 409 busy / 超时）：照发歌令牌，`yieldWarning` 记录 + 面板红字；RVC 若 OOM
  按其既有错误路径报错退 CD。
- **画画暂停中**：`PAUSED`，不占 CD、不进队列；`draw_setup action=verify` **不受暂停影响**（它是安装校验，
  不是用户点图），但要占队列（它也真跑 GPU）。
- **中止时正好没有在画**：`{ok:true, aborted:[], workerStopped:false}`，界面提示「刚才那张已经结束了」。
- **拿不到的写权限**：所有写端点要求 `X-Control-Token`（从各服务的 `data/state/control-token` 读；
  orb 的前例是 `DSH_ORB_TOKEN`）。Origin 校验保留，但不是唯一防线。
- **Electron 下载失败**：`floatball_status` 报 `runtime: missing`，给出镜像与手动放置路径。

## 9. 测试与验收

**自动化（`node --test`，跟现有 51 个测试的写法）**

- gpu-queue：FIFO 顺序；voice 插队但不抢占；心跳过期回收；持有者进程死回收；让位在无在飞时被调用、
  有在飞时 409 后重试；取消排队项后客户端拿到 `cancelled`；`GET /gpu/state` 形状快照；token 拒绝。
- fish-paint：`paused` 时 `draw_image` 回 `PAUSED` 且 **`draw-cooldown.json` 不变**；abort 时在飞 reject
  映射成 `ABORTED` 且 CD 退还；`/paint/yield` 在有在飞时 409；`/paint.json` 字段形状（尤其 `recent`
  用 `path`/ISO `createdAt`/`all|r18`）；Origin/token 校验。
- qq-sing：`cancel` 只动当前单；`alsoQueue=1` 清排单并退 CD；没在唱时 `cancelled:false`；
  `/qqsing.json` 新字段形状。
- floatball：`window.json` 读写；下载 URL 选择（镜像优先/回退）；父进程死亡检测的纯函数；
  helper 的 IPC 消息形状。
- 跨包集成脚本（`tests/integration-queue.test.mjs`）：起一个真 gpu-queue + 假 fish-paint + 假 qq-sing，
  跑「两个 draw + 一个 sing」验证串行与让位。

**手动验收（我会跑一遍并把结果贴回来）**

1. `floatball_status` 报 runtime ok、ball running、三个端点可达。
2. 球出现；拖动后重启 DSH，位置还在；DSH 被杀，球 5s 内自己退。
3. 群里点一首 → 画画页签顶栏看到「唱歌占卡」；点「画一张」→ 队列里排在后面，唱歌结束后才开画。
4. 点「取消这首」→ 语音停、下一首 20s 内起。
5. 扳「接新点歌」→ 群里再点 → 回「暂停中」；恢复 → 排单自动续。
6. 扳「接新点图」→ 主会话 `draw_image` 回 `PAUSED` 且不占 CD。
7. 画到一半点「中止」→ `ABORTED`、worker 停、CD 退了、能立刻再点。

## 10. 上线与回滚

- 顺序：`dsh-gpu-queue`（先装、只被服务端调用）→ fish-paint（暂停默认 off、队列接入）→ qq-sing
  （cancel 端点 + pipeline 换令牌）→ 语音两个 → `dsh-floatball` 最后。
- 每个包都先装不启，手测通过再 `enabled=true`（热点重载路径照 fish-paint 的老办法：
  `plugin_manager set_bundle enabled=false→true`）。
- 回滚：禁用 `dsh-floatball` 立即回到「没有球」；禁用 `dsh-gpu-queue` 则唱歌/画画会**明确报错**
  （不是静默退化），所以回滚顺序必须反过来：先退 qq-sing/fish-paint 的客户端，再退队列服务。
  文档里写清这条依赖方向。
- `patch-orb.mjs` 不删，README 标 legacy；**orb 本体在验收通过后卸载**（`plugin_manager
  remove_bundle dsh-orb`，同时从 profile 的 `dsh.profile.bundles` 里去掉），顺序：新球端到端验收
  通过 → 卸载 orb → 复核 profile 起得来。
- 发布：dsh-lab 加两个插件条目 + README 表格 + CHANGELOG。

## 11. 我拍板的自由度（builder 可改）

- 视觉：自绘 SVG 鲸鱼球（不抄 orb 的 gif）；面板深色玻璃拟态，跟现有插件口气一致。
- 轮询：可见页签 1s、收起 5s；单端点 2.5s 超时；三端点并发。
- 列表条数：排单 5、历史 4、冷却 5；队列全显示但超过 8 条折叠。
- 二次确认窗口 2.5s，鼠标移开即失效。
- 端口可配：`qqsingBaseUrl`(31877) / `paintBaseUrl`(31878) / `queueBaseUrl`(31879)。
- 排队超过 20s 且这次画画带 `target` 时，先往群里发一条「排队中，前面还有 N 个」——只发一次。
- 工具拆两个：`floatball_status`（只读快照）、`floatball_control`（`action: start|stop|restart|open`）。
- 包名：`dsh-gpu-queue`、`dsh-floatball`（中文名「小浮球」）。

## 12. 已拍板（2026-11-18 v3，四点全部确认）

1. **画画暂停 = 全局开关**：`draw_image` 入口统一判 `paused`，主会话自己画的也回 `PAUSED`，
   不做 bypass 特例（实现更简单、语义更硬）。
2. **中止 = 停常驻 worker**：接受冷加载代价，也接受 `serial()` 链上其它张被一并拒（界面写明 N 张）。
3. **球随 DSH 自动启动**（`autoStart:true`），右键「退出」只是本次不收；下次开 DSH 还起。
4. **orb 卸掉**：新球端到端验收通过后再 `plugin_manager remove_bundle dsh-orb`——先建后拆，
   中间不留没有球的空档；computer-use 预设随之消失（用户已确认）。

## 13. 实施记录（v4，2026-11-18 落地时补）

这一节只记「计划之外、写代码时才撞上」的东西，供以后改这个球的人少踩两轮。

### 13.1 Electron 两个致命坑（都花了整轮排查）

1. **`ELECTRON_RUN_AS_NODE` 会从 DSH 继承进子进程**：electron.exe 一进 Node 模式，`require('electron')`
   就是 `Cannot find module 'electron'`，球起一秒就退（`code=1`）。`lib/supervisor.js` 的 `childEnv()`
   现在显式剔除它（连同 `ELECTRON_NO_ATTACH_CONSOLE`）。
2. **Chromium 不接受含中文的 exe 路径**：同一份 exe（SHA256 一致）放 ASCII 目录跑得好好的，放
   `D:\新建文件夹\…` 下就静默 `STATUS_BREAKPOINT`（`code=-2147483645`，stderr 空、脚本一行没跑）。
   运行时因此搬到 `%LOCALAPPDATA%\dsh-floatball\runtime\`，`runtimeStatus()` 里 `ascii` 是硬条件。
3. 附带教训：`stdio:'ignore'` 会把所有线索吞掉——现在 stdout/stderr 都按行进 `ball.log`，
   前两轮「只看到 code=1」的排查成本就是这么来的。

### 13.2 ESM/CJS 边界

`helper/main.cjs` 与 `helper/preload.cjs` 都是 CommonJS（插件 `type:"module"` 不影响 `.cjs`）。
ESM 里 named import `electron` 会直接语法错误。渲染层 `helper/app.js` 仍是 ESM（`<script type="module">`）。

### 13.3 面板与接口的形状对齐

- `/paint.json` 的 `paused` 是**顶层布尔**，不是 `{paused:{paused}}`（早期 app.js 读错，导致点两次
  「暂停」都只是重复置位）。
- 「掐掉当前这首」从 active 卡的 innerHTML 提成固定按钮 `#btnSingCancel`（重复 id 会互相覆盖），
  没在唱时 `disabled`。
- 所有写请求带 `x-control-token`；带人名时 `x-control-by: encodeURIComponent(名字)`——HTTP 头只能
  放 latin1，中文直接塞会 `Cannot convert argument to a ByteString`。

### 13.4 验收证据（2026-11-18）

- `tools/e2e-ui.mjs`（CDP 真点）**14/14**：球渲染、单击展开、队列条「空闲」、限流文案
  「每人 60 分钟一首 · 排单上限 5」、切 tab、画画暂停 `false→true` 且按钮变「恢复」、再点恢复、
  点歌暂停/恢复、掐歌按钮空闲时 disabled、`#dot` 有状态。
- 端点级：`POST /paint/abort` 空闲 → `{ok:true,aborted:[],workerStopped:false,reason:'already-idle'}`；
  `POST /qqsing/cancel?alsoQueue=0` 空闲 → `{ok:true,cancelled:false,clearedQueue:0,…}`（顺手清残留锁）。
- 单测：floatball 21/21、gpu-queue 17/17、fish-paint 74/74。
- 真机：`floatball_control action=restart` → pid 5916，窗口标题「大肥鱼悬浮球」，
  `window.json` = `{"x":2432,"y":1248,…}`；`floatball_status` 三服务全通、显卡空闲。

### 13.5 遗留

- 旧中文路径运行时目录 `data/engine/runtime/**` 删到只剩 `resources/default_app.asar`（111KB）
  被某进程占用，删不掉；不影响功能（`ensureRuntime` 只在旧目录有 `electron.exe` 时才复用），
  重启机器后可直接删。

### 13.6 落位修正：球固定在主屏（2026-11-18 晚）

**现象**：验收后用户两次反馈「球又不见了 / 位置有问题」。第二次抓到 `window.json` 里是
`{"x":1520,"y":-645}`，`GetWindowRect` 得到物理矩形 `(2281,-968)–(2430,-819)`——落在两块屏
之间的死区，肉眼不可见，也拖不回来。

**根因**：这台机器是混合 DPI——主屏 `2560×1440 @ scaleFactor 1.0`，副屏在 `(-417,-1440)`
`2561×1440 @ scaleFactor 1.5`（`screen.getAllDisplays()` 实测）。Electron 的窗口坐标是按各自
display 的 DIP 换算的：同一个 `getBounds()` 值在两块屏上指的不是同一个物理位置。球被拖到副屏
后，存下来的 DIP 坐标下次在主屏（scale 1.0）坐标空间里被解释，就变成屏幕上方/右侧之外的点。
原实现只在新位置「附近有屏」时才夹，遇到这种跨屏换算就对不上；启动时也只 `loadPosition()`
不校验。

**决策**：球只服务「一开就在」的稳定预期，**固定在主屏**，放弃跨屏放置（真需要再开配置项）。

**改动**（`helper/position.cjs` + `helper/main.cjs`）：

- 新增纯函数 `resolvePosition({saved, displays, size})` / `defaultPosition` / `clampPosition` /
  `displayForPoint`（带 `gap`：球只露出一小截仍算那块屏），落盘坐标全部按主屏工作区夹；
- 启动：`window.json` 不在主屏 → 回主屏右下角，并记一行 `[floatball] 窗口位置：旧 → 新` 进 `ball.log`；
- 运行中：`moved` 事件里直接夹回主屏（OS 挪走也能拽回来）；启动 1.5 秒后再核一次位置；
- 拖动：`clampToScreen` 改为只夹主屏工作区；
- 新增 `test/position.test.mjs` 11 个用例（无历史位、屏内保留、贴边夹回、远端回主屏、副屏丢失回主屏、
  展开态按大窗夹、脏坐标、`displayForPoint` 归属、slack），`npm test` 从 21 → **32/32**。

**验证**：把 `window.json` 手动写成那个坏坐标 `{"x":1520,"y":-645}` → 重启 → 日志记
`窗口位置：1520,-645 → 2432,1248`，`GetWindowRect` 为 `(2432,1248)–(2528,1344)`，在 2560×1440
主屏内、右下角，绿点正常。

