/**
 * 工具输出契约表。
 *
 * 工具定义里只写契约名（如 `output: 'TEXT_SUMMARY'`），schema + render 集中在这里。
 * 契约名重复、缺 schema/render 会在模块加载时直接抛错——启动自检依赖这张表。
 */

/** 工具执行结果被渲染成什么给模型看；返回值是 ContentBlock 数组。 */
const TEXT_SUMMARY = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: String(value?.summary ?? JSON.stringify(value)) }],
}

const CONTRACT_DEFINITIONS = [['TEXT_SUMMARY', TEXT_SUMMARY]]

/**
 * 由定义列表构建契约表：名字唯一 + 形状合法是硬约束，违反直接 throw。
 * @param {Array<[string, {schema: object, render: Function}]>} definitions
 * @returns {Map<string, {name: string, schema: object, render: Function}>}
 */
export function buildContracts(definitions) {
  const table = new Map()
  for (const [name, definition] of definitions) {
    if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new TypeError(`工具输出契约名不合规（要大写字母+下划线）：${String(name)}`)
    }
    if (table.has(name)) throw new TypeError(`工具输出契约重名：${name}`)
    if (!definition || typeof definition.schema !== 'object' || definition.schema === null) {
      throw new TypeError(`工具输出契约 ${name} 缺 schema`)
    }
    if (definition.schema.type !== 'object') {
      throw new TypeError(`工具输出契约 ${name} 的 schema 必须是 object`)
    }
    if (typeof definition.render !== 'function') {
      throw new TypeError(`工具输出契约 ${name} 缺 render 函数`)
    }
    table.set(name, Object.freeze({ name, schema: Object.freeze(definition.schema), render: definition.render }))
  }
  return table
}

/** 所有工具可引用的输出契约。 */
export const TOOL_CONTRACTS = buildContracts(CONTRACT_DEFINITIONS)
