// lib/presets.js 的单测：参数归一、去重、预设尺寸、sticker resize。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_NEGATIVE,
  PRESETS,
  QUALITY,
  PRESET_NAMES,
  buildArgs,
  dedupeTags,
  joinTags,
  normalizePreset,
  normalizeSeed,
  roundSize,
  splitTags,
} from '../lib/presets.js'

test('buildArgs 默认：anime 1024²、质量词、默认负面词、默认采样参数', () => {
  const args = buildArgs({ prompt: '1girl, solo' })
  assert.equal(args.preset, 'anime')
  assert.equal(args.width, 1024)
  assert.equal(args.height, 1024)
  assert.equal(args.negative, DEFAULT_NEGATIVE)
  assert.equal(args.steps, 28)
  assert.equal(args.cfg, 5.5)
  assert.equal(args.seed, -1)
  assert.equal(args.count, 1)
  assert.equal(args.clipSkip, 2)
  assert.equal(args.resize, undefined)
  assert.ok(args.prompt.startsWith(QUALITY), '质量词应该在最前面')
  assert.ok(args.prompt.includes('1girl'))
  assert.ok(args.prompt.includes('solo'))
})

test('buildArgs 不重复质量词（调用方自己也写了 masterpeice 类词时去重）', () => {
  const args = buildArgs({ prompt: 'masterpiece, best quality, 1girl' })
  const occurrences = args.prompt.split(', ').filter((tag) => tag === 'masterpiece').length
  assert.equal(occurrences, 1)
})

test('预设：portrait / landscape 尺寸正确，sticker 追加词 + 512² resize', () => {
  assert.deepEqual([PRESETS.portrait.width, PRESETS.portrait.height], [832, 1216])
  assert.deepEqual([PRESETS.landscape.width, PRESETS.landscape.height], [1216, 832])

  const sticker = buildArgs({ preset: 'sticker', prompt: 'cat' })
  assert.equal(sticker.width, 1024)
  assert.equal(sticker.height, 1024)
  assert.deepEqual(sticker.resize, { width: 512, height: 512 })
  assert.ok(sticker.prompt.includes('chibi'))
  assert.ok(sticker.prompt.includes('thick outline'))
})

test('未知预设回落到 anime，预设名大小写不敏感', () => {
  assert.equal(normalizePreset('Sticker'), 'sticker')
  assert.equal(normalizePreset('oil-painting'), 'anime')
  assert.equal(normalizePreset(undefined), 'anime')
  assert.deepEqual(PRESET_NAMES, ['anime', 'portrait', 'landscape', 'sticker'])
})

test('尺寸按 8 取整并夹到 [256, 2048]', () => {
  assert.equal(roundSize(1100, 1024), 1104) // 137.5 → 138 * 8
  assert.equal(roundSize(1003, 1024), 1000) // 125.375 → 125 * 8
  assert.equal(roundSize(4096, 1024), 2048)
  assert.equal(roundSize(100, 1024), 256)
  assert.equal(roundSize(undefined, 832), 832)

  const args = buildArgs({ prompt: 'x', width: 1001, height: 777 })
  assert.equal(args.width % 8, 0)
  assert.equal(args.height % 8, 0)
})

test('seed 归一：空/负/NaN → -1，字符串数字 → 整数，超界截断', () => {
  assert.equal(normalizeSeed(undefined), -1)
  assert.equal(normalizeSeed(''), -1)
  assert.equal(normalizeSeed(-5), -1)
  assert.equal(normalizeSeed('123'), 123)
  assert.equal(normalizeSeed(1e12), 4294967295)
  assert.equal(buildArgs({ prompt: 'x', seed: 0 }).seed, 0)
})

test('variants 收敛 1–maxVariants，steps/cfg 夹到合法区间', () => {
  assert.equal(buildArgs({ prompt: 'x', variants: 9 }).count, 4)
  assert.equal(buildArgs({ prompt: 'x', variants: 0 }).count, 1)
  assert.equal(buildArgs({ prompt: 'x', variants: 3, maxVariants: 2 }).count, 2)
  assert.equal(buildArgs({ prompt: 'x', steps: 200 }).steps, 80)
  assert.equal(buildArgs({ prompt: 'x', steps: 1 }).steps, 4)
  assert.equal(buildArgs({ prompt: 'x', cfg: 99 }).cfg, 20)
  assert.equal(buildArgs({ prompt: 'x', cfg: -1 }).cfg, 1)
})

test('显式负面词追加在默认负面词之后，不能替换默认硬约束', () => {
  const merged = buildArgs({ prompt: 'x', negative: 'ugly, lowres' }).negative
  assert.ok(merged.startsWith(DEFAULT_NEGATIVE), '默认负面词应该在最前面，且完整保留')
  assert.ok(merged.endsWith('ugly'), '调用方追加的词在最后')
  assert.equal(merged.split(', ').filter((tag) => tag === 'lowres').length, 1, '重复 tag 去重')

  assert.equal(buildArgs({ prompt: 'x', negative: '   ' }).negative, DEFAULT_NEGATIVE)
  assert.equal(buildArgs({ prompt: 'x', negative: null }).negative, DEFAULT_NEGATIVE)

  // 手部/肢体的通用硬约束对每张图都生效
  for (const tag of ['extra fingers', 'fewer fingers', 'extra digits', 'extra limbs', 'bad proportions']) {
    assert.ok(buildArgs({ prompt: 'x' }).negative.includes(tag), `默认负面词缺少 ${tag}`)
  }
  assert.ok(buildArgs({ prompt: 'x' }).prompt.includes('perfect hands'), '正向质量词含 perfect hands')
})

test('中文逗号/顿号/换行都能切 tag，去重大小写无关', () => {
  assert.deepEqual(splitTags('1girl，solo、cat\ndog'), ['1girl', 'solo', 'cat', 'dog'])
  assert.deepEqual(dedupeTags(['1Girl', '1girl', ' solo ', 'Solo']), ['1Girl', 'solo'])
  assert.equal(joinTags(['a', 'A', 'b']), 'a, b')
})

test('buildArgs 返回的尺寸都是 8 的倍数，resize 也是', () => {
  for (const preset of PRESET_NAMES) {
    const args = buildArgs({ preset, prompt: 'x', width: 833, height: 1217 })
    assert.equal(args.width % 8, 0, `${preset} width`)
    assert.equal(args.height % 8, 0, `${preset} height`)
    if (args.resize) {
      assert.equal(args.resize.width % 8, 0)
      assert.equal(args.resize.height % 8, 0)
    }
  }
})
