# dsh-idea-log · 灵感账本

> 干活时冒出来的插件点子、绕不过去的坑、对现有工具的改进点——先记下来，再慢慢挑着做。
> 每天半夜自动从当天的会话里提炼一轮新的，点侧栏「灵感账本」就能看到一墙卡片。

## 它解决什么

写插件的时候想法来得快去得也快：某个 API 契约的坑、某个"要是能自动就好了"的瞬间，过两天就忘了。
这个插件把两件事合在一起：

1. **随手记**：`idea_add` 一条命令就进账本（AI 自己也能记）。
2. **自动捞**：每天定时扫 DSH 的会话记录，让模型从当天真实的工作里提炼「插件点子 / 踩坑 / 改进点」，去重后入库。

## 三个工具

| 工具 | 干什么 |
| --- | --- |
| `idea_add` | 记一条：`kind`（idea / pitfall / improve）+ 标题 + 两三句正文 + 标签。24 小时内同名不重复记。 |
| `idea_list` | 翻账本：按类型、状态、关键词筛，返回带编号的清单。 |
| `idea_digest` | 手动跑一轮提炼（默认往回扫 24 小时）。日常每天自动跑，这里是临时加跑。 |

状态有五种：`new` 待看 / `incubating` 孵化中 / `done` 已做 / `parked` 搁置 / `dropped` 丢弃。

## 网页：灵感墙

装好后 DSH 侧栏会出现「灵感账本」，点开在对话区显示：

- 顶部统计：全部 / 插件点子 / 踩坑 / 改进点 / 待看
- 类型 tab + 状态筛选 + 关键词搜索
- 卡片墙：类型色条、标题、三行正文（点开看全部）、标签
- 每张卡片底下五个状态按钮，点一下直接写回 SQLite
- 每张卡片还有一个「开工 →」：点一下开一个新对话，把这条的编号、类型、标题、正文、标签
  和「动手前先确认范围」的要求一起预填进输入框（只预填，不自动发送），条目顺手标成「孵化中」
- 主机端只接受同源请求，别的网页读不到你的账本

## 每日提炼怎么跑

- 默认 `23:30`，扫最近 24 小时内改过的会话文件（`~/.dsh/sessions/**/session.v4.jsonl.zstd`）。
- DSH 的会话是**多帧 zstd**（一行事件一帧），Node 的 `zstdDecompressSync` 只解第一帧，所以这里按 zstd 魔数 `28 B5 2F FD` 切帧逐段解压。
- 从事件里抽：用户说的话、助手回答的要点、调过的工具，拼成素材；再让模型输出 `{"items":[...]}`。
- 提炼结果**去重**：标题在最近 30 天出现过的跳过；同一天重复提炼同一批素材也会被 `24 小时内同名` 的规则挡住。

不想让它自动跑，把 `digest.schedule` 设成空字符串即可。

## 配置

```yaml
- id: idea-log
  config:
    home: ""                # 默认 ~/.dsh/idea-log
    sessionsRoot: ""        # 默认 ~/.dsh/sessions
    digest:
      schedule: "23:30"     # 空 = 不自动跑
      hours: 24             # 往回扫多久
      maxSessions: 40       # 最多读几个会话文件
    llm:
      provider: ""          # 空 = 用第一个可用模型
      model: ""
```

## 数据与隐私

- 所有数据在 `~/.dsh/idea-log/ideas.db`（SQLite），不联网、不上传。
- 提炼时只把**素材摘要**（用户原话 + 回答要点 + 工具名）发给当前配置的模型，跟 DSH 平时聊天用的是同一条链路。
- 会话文件只读，不改。

## 开发

```bash
npm test     # node:test，11 个用例（去重 / 筛选 / 多帧解压 / 素材抽取 / 定时判定 / 开工任务书）
```

目录：

```
index.js          插件入口：三个工具 + 每日定时 + 网页挂载
lib/db.mjs        SQLite schema 与增删查
lib/digest.mjs    会话扫描、多帧解压、素材抽取、提示词、解析
lib/llm.mjs       DSH llm 服务的薄封装（流式收文本）
lib/page.mjs      灵感墙 HTML（午夜墨风格）
lib/start.mjs     「开工」任务书：按类型生成要交给新对话的提示词
lib/web.mjs       /idea-log 的 Host 路由与 JSON API
lib/client.js     侧栏入口与 iframe 面板（收 iframe 的开工请求，开新对话并预填）
```

「开工」的链路：灵感墙（iframe）→ `postMessage({type:'dsh-idea-log:start'})` →
`lib/client.js` 校验同源与来源窗口 → `uiWorkspace.startSession(undefined, {prompt, whenDraftExists:'replace'})`
→ 回 `started` / `start-failed`。两边协议常量由 `tests/start.test.mjs` 守着，改一处忘了另一处会红。

## License

MIT
