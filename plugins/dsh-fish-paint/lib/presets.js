// dsh-fish-paint · 画风预设、尺寸、质量词、默认负面词
//
// 只做纯函数：把调用方给的（可能很脏的）参数归一成 worker 能直接吃的 JSONL 请求。
// 规则：tag 去空、去重（大小写无关）、尺寸按 8 的倍数取整、变体数收敛到 1–maxVariants。

/** 正向质量词（Illustrious 向），anime / portrait / landscape 预设都会自动补上。 */
export const QUALITY = 'masterpiece, best quality, very aesthetic, absurdres'

/** 默认负面词（CONTRACT.md §4 钉死，别改）。 */
export const DEFAULT_NEGATIVE =
  'lowres, bad anatomy, bad hands, text, error, missing finger, extra digits, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, bad eyes, mutated'

/** 可用的画风预设名。 */
export const PRESET_NAMES = ['anime', 'portrait', 'landscape', 'sticker']

/**
 * 预设表。
 * - resize：生成后再缩放到的存图尺寸（sticker 1024² → 512²）；null 表示不缩放。
 */
export const PRESETS = {
  anime: { width: 1024, height: 1024, quality: QUALITY, extra: '', resize: null },
  portrait: { width: 832, height: 1216, quality: QUALITY, extra: '', resize: null },
  landscape: { width: 1216, height: 832, quality: QUALITY, extra: '', resize: null },
  sticker: {
    width: 1024,
    height: 1024,
    quality: QUALITY,
    extra: 'chibi, simple background, thick outline, vibrant colors',
    resize: { width: 512, height: 512 },
  },
}

/** 预设的一句话说明（给工具描述 / status 用）。 */
export function presetSummary() {
  return PRESET_NAMES.map((name) => {
    const preset = PRESETS[name]
    const size = preset.resize
      ? `${preset.width}×${preset.height}→存 ${preset.resize.width}×${preset.resize.height}`
      : `${preset.width}×${preset.height}`
    return `${name} ${size}`
  }).join(' / ')
}

/** 未知预设回落到 anime，避免调用方随便写个词就报错。 */
export function normalizePreset(name) {
  const key = typeof name === 'string' ? name.trim().toLowerCase() : ''
  return Object.prototype.hasOwnProperty.call(PRESETS, key) ? key : 'anime'
}

/**
 * 把 prompt / negative 切成 tag 数组。
 * 逗号（中英文）、顿号、换行都当分隔符；返回去空后的原始 tag（保留权重写法如 `(tag:1.2)`）。
 */
export function splitTags(input) {
  if (typeof input !== 'string') return []
  return input
    .split(/[,，、\n]+/)
    .map((tag) => tag.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
}

/**
 * tag 去重：大小写无关（`1Girl` 与 `1girl` 视为同一个），保留第一次出现的写法与顺序。
 * 这样调用方既写了质量词、preset 又补了一遍时不会出现重复 tag。
 */
export function dedupeTags(tags) {
  const seen = new Set()
  const out = []
  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const cleaned = tag.trim().replace(/\s+/g, ' ')
    if (!cleaned) continue
    const key = cleaned.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cleaned)
  }
  return out
}

/** tag 数组 → 逗号分隔的字符串。 */
export function joinTags(tags) {
  return dedupeTags(tags).join(', ')
}

/** 尺寸按 8 取整并夹到 [256, 2048]。 */
export function roundSize(value, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  const snapped = Math.round(num / 8) * 8
  return Math.min(2048, Math.max(256, snapped))
}

function clampInt(value, min, max, fallback) {
  const num = Math.trunc(Number(value))
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

function clampFloat(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

/** seed：-1 / 空 / 负数 = 随机；其余取整并夹到 SD 的 32 位 seed 区间。 */
export function normalizeSeed(value) {
  if (value === undefined || value === null || value === '') return -1
  const num = Math.trunc(Number(value))
  if (!Number.isFinite(num) || num < 0) return -1
  return Math.min(4294967295, num)
}

/**
 * 参数归一：补质量词 / 预设追加词 / 默认负面词 / 尺寸，去重，算 resize。
 *
 * @param {object} input
 * @param {string} [input.preset]     预设名，未知回落 anime
 * @param {string} [input.prompt]     正向 tag（调用方负责翻译成英文 danbooru tags）
 * @param {string} [input.negative]   显式负面词；不传/空串 = 用 DEFAULT_NEGATIVE
 * @param {number} [input.width]      覆盖预设宽度（8 的倍数取整）
 * @param {number} [input.height]     覆盖预设高度
 * @param {number} [input.steps]      默认 28
 * @param {number} [input.cfg]        默认 5.5
 * @param {number} [input.seed]       -1/负数 = 随机
 * @param {number} [input.count]      变体数 1–maxVariants（也接受 variants 字段）
 * @param {number} [input.variants]   同上
 * @param {number} [input.maxVariants] 上限，默认 4
 * @returns {{preset:string,prompt:string,negative:string,width:number,height:number,steps:number,cfg:number,seed:number,count:number,clipSkip:number,resize:({width:number,height:number}|undefined)}}
 */
export function buildArgs(input = {}) {
  const presetName = normalizePreset(input.preset)
  const preset = PRESETS[presetName]

  const positive = dedupeTags([
    ...splitTags(preset.quality),
    ...splitTags(preset.extra),
    ...splitTags(input.prompt),
  ])

  const explicitNegative = typeof input.negative === 'string' ? input.negative.trim() : ''
  const negative = explicitNegative ? joinTags(splitTags(explicitNegative)) : DEFAULT_NEGATIVE

  const width = roundSize(input.width, preset.width)
  const height = roundSize(input.height, preset.height)
  const steps = clampInt(input.steps, 4, 80, 28)
  const cfg = clampFloat(input.cfg, 1, 20, 5.5)
  const seed = normalizeSeed(input.seed)
  const maxVariants = clampInt(input.maxVariants, 1, 4, 4)
  const count = clampInt(input.variants ?? input.count, 1, maxVariants, 1)

  // sticker 的存图尺寸由预设定义：生成 1024² 再缩到 512²（透明底不在 MVP）。
  const resize = preset.resize ? { width: preset.resize.width, height: preset.resize.height } : undefined

  return {
    preset: presetName,
    prompt: positive.join(', '),
    negative,
    width,
    height,
    steps,
    cfg,
    seed,
    count,
    clipSkip: 2,
    resize,
  }
}
