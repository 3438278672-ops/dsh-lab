# dsh-lab

给 [DeepSeek Harness](https://github.com/deepseek-ai)（下称 DSH）写的插件与本地 MCP 服务合集。

不是示例代码，也不是 demo：这七个项目都在一台 Windows 机器上真实跑着——群里有人点歌它真的会唱，发一张图它真的会去反查，Pixiv / B 站的 MCP 每天都在被智能体调用。这里放的是能在自己机器上复现的那部分源码。

> 2026 年 9–11 月，围绕「让智能体真的能干活」做的一批东西。

---

## 一览

| 项目 | 做什么 | 关键实现 |
| --- | --- | --- |
| [dsh-qq-sing](plugins/dsh-qq-sing) | 群友点歌 → B 站取源 → UVR5 分离人声 → RVC 翻唱 → 按静音切段 → 一条条语音发群 | detached worker、FFmpeg、RVC、QQ 桥 |
| [dsh-coser-fish](plugins/dsh-coser-fish) | 一张图反查 coser 的推特 / 微博 / B站 / Instagram / Pixiv | 8 个识图引擎、无头浏览器、名字二次外搜 |
| [dsh-qq-voice](plugins/dsh-qq-voice) | 让智能体用本机音色（GPT-SoVITS）发真正的 QQ 语音条 | GPT-SoVITS、qq-bridge 限流 |
| [dsh-self-extend](plugins/dsh-self-extend) | 能力缺口 → 检索 6900+ 插件目录 → 直接安装或生成骨架 | 插件目录、plugin_manager |
| [dsh-adb-phone](plugins/dsh-adb-phone) | 用 adb 操作一台真手机：截图 / UI 树 / 点击 / 输入 / 按键 / 应用 | adb、ADBKeyboard（中文输入） |
| [mcp/pixiv-duty](mcp/pixiv-duty) | Pixiv App API 的 MCP：搜索 / 详情 / 下载 / 小说分段 / 校验 | pixivpy、FastMCP |
| [mcp/bili-duty](mcp/bili-duty) | B 站 MCP 的加固分支：30 个工具，登录 / 搜索 / 评论 / 字幕 / 私信 / 投稿 | bilibili-api-python |

七个项目、约 500 KB 源码、8 个测试文件。**仓库里没有任何账号凭证**（token / cookie / 密码一律走运行目录里的 `credential.json`，已被 `.gitignore` 排除）。

---

## 三个设计故事

### 1. 点歌：按「静音」切，而不是按时间切

QQ 语音有条数限流（桥里默认 3 条/分钟），一首 5 分钟的歌不可能塞进一条。天真的做法是每 60 秒切一刀——但刀口落在字中间，听感立刻碎掉。

`dsh-qq-sing` 的做法是**先混完整首，再找人声的静音处下刀**：0.35 秒以上的静音才算边界，目标段长 48 秒、最长 56 秒；段与段之间电平一致（整首一次混音，人声 1.15 / 伴奏 0.9 / `alimiter=limit=0.89`）。发的时候严格 31 秒一条，5 分钟的歌切 7 段左右，3–4 分钟发完。

另外两个踩出来的决定：

- **worker 必须 detached**。DSH 关掉、模型睡着，这首歌也要唱完——失败和唱完用桥的 `/api/test-send` 补一句人话。
- **长伴奏头尾会被掐掉**（首/尾静音 > 18 秒）。此时人声块、伴奏、切片必须对齐同一段：伴奏先 `-ss/-t` 裁成同一区间，切片用相对时间（`s-offset`）。否则整首错位，最后几段还会超出混音长度——2026-10-27《大鱼》第 6 段空文件就是这么来的。

排队与额度：同一时间只唱一首，忙了进 FIFO（最多 5 首），每人 1 小时限 1 首且**没唱成自动退还**；白名单里的人不计时。悬浮球（dsh-orb）每 5 秒拉一次只读端点 `http://127.0.0.1:31877/qqsing.json`，显示在唱 + 排单。

### 2. 以图找人：为什么默认只开两个引擎

`fish_find` 接了 8 个引擎，但默认只跑 **saucenao + tracemoe**（本机实测约 2 秒出结论）。原因很实际：

- **Google Lens 最准**，能直接抓到推特主页，但要外网 + headless 浏览器。本机直连 `lens.google.com` 不通，硬跑会卡 5 分钟以上。所以插件在开跑前先做 **4 秒 TCP 预检**，不通就跳过，并在结果末尾写明原因——不会把整次反查拖死。
- saucenao / tracemoe 索引的是**画作和动画截图**，coser 本人的主页基本不在里头。所以「只命中 pixiv」是常态，不是故障。

于是有了第二层：拿到 pixiv 作者名之后，再按名字去外网搜「<名字> Twitter 账号」「<名字> コスプレ twitter」「<名字> 微博 账号」，从结果里认 `x.com` / `weibo.com` / `space.bilibili.com` / `instagram.com` 链接。规矩是宁可少报也不瞎报——**标题或摘要里必须能看到那个名字**，否则当撞号丢弃；一律标 `confidence: "inferred"`，输出带「（推断，未核实）」。

其他：QQ 会话里引用一张图就能查（插件直接向本机 qq-bridge 取原图，不用先落盘）；同一张图 30 天内重复问走缓存（300 条上限），不重复烧 SauceNAO 的免费额度。

### 3. MCP 的闸门要开在注册层

Pixiv 和 B 站这两个 MCP 都支持 `PIXIV_MCP_TOOLS` / `BILI_MCP_TOOLS` 环境变量白名单。关键不在「提示词里劝模型别用」——而在**不在名单里的工具连 `tools/list` 都不出现**，模型那边等于根本不存在。这是代码里的 `tool()` 装饰器替身做的事。

同样统一的还有错误口径：任何失败都返回 `{ok:false, code, message}`，不向上抛协议异常，上层 JS 永远能拿到人话提示。以及——`stdout` 是 JSON-RPC 通道，所有调试输出必须走 `stderr` 或 `duty.log`。

---

## 一些数字

| 项目 | 数字 |
| --- | --- |
| 识图引擎 | 8 个（saucenao / lens / yandex / bing / baidu / google / iqdb / tracemoe） |
| 点歌 | 单曲上限 9 分钟 / 12 段；一条语音 31 秒；排单 5 首；CD 1 小时 |
| Pixiv MCP | App API 请求最小间隔 1.5 秒（账号级风控，token 被吊销不可恢复）；单次搜索 3 个查询 / 20 条 |
| B 站 MCP | 30 个工具；凭证原子写；风控 -412 不再伪装成「0 条评论」 |
| 插件目录 | 检索 6900+ 个 DSH 插件，标注本机已装状态 |

---

## 快速开始

### 装 DSH 插件

```powershell
# 在 DSH 里执行（把路径换成你 clone 下来的位置）
plugin_manager action=install_bundle target="link:D:/path/to/dsh-lab/plugins/dsh-qq-sing"
# 装完重启 DSH 桌面端
```

每个插件目录都有自己的 `README.md`，写了依赖、配置项和自检方式。路径默认值来自开发机，换机器时用插件 `config` 覆盖即可。

### 挂 MCP

```yaml
# cordis.patch.yml（DSH profile 目录下）
- insert:
    - id: mcp-pixiv
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: pixiv
        transport: stdio
        command: 'C:\Windows\System32\cmd.exe'
        args: ['/c', 'D:\path\to\pixiv-duty\run-mcp.cmd']
        toolCallTimeoutMs: 120000
```

Python 侧：

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
# 放入 credential.json（Pixiv: {"refresh_token": "..."}；B站: 扫码登录后自动生成）
```

---

## 目录

```
dsh-lab/
├─ plugins/
│  ├─ dsh-qq-sing/        # 点歌翻唱（index/worker/queue/cooldown + python 管线 + 8 个测试）
│  ├─ dsh-coser-fish/     # 以图找人（引擎内核 + 插件层 + 上游 CLI）
│  ├─ dsh-qq-voice/       # 文字 → 本机音色语音条
│  ├─ dsh-self-extend/    # 插件自扩展闭环
│  └─ dsh-adb-phone/      # adb 手机控制
└─ mcp/
   ├─ pixiv-duty/         # Pixiv MCP（px_* 7 个工具）
   └─ bili-duty/          # B 站 MCP（bili_* 30 个工具）
```

---

## 没有放进来的

- **OPCG（航海王卡牌）相关**：卡牌库管线、单文件卡牌管理器 / 卡组编辑器、线上对战平台、规则引擎与审计报告。这部分和真实用户数据、线上服务耦合，暂不公开源码。同期的工作量供参考：2970 张卡 / 5056 个变体 / 5052 张卡图、2608 张卡效实装、一次审计整理出 160 条问题（P0 2 / P1 36 / P2 93 / P3 29）。
- **dsh-see-now**：第三方插件（PolyForm Noncommercial，作者 SAOS-3624），不在本仓库分发。

---

## License 与声明

- 本仓库**自有代码**：MIT，见 [LICENSE](LICENSE)。
- `mcp/bili-duty/mcp_server.py`：派生自 [AGI_Ananas/bilibili-mcp](https://github.com/AGI_Ananas/bilibili-mcp)（MIT），改动清单见文件头注释与 [NOTICE](mcp/bili-duty/NOTICE.md)。
- `plugins/dsh-coser-fish`：内核来自 `coser-image-search v1.0.0`（MIT，Copyright © 2026 小鲸鱼），插件层为适配 DSH / QQ 桥新增。
- 仓库不含任何平台账号凭证。代码只做只读抓取与个人收藏用途；平台内容版权归各平台与原作者，使用时请遵守对应服务条款。
