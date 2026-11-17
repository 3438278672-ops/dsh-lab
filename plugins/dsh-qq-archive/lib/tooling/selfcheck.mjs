/**
 * 工具注册自检。
 *
 * 自动发现的代价是「坏文件只有跑起来才知道」，所以注册前先把所有工具定义
 * 逐条验一遍，问题聚合后一次性报出来（而不是第一个错就抛、或者注册一半留脏状态）。
 * 任何一条不通过都算插件加载失败：宁可整组工具不出现，也不要出现一半、或者
 * 悄悄把参数 schema 写坏导致模型永远调不动。
 */

/** 自检失败：problems 是全部问题，按「文件: 问题」排好序，便于直接看日志。 */
export class ToolRegistryError extends Error {
  constructor(problems) {
    const list = problems.map((p, i) => `  ${i + 1}. ${p}`).join('\n')
    super(`qq-archive 工具注册自检未通过（${problems.length} 处）：\n${list}`)
    this.name = 'ToolRegistryError'
    this.problems = problems
  }
}

const NAME_RE = /^[a-z][a-z0-9_]*$/
const FILE_RE = /^[a-z][a-z0-9_]*\.mjs$/
const PROBE = { summary: '自检探针' }

/**
 * 校验一组工具定义。
 * @param {Array<{file: string, definition: object}>} entries
 * @param {{contracts: Map<string, {schema: object, render: Function}>, namePrefix?: string}} options
 * @returns {string[]} 问题列表（空数组=全部通过）
 */
export function validateToolDefinitions(entries, { contracts, namePrefix = '' } = {}) {
  const problems = []
  const contractTable = contracts instanceof Map ? contracts : new Map(Object.entries(contracts || {}))
  const contractNames = [...contractTable.keys()].sort().join('、')
  const seenNames = new Map()

  for (const entry of entries) {
    const file = entry?.file || '(未知文件)'
    const where = `tools/${file}`
    const definition = entry?.definition
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      problems.push(`${where}: 没有导出工具定义对象`)
      continue
    }

    // 文件名与工具名一一对应：加工具=加一个同名文件，不用再两头改
    const expectedName = file.replace(/\.mjs$/, '')
    if (!FILE_RE.test(file)) problems.push(`${where}: 文件名不合规（要小写字母/数字/下划线 + .mjs）`)
    if (typeof definition.name !== 'string' || !NAME_RE.test(definition.name)) {
      problems.push(`${where}: name 不合规：${JSON.stringify(definition.name)}（要小写字母/数字/下划线）`)
    } else {
      if (definition.name !== expectedName) {
        problems.push(`${where}: name「${definition.name}」与文件名不一致（应同名）`)
      }
      if (seenNames.has(definition.name)) {
        problems.push(`工具名重复：${definition.name}（${seenNames.get(definition.name)} 与 ${where}）`)
      } else {
        seenNames.set(definition.name, where)
      }
      if (namePrefix && !definition.name.startsWith(namePrefix)) {
        problems.push(`${where}: name「${definition.name}」缺少插件前缀「${namePrefix}」`)
      }
    }

    if (typeof definition.description !== 'string' || !definition.description.trim()) {
      problems.push(`${where}: description 不能为空（模型靠它决定要不要调）`)
    }

    // parameters：必须是 object schema，required 里的字段必须真的声明过
    const parameters = definition.parameters
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
      problems.push(`${where}: parameters 必须是 JSON schema 对象`)
    } else {
      if (parameters.type !== 'object') problems.push(`${where}: parameters.type 必须是 "object"`)
      const properties = parameters.properties
      if (properties === undefined || properties === null) {
        problems.push(`${where}: parameters 缺少 properties`)
      } else if (typeof properties !== 'object' || Array.isArray(properties)) {
        problems.push(`${where}: parameters.properties 必须是对象`)
      } else {
        for (const [key, schema] of Object.entries(properties)) {
          if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
            problems.push(`${where}: 参数「${key}」的 schema 必须是对象`)
          }
        }
        if (parameters.required !== undefined) {
          if (!Array.isArray(parameters.required)) {
            problems.push(`${where}: parameters.required 必须是数组`)
          } else {
            for (const key of parameters.required) {
              if (!Object.prototype.hasOwnProperty.call(properties, key)) {
                problems.push(`${where}: required 里的「${key}」没有在 properties 里声明`)
              }
            }
          }
        }
      }
    }

    if (definition.timeoutMs !== undefined) {
      if (!Number.isInteger(definition.timeoutMs) || definition.timeoutMs <= 0) {
        problems.push(`${where}: timeoutMs 必须是正整数，当前 ${JSON.stringify(definition.timeoutMs)}`)
      }
    }

    if (typeof definition.execute !== 'function') {
      problems.push(`${where}: execute 必须是函数`)
    }

    // 输出契约：工具只引用名字，这里确认名字存在且真能渲染出文本块
    if (typeof definition.output !== 'string') {
      problems.push(`${where}: output 必须写契约名（如 'TEXT_SUMMARY'），不要直接内联对象`)
    } else if (!contractTable.has(definition.output)) {
      problems.push(`${where}: 引用了不存在的输出契约「${definition.output}」（可用：${contractNames}）`)
    } else {
      const contract = contractTable.get(definition.output)
      let blocks
      try {
        blocks = contract.render({}, PROBE)
      } catch (e) {
        problems.push(`${where}: 输出契约「${definition.output}」渲染探针时抛错：${e?.message || e}`)
      }
      if (!Array.isArray(blocks) || !blocks.length) {
        problems.push(`${where}: 输出契约「${definition.output}」没有渲染出内容块`)
      } else if (blocks.some((b) => !b || b.type !== 'text' || typeof b.text !== 'string')) {
        problems.push(`${where}: 输出契约「${definition.output}」渲染出了非 text 内容块`)
      }
    }
  }

  return problems
}
