# dsh-qq-sing · 群友点歌，我来唱

QQ 群里有人 @ 你 点歌（「唱首晴天」），自动：

```
B 站搜歌/下载 ──► UVR5 分离人声伴奏 ──► 按她自己的音域定调 ──► 静音处切段 ──► RVC 翻唱
      ──► 整首混音（DJ/搞笑歌踩点加怪叫）──► 按静音边界切片 ──► 逐条语音发群 ──► 写 LESSONS 复盘
```

同一时间只唱一首：后台在合成/发送时，新的点歌进排单（最多 5 首，`queued=true, position=N`），排满才 `queueFull=true`。每个点歌人 1 小时只能点 1 首（没唱成自动退还）。

搜索拿不准时不会瞎唱：先返回候选，等点歌人确认「是这首」再起唱（见下节）。

## 工具

| 工具 | 说明 |
| --- | --- |
| `qq_sing(song, requester, target, confirm?, pick?)` | 点歌。`song` 传歌名或 BV 号；`requester` 传点歌人 QQ 号（群聊必填，私聊可省＝用对方 QQ 号）；`target` 传当前会话 key（`group:群号` / `private:QQ号`）。搜索很确定 → 直接开唱/排单；拿不准 → 返回 `needConfirm=true` + token + 最多 3 个候选，把 `summary` 发到群里等对方回序号，再传 `confirm=token, pick=序号`。立即返回，实际任务在 detached worker 里跑 |
| `qq_sing_status()` | 看后台到哪一步了（找歌/分离/RVC/发第几条），以及排单还有几首 |
| `qq_sing_cancel()` | 掐掉当前这一首（只在真卡住时用），同时清空排单 |
| `qq_sing_selftest()` | 自检桥、令牌、python、凭证、锁（只在 DSH 主会话用，QQ 里被隐藏） |

## 搜索与确认（2026-11 改）
- **解析**：`songsearch.parse_query` 剥命令词/语气词、`歌手《歌名》`/`歌手 - 歌名`/「X 的 Y」、书名号；把 DJ版/翻唱/现场/日语/女声/slowed 等版本词剥进 `traits`（点歌人自己点 DJ 版时不吃 DJ 负分），具名版本词（如「dj德朋版」的「德朋」）留下当加分信号。
- **多查询**：原话 → 纯歌名 → 歌名+歌手/歌手+歌名 → 歌名+版本词 → 歌名+原唱 → 歌名+官方；全部跑完（不再提前停），按 bvid 去重。
- **打分只看标题**：试听/录音棚/Hi-Res/黑胶/无损、nightcore/slowed、伴奏/KTV、教学/曲谱、合集/直播、解说盘点、翻唱对比等都只匹配标题（标签里人人都写「无损」，看标签会全灭）；官方/原唱、MV、高清加分；时长 150–330s 加分、<90s 或 >420s 减分；播放量只作小权重，不再压过「选对源」。
- **歌手推断**：标题里没给歌手时，从《歌名》旁的名字投票（票数 ≥2 且明显领先才采用），补搜「歌手+歌名」；推断只在真的提升置信度时才保留。
- **指定频道优先（2026-11-10）**：解析出歌名后先去 `JLRS-jayfm`（mid `3493082817366845`）和 `JLRS-LeoFM`（mid `3493093607213343`）的频道里搜，jayfm 优先、LeoFM 次之；标题必须**边界命中**歌名（「后来」不会选中「后来的我们」；单个拉丁词还要求前后不是另一个词的一部分，「I Want Love / Love's Not A Game / Une Année Sans Lumiere」都不算，`feat. Eric Lumiere` 这种客串署名也不算），歌手名（含「OKGO乐队」去掉「乐队」后缀）和版本词命中加分；器乐版（小提琴/大提琴/古筝/二胡/八音盒/口琴/笛子/尤克里里/双排键/器乐/演奏）按 `instrumental` 降权，但点歌人点名器乐版时反过来加分。点歌人点名的版本（DJ/现场/翻唱/器乐…）只有频道里有同款才用，没有就跳过频道阶段。两位频道都没有 → 走普通搜索，但**回退也强制先确认**，不自动选。
- **重复转载**：同 UP 或时长差 ≤5s 且标题相似度 ≥0.8 的第二条不算「第二名」，避免近似转载把置信度拖成 low。
- **低置信先确认**：`confidence=low`（歌名对不上 / 最好的也带硬伤 / 分数低 / 前两名太近 / 歌手没对上 / 时长不像整首）→ 存 `~/.dsh/qq-sing/pending-confirm.json`，返回 token（10 分钟、一次性、绑定 requester+target）。模型把「我找到的是这一首吗？」的候选发群里，对方回序号后 `confirm=token, pick=N`；确认过的 bvid 会随排单一路传到 worker，worker 用 `fetch_song.py --bvid` 直接下这一条，不再重搜。
- **开场裁切**：分离后在 `pipeline.py` 调 `intro_trim.py`——伴奏开头连续安静 ≥4s 且人声有响度 → 判为「先说后唱」，裁到起唱前 0.3s（最多 45s），切段/混音/切片共用同一起点，`RESULT.introTrim` 记录裁了多少。已知代价：极少数 >4s 的清唱开头会被误切，日志会写明。
- 测试：`node tests/confirm.test.mjs`（确认分支 7 项）；`python tests\test_channels.py`（频道优先/解析/器乐版 13 项，纯函数、不联网）；搜索回归脚本在 `D:\TAP\_qqsing_probe\batch_cases.py`（需 B 站凭证，离线不跑）。

## 安装

```powershell
# 在 DSH 里
plugin_manager install_bundle target="link:D:/新建文件夹/DSK/dsh-qq-sing"
# 然后重启 DSH 桌面端
```

依赖本机已有环境（改路径用插件 config 覆盖，见 `index.js` 的 `DEFAULTS`）：

- QQ 桥控制台 `http://127.0.0.1:3100`（操作者通道，令牌自动从桥目录读）
- B 站下载：`C:\Users\Administrator\.dsh\bili-duty\.venv\Scripts\python.exe` + `bili_credential.json`
- RVC：`D:\GSV\rvc\venv\Scripts\python.exe`，模型 `assets/weights/s3125_sing_v1.pth` + 同名 index（3125 声线，2026-11-10 起默认；旧 `dfy2_sing_v3` 的 pth/index 都还在，改回 `python/pipeline.py` 的 MODEL/INDEX 两行即可回滚）
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
- 悬浮球（dsh-orb）显示：插件内起一个只读 HTTP 端点 `GET http://127.0.0.1:31877/qqsing.json`（CORS `Access-Control-Allow-Origin: *`，只读、只在本机回环），返回 `{paused, active, queue, recent}`，其中群名/昵称由 SnowLuma OneBot `get_group_info / get_group_member_info / get_stranger_info` 解析（`names.mjs`，8s 超时，失败就退回数字）。
- 页面侧：`tools/patch-orb.mjs` 幂等地给 `dsh-orb/dist/helper/assets/floating.html` 注入 `qqsing-queue.js`，并放行 CSP `connect-src http://127.0.0.1:31877`；卡片 DOM 由脚本自建，每 5s 拉一次端点：收起时球右上角红点（在唱/有排单，暂停时变琥珀色），展开显示在唱那首（红字）+ 排单 1-5 + 空闲时的最近 4 首。
- **暂停键**：卡片右上角「暂停/恢复」。暂停只挡**新**点歌——`qq_sing` 直接返回 `ok=false, paused=true` 并说明原因；在唱的那首照常唱完，排单保留但调度器跳过，恢复后按原顺序继续。状态落盘 `~/.dsh/qq-sing/paused.json`（重启 DSH 也记得），开关端点是 `POST http://127.0.0.1:31877/qqsing/pause?on=1|0`，只接受本机页面（`file://` 的 `Origin: null`）或本机程序，别的网站带外站 Origin 会被 403，防止随手一个网页就把点歌停掉。
- **dsh-orb 升级/重装会覆盖 dist 资产**（2026-11-09 的 0.2.1 升级就把补丁冲掉过一次）；升级后跑一次 `node tools/patch-orb.mjs` 即可恢复，脚本带 `floating.html.bak-qqsing` 备份、可重复执行。只想验证端点：`curl http://127.0.0.1:31877/qqsing.json`。
- 截图：`docs/orb-card-queue.png`（在唱+排单）、`docs/orb-card.png`（只有历史）。

## 关键实现

- `worker.mjs` detached 运行：DSH 关了也会把这首唱完。
- 状态：`~/.dsh/qq-sing/state.json`；锁：`busy.lock`（pid 死了 15s 后自动判废）。
- 切段按人声静音处切（0.35s 以上静音、目标 48s、最长 56s），避免句中截断。
- RVC 批量推理必须 `RVC_CUDA_GRAPH=0`：CUDA Graph 对每种音频长度都要重捕获，批量短段会慢 15 倍。
- 长伴奏头尾（首/尾静音 >18s）会被掐掉，此时**人声块、伴奏、切片必须对齐同一段**：伴奏先 `-ss/-t` 裁成同一区间，切片用相对时间（`s-offset`）。否则整首错位，最后几段还会超出混音长度（2026-10-27《大鱼》第 6 段空文件就是踩了这个）。
- 失败/唱完用桥的 `/api/test-send` 补一句人话（此时模型可能已经睡了）。
- 排单/调度/只读端点：`queue.mjs` + `index.js` 的 `startJob`/supervisor effect；悬浮球桥接是 `tools/patch-orb.mjs` + `tools/qqsing-queue.js`（dsh-orb 升级后重跑前者）。

## 对齐隔壁 RVC 会话的标准（2026-10-27）

- **定调**：`D:\GSV\rvc\key_adjust.py` 先量人声中位基频，往 344Hz（她训练集的中位）靠；只升不降、上限 +6 半音，原曲 ≥300Hz 不动。`RVC_PITCH` 可强制覆盖。
- **怪叫**：`D:\GSV\rvc\adlib.py` 用 librosa 跟拍，只在「人声安静 + 伴奏有劲」的拍点插短怪叫（`MIN_GAP=4.5s`、约 3 处/分钟，纯怪叫不喊口号）。触发词：歌名/标题含 DJ/电音/舞曲/remix/蹦迪 → `dj`；搞笑/鬼畜/沙雕/整活 → `funny`；`ADLIB=dj|funny|party` 强制、`ADLIB=0` 关闭。怪叫失败自动退回普通混音，不影响发歌。
- **混音**：整首一次混（人声 1.15 / 伴奏 0.9 / `alimiter=limit=0.89`），再按静音边界切片，段与段之间电平一致。
- **复盘**：每首往 `D:\GSV\rvc\LESSONS.md` 追加一条（中位/变调/风格/怪叫数/电平/时长），下次做歌前先看。
- 依赖：怪叫用 `D:\GSV\feiyu\venv\Scripts\python.exe`（librosa）+ GPT-SoVITS TTS `127.0.0.1:9880`；定调用 GSV runtime python。

## 手工验证

```powershell
# 只搜不下（看候选/置信度）
& C:\Users\Administrator\.dsh\bili-duty\.venv\Scripts\python.exe python\fetch_song.py --song "若生命等候 dj德朋版" --plan --credential C:\Users\Administrator\.dsh\bili-duty\bili_credential.json

# 单跑取歌（确认后按 BV 直接下）
& C:\Users\Administrator\.dsh\bili-duty\.venv\Scripts\python.exe python\fetch_song.py --bvid BV19E4m1X7vb --workdir D:\GSV\qq-sing\t1

# 单跑整条流水线（不发送）
& D:\GSV\rvc\venv\Scripts\python.exe python\pipeline.py --input D:\GSV\qq-sing\t1\source.m4a --workdir D:\GSV\qq-sing\t1\pipeline

# 暂停/恢复点歌（本机 loopback，卡片按钮走的就是这个端点）
curl.exe -X POST "http://127.0.0.1:31877/qqsing/pause?on=1"
curl.exe "http://127.0.0.1:31877/qqsing.json"   # 看 "paused":true
curl.exe -X POST "http://127.0.0.1:31877/qqsing/pause?on=0"
```
