// 「名字 → 推特/微博/B站」这一层的离线测试：喂假的搜索结果，不联网、不碰 SauceNAO。
// 跑法：node test/social.mjs

import assert from 'node:assert/strict'
import { __internals } from '../index.js'

const { socialFromSource, searchSocialByName, setWebSearch } = __internals

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
  return searchSocialByName(['阿薰kaOri']).then((found) => assert.equal(found.length, 0))
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
  const found = await searchSocialByName(['阿薰kaOri'])
  assert.equal(found.length, 1)
  assert.equal(found[0].platform, 'twitter')
  assert.equal(found[0].handle, 'kaori_cos')
  assert.equal(found[0].confidence, 'inferred')
})

await ok('同一次结果里不会重复报同一个号', async () => {
  setWebSearch(async () => ({
    sources: [
      { url: 'https://x.com/kaori_cos', title: '阿薰kaOri 的主页' },
      { url: 'https://x.com/kaori_cos/status/9', title: '阿薰kaOri 发了一条' },
    ],
  }))
  const found = await searchSocialByName(['阿薰kaOri'])
  assert.equal(found.length, 1)
})

await ok('搜不到时安静返回空数组', async () => {
  setWebSearch(async () => ({ sources: [] }))
  assert.deepEqual(await searchSocialByName(['某某']), [])
})

console.log(`\n${passed} 项通过`)
