import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportFind, renderFindHtml, renderFindMarkdown } from '../lib/findexport.mjs'

const T0 = 1760000000
// 固定「导出时间」，让文件名与页脚可断言（new Date(2026, 10, 11, 19, 30) 是本地时间 2026-11-11 19:30）
const AT = new Date(2026, 10, 11, 19, 30, 0)

function sampleResult(overrides = {}) {
  return {
    ok: true,
    summary: '找到 2 条（精确）。',
    mode: 'chars',
    count: 2,
    coverage: '索引覆盖 5 条消息（2026-11-01 10:00 ~ 2026-11-11 19:30）',
    filters: {
      query: '打牌',
      chat: '群「测试群」',
      sender: '阿猫',
      from: '2026-11-01',
      to: '',
      kind: 'all',
      semantic: false,
    },
    hits: [
      {
        time: '2026-11-11 19:33',
        ts: T0 + 10,
        chat: '群「测试群」',
        chatKey: 'group:123',
        sender: '阿猫',
        senderId: '111',
        kind: 'text',
        text: '今天下午三点在牌店打牌，地址 https://example.com/牌店',
        replyTo: null,
        context: [{ time: '2026-11-11 19:32', sender: '阿狗', text: '你来吗' }],
      },
      {
        time: '2026-11-11 19:34',
        ts: T0 + 20,
        chat: '群「测试群」',
        chatKey: 'group:123',
        sender: '阿狗',
        senderId: '222',
        kind: 'text',
        text: '不来，我打牌打腻了',
        replyTo: null,
      },
    ],
    ...overrides,
  }
}

test('Markdown：标题、筛选条件、命中统计、每条一行、上下文与链接', () => {
  const md = renderFindMarkdown(sampleResult(), { generatedAt: AT })

  assert.ok(md.startsWith('# QQ 搜索导出'))
  assert.match(md, /- 导出时间：2026-11-11 19:30/)
  assert.match(md, /- 筛选条件：关键词：打牌 · 会话：群「测试群」 · 发送者：阿猫 · 起始时间：2026-11-01/)
  assert.match(md, /- 命中：2 条 · 检索模式：精确/)
  assert.match(md, /- 涉及：1 个会话 · 2 位发送者/)
  assert.match(md, /- 索引覆盖：索引覆盖 5 条消息（2026-11-01 10:00 ~ 2026-11-11 19:30）/)
  assert.match(md, /^## 命中$/m)
  assert.ok(
    md.includes('- 2026-11-11 19:33 · 群「测试群」 · 阿猫：今天下午三点在牌店打牌，地址 https://example.com/牌店'),
  )
  assert.ok(md.includes('- 2026-11-11 19:34 · 群「测试群」 · 阿狗：不来，我打牌打腻了'))
  assert.ok(md.includes('  - 上下文：2026-11-11 19:32 阿狗：你来吗'))

  const custom = renderFindMarkdown(sampleResult(), { title: '牌局回顾', generatedAt: AT })
  assert.ok(custom.startsWith('# 牌局回顾'))
})

test('Markdown：没有命中、没有筛选条件时的文案', () => {
  const md = renderFindMarkdown({ ok: true, mode: 'none', count: 0, hits: [], coverage: '' }, { generatedAt: AT })
  assert.match(md, /- 筛选条件：无（全库最近消息）/)
  assert.match(md, /- 命中：0 条 · 检索模式：无/)
  assert.match(md, /没有命中。换个关键词/)
})

test('Markdown：兼容 db 原始行形状，正文换行折叠成一行', () => {
  const md = renderFindMarkdown(
    {
      mode: 'fts',
      count: 1,
      coverage: '',
      hits: [
        {
          id: 7,
          ts: T0 + 10,
          chatKey: 'group:456',
          senderName: '阿鸡',
          kind: 'text',
          text: '第一行\n第二行',
          context: [{ ts: T0, senderName: '阿狗', text: '上文' }],
        },
      ],
    },
    { generatedAt: AT },
  )
  assert.match(md, /· 群 456 · 阿鸡：第一行 第二行/)
  assert.match(md, /  - 上下文：.*阿狗：上文/)
})

test('HTML：单文件、午夜墨配色、统计与命中列表', () => {
  const html = renderFindHtml(sampleResult(), { generatedAt: AT })

  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(html.includes('--paper:#0e0d0c'))
  assert.ok(html.includes('--ink:#ece2cf'))
  assert.ok(html.includes('--accent:#d4a04a'))
  assert.ok(html.includes('命中条数'))
  assert.ok(html.includes('检索模式'))
  assert.ok(html.includes('精确'))
  assert.ok(html.includes('涉及会话'))
  assert.ok(html.includes('<title>QQ 搜索导出</title>'))
  assert.ok(html.includes('今天下午三点在牌店打牌'))
  assert.ok(html.includes('id="q"'))
  assert.ok(html.includes('id="hits"'))
  assert.ok(
    html.includes('<a href="https://example.com/牌店" target="_blank" rel="noopener noreferrer">'),
  )
  assert.ok(html.includes('导出时间 2026-11-11 19:30'))
  assert.ok(html.includes('你来吗'))
})

test('HTML：消息正文/标题里的标签与 </script> 都被转义，内联 JSON 打不穿脚本', () => {
  const evilText = '看这个 <img src=x onerror=alert(1)> </script><script>alert(1)</script>'
  const result = sampleResult({
    hits: [
      {
        time: '2026-11-11 19:33',
        ts: T0 + 10,
        chat: '群「测试群」',
        sender: '阿猫',
        kind: 'text',
        text: evilText,
      },
    ],
  })
  const html = renderFindHtml(result, { title: '<script>alert("title")</script>', generatedAt: AT })

  // 静态列表是转义后的文本，不能出现可执行标签
  assert.ok(!html.includes('<img src=x'))
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.ok(!html.includes('<script>alert("title")</script>'))
  assert.ok(html.includes('&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;'))

  // 内联数据里所有 '<' 都变成了 \u003c，整页只有我们自己的一个 </script>
  assert.ok(html.includes('\\u003c/script>'))
  assert.equal(html.split('</script>').length - 1, 1)
})

test('HTML：没有命中时显示空状态且不渲染筛选框', () => {
  const html = renderFindHtml({ mode: 'none', count: 0, hits: [], coverage: '' }, { generatedAt: AT })
  assert.ok(html.includes('这次检索没有命中。'))
  assert.ok(!html.includes('id="q"'))
  assert.ok(!html.includes('id="hits"'))
})

test('exportFind：md 默认写到 home/exports，返回 path/bytes 且内容一致', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qq-archive-findexport-'))
  try {
    const result = exportFind({ home, result: sampleResult(), generatedAt: AT })
    assert.equal(result.path, join(home, 'exports', 'search-20261111-193000.md'))
    assert.ok(existsSync(result.path))
    const content = await readFile(result.path, 'utf8')
    assert.equal(result.bytes, Buffer.byteLength(content))
    assert.ok(content.startsWith('# QQ 搜索导出'))
    assert.ok(content.includes('今天下午三点在牌店打牌'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('exportFind：html 默认路径、outPath 覆盖与参数校验', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qq-archive-findexport-'))
  try {
    const html = exportFind({ home, result: sampleResult(), format: 'html', generatedAt: AT })
    assert.equal(html.path, join(home, 'exports', 'search-20261111-193000.html'))
    assert.ok((await readFile(html.path, 'utf8')).startsWith('<!doctype html>'))

    const custom = join(home, 'deep', 'nested', 'find.md')
    const overridden = exportFind({ home, result: sampleResult(), format: 'md', outPath: custom, generatedAt: AT })
    assert.equal(overridden.path, custom)
    assert.ok(existsSync(custom))

    assert.throws(() => exportFind({ home, result: sampleResult(), format: 'pdf' }), /不支持的导出格式/)
    assert.throws(() => exportFind({ result: sampleResult() }), /需要 home/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
