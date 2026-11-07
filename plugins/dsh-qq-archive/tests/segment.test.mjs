import test from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, charTokens, charPhrases, ftsTerms, ftsAnd, ftsOr, escapeLike } from '../lib/segment.mjs'

test('中文按词切分，词典里的词能整词出来', () => {
  const words = tokenize('今天下午三点在牌店打牌')
  assert.ok(words.split(' ').includes('打牌'))
  assert.ok(words.split(' ').includes('今天'))
})

test('单字索引把字母、数字、汉字拆成单字并用空格连接', () => {
  assert.equal(charTokens('打牌'), '打 牌')
  assert.equal(charTokens('OPCG-01'), 'O P C G 0 1')
  assert.equal(charTokens('a  b'), 'a b')
  assert.equal(charTokens('[图片]'), '图 片')
})

test('查询按标点/空白分段，每段变成单字短语，段间 AND', () => {
  assert.equal(charPhrases('卡组'), '"卡 组"')
  assert.equal(charPhrases('opcg 卡组'), '"o p c g" "卡 组"')
  assert.equal(charPhrases('打牌，谁去？'), '"打 牌" "谁 去"')
  assert.equal(charPhrases('   '), null)
})

test('ftsAnd / ftsOr 给每个词加引号，特殊字符不会带偏 MATCH 语法', () => {
  assert.equal(ftsAnd('打牌'), '"打牌"')
  assert.equal(ftsOr('打牌 opcg'), '"打牌" OR "opcg"')
  // 词典外词可能被切成两段，但每段都必须是独立加引号的短语
  for (const w of ftsTerms('打牌 组队')) assert.match(w, /^[\p{L}\p{N}]+$/u)
  assert.equal(ftsAnd(''), null)
})

test('LIKE 转义', () => {
  assert.equal(escapeLike('50%_a'), '50\\%\\_a')
})
