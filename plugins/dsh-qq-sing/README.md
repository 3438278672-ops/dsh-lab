# dsh-qq-sing · 群友点歌，我来唱

QQ 群里有人 @ 你 点歌（「唱首晴天」），自动：

```
B 站搜歌/下载 ──► UVR5 分离人声伴奏 ──► 按她自己的音域定调 ──► 静音处切段 ──► RVC 翻唱
      ──► 整首混音（DJ/搞笑歌踩点加怪叫）──► 按静音边界切片 ──► 逐条语音发群 ──► 写 LESSONS 复盘
```

同一时间只唱一首：后台在合成/发送时，新的点歌直接返回 `busy=true`，不排队、不覆盖。每个点歌人 1 小时只能点 1 首（没唱成自动退还）。

## 工具

| 工具 | 说明 |
| --- | --- |
| `qq_sing(song, requester, target)` | 点歌。`song` 传歌名或 BV 号；`requester` 传点歌人 QQ 号（群聊必填，私聊可省＝用对方 QQ 号）；`target` 传当前会话 key（`group:群号` / `private:QQ号`）。后台在唱就自动排单（最多 5 首），返回 queued + position；立即返回，实际任务在 detached worker 里跑 |
| `qq_sing_status()` | 看后台到哪一步了（找歌/分离/RVC/发第几条），以及排单还有几首 |
| `qq_sing_cancel()` | 掐掉当前这一首（只在真卡住时用），同时清空排单 |
| `qq_sing_selftest()` | 自检桥、令牌、python、凭证、锁（只在 DSH 主会话用，QQ 里被隐藏） |

## 安装

```powershell
# 在 DSH 里
plugin_manager install_bundle target="link:D:/path/to/dsh-qq-sing"
# 然后重启 DSH 桌面端
```

依赖本机已有环境（改路径用插件 config 覆盖，见 `index.js` 的 `DEFAULTS`）：

- QQ 桥控制台 `http://127.0.0.1:3100`（操作者通道，令牌自动从桥目录读）
- B 站下载：`C:\Users\<你>\.dsh\bili-duty\.venv\Scripts\python.exe` + `bili_credential.json`
- RVC：`D:\GSV\rvc\venv\Scripts\python.exe`，模型 `assets/weights/dfy2_sing_v3.pth`（v2/v1 保留可回滚）
- UVR5：`D:\GSV\GPT-SoVITS-v2pro-20250604\tools\uvr5` + HP5 权重
- ffmpeg：`C:\ffmpeg\bin\ffmpeg.exe`

## 节奏与额度

- 桥语音限流 `socialV2.voice.maxPerMinute=3 / maxPerHour=100`，worker 严格按 31s 一条发。
- 一首 5 分钟的歌切 7 段左右 ≈ 3-4 分钟发完；`maxSegments=12`、`maxSongMinutes=9` 是硬上限。
- 桥语音额度/时长上限改完必须**重启桥**才生效。
- worker 对桥短暂断线是容忍的：网络异常每 5s 重试、最多 3 分钟，不会因为桥重启把整首歌判死。

## 点歌 CD

- 每个点歌人（QQ 号）**1 小时只能点 1 首**，存在 `~/.dsh/qq-sing/cooldown.json`。
- 起唱成功那一刻记账；**没唱成（找歌/翻唱/发送失败）自动退还**，不算点过。
- 同一个人再点返回 `ok=false, cooldown=true, remainingMs`，不排队、不起 worker。
- 群聊必须带 `requester`（点歌人的 QQ 号），没带就明确报错；私聊不传则自动用对方 QQ 号。
- **白名单**：`~/.dsh/qq-sing/allowlist.txt`，一行一个 QQ 号（支持 `#` 注释、逗号/空格分隔）；名单里的人**不计时**——不查 CD、不记账，随便点。文件改完立即生效，不用重启 DSH 或桥；白名单只免 CD，仍然遵守“同一时间只唱一首”。
- 也可以写死在插件 config 的 `cooldownBypassUids: ["QQ号"]`（改它要重载插件）；改时长用 `cooldownMs`（默认 3600000）。
- 测试：`node tests/cooldown.test.mjs`（单元）、`node tests/integration.test.mjs`（stub ctx，不碰真桥）。

## 排单与悬浮球

- 忙的时候不再拒单：`qq_sing` 会把歌放进 FIFO 排单（`~/.dsh/qq-sing/queue.json`，最多 **5 首**），返回 `queued=true, position=N`；排满才返回 `queueFull=true`。
- 调度器在插件里每 20s tick 一次：当前没歌在唱、排单非空 → 取队头直接开唱（`startJob` 抽成函数复用）。排单里的歌在入队时**不**记 CD，等真正开唱再记；失败照常退还。
- 悬浮球（dsh-orb）显示：插件内起一个只读 HTTP 端点 `GET http://127.0.0.1:31877/qqsing.json`（CORS `Access-Control-Allow-Origin: *`，只读、只在本机回环），返回 `{active, queue, recent}`，其中群名/昵称由 SnowLuma OneBot `get_group_info / get_group_member_info / get_stranger_info` 解析（`names.mjs`，8s 超时，失败就退回数字）。
- 页面侧：给 `dsh-orb/dist/helper/assets/floating.html` 加了 `#qqsing-card`（含 `#qqsing-badge` 未读红点）和一个 `qqsing-queue.js`，每 5s 拉一次端点；收起时球右上角出现红点（在唱/有排单），展开显示：在唱那首（红字）+ 排单 1-5 + 最近 4 首历史。CSP 已放行 `connect-src http://127.0.0.1:31877`。
- 注意：改的是 dsh-orb 安装目录里的 dist 资产，**dsh-orb 升级会覆盖**；备份在 `floating.html.bak-qqsing`。只想验证端点：`curl http://127.0.0.1:31877/qqsing.json`。
- 截图：`docs/orb-card-queue.png`（在唱+排单）、`docs/orb-card.png`（只有历史）。

## 关键实现

- `worker.mjs` detached 运行：DSH 关了也会把这首唱完。
- 状态：`~/.dsh/qq-sing/state.json`；锁：`busy.lock`（pid 死了 15s 后自动判废）。
- 切段按人声静音处切（0.35s 以上静音、目标 48s、最长 56s），避免句中截断。
- RVC 批量推理必须 `RVC_CUDA_GRAPH=0`：CUDA Graph 对每种音频长度都要重捕获，批量短段会慢 15 倍。
- 长伴奏头尾（首/尾静音 >18s）会被掐掉，此时**人声块、伴奏、切片必须对齐同一段**：伴奏先 `-ss/-t` 裁成同一区间，切片用相对时间（`s-offset`）。否则整首错位，最后几段还会超出混音长度（2026-10-27《大鱼》第 6 段空文件就是踩了这个）。
- 失败/唱完用桥的 `/api/test-send` 补一句人话（此时模型可能已经睡了）。
- 排单/调度/只读端点：`queue.mjs` + `index.js` 的 `startJob`/supervisor effect；悬浮球桥接是 `dsh-orb` 页面补丁 + `qqsing-queue.js`。

## 对齐隔壁 RVC 会话的标准（2026-10-27）

- **定调**：`D:\GSV\rvc\key_adjust.py` 先量人声中位基频，往 344Hz（她训练集的中位）靠；只升不降、上限 +6 半音，原曲 ≥300Hz 不动。`RVC_PITCH` 可强制覆盖。
- **怪叫**：`D:\GSV\rvc\adlib.py` 用 librosa 跟拍，只在「人声安静 + 伴奏有劲」的拍点插短怪叫（`MIN_GAP=4.5s`、约 3 处/分钟，纯怪叫不喊口号）。触发词：歌名/标题含 DJ/电音/舞曲/remix/蹦迪 → `dj`；搞笑/鬼畜/沙雕/整活 → `funny`；`ADLIB=dj|funny|party` 强制、`ADLIB=0` 关闭。怪叫失败自动退回普通混音，不影响发歌。
- **混音**：整首一次混（人声 1.15 / 伴奏 0.9 / `alimiter=limit=0.89`），再按静音边界切片，段与段之间电平一致。
- **复盘**：每首往 `D:\GSV\rvc\LESSONS.md` 追加一条（中位/变调/风格/怪叫数/电平/时长），下次做歌前先看。
- 依赖：怪叫用 `D:\GSV\feiyu\venv\Scripts\python.exe`（librosa）+ GPT-SoVITS TTS `127.0.0.1:9880`；定调用 GSV runtime python。

## 手工验证

```powershell
# 单跑取歌
& C:\Users\<你>\.dsh\bili-duty\.venv\Scripts\python.exe python\fetch_song.py --song 晴天 --workdir D:\GSV\qq-sing\t1

# 单跑整条流水线（不发送）
& D:\GSV\rvc\venv\Scripts\python.exe python\pipeline.py --input D:\GSV\qq-sing\t1\source.m4a --workdir D:\GSV\qq-sing\t1\pipeline
```
