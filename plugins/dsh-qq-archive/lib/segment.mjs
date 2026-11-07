/**
 * 中文分词 + FTS5 查询构造。
 *
 * 为什么不直接让 FTS5 自己切：unicode61 把连续中文当一个大 token，
 * trigram 又搜不到 2 字词。所以写入前用 Intl.Segmenter 预分词、空格连接，
 * 查询时走同一条分词路径，FTS5 只负责倒排和 bm25。
 */
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })

/** 把一段文本切成 FTS 可用的词串（空格连接）。 */
export function tokenize(text) {
  if (!text) return ''
  const out = []
  for (const part of segmenter.segment(String(text))) {
    if (!part.isWordLike) continue
    const w = part.segment.trim()
    if (!w) continue
    out.push(w)
  }
  return out.join(' ')
}

/** 分词后每个词加双引号，避免 MATCH 语法被用户输入的特殊字符带偏。 */
export function ftsTerms(text) {
  if (!text) return []
  const out = []
  for (const part of segmenter.segment(String(text))) {
    if (!part.isWordLike) continue
    const w = part.segment.trim()
    if (w) out.push(w)
  }
  return out
}

export function ftsAnd(text) {
  const words = ftsTerms(text)
  if (!words.length) return null
  return words.map((w) => '"' + w.replace(/"/g, '""') + '"').join(' ')
}

export function ftsOr(text) {
  const words = ftsTerms(text)
  if (!words.length) return null
  return words.map((w) => '"' + w.replace(/"/g, '""') + '"').join(' OR ')
}

export function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, (c) => '\\' + c)
}

/**
 * 字符级 token：所有字母/数字/汉字按单字空格分隔。
 *
 * 中文分词的词典外词（「卡组」→「卡」「组」）会让短语查询失真，
 * 单字倒排 + 短语查询等价于「连续子串」匹配，正好补上这个缺口。
 */
export function charTokens(text) {
  if (!text) return ''
  const out = []
  for (const ch of String(text)) {
    if (/[\p{L}\p{N}]/u.test(ch)) out.push(ch)
  }
  return out.join(' ')
}

const SPLIT_RE = /[\s,，。;；、!?！？:：/\\|()（）[\]【】"'“”‘’<>《》~`@#$%^&*+=_-]+/u

/** 把查询按空白/标点分段，每段变成「单字短语」，段间 AND。 */
export function charPhrases(query) {
  if (!query) return null
  const parts = String(query).split(SPLIT_RE).filter(Boolean)
  const out = []
  for (const part of parts) {
    const chars = []
    for (const ch of part) {
      if (/[\p{L}\p{N}]/u.test(ch)) chars.push(ch)
    }
    if (chars.length) out.push('"' + chars.join(' ') + '"')
  }
  return out.length ? out.join(' ') : null
}
