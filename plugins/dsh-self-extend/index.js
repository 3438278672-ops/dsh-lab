import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'dsh-self-extend'
export const inject = ['tools', 'systemPrompt']

const SECTION = 'self-extend'

const POLICY = `## 自我扩展（用户已长期授权，优先级高）
出现这三类情况时先找插件、别硬拼：能力缺口；同类操作已重复三次以上；要跨多个工具手工拼装。
1. extend_suggest("关键词") —— 一次调用检索 ~6.9k 个插件的目录（awesome-dsh-plugin），并标出本机已装状态，返回可直接安装的 spec。
2. 有合适的就直接 extend_install(spec) 安装并马上用起来（用户已授权，不必再问）；看 application：applied 已生效，restart-required 需重启。
3. 没有合适的：extend_scaffold 生成骨架，用两三句话说清要做什么，等用户点头后再装。
约束：npm 源 / 本地路径优先（本机 git 直连 GitHub 常超时）；一次性任务不装；已装且启用的不重复装。`

const text = (value) => [{ type: 'text', text: value }]
const msg = (error) => (error instanceof Error ? error.message : String(error))

function pick(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  return value.zh || value.en || Object.values(value).find((item) => typeof item === 'string') || ''
}

function brief(value, max = 200) {
  const line = String(value ?? '').replace(/\s+/g, ' ').trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

function requirementsText(compatibility) {
  if (!compatibility || compatibility.compatible !== false) return '兼容'
  const needs = Object.entries(compatibility.requirements || {})
    .map(([key, range]) => key + ' ' + range)
    .join(', ')
  return '不兼容（需 ' + (needs || compatibility.runtimeVersion) + '）'
}

function candidateVersion(entry) {
  const versions = entry.versions || []
  if (!versions.length) return undefined
  return versions.find((item) => item.version === entry.defaultVersion) || versions[0]
}

const CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json'
const CATALOG_TTL_MS = 10 * 60 * 1000
let catalog = { at: 0, plugins: [], error: null }

async function loadCatalog(force) {
  const fresh = catalog.plugins.length > 0 && Date.now() - catalog.at < CATALOG_TTL_MS
  if (fresh && !force) return catalog
  try {
    const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const payload = await response.json()
    const plugins = Array.isArray(payload) ? payload : payload.plugins
    if (!Array.isArray(plugins)) throw new Error('catalog payload has no plugins array')
    catalog = { at: Date.now(), plugins, error: null }
  } catch (error) {
    catalog = { at: catalog.at, plugins: catalog.plugins, error: msg(error) }
  }
  return catalog
}

function specOf(plugin) {
  if (plugin.npm) return String(plugin.npm)
  const install = String(plugin.install || '').trim()
  const match = install.match(/\badd\s+(.+)$/)
  if (match) return match[1].replace(/^["']|["']$/g, '').trim()
  if (plugin.tarball) return String(plugin.tarball)
  const segments = String(plugin.url || '')
    .replace(/^https?:\/\/(www\.)?github\.com\//, '')
    .split('/')
  return segments.length >= 2 ? 'github:' + segments[0] + '/' + segments[1] : ''
}

function scorePlugin(plugin, tokens) {
  const name = String(plugin.name || '').toLowerCase()
  const owner = String(plugin.owner || '').toLowerCase()
  const category = String(plugin.category || '').toLowerCase()
  const description = String(
    pick(plugin.description) + ' ' + ((plugin.description && plugin.description.en) || ''),
  ).toLowerCase()
  let score = 0
  for (const token of tokens) {
    let hit = 0
    if (name === token) hit = 40
    else if (name.startsWith(token)) hit = 26
    else if (name.includes(token)) hit = 18
    if (!hit && category.includes(token)) hit = 10
    if (!hit && description.includes(token)) hit = 6
    if (!hit && owner.includes(token)) hit = 2
    if (!hit) return 0
    score += hit
  }
  score += Math.min(Number(plugin.stars) || 0, 300) / 15
  score += Math.min(Number(plugin.downloads) || 0, 30000) / 3000
  return score
}

async function installedNames(ctx) {
  const manager = ctx.get('pluginManager')
  const names = new Set()
  if (!manager) return names
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) names.add(value.trim().toLowerCase())
  }
  try {
    const bundles = (await manager.listBundles()) || []
    for (const bundle of bundles) {
      if (!bundle || bundle.installed === false) continue
      add(bundle.name)
      add(bundle.packageName)
    }
  } catch {
    /* bundles are optional context */
  }
  try {
    const entries = (await manager.listPlugins()) || []
    for (const entry of entries) {
      if (!entry) continue
      add(entry.name)
      add(entry.moduleName)
      add(entry.packageName)
    }
  } catch {
    /* plugin list is optional context */
  }
  return names
}

function isInstalled(plugin, installed) {
  if (!installed.size) return false
  const keys = new Set()
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) keys.add(value.trim().toLowerCase())
  }
  add(plugin.name)
  add(plugin.npm)
  const name = String(plugin.name || '')
  if (name.includes('#')) add(name.split('#').pop())
  for (const key of keys) if (installed.has(key)) return true
  return false
}

async function suggest(ctx, args) {
  const query = String(args.query ?? '').trim()
  const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 30)
  const notes = []
  const loaded = await loadCatalog(false)
  if (loaded.error) notes.push('索引拉取失败：' + brief(loaded.error, 140))
  const plugins = loaded.plugins || []
  if (!plugins.length) {
    return { rows: [], notes: notes.concat('没有可检索的插件索引（' + CATALOG_URL + '）'), total: 0, catalog: 0, age: 0 }
  }

  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  const hits = []
  for (const plugin of plugins) {
    const score = scorePlugin(plugin, tokens)
    if (score > 0) hits.push({ plugin, score })
  }
  hits.sort((left, right) => right.score - left.score)

  const installed = await installedNames(ctx)
  const rows = hits.slice(0, limit).map(({ plugin }) => ({
    plugin,
    spec: specOf(plugin),
    installed: isInstalled(plugin, installed),
  }))

  return {
    rows,
    notes,
    total: hits.length,
    catalog: plugins.length,
    age: Math.round((Date.now() - loaded.at) / 60000),
  }
}

function renderSuggest(query, result) {
  const lines = []
  lines.push(
    '检索「' + query + '」：命中 ' + result.total + ' / ' + result.catalog + ' 个插件（索引缓存 ' + result.age + ' 分钟前）',
  )
  if (!result.rows.length) {
    lines.push('没有现成插件。→ extend_scaffold 生成骨架；用两三句话说清要做什么，等用户点头后再装。')
  }
  result.rows.forEach((row, index) => {
    const { plugin, spec, installed } = row
    const facts = []
    if (plugin.category) facts.push(plugin.category)
    if (plugin.stars) facts.push('★' + plugin.stars)
    if (plugin.downloads) facts.push('↓' + plugin.downloads)
    facts.push(installed ? '已装' : '未装')
    lines.push('')
    lines.push(index + 1 + '. ' + plugin.name + ' · ' + facts.join(' · '))
    const description = brief(pick(plugin.description), 170)
    if (description) lines.push('   ' + description)
    if (spec) {
      const remote = /^(github:|https?:|[A-Za-z]:\\|\/)/.test(spec)
      lines.push('   spec: ' + spec + (remote ? '   ← 非 npm 源，本机 git 直连 GitHub 常超时' : ''))
    }
  })
  if (result.rows.length) {
    lines.push('')
    lines.push('直接用上面的 spec 调 extend_install({ "spec": "<spec>" })。')
  }
  for (const note of result.notes) lines.push('· ' + note)
  return lines.join('\n')
}

function renderInstall(spec, result) {
  const head = {
    applied: '已安装并生效',
    'restart-required': '已安装，需重启 DSH',
    failed: '安装失败',
    cancelled: '已取消',
    overridden: '已安装但被更高优先级覆盖',
  }[result.application] || String(result.application)

  const lines = ['spec=' + spec + ' → ' + head]
  if (result.version) lines.push('版本：' + result.version)
  if (result.bundle) lines.push('bundle：' + result.bundle)
  if (result.restartReason) lines.push('重启原因：' + result.restartReason)
  if (result.error) {
    lines.push('错误：' + result.error.code + (result.error.diagnostic ? ' — ' + brief(result.error.diagnostic, 700) : ''))
    const incompatible = result.error.incompatible || []
    for (const item of incompatible) {
      lines.push('不兼容：' + item.name + '@' + item.version + ' 需 ' + JSON.stringify(item.requirements) + '，运行时 ' + item.runtimeVersion)
    }
  }
  if (result.pendingBuilds && result.pendingBuilds.length) {
    lines.push('待批准的构建脚本：' + result.pendingBuilds.join(', ') + '（要跑得先征得用户明确同意，再带 approvedBuilds 重试）')
  }
  if (result.warnings && result.warnings.length) lines.push('警告：' + result.warnings.join(' | '))
  if (result.application === 'applied') lines.push('→ 新工具现在就能用。')
  if (result.application === 'restart-required') lines.push('→ 重启 DSH 后生效。')
  return lines.join('\n')
}

const SCAFFOLD_INDEX = `export const name = __PKG__
export const inject = ['tools', 'systemPrompt']

const SECTION = __SLUG__
const text = (value) => [{ type: 'text', text: value }]

export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION,
    order: 900,
    text: __PROMPT__,
  }))

  ctx.effect(() => ctx.tools.register({
    name: __TOOL__,
    description: __TOOL_DESC__,
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Text passed to the tool.' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
    async execute(args) {
      return 'echo: ' + String(args.input || '')
    },
  }))
}
`

function scaffoldFiles(pkg, slug, title, description, toolName) {
  const prompt = '本插件提供 ' + toolName + '：' + (description || title) + '。需要时优先用它，别手工拼多步。'
  const toolDesc = description || 'Replace this with what the tool does and when to call it.'
  return {
    'package.json': JSON.stringify({
      name: pkg,
      version: '0.1.0',
      private: true,
      type: 'module',
      description,
      exports: { '.': './index.js', './icon.svg': './icon.svg', './locale/*.json': './locale/*.json' },
      files: ['index.js', 'cordis.patch.yml', 'icon.svg', 'locale'],
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2) + '\n',
    'cordis.patch.yml': '- insert:\n    - id: ' + slug + '\n      name: ' + pkg + '\n      config: {}\n',
    'index.js': SCAFFOLD_INDEX
      .replace('__PKG__', JSON.stringify(pkg))
      .replace('__SLUG__', JSON.stringify(slug))
      .replace('__PROMPT__', JSON.stringify(prompt))
      .replace('__TOOL__', JSON.stringify(toolName))
      .replace('__TOOL_DESC__', JSON.stringify(toolDesc)),
    'locale/en.json': JSON.stringify({ meta: { title, description } }, null, 2) + '\n',
    'locale/zh.json': JSON.stringify({ meta: { title, description } }, null, 2) + '\n',
    'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>\n',
    'README.md': '# ' + pkg + '\n\n' + description + '\n\n## 安装\n\n- 在本机：plugin_manager（action=install_bundle, target=<本目录绝对路径>），或 `dsh plugin add <本目录绝对路径>`\n- 即插即用：bundle patch 在 cordis.patch.yml，安装后自动补进 profile。\n\n## 开发\n\n改 index.js 后需重启 DSH（或重装该 bundle）才生效。\n',
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION,
    order: 900,
    text: POLICY,
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'extend_suggest',
    description: 'Find installable DSH plugins for a capability gap, a repeated multi-step workflow, or glue code you were about to write yourself. Searches the awesome-dsh-plugin catalog (~6.9k entries) and annotates what is already installed. Call this before hand-writing a workaround or before proposing to build a plugin.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Capability in a few words, e.g. "pdf ocr", "browser screenshot", "git diff review".' },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Max candidates to print. Defaults to 8.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
    async execute(args) {
      const query = String(args.query ?? '').trim()
      if (!query) throw new Error('query is required')
      return renderSuggest(query, await suggest(ctx, args))
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'extend_install',
    description: 'Install a DSH plugin bundle by spec (npm name, absolute path, git address, or tarball) and report the exact activation outcome. The user has pre-authorized installing plugins when a real need exists, so do not ask again; prefer npm or local-path specs because git over GitHub often times out on this machine.',
    parameters: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'Install spec, e.g. "dsh-foo", "D:\\\\path\\\\to\\\\plugin", "github:owner/repo".' },
        enabled: { type: 'boolean', description: 'Activate the bundle after install. Defaults to true.' },
      },
      required: ['spec'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
    async execute(args) {
      const spec = String(args.spec ?? '').trim()
      if (!spec) throw new Error('spec is required')
      const manager = ctx.get('pluginManager')
      if (!manager) throw new Error('pluginManager service is unavailable')
      try {
        const result = await manager.installBundle(spec, { enabled: args.enabled !== false })
        return renderInstall(spec, result)
      } catch (error) {
        return 'spec=' + spec + ' → 安装抛错：' + msg(error)
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'extend_scaffold',
    description: 'Write a working DSH plugin skeleton (package.json + cordis.patch.yml + index.js + locale + icon + README) into a directory, then report the install command. Use when no existing plugin fits and the user approved building one; it only writes files and never installs.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Absolute destination directory, e.g. "D:\\\\work\\\\my-plugin".' },
        name: { type: 'string', description: 'Package name, e.g. "dsh-my-plugin" (the dsh- prefix is added when missing).' },
        summary: { type: 'string', description: 'One line describing what the plugin is for.' },
        tool_name: { type: 'string', description: 'Name of the example tool, e.g. "myplugin_run". Defaults to <slug>_hello.' },
      },
      required: ['dir', 'name'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
    async execute(args) {
      const dir = String(args.dir ?? '').trim()
      const raw = String(args.name ?? '').trim()
      if (!dir) throw new Error('dir is required')
      if (!raw) throw new Error('name is required')
      const pkg = raw.startsWith('dsh-') ? raw : 'dsh-' + raw
      const slug = pkg.replace(/^dsh-/, '')
      const title = slug.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
      const description = String(args.summary ?? '').trim() || title + ' plugin'
      const toolName = String(args.tool_name ?? '').trim() || slug.replace(/-/g, '_') + '_hello'

      const files = scaffoldFiles(pkg, slug, title, description, toolName)
      await mkdir(join(dir, 'locale'), { recursive: true })
      const written = []
      for (const [relative, content] of Object.entries(files)) {
        await writeFile(join(dir, relative), content, 'utf8')
        written.push(relative)
      }

      return [
        '已生成骨架：' + dir,
        '文件：' + written.join(', '),
        '包名：' + pkg + '　bundle id：' + slug + '　示例工具：' + toolName,
        '',
        '下一步：',
        '1. 改 index.js（示例工具是回显，按需要重写 execute 与参数）。',
        '2. 用 plugin_manager（action=install_bundle, target=' + JSON.stringify(dir) + '）安装并启用；或 dsh plugin add ' + dir,
        '3. 装完看 application：applied 即生效；restart-required 需重启 DSH。',
      ].join('\n')
    },
  }))
}
