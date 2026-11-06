// Standalone smoke test: register the plugin against a fake host ctx and run read-only tools.
import { apply } from './index.js'

const tools = new Map()
const ctx = {
  tools: {
    register(def) {
      tools.set(def.name, def)
      return () => tools.delete(def.name)
    },
  },
  effect(fn) {
    const dispose = fn()
    return () => dispose?.()
  },
  get(name) {
    if (name === 'attachments') {
      return {
        async saveImage() {
          throw new Error('no attachments service in this test')
        },
      }
    }
    return undefined
  },
}

apply(ctx, {})
console.log('tools registered:', [...tools.keys()].join(', '))

for (const [name, args] of [
  ['phone_screen', {}],
  ['phone_ui', { max: 12 }],
  ['phone_app', { action: 'current' }],
]) {
  const def = tools.get(name)
  try {
    const value = await def.execute(args)
    const blocks = def.output.render(args, value)
    const summary = blocks
      .map((block) =>
        block.type === 'text'
          ? block.text
          : `[image block ${JSON.stringify(block.attachment ?? block).slice(0, 120)}]`,
      )
      .join('\n')
    console.log(`\n=== ${name} ok ===\n${summary.slice(0, 1200)}`)
  } catch (error) {
    console.log(`\n=== ${name} FAILED ===\n${error?.stack || error}`)
  }
}
