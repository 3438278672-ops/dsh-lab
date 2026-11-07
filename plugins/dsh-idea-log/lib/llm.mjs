/**
 * DSH `llm` 服务的薄封装：把流式 chunk 收成一段文本。
 *
 * llm 是可选服务（ctx.get('llm')），插件不把它列进 inject，
 * 所以每次用的时候现取；没配模型时给出能看懂的错误。
 */

export function getLlm(ctx) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get('llm') ?? null
    return ctx?.llm ?? null
  } catch {
    return null
  }
}

/** 列出所有 provider × model 组合（有的 provider 暂时不可用时跳过）。 */
export async function listRoutes(llm) {
  const out = []
  const providers = llm?.listProviders?.() || []
  for (const p of providers) {
    try {
      const models = await llm.listModels(p.id)
      for (const m of models || []) {
        out.push({ provider: p.id, providerName: p.name || p.id, model: m.id, modelName: m.name || m.id })
      }
    } catch {
      /* 单个 provider 列不出来不影响别的 */
    }
  }
  return out
}

/** 配置里点名了就用点名的，否则用第一个可用的。 */
export function pickRoute(routes, wanted) {
  if (!routes.length) return null
  if (wanted?.provider) {
    const exact = routes.find((r) => r.provider === wanted.provider && (!wanted.model || r.model === wanted.model))
    if (exact) return exact
    const sameProvider = routes.find((r) => r.provider === wanted.provider)
    if (sameProvider) return sameProvider
  }
  return routes[0]
}

/**
 * 流式调用收全文。
 * @returns {Promise<{text:string, usage:object|null}>}
 */
export async function streamText(llm, { provider, model, system, prompt, temperature = 0.4, maxTokens = 800, signal, onDelta } = {}) {
  if (!llm) throw new Error('DSH 的 llm 服务不可用（插件没拿到 ctx.get("llm")）')
  if (!provider || !model) throw new Error('没有可用的模型：请先配置 llm.provider / llm.model，或在 DSH 里启用一个模型')

  const stream = llm.stream({
    provider,
    model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    temperature,
    maxTokens,
    signal,
  })

  let text = ''
  let usage = null
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
      onDelta?.(chunk.text)
    } else if (chunk.type === 'usage') {
      usage = chunk.usage
    } else if (chunk.type === 'finish') {
      const reason = chunk.reason
      if (reason?.kind === 'error') {
        throw new Error(`模型调用失败：${reason.failure?.message || reason.failure?.code || '未知错误'}`)
      }
      if (reason?.kind === 'aborted') throw new Error('模型调用被中断')
      if (reason?.kind === 'max-tokens' && !text.trim()) throw new Error('模型输出被截断且没有内容，调大 maxTokens 再试')
    }
  }
  return { text, usage }
}
