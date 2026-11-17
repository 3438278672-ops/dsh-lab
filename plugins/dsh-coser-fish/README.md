# dsh-coser-fish（鱼鱼找鸡）

给一张图，反查这个 coser 的社媒账号 —— 推特 / 微博 / B站 / Instagram / Pixiv。

这是把上游 **coser-image-search v1.0.0**（一个零依赖的普通 Node 包）包成 DSH 插件的版本：
`src/`、`bin/`、`adapters/` 都是上游原样保留的内核，这里只加了 `index.js`（Cordis Host 插件层）。

## 两个工具

### `fish_find` — 反查

| 参数 | 说明 |
| --- | --- |
| `image` | 本机图片绝对路径，或 `http(s)` 图片地址 |
| `qqKey` + `qqMessageId` | QQ 会话里被引用/转发的那条带图消息；插件直接向本机 qq-bridge 取原图（不需要先落盘） |
| `engines` | 默认 `saucenao, tracemoe`；可选 `saucenao / lens / yandex / bing / baidu / google / iqdb / tracemoe` |
| `max` | 最多报几个账号（1–5，默认 3） |
| `timeoutSec` | 单引擎超时（5–180 秒，默认 45） |
| `proxy` | 只给浏览器引擎用的代理，如 `http://127.0.0.1:10090` |
| `strict` | 默认 `true`：名字对不上的别人的号不报；`false`：全报出来自己挑 |
| `xSearch` | 默认 `true`：只翻到画作账号时，按作者名去外网再搜 —— **先 X（推特），X 没有才降级微博 / B站**；`false`：只要图直接命中的账号 |
| `noCache` | 跳过本地缓存重新查 |

返回 `summary`（能直接发给用户的人话）+ `accounts`（`platform/handle/url/authorName/confidence`）+ `xSearch`（`tried`：是否真的按名字搜过；`found`：搜到几个；`searched`：搜索服务是否跑通）。
同一张图 30 天内重复问会命中缓存（`cached: true`），不会重复烧 SauceNAO 的免费额度。
引擎没跑通（HTTP 5xx / 超时）或名字搜索不可用时不写缓存 —— 那是环境问题，不是这张图的结论。

### 名字 → 先 X（推特），没有再降级（`xSearch`）

saucenao / tracemoe 是**画作库**，coser 本人的主页基本不在里头 —— 所以「只命中 pixiv」是常态，不是故障。
这一层在拿到 pixiv 作者名之后，再用宿主的 `ctx.web.search` 反查，**严格按阶梯走**：

1. 先把所有作者名的 X（推特）搜完（查询形如「<名字> Twitter 账号」「<名字> site:x.com」「<名字> コスプレ twitter」）；
2. X 整级都没有，才降级搜微博 / B站。

X 上有命中就停在这一级，不会再去搜微博 / B站。pixiv 不参与名字搜索 —— 图搜引擎已经直接给出了图源作者，拿名字去搜 pixiv 多半是同名画师。

规矩（宁可少报也不瞎报）：

- 结果标题或摘要里必须**能看到那个名字**，否则当成撞号丢弃；
- 平台严格隔离：X 阶段搜到的微博链接不会被当成 X 号；
- 一律标 `confidence: "inferred"`，输出时带「（推断，未核实）」；
- 名字是画师本人时，捞到的是**画师的**推特，不一定是照片里那个 coser；
- 宿主搜索服务不可用时，回话会写「这次没能搜 X」，不会谎称「X 上没搜到」；
- 这种不完整结论不写缓存；想重搜也可以传 `noCache: true`。

### 展示顺序

账号统一按 **X → 微博 → B站 → Instagram → Pixiv** 排，同平台再 `direct` > `weak` > `inferred`。
Pixiv 是画作平台，不是本人社交号：平台会写成「Pixiv（画作平台）」，并在末尾说明「Pixiv 那条只是画作作者……」，真人号一般在 X。

### `fish_check` — 环境自检

引擎与超时、有没有 Edge/Chrome、SauceNAO 与谷歌 Lens 直连通不通、缓存条数、qq-bridge 的控制台令牌与二代会话数量。
反查失败时先跑它，别猜。

## 引擎怎么选

默认只跑直连的 **saucenao + tracemoe**（本机实测约 2 秒出结论）。

- **saucenao**：同人图/画作反查，直连、免费、有频率限制。
- **tracemoe**：动漫截图溯源（直连）。
- **lens（谷歌 Lens）**：最准，能直接抓到推特主页；但要走外网 + headless 浏览器。**本机直连 `lens.google.com` 不通，硬跑会卡住 5 分钟以上**，所以默认不开它；要用就传 `engines:["lens","saucenao"]` + `proxy`。未配代理时插件会先做 4 秒 TCP 探测，不通就直接跳过并在结果末尾写明原因，不会卡死。
- **iqdb**：动漫图库（直连，常排队）。
- 百度识图 / 必应 / Yandex / 谷歌识图：浏览器引擎，慢，按需用（同样受 TCP 预检约束）。

## QQ 里怎么用

在本机 qq-bridge（reserved2 模式）的会话里，引用一张图问「这是谁」，调用：

```
fish_find qqKey="group:1104418054" qqMessageId="<那条消息的 messageId 或 seq>"
```

插件会自己读 `state/console-token` 和 `state/social-v2.json` 里该会话的 `agentToken`，
走 `GET http://127.0.0.1:3100/api/images/message` 取原图。桥没开或会话令牌缺失时会给明确错误。

## 配置

`cordis.patch.yml` 里 `config` 可直接覆盖（也可留空）：

```yaml
- insert:
    - id: coser-fish
      name: dsh-coser-fish
      config:
        engines: [saucenao, tracemoe]
        timeoutMs: 45000
        maxAccounts: 3
        strict: true
        proxy: ''
        qqBridgeDir: 'D:\DPQQ\qq-bridge-0.2.1-r1\qq-bridge-0.2.1-r1'
```

缓存默认写 `state/cache.json`（`cacheDays: 30`，`cacheMax: 300`）。
浏览器 profile 在 `state/fish-find-profile`（上游固定用这个目录，谷歌的 cookie 在里面）。

## 本地冒烟测试

```
node test/smoke.mjs                                   # 只跑 fish_check
node test/smoke.mjs --no-check --find D:\图\a.jpg     # 跑一次反查
node test/smoke.mjs --no-check --qq group:123 --msg 456
```

## 上游 CLI 仍然可用

```
node bin/fish.mjs D:\图\a.jpg --json
node bin/fish.mjs https://example.com/a.jpg
node bin/fish.mjs --check
```
