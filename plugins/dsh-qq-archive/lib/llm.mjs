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
 *
 * 只把「调用失败/被中断」当错误抛；`finish.reason` 原样返回，
 * 由上层（通常是 generateText）决定预算不够时怎么重试。
 *
 * @returns {Promise<{text:string, usage:object|null, reason:object|null}>}
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
  let reason = null
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
      onDelta?.(chunk.text)
    } else if (chunk.type === 'usage') {
      usage = chunk.usage
    } else if (chunk.type === 'finish') {
      reason = chunk.reason || null
      if (reason?.kind === 'error') {
        throw new Error(`模型调用失败：${reason.failure?.message || reason.failure?.code || '未知错误'}`)
      }
      if (reason?.kind === 'aborted') throw new Error('模型调用被中断')
    }
  }
  return { text, usage, reason }
}

/**
 * 生成正文：输出预算不够时自动翻倍重试。
 *
 * 推理型模型会先花输出预算做「思考」，maxTokens 给小了会出现
 * `finish.reason=max-tokens 但正文为空`。所有调用点都走这里，
 * 从 base 预算起调，每次翻倍（封顶 8192），直到拿到非空且未被
 * 截断的正文；只对「预算不够」重试，别的错误直接抛。
 *
 * @param {object} llm
 * @param {object} opts 同 streamText，另加 maxTokens（起始预算）/attempts
 * @returns {Promise<{text:string, usage:object|null, attempts:number, truncated:boolean}>}
 */
export async function generateText(llm, { maxTokens = 900, attempts = 4, ...opts } = {}) {
  const base = Math.max(1, Number(maxTokens) || 900)
  const cap = 8192
  let budget = base
  let best = ''
  let usage = null
  let truncated = false
  for (let i = 0; i < attempts; i++) {
    const result = await streamText(llm, { ...opts, maxTokens: budget })
    const text = String(result.text || '').trim()
    usage = result.usage || usage
    truncated = result.reason?.kind === 'max-tokens'
    if (text) best = text
    if (text && !truncated) return { text, usage, attempts: i + 1, truncated: false }
    if (!truncated) {
      if (best) return { text: best, usage, attempts: i + 1, truncated: false }
      throw new Error('模型没有返回内容')
    }
    // 预算被思考吃光：下次翻倍再来，尽量拿到完整正文
    if (budget >= cap) break
    budget = Math.min(cap, budget * 2)
  }
  if (best) return { text: best, usage, attempts, truncated: true }
  throw new Error('模型在最大输出预算内没有返回正文（输出预算被思考占满），请调大 maxTokens 或换一个模型')
}
