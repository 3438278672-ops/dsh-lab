# dsh-self-extend

给我自己装能力的插件：找插件 → 装插件 → 没合适的就现造一个。

它做三件事：往系统提示里塞一段「遇到能力缺口先找插件」的策略，并注册三个工具。

## 三个工具

| 工具 | 作用 |
|---|---|
| `extend_suggest(query)` | 检索 ~6.9k 个 DSH 插件（数据来自 https://awesome-dsh-plugin.com/plugins.json），按名称/分类/描述/作者打分，标注本机是否已装，直接给出可安装的 spec |
| `extend_install(spec)` | 调 `pluginManager.installBundle` 装上并启用；返回 `applied` / `restart-required` 等结果 |
| `extend_scaffold(dir, name, ...)` | 生成一个能直接安装的插件骨架（package.json + cordis.patch.yml + index.js + locale + icon + README） |

## 检索逻辑

- 索引整份 JSON 一次拉下来，进程内缓存 10 分钟（不逐次打网）。
- 查询按空格切词，**每个词都必须命中**（AND）；单个词按 name 精确 > 前缀 > 子串 > category > description > owner 计分，再用 stars / downloads 微调。
- spec 优先级：`npm` 字段 → `install` 字符串里 `add` 之后的部分 → `tarball` → `github:owner/repo`。
- 非 npm 源的 spec 会标一句「本机 git 直连 GitHub 常超时」——这台机器上 `github:` 装法基本会 `exit=1`，优先 npm。
- 已装判定：`pluginManager.listBundles()` 的 `name` / `packageName` 加 `listPlugins()` 的 `name` / `moduleName`，与条目的 `name` / `npm` 对照（含 `Owner#pkg` 这种取 `#` 后半段的归一化）。

## 写一个新插件（骨架长这样）

```
package.json    dsh.bundle.patch -> ./cordis.patch.yml；exports 指 index.js
cordis.patch.yml  - insert: [{ id: <slug>, name: <pkg>, config: {} }]
index.js        export const name / inject / function apply(ctx)
locale/{en,zh}.json   { "meta": { "title", "description" } }
```

index.js 的最小可用写法：

```js
export const name = 'dsh-foo'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({ name: 'foo', order: 900, text: '…策略…' }))
  ctx.effect(() => ctx.tools.register({
    name: 'foo_run',
    description: '…',
    parameters: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) { return 'ok: ' + String(args.x || '') },
  }))
}
```

可选服务用 `ctx.get('xxx')` 取并判空，不要写进 `inject`（inject 里没有的服务会让插件起不来）。

## 装、改、生效

- 装：`plugin_manager(action=install_bundle, target="<插件目录绝对路径>")`，或 `dsh plugin add <目录>`。
- 改完代码不重启也能生效：
  1. `plugin_manager(action=set_plugin, target="include:<bundle id>", enabled=false)`
  2. 再 `enabled=true`
  这一步会重新 import 模块；验一下系统提示里的文本变没变就知道是不是新代码。
- 想彻底卸载：`plugin_manager(action=remove_bundle, target="<包名>")`。

## 实测过的东西

- 假包名装 → 真实 pnpm 404（`registry.npmmirror.com`），说明 install 链路是通的、npm 走的是清华镜像。
- `extend_suggest("browser")` → 435 命中，BrowserSkill 正确显示「已装」。
- `extend_scaffold` 产出的骨架 → 装 → 系统提示注入 + 工具可调 → 卸载，全链路通过。

## 已知限制

- 索引是社区维护的第三方榜单，不等于 npm 全量；npm 上没进榜的插件搜不到。
- 索引条目偶尔带 `#path:` 之类多包仓库写法，装之前看一眼 spec。
- 装插件是有副作用的操作（会改 profile 的 package.json 与 pnpm-lock），所以策略里写了「一次性任务不装」。
