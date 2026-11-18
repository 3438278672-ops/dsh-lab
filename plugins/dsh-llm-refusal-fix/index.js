/**
 * dsh-llm-refusal-fix：接管 deepseek-account provider，修正 Messages 终止原因契约。
 *
 * 背景（上游 DSH 0.2.2 线）：
 * `@deepseek-ai/dsh-llm-deepseek` 的 `stopReason()` 只认 end_turn / stop_sequence /
 * tool_use / max_tokens，其余一律 `malformed('unsupported stop reason ...')` ->
 * MALFORMED_RESPONSE。但 Messages 协议里 refusal / pause_turn /
 * model_context_window_exceeded 都是合法终止原因；模型因内容安全审查拒答时，
 * 整个回合会被判成协议错误（MALFORMED_RESPONSE），QQ 桥这类把 error 原文转发给
 * 终端用户的面孔上就是一条「agent 处理出错」。
 *
 * 本 bundle 的做法（根治，不是特判字符串）：
 * - lib/adapter.js 是随 dsh 发布的 adapter 的能力等价副本，只改「终止原因 ->
 *   Harness 终止状态」这一层契约：refusal 映射为正常 stop，并把说明合成成一条
 *   text block（避免 EMPTY_RESPONSE，用户能看到为什么没回答）；pause_turn /
 *   cancelled / model_context_window_exceeded 也各归其位；未知值仍然报错。
 * - lib/account.js 是随 dsh 发布的 account provider 的副本，只改两处：
 *   适配器从 vendored 副本导入、settingsNs 固定为 llm-deepseek-account。
 * - cordis.patch.yml 禁用内置行并插入本 bundle 的行。
 *
 * 另外注册一个 `llm_refusal_fix_selftest` 工具：对 translate() 跑一组终止原因
 * fixture（含真实 refusal 事件形状），装完就能自检补丁是否生效。
 */
import { apply as applyAccountProvider, Config } from './lib/account.js'
import { translate } from './lib/adapter.js'

export { Config }

/** Cordis 插件名：与 patch 行的 id 一致，日志/设置里好认。 */
export const name = 'llm-deepseek-account-fix'

/** provider 注册需要 ctx.llm；自检工具注册需要 ctx.tools。 */
export const inject = ['llm', 'tools']

const OUTPUT_CONTRACT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: String(value?.summary ?? JSON.stringify(value)) }],
}

const START = { type: 'message_start', message: { usage: { input_tokens: 14631, output_tokens: 0 } } }

function textBlock(text) {
  return [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
  ]
}

function thinkingBlock(text) {
  return [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: text } },
    { type: 'content_block_stop', index: 0 },
  ]
}

async function collect(events) {
  const chunks = []
  try {
    for await (const chunk of translate(events, 'deepseek-flash')) chunks.push(chunk)
    return { chunks }
  } catch (error) {
    return { chunks, error }
  }
}

function finishOf(result) {
  return result.chunks.find((chunk) => chunk.type === 'finish')
}

function blocksOf(result) {
  return result.chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
}

const CASES = [
  {
    name: 'refusal-with-no-content-is-a-normal-stop',
    events: [
      START,
      { type: 'message_delta', delta: { stop_reason: 'refusal', stop_sequence: null }, usage: { output_tokens: 22 } },
      { type: 'message_stop' },
    ],
    check(result) {
      const finish = finishOf(result)
      const blocks = blocksOf(result)
      return (
        result.error === undefined &&
        finish?.reason?.kind === 'stop' &&
        blocks.length === 1 &&
        blocks[0].type === 'text' &&
        blocks[0].text.length > 0
      )
    },
  },
  {
    name: 'refusal-carries-stop-details-explanation',
    events: [
      START,
      {
        type: 'message_delta',
        delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', explanation: 'safety-review' } },
        usage: { output_tokens: 8 },
      },
      { type: 'message_stop' },
    ],
    check(result) {
      const blocks = blocksOf(result)
      return result.error === undefined && blocks.length === 1 && blocks[0].text.includes('safety-review')
    },
  },
  {
    name: 'refusal-after-thinking-keeps-order',
    events: [
      START,
      ...thinkingBlock('pondering'),
      { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 22 } },
      { type: 'message_stop' },
    ],
    check(result) {
      const blocks = blocksOf(result)
      return (
        result.error === undefined &&
        blocks.length === 2 &&
        blocks[0].type === 'reasoning' &&
        blocks[1].type === 'text' &&
        finishOf(result)?.reason?.kind === 'stop'
      )
    },
  },
  {
    name: 'pause-turn-is-terminal-not-malformed',
    events: [START, ...textBlock('partial answer'), { type: 'message_delta', delta: { stop_reason: 'pause_turn' } }, { type: 'message_stop' }],
    check(result) {
      return result.error === undefined && finishOf(result)?.reason?.kind === 'stop'
    },
  },
  {
    name: 'context-window-exceeded-maps-to-max-tokens',
    events: [
      START,
      ...textBlock('truncated answer'),
      { type: 'message_delta', delta: { stop_reason: 'model_context_window_exceeded' } },
      { type: 'message_stop' },
    ],
    check(result) {
      return result.error === undefined && finishOf(result)?.reason?.kind === 'max-tokens'
    },
  },
  {
    name: 'unknown-stop-reason-still-malformed',
    events: [START, { type: 'message_delta', delta: { stop_reason: 'banana' } }, { type: 'message_stop' }],
    check(result) {
      return result.error?.code === 'MALFORMED_RESPONSE'
    },
  },
  {
    name: 'plain-end-turn-unchanged',
    events: [START, ...textBlock('hello'), { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }],
    check(result) {
      return result.error === undefined && finishOf(result)?.reason?.kind === 'stop'
    },
  },
]

async function runSelfTest() {
  const results = []
  for (const testCase of CASES) {
    let pass = false
    let detail = ''
    try {
      const result = await collect(testCase.events)
      pass = testCase.check(result) === true
      if (!pass) detail = result.error ? `error: ${result.error.code ?? ''} ${result.error.message ?? result.error}` : `chunks: ${JSON.stringify(result.chunks).slice(0, 400)}`
    } catch (error) {
      detail = `threw: ${error?.message ?? error}`
    }
    results.push({ case: testCase.name, pass, detail })
  }
  const failed = results.filter((result) => !result.pass)
  return {
    ok: failed.length === 0,
    passed: results.length - failed.length,
    total: results.length,
    failed: failed.map((result) => result.case),
    cases: results,
    summary:
      failed.length === 0
        ? `refusal-fix selftest: ${results.length}/${results.length} PASS — 终止原因契约已修正`
        : `refusal-fix selftest: ${results.length - failed.length}/${results.length} PASS，失败：${failed.map((f) => `${f.case}（${f.detail}）`).join('；')}`,
  }
}

function registerSelfTest(ctx) {
  const definition = {
    name: 'llm_refusal_fix_selftest',
    description:
      '自检 dsh-llm-refusal-fix 补丁是否生效：对 Messages 适配器的 translate() 跑一组终止原因 fixture（refusal / refusal+stop_details / refusal 跟在 thinking 后 / pause_turn / model_context_window_exceeded / 未知值 / end_turn），逐条报告 PASS/FAIL。只读，不发网络请求。',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 30000,
    output: OUTPUT_CONTRACT,
    async execute() {
      return runSelfTest()
    },
  }
  ctx.effect(() => ctx.tools.register(definition))
}

export function apply(ctx, config) {
  applyAccountProvider(ctx, config)
  registerSelfTest(ctx)
}
