/**
 * lib/llm.mjs 的预算重试：推理模型常把输出预算先花在「思考」上，
 * streamText 只收文本，generateText 负责在 max-tokens 时翻倍预算重来。
 *
 * 这里用假 llm 精确控制每次 stream 的产出，盯三件事：
 *   1. 空正文 + max-tokens → 预算翻倍重试；
 *   2. 有正文但被截断 → 也重试，拿到完整正文；
 *   3. 其他错误 / 一直截断 → 直接报错或带 truncated 返回，不无限重试。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { generateText, streamText } from '../lib/llm.mjs'

/** 按脚本逐次产出 chunk 的假 llm。plans[i] = { text, reason }，超出就重复用最后一项。 */
function fakeLlm(plans) {
  const calls = []
  let i = 0
  const pick = () => plans[Math.min(i++, plans.length - 1)]
  return {
    calls,
    llm: {
      listProviders: () => [{ id: 'fake', name: 'Fake' }],
      listModels: async () => [{ id: 'm', name: 'M' }],
      stream(opts) {
        calls.push(opts)
        const plan = pick()
        return (async function* () {
          if (plan.text) yield { type: 'text-delta', text: plan.text }
          if (plan.usage) yield { type: 'usage', usage: plan.usage }
          if (plan.throw) throw new Error(plan.throw)
          yield { type: 'finish', reason: plan.reason || { kind: 'stop' } }
        })()
      },
    },
  }
}

const BASE = { provider: 'fake', model: 'm', system: 's', prompt: 'p' }

test('streamText：收全文、透传 usage 与 finish.reason', async () => {
  const { llm } = fakeLlm([{ text: '好的', usage: { input: 3, output: 2 }, reason: { kind: 'stop' } }])
  const r = await streamText(llm, { ...BASE, maxTokens: 100 })
  assert.equal(r.text, '好的')
  assert.deepEqual(r.usage, { input: 3, output: 2 })
  assert.deepEqual(r.reason, { kind: 'stop' })
})

test('generateText：空正文被截断时预算翻倍重试，拿到正文即返回', async () => {
  const { llm, calls } = fakeLlm([
    { text: '', reason: { kind: 'max-tokens' } },
    { text: '第二把成了', reason: { kind: 'stop' } },
  ])
  const r = await generateText(llm, { ...BASE, maxTokens: 700 })
  assert.equal(r.text, '第二把成了')
  assert.equal(r.attempts, 2)
  assert.equal(r.truncated, false)
  assert.deepEqual(calls.map((c) => c.maxTokens), [700, 1400])
})

test('generateText：有正文但被截断也重试；预算封顶 8192', async () => {
  const { llm, calls } = fakeLlm([
    { text: '前半段', reason: { kind: 'max-tokens' } },
    { text: '完整正文', reason: { kind: 'stop' } },
  ])
  const r = await generateText(llm, { ...BASE, maxTokens: 4000 })
  assert.equal(r.text, '完整正文')
  assert.equal(r.truncated, false)
  assert.deepEqual(calls.map((c) => c.maxTokens), [4000, 8000])

  // 起始预算已经在封顶附近：只按 8192 试一次，文本仍被截断就如实返回 truncated
  const capped = fakeLlm([{ text: '还是被截断', reason: { kind: 'max-tokens' } }])
  const r2 = await generateText(capped.llm, { ...BASE, maxTokens: 8192 })
  assert.equal(r2.text, '还是被截断')
  assert.equal(r2.truncated, true)
  assert.equal(capped.calls.length, 1)
})

test('generateText：一直「截断且无正文」时按次数停止并报可读错误', async () => {
  const { llm, calls } = fakeLlm([{ text: '', reason: { kind: 'max-tokens' } }])
  await assert.rejects(generateText(llm, { ...BASE, maxTokens: 700, attempts: 4 }), /最大输出预算/)
  assert.deepEqual(calls.map((c) => c.maxTokens), [700, 1400, 2800, 5600])
})

test('generateText：非「预算不够」的错误不重试，直接抛', async () => {
  const { llm, calls } = fakeLlm([{ text: '', reason: { kind: 'error', failure: { message: '上游 502' } } }])
  await assert.rejects(generateText(llm, { ...BASE, maxTokens: 700 }), /上游 502/)
  assert.equal(calls.length, 1)
})

test('generateText：模型一个字都没吐且正常结束 → 报「没有返回内容」', async () => {
  const { llm } = fakeLlm([{ text: '   ', reason: { kind: 'stop' } }])
  await assert.rejects(generateText(llm, { ...BASE, maxTokens: 700 }), /没有返回内容/)
})
