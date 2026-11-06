// 本地冒烟测试：用假的 Cordis ctx 把插件跑起来，直接调工具 execute。
// 用法：node test/smoke.mjs [--find <图片路径|URL>] [--qq group:123 --msg 456]
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const pick = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : ''
}

const defs = new Map()
const fakeCtx = {
  effect(fn) {
    fn()
  },
  systemPrompt: { section() {} },
  tools: {
    register(def) {
      defs.set(def.name, def)
    },
  },
}

apply(fakeCtx, {})

const check = defs.get('fish_check')
const find = defs.get('fish_find')
console.log('注册的工具：', [...defs.keys()].join(', '))

if (!argv.includes('--no-check')) {
  const checkValue = await check.execute({})
  console.log('\n=== fish_check ===\n' + checkValue)
}

const image = pick('--find')
const qqKey = pick('--qq')
const messageId = pick('--msg')
if (image || messageId) {
  const args = messageId ? { qqKey, qqMessageId: messageId } : { image }
  const started = Date.now()
  const value = await find.execute(args)
  console.log(`\n=== fish_find（${((Date.now() - started) / 1000).toFixed(1)}s）===`)
  console.log(value.summary)
  console.log(JSON.stringify({ accounts: value.accounts, enginesUsed: value.enginesUsed, failures: value.failures, cached: value.cached, image: value.image }, null, 2))
}
