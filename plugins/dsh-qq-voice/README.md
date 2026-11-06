# dsh-qq-voice

让 DeepSeek Harness 的智能体用本机「大肥鱼」音色（GPT-SoVITS 微调）把一段文字念成语音，并作为**真正的 QQ 语音条**发到指定会话。

## 链路

```
text ──► D:\GSV\gsv\gsv_speak.py（本地 GPT-SoVITS，大肥鱼音色）──► 临时 wav
     ──► QQ 桥操作者通道 POST /api/voice/send（consoleToken）
     ──► 白名单 → 时长/体积校验 → 语音限流 → SnowLuma record 段 → QQ 语音条
     ──► get_msg 落地校验（verified）
```

走**操作者通道**而不是 AI 通道（`/api/socialV2/send-voice`）的原因：AI 通道要求
`socialV2.voice.enabled = true`，且只允许读语音库内文件、只允许当前会话。本插件在库外渲染
临时 wav，所以用控制台令牌走操作者通道；白名单、语音限流（默认 2 条/分、10 条/小时）、
文件名审计、落地校验一样不少。

## 工具

- `qq_voice_say` — 渲染 + 发送。
  - `text`（必填）：要念的内容；短句为宜，默认上限 500 字。
  - `target`：`group:群号` / `private:QQ号`；不填用配置里的 `defaultTarget`。
  - `speed` / `volume` / `normalize` / `verify`（默认 true）/ `dryRun`。
- `qq_voice_status` — 自检：本地语音服务、QQ 桥、语音限流、白名单会话、语音库。

## 配置

在 `cordis.patch.yml` 的 `config` 里可覆盖（默认值即本机部署）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `bridgeUrl` | `http://127.0.0.1:3100` | QQ 桥控制台 |
| `bridgeDir` | `D:\DPQQ\qq-bridge-0.2.1-r1\qq-bridge-0.2.1-r1` | 读白名单 + 兜底读控制台令牌 |
| `consoleToken` | 空 | 空则从 `bridgeDir` 的 `config.json` / `state/console-token` 读 |
| `pythonPath` | `D:\GSV\GPT-SoVITS-v2pro-20250604\runtime\python.exe` | TTS 运行时 |
| `ttsScript` | `D:\GSV\gsv\gsv_speak.py` | TTS 入口 |
| `ttsUrl` | `http://127.0.0.1:9880` | 语音服务（自检用；没起来时合成会自动拉起） |
| `speed` | `0` | 0 = 用 gsv_config.json 的 speed_factor |
| `volume` | `0` | 0 = 用桥的 defaultVolume |
| `normalize` | `false` | 响度归一化 |
| `defaultTarget` | 空 | 不传 `target` 时的默认会话 |
| `keepAudio` | `false` | 保留渲染出的 wav |
| `maxChars` | `500` | 文本上限 |
| `timeoutMs` | `150000` | 单次合成/发送超时 |

## 安装 / 重载

```powershell
# 安装（本地目录，pnpm link）
# 在 DSH 里用 plugin_manager install_bundle，target 指到本目录
```

改了 `index.js` 后需要重载条目：`plugin_manager set_plugin enabled=false` → `enabled=true`
（entryId：`include:qq-voice`）。

## 注意

- 目标必须在 QQ 桥白名单（`config.json` 的 `allow.groups` / `allow.private`）里。
- 语音限流与文本发送分开计数，超限会返回「语音发送频率超限」。
- QQ 仿真会话（`qq-chat-v2`）的本地工具白名单已经放行本插件：`qq_voice_say` 在
  `D:\DPQQ\qq-bridge-0.2.1-r1\qq-bridge-0.2.1-r1\plugins\qq-agent-presets\qq-tool-restrict.mjs`
  的 `SAFE_EXACT` 里；`qq_voice_status` 反过来进了 `KNOWN_DANGEROUS_GLOBAL_TOOLS`，
  QQ 会话里看不到它（自检是维护者的事）。这是一次有意的边界调整，升级 QQ 桥时要重新确认。
- 发送失败时错误信息只给相对文件名，不泄露本机绝对路径（`exposePaths: false`）；
  排查时把插件配置 `exposePaths` 打开即可看到 wav 路径。
- QQ 里的语音由桥统一限流；被限流时工具会直接报「语音发送频率超限」，隔一会儿再发。
