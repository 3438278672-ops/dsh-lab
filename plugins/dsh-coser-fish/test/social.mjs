// 「名字 → 推特/微博/B站」这一层的离线测试：喂假的搜索结果，不联网、不碰 SauceNAO。
// 跑法：node test/social.mjs

import assert from 'node:assert/strict'
import { __internals } from '../index.js'
import { cacheGet, cachePut, formatReply } from '../src/fish-find-chicken.js'

const { FIND_VERSION, NAME_SEARCH_STAGES, cacheKeyOf, rankAccounts, socialFromSource, searchSocialByName, setWebSearch } = __internals

let passed = 0
async function ok(name, fn) {
  await fn()
  passed += 1
  console.log(`✓ ${name}`)
}

// ── 链接识别 ──────────────────────────────────────────────────────────────
await ok('x.com 状态页 → 推特 handle', () => {
  const hit = socialFromSource({ url: 'https://x.com/amabox2001/status/123' })
  assert.deepEqual(hit, { platform: 'twitter', handle: 'amabox2001', url: 'https://x.com/amabox2001' })
})

await ok('twitter.com 主页 → 推特 handle', () => {
  assert.equal(socialFromSource({ url: 'https://twitter.com/cos_fire_17' })?.handle, 'cos_fire_17')
})

await ok('/i/web/status 这类保留段不当 handle', () => {
  assert.equal(socialFromSource({ url: 'https://x.com/i/web/status/1' }), null)
})

await ok('粉丝站标题里的「（@handle）」也能捞出来', () => {
  const hit = socialFromSource({
    url: 'https://twfan.net/user/2791535917/new/1',
    title: 'ふぁいあ（@cos_fire_17）さんの人気ツイート',
  })
  assert.equal(hit?.platform, 'twitter')
  assert.equal(hit?.handle, 'cos_fire_17')
})

await ok('weibo.com/u/<uid> → 微博', () => {
  const hit = socialFromSource({ url: 'https://weibo.com/u/1234567890' })
  assert.equal(hit?.platform, 'weibo')
  assert.equal(hit?.url, 'https://weibo.com/u/1234567890')
})

await ok('space.bilibili.com/<mid> → B站', () => {
  const hit = socialFromSource({ url: 'https://space.bilibili.com/12345678' })
  assert.equal(hit?.platform, 'bilibili')
  assert.equal(hit?.handle, '12345678')
})

await ok('instagram 主页 → Instagram', () => {
  assert.equal(socialFromSource({ url: 'https://instagram.com/some_coser' })?.platform, 'instagram')
})

await ok('普通文章链接不报账号', () => {
  assert.equal(socialFromSource({ url: 'https://zhuanlan.zhihu.com/p/123', title: '某 coser 的图' }), null)
})

// ── 名字门槛：标题里没有这个名字就不认（宁缺毋滥） ────────────────────────
await ok('标题里没有同名 → 不采纳', () => {
  setWebSearch(async () => ({ sources: [{ url: 'https://x.com/someone_else', title: '完全不相关' }] }))
  return searchSocialByName(['阿薰kaOri']).then((result) => assert.equal(result.accounts.length, 0))
})

await ok('标题里有同名 → 采纳并标 inferred', async () => {
  setWebSearch(async (query) => {
    if (query.startsWith('阿薰kaOri')) {
      return {
        sources: [{ url: 'https://twfan.net/user/1/new', title: '阿薰kaOri（@kaori_cos）的推特' }],
      }
    }
    return { sources: [] }
  })
  const { accounts } = await searchSocialByName(['阿薰kaOri'])
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].platform, 'twitter')
  assert.equal(accounts[0].handle, 'kaori_cos')
  assert.equal(accounts[0].confidence, 'inferred')
})

await ok('同一次结果里不会重复报同一个号', async () => {
  setWebSearch(async () => ({
    sources: [
      { url: 'https://x.com/kaori_cos', title: '阿薰kaOri 的主页' },
      { url: 'https://x.com/kaori_cos/status/9', title: '阿薰kaOri 发了一条' },
    ],
  }))
  const { accounts } = await searchSocialByName(['阿薰kaOri'])
  assert.equal(accounts.length, 1)
})

await ok('搜不到时安静返回空数组', async () => {
  setWebSearch(async () => ({ sources: [] }))
  assert.deepEqual((await searchSocialByName(['某某'])).accounts, [])
})

// ── 「先 X、X 没有才降级微博 / B站」的链路 ────────────────────────────────
await ok('阶梯定义：X 是唯一的第一级', () => {
  assert.deepEqual(NAME_SEARCH_STAGES[0], ['twitter'])
  assert.ok(!NAME_SEARCH_STAGES.flat().includes('pixiv'))
})

await ok('X 命中后不再搜微博', async () => {
  const queries = []
  setWebSearch(async (query) => {
    queries.push(query)
    if (query.includes('Twitter') || query.includes('site:x.com')) {
      return { sources: [{ url: 'https://x.com/kaori_cos', title: '阿薰kaOri 的主页' }] }
    }
    return { sources: [{ url: 'https://weibo.com/u/1234567890', title: '阿薰kaOri 的微博' }] }
  })
  const found = await searchSocialByName(['阿薰kaOri'])
  assert.equal(found.accounts.length, 1)
  assert.equal(found.accounts[0].platform, 'twitter')
  assert.ok(!queries.some((query) => query.includes('微博')), `X 已有结果却还搜了微博：${queries.join(' | ')}`)
})

await ok('X 全空才降级微博，并采纳微博号', async () => {
  const queries = []
  setWebSearch(async (query) => {
    queries.push(query)
    if (query.includes('微博')) {
      return { sources: [{ url: 'https://weibo.com/u/1234567890', title: '阿薰kaOri 的微博' }] }
    }
    return { sources: [] }
  })
  const found = await searchSocialByName(['阿薰kaOri'])
  assert.equal(found.accounts.length, 1)
  assert.equal(found.accounts[0].platform, 'weibo')
  assert.ok(queries.some((query) => query.includes('微博')), 'X 全空时应该降级搜微博')
})

await ok('整级跑完才降级：第二个名字的 X 命中也不去搜微博', async () => {
  const queries = []
  setWebSearch(async (query) => {
    queries.push(query)
    if (query.startsWith('第二个')) {
      return { sources: [{ url: 'https://x.com/second_one', title: '第二个（@second_one）' }] }
    }
    return { sources: [] }
  })
  const found = await searchSocialByName(['第一个', '第二个'])
  assert.equal(found.accounts[0]?.handle, 'second_one')
  assert.ok(!queries.some((query) => query.includes('微博')), `不该搜微博：${queries.join(' | ')}`)
})

await ok('X 阶段搜到微博链接不采纳（平台严格隔离）', async () => {
  setWebSearch(async () => ({
    sources: [{ url: 'https://weibo.com/u/1234567890', title: '阿薰kaOri 的微博' }],
  }))
  const found = await searchSocialByName(['阿薰kaOri'], { stages: [['twitter']] })
  assert.deepEqual(found.accounts, [])
})

await ok('搜索服务不可用时 ok=false（不能谎称「X 上没搜到」）', async () => {
  setWebSearch(async () => {
    throw new Error('宿主没有 ctx.web 服务')
  })
  const result = await searchSocialByName(['阿薰kaOri'])
  assert.deepEqual(result.accounts, [])
  assert.equal(result.ok, false)
  assert.equal(result.queries, 0)
})

// ── 展示排序：X 永远压过 Pixiv ────────────────────────────────────────────
await ok('缓存 key 带结论口径版本（口径一变旧缓存自动失效）', () => {
  const key = cacheKeyOf(Buffer.from('fake-image'), ['saucenao', 'tracemoe'])
  assert.match(key, new RegExp(`:${FIND_VERSION}:`))
  assert.ok(key.endsWith(":saucenao,tracemoe"), `引擎要排序后入 key：${key}`)
})

await ok('cacheGet：结论版本对不上就当没缓存', () => {
  const cache = cachePut({}, 'k', { accounts: [] }, Date.now(), { version: FIND_VERSION - 1 })
  assert.equal(cacheGet(cache, 'k', Date.now(), { cacheDays: 30, version: FIND_VERSION }), null)
  assert.ok(cacheGet(cache, 'k', Date.now(), { cacheDays: 30, version: FIND_VERSION - 1 }))
  // 旧条目（没有 version 字段）也不能冒充新结论
  const legacy = { k: { at: Date.now(), result: { accounts: [] } } }
  assert.equal(cacheGet(legacy, 'k', Date.now(), { cacheDays: 30, version: FIND_VERSION }), null)
})

await ok('rankAccounts：推断的 X 号排在 direct 的 Pixiv 前', () => {
  const ranked = rankAccounts([
    { platform: 'pixiv', handle: '12345', confidence: 'direct', evidence: { similarity: 0.95 } },
    { platform: 'twitter', handle: 'kaori_cos', confidence: 'inferred' },
  ])
  assert.equal(ranked[0].platform, 'twitter')
  assert.equal(ranked[1].platform, 'pixiv')
})

await ok('rankAccounts：同平台 direct 压过 inferred', () => {
  const ranked = rankAccounts([
    { platform: 'twitter', handle: 'a', confidence: 'inferred' },
    { platform: 'twitter', handle: 'b', confidence: 'direct', evidence: { similarity: 0.4 } },
  ])
  assert.equal(ranked[0].handle, 'b')
})

await ok('formatReply：只剩 Pixiv 时标明「非本人社交号」', () => {
  const text = formatReply({
    accounts: [{ platform: 'pixiv', handle: '12345', url: 'https://pixiv.net/users/12345', confidence: 'direct' }],
    xSearch: { tried: true, found: 0 },
  })
  assert.match(text, /不是 coser 本人的社交号/)
})

await ok('formatReply：搜索服务不可用时说「没能搜 X」而不是「没搜到」', () => {
  const text = formatReply({
    accounts: [{ platform: 'pixiv', handle: '12345', url: 'https://pixiv.net/users/12345', confidence: 'direct' }],
    xSearch: { tried: true, found: 0, searched: false },
  })
  assert.match(text, /没能搜 X/)
  assert.doesNotMatch(text, /按作者名没搜到号/)
})

await ok('formatReply：X 在列表里时不再加「没搜到」提示', () => {
  const text = formatReply({
    accounts: [{ platform: 'twitter', handle: 'kaori_cos', url: 'https://x.com/kaori_cos', confidence: 'inferred' }],
    xSearch: { tried: true, found: 1 },
  })
  assert.doesNotMatch(text, /不是 coser 本人的社交号/)
})

console.log(`\n${passed} 项通过`)
