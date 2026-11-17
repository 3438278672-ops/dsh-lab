/**
 * 工具模块的发现、构建与注册。
 *
 * 一个工具 = tools/ 下一个同名 .mjs 文件，export default (rt) => 工具定义。
 * 新增工具只要放文件；改错文件在插件加载时就会硬失败，不会注册一半。
 * `_` 开头的文件是工具间共享的辅助模块，不会被当成工具加载。
 */
import { readdir } from 'node:fs/promises'
import { TOOL_CONTRACTS } from './contracts.mjs'
import { ToolRegistryError, validateToolDefinitions } from './selfcheck.mjs'

const TOOL_SUFFIX = '.mjs'
const SHARED_PREFIX = '_'

/**
 * 扫描 tools/ 目录并 import 每个工具模块（按文件名排序，注册顺序稳定）。
 * @param {URL | string} dirUrl tools 目录
 * @returns {Promise<Array<{file: string, name: string, factory: Function}>>}
 */
export async function loadToolModules(dirUrl) {
  const dir = new URL(dirUrl)
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(TOOL_SUFFIX) && !entry.name.startsWith(SHARED_PREFIX))
    .map((entry) => entry.name)
    .sort()
  if (!entries.length) throw new ToolRegistryError([`工具目录为空：${dir.pathname}`])

  const modules = []
  for (const file of entries) {
    let mod
    try {
      mod = await import(new URL(file, dir).href)
    } catch (e) {
      throw new ToolRegistryError([`tools/${file}: 加载失败：${e?.stack || e?.message || e}`])
    }
    if (typeof mod.default !== 'function') {
      throw new ToolRegistryError([`tools/${file}: 必须 export default (rt) => 工具定义`])
    }
    modules.push({ file, name: file.slice(0, -TOOL_SUFFIX.length), factory: mod.default })
  }
  return modules
}

/**
 * 用运行时把模块构建成工具定义；工厂抛错同样聚合进 ToolRegistryError。
 * @param {Array<{file: string, factory: Function}>} modules
 * @param {object} runtime
 * @returns {Array<{file: string, definition: object}>}
 */
export function buildToolDefinitions(modules, runtime) {
  const problems = []
  const built = []
  for (const { file, factory } of modules) {
    try {
      built.push({ file, definition: factory(runtime) })
    } catch (e) {
      problems.push(`tools/${file}: 构建工具定义失败：${e?.stack || e?.message || e}`)
    }
  }
  if (problems.length) {
    const error = new ToolRegistryError(problems)
    // 这里是构建期，还没有 ctx 可用，交给调用方打印
    throw error
  }
  return built
}

/**
 * 构建、自检、注册。校验失败会 log.error 后 throw；成功返回已注册的工具名列表。
 */
export function registerTools(ctx, modules, { runtime, contracts = TOOL_CONTRACTS, namePrefix = '', log = console } = {}) {
  let built
  try {
    built = buildToolDefinitions(modules, runtime)
  } catch (error) {
    // 构建期没有 ctx 可用，日志只能在这里补；错误本身继续抛给插件加载器
    log.error?.(error.message)
    throw error
  }
  const problems = validateToolDefinitions(built, { contracts, namePrefix })
  if (problems.length) {
    const error = new ToolRegistryError(problems)
    log.error?.(error.message)
    throw error
  }
  for (const { definition } of built) {
    const contract = contracts.get(definition.output)
    ctx.effect(() => ctx.tools.register({ ...definition, output: contract }))
  }
  return built.map(({ definition }) => definition.name)
}
