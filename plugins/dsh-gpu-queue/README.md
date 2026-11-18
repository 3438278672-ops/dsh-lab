# dsh-gpu-queue · 一张显卡的发牌员

画画、唱歌、语音合成都要吃这块卡，谁先领到令牌谁上，其余排队。同一时刻只有一个重活占卡——排队，而不是撞在一起把显存撑爆。

这是三个插件共用的「本机服务」：`dsh-fish-paint`（画）、`dsh-qq-sing`（翻唱）、`dsh-qq-voice` / `dsh-voice-dfy`（念）都通过它领令牌；球面板（`dsh-floatball`）读它的状态、撤排队项。

## 接口（只听 127.0.0.1:31879）

| 方法 | 路径 | 令牌 | 说明 |
| --- | --- | --- | --- |
| `POST` | `/gpu/acquire` | 要 | `{kind,label,ownerPid}` → `{ok,state:'granted'\|'queued',ticket,position}` |
| `GET` | `/gpu/ticket?id=` | 不要 | 查自己的牌：`granted` / `queued`（带 position）/ `cancelled` / `lost` / `unknown` |
| `POST` | `/gpu/heartbeat` | 要 | `{id}` 续命（持有者 60s 没心跳、或进程没了会被回收） |
| `POST` | `/gpu/release` | 要 | `{id}` 还牌，下一个自动接上 |
| `POST` | `/gpu/cancel` | 要 | `{id}` 撤掉**排队中**的项（自己已持有的不能撤，要撤就 release） |
| `GET` | `/gpu/state` | 不要 | 快照：现在谁持有、队列里几个、最近 20 条历史 |
| `GET` | `/gpu/ping` | 不要 | 存活探针 |

`kind` 只有三种：`draw` / `sing` / `voice`。`voice`（TTS）排到所有排队项前面但不抢占当前持有者；`draw` 与 `sing` 同优先级、先来先上。

写操作要 `x-control-token`，令牌在 `~/.dsh/dsh-services/gpu-queue.token`（`DSH_SERVICES_DIR` 可改目录），插件首次启动自己生成。只读接口开着 CORS（`*`），方便面板直接读。

## 唱歌前先让位

发 `sing` 令牌之前，会依次 POST 一遍 `yieldTargets.sing`（默认 `http://127.0.0.1:31878/paint/yield`）：画画那边如果没在画，就把常驻 SDXL worker 停掉，给唱歌腾出约 5GB 显存。让位失败或超时（默认 20s）**照样发牌**，原因写进 `holder.yieldWarning`——宁可能挤一点，也不要因为画画插件没起就唱不了。

## 装上

```powershell
extend_install("D:\\新建文件夹\\DSK\\dsh-lab\\plugins\\dsh-gpu-queue")
```

装完在 profile 里 `dsh-gpu-queue` 要排在客户端插件**前面**（先有发牌的，再来领牌的）。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `31879` | 监听端口（`127.0.0.1`） |
| `dataDir` | `<插件>/data` | 快照落在 `data/state/queue.json` |
| `servicesDir` | `~/.dsh/dsh-services` | 令牌与状态文件目录 |
| `holderTtlMs` | `60000` | 持有者多久没心跳算掉线（最小 1000） |
| `queueIdleDropMs` | `90000` | 排队项多久没轮询算人没了（最小 1000） |
| `reapIntervalMs` | `5000` | 回收扫描间隔（最小 100） |
| `yieldTimeoutMs` | `20000` | 唱歌前让位的超时 |
| `yieldTargets.sing` | `[{url, tokenFile}]` | 让位要打谁、令牌从哪读 |

## 出问题先看

- `GET /gpu/state`：现在卡在谁手里、队列里是谁、最近发生了什么（`how: released|stale|pid-gone|idle`）。
- `~/.dsh/dsh-services/gpu-queue.status.json`：真端口、pid、启动时间、`EADDRINUSE` 之类的错误。
- 服务没起时，客户端是**明确失败**（画画回 `QUEUE_UNAVAILABLE`，唱歌/念词打日志照做），不会静默放行到「两边一起抢卡」。

## 测试

```powershell
node --test test/queue-core.test.mjs test/service.test.mjs   # 17 个：纯状态机 + 真 HTTP 行为
node tools/e2e-python.mjs                                    # 跟 python 客户端联调（要本机 python）
```

状态机（`lib/queue-core.js`）不碰时钟、不碰 IO：`now` 全由调用方传，所以时间相关的分支用 `holderTtlMs: 1200` + 等 1600ms 就能测。
