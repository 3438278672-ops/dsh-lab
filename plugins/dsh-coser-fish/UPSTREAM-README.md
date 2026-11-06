# 鱼鱼找鸡 v1.0.0

给一张图，反查这人是哪个 coser、账号在哪。

- 多引擎：**谷歌 Lens**（最准，能抓到推特主页）、SauceNAO（动漫/同人）、trace.moe（动漫截屏）、IQDB、百度识图。
- 零 token：不调用任何大模型，**不花 API 钱**。
- 不依赖 npm 包（只用 Node 内置模块 + 本机已装的 Edge/Chrome）。

---

## 1. 装环境

| 需要 | 说明 |
|---|---|
| Node.js ≥ 20 | 内置 `fetch`、`WebSocket`，不用装依赖 |
| Edge 或 Chrome | 谷歌 Lens 那条路要开一个无头浏览器（Windows 自带 Edge 就够） |
| 外网（可选） | 只用 SauceNAO / trace.moe 的话，国内直连也能用 |

```bash
node bin/fish.mjs --check
```

## 2. 配配置

```bash
copy config.example.json config.json
```

| 配置 | 什么时候改 |
|---|---|
| `engines` | 想加/减引擎。默认 `lens,saucenao,tracemoe` |
| `proxy` | 机器上没全局代理、但你有本地代理端口（clash 7890、猫猫云 10090…）时填，只让浏览器走它 |
| `strictConsensus` | 想「宁可多报」就设 false |
| `foundImage` | 想命中时顺带发张图（比如一张「找到了」的表情） |

## 3. 用

```bash
# 查本机图片
node bin/fish.mjs D:/图片/a.jpg

# 查网址
node bin/fish.mjs https://example.com/a.jpg

# 只看结构化结果（方便自己接脚本）
node bin/fish.mjs D:/图片/a.jpg --json

# 只走直连引擎（不开浏览器、不碰外网）
node bin/fish.mjs D:/图片/a.jpg --engines saucenao,tracemoe

# 名字对不上也报（自己挑）
node bin/fish.mjs D:/图片/a.jpg --no-strict
```

输出长这样：

```
🎯 鱼鱼找鸡结果

🌐 平台：Twitter
👤 名字：阿薰kaOri
🆔 账号：@izayoill · https://x.com/izayoill
```

### 它是怎么认的（也是「为什么有时候查不到」的原因）

1. 各引擎返回「相似图的所在页面」；
2. 从页面里抽社交账号（推特/微博/B站/Instagram/小红书…），作者页比帖子页可信；
3. 同一角色常有好几个 coser，只留「标题里出现同一个人名」的那一撮（`strictConsensus`）；
4. 画作平台（pixiv）容易把画师当 coser，相似度不够的会丢掉——所以偶尔会明说「只翻到相似画作」。

## 4. 挂进 QQ 机器人（OneBot 11）

```js
import { handleFishCommand } from './adapters/onebot.mjs';

const onebot = (action, params) =>
  fetch(`http://127.0.0.1:3000/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer 你的token' },
    body: JSON.stringify(params)
  }).then((r) => r.json());

onMessage(async (event) => {
  const key = event.group_id ? `group:${event.group_id}` : `private:${event.user_id}`;
  const done = await handleFishCommand({ text: event.raw_message, key, event, onebot });
  if (done.handled) return;
});
```

用法：**引用一张图**，发 `/鱼鱼找鸡`。它先回「收到，开始找鸡」，再回结果；有 `foundImage` 时图 + 文一条发出去。

## 5. 常见问题

**Lens 一直没结果 / 报 `GOOGLE_UNREACHABLE`**
谷歌连不上。要么开系统代理，要么在 `config.json` 填 `proxy`（只让浏览器走，不动系统代理）。

**报 `GOOGLE_CAPTCHA`**
谷歌要人机验证。用 `--proxy` 换个出口，或者先用 `--engines saucenao,tracemoe` 顶着。

**第一次跑很慢**
无头浏览器冷启动要 2~4 秒；它会复用同一个 profile 目录（`state/`），第二次就快。

**SauceNAO 报 429**
免费额度被刷完了，等一会儿，或者少查几张。

**查到一堆别人的号**
保持 `strictConsensus: true`（默认）。它是「只报标题里出现同一个名字的人」。

**图片会不会被上传到网上**
会——反查必须把图发给引擎（SauceNAO/Lens/百度…）。上传目标写死在 `src/fish-find-chicken.js` 的 `UPLOAD_HOSTS` 白名单里，不读配置，防止被配置改去奇怪的域名。不想上传就别用。

## 6. 隐私与许可

- 不收集、不上报任何使用数据；所有请求只发给你配置在引擎白名单里的域名。
- 浏览器 profile 存在插件目录 `state/` 下，只用来复用谷歌的验证 cookie，可以随时删。
- 代码 MIT。

---

版本 1.0.0 · 文件名 `coser-image-search`
