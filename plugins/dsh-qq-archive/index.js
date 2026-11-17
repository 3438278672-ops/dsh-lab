/**
 * 群聊档案馆（qq-archive）：把 QQ 聊天记录归档成可搜索、可分析、可看板的本地库。
 *
 * 零 npm 依赖：只用 node:sqlite（FTS5）+ Intl.Segmenter + node:http。
 * 默认只读 SnowLuma 的 messages.db，归档库放在插件 home 目录（见 config.mjs）。
 *
 * 结构：
 * - 本文件只留插件元信息 + apply 装配；
 * - tools/<工具名>.mjs 每个文件一个工具（schema + execute），由 lib/tooling/registry.mjs 自动发现；
 * - lib/runtime.mjs 持有 archive/source/board 生命周期、同步、定时任务和推送；
 * - lib/tooling/selfcheck.mjs 在注册前校验工具定义，有问题直接让插件加载失败。
 */
import { createArchiveRuntime } from './lib/runtime.mjs'
import { loadToolModules, registerTools } from './lib/tooling/registry.mjs'

export const name = 'qq-archive'
export const inject = ['tools', 'webServer']

/** 工具名统一前缀：自检会检查，避免和别的插件撞名。 */
export const TOOL_NAME_PREFIX = 'qq_'

// 启动时（模块加载期）就把工具模块读进来：apply 保持同步，
// 也保证工具文件写坏时插件直接加载失败、日志里能看全所有问题。
export const toolModules = await loadToolModules(new URL('./tools/', import.meta.url))

export function apply(ctx, config) {
  const runtime = createArchiveRuntime({ ctx, config })
  registerTools(ctx, toolModules, {
    runtime,
    namePrefix: TOOL_NAME_PREFIX,
    log: runtime.log,
  })
  runtime.start()
}
