/**
 * 数据目录（home）契约：
 *   - 显式 home > QQ_ARCHIVE_HOME > 生产默认 ~/.dsh/qq-archive；
 *   - 测试进程（node --test）里没有显式目录时直接抛 ArchiveHomeError，
 *     绝不猜测用户真实档案；
 *   - openArchive 必须拿到非空目录，空值不再静默回退；
 *   - `npm test` 整套跑在 --import 注入的临时沙箱里（HOME/USERPROFILE/
 *     QQ_ARCHIVE_HOME 全指向临时目录），漏传 home 的装配也写不到真实档案。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ArchiveHomeError, isTestProcess, mergeConfig, resolveHome } from '../lib/config.mjs'
import { openArchive } from '../lib/db.mjs'
import { defaultHome } from '../lib/util.mjs'

const SANDBOX = process.env.QQ_ARCHIVE_TEST_SANDBOX
const NO_SANDBOX = '只在 npm test（--import tests/setup-sandbox.mjs）下生效'

test('resolveHome：显式 home 优先于 QQ_ARCHIVE_HOME 与默认值', () => {
  const explicit = join(tmpdir(), 'qqa-explicit')
  const fromEnv = join(tmpdir(), 'qqa-from-env')
  assert.equal(
    resolveHome({
      home: explicit,
      env: { QQ_ARCHIVE_HOME: fromEnv },
      testProcess: false,
      fallback: () => join(tmpdir(), 'qqa-fallback'),
    }),
    explicit,
  )
})

test('resolveHome：没有显式 home 时用 QQ_ARCHIVE_HOME', () => {
  const fromEnv = join(tmpdir(), 'qqa-from-env')
  assert.equal(
    resolveHome({ env: { QQ_ARCHIVE_HOME: fromEnv }, testProcess: false, fallback: () => join(tmpdir(), 'qqa-fallback') }),
    fromEnv,
  )
})

test('resolveHome：测试进程没有显式目录时拒绝猜测默认目录', () => {
  const defaultValue = join(tmpdir(), 'qqa-real-default')
  assert.throws(
    () => resolveHome({ env: {}, testProcess: true, fallback: () => defaultValue }),
    (error) =>
      error instanceof ArchiveHomeError &&
      error.code === 'ARCHIVE_HOME_UNAVAILABLE' &&
      error.message.includes(defaultValue) &&
      error.message.includes('QQ_ARCHIVE_HOME'),
  )
})

test('resolveHome：生产进程仍回退到 defaultHome()', () => {
  assert.equal(resolveHome({ env: {}, testProcess: false }), defaultHome())
})

test('isTestProcess：识别 runner、测试子进程与普通进程', () => {
  assert.equal(isTestProcess({}, []), false)
  assert.equal(isTestProcess({}, ['--inspect']), false)
  assert.equal(isTestProcess({ NODE_TEST_CONTEXT: 'child-v8' }, []), true)
  assert.equal(isTestProcess({}, ['--test']), true)
  assert.equal(isTestProcess({}, ['--test-isolation=process']), true)
})

test('mergeConfig：显式 home 原样保留，不被默认值覆盖', () => {
  const home = join(tmpdir(), 'qqa-explicit-merge')
  assert.equal(mergeConfig({ home }).home, home)
})

test('mergeConfig：QQ_ARCHIVE_HOME 作为解析结果', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qqa-env-merge-'))
  const saved = process.env.QQ_ARCHIVE_HOME
  process.env.QQ_ARCHIVE_HOME = home
  try {
    assert.equal(mergeConfig({}).home, home)
  } finally {
    if (saved === undefined) delete process.env.QQ_ARCHIVE_HOME
    else process.env.QQ_ARCHIVE_HOME = saved
    await rm(home, { recursive: true, force: true })
  }
})

test('mergeConfig：测试进程没有显式目录时抛 ArchiveHomeError', () => {
  const savedContext = process.env.NODE_TEST_CONTEXT
  const savedHome = process.env.QQ_ARCHIVE_HOME
  process.env.NODE_TEST_CONTEXT = 'child-v8'
  delete process.env.QQ_ARCHIVE_HOME
  try {
    assert.throws(
      () => mergeConfig({}),
      (error) => error instanceof ArchiveHomeError && error.code === 'ARCHIVE_HOME_UNAVAILABLE',
    )
  } finally {
    if (savedContext === undefined) delete process.env.NODE_TEST_CONTEXT
    else process.env.NODE_TEST_CONTEXT = savedContext
    if (savedHome === undefined) delete process.env.QQ_ARCHIVE_HOME
    else process.env.QQ_ARCHIVE_HOME = savedHome
  }
})

test('openArchive：拒绝空 home，不再静默落到任何默认目录', () => {
  for (const home of ['', undefined, '   ', null]) {
    assert.throws(() => openArchive(home), (error) => error instanceof TypeError && error.message.includes('显式'))
  }
})

test('openArchive：显式 home 的库只建在该目录里', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qqa-open-'))
  try {
    const archive = openArchive(home)
    try {
      assert.equal(archive.path, join(home, 'archive.db'))
      assert.ok(existsSync(archive.path))
    } finally {
      archive.db.close()
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('npm test 默认跑在临时沙箱里（HOME/USERPROFILE/QQ_ARCHIVE_HOME 全指向临时目录）', {
  skip: SANDBOX ? false : NO_SANDBOX,
}, () => {
  assert.ok(SANDBOX.startsWith(tmpdir()), `沙箱应在 tmpdir 下：${SANDBOX}`)
  assert.equal(process.env.QQ_ARCHIVE_HOME, join(SANDBOX, 'qq-archive'))
  assert.equal(process.env.HOME, SANDBOX)
  assert.equal(process.env.USERPROFILE, SANDBOX)
})

test('沙箱里 apply 漏传 home 也只写临时目录', { skip: SANDBOX ? false : NO_SANDBOX }, async () => {
  const { apply } = await import('../index.js')
  const toolDefs = new Map()
  const disposers = []
  const ctx = {
    logger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
    tools: {
      register(definition) {
        toolDefs.set(definition.name, definition)
        return () => toolDefs.delete(definition.name)
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    get() {
      throw new Error('隔离装配不该取别的服务')
    },
    webServer: null,
  }

  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = () => ({ unref() {} })
  try {
    // 故意不传 home：过去会落真实档案，现在应落到沙箱的 QQ_ARCHIVE_HOME
    apply(ctx, { syncIntervalMin: 0, source: 'json', sourcePath: join(SANDBOX, 'missing-source.json') })
  } finally {
    globalThis.setTimeout = realSetTimeout
  }

  try {
    assert.ok(toolDefs.has('qq_archive'))
    const result = await toolDefs.get('qq_archive').execute({ action: 'status' })
    assert.equal(result.ok, true)
    assert.equal(result.path, join(process.env.QQ_ARCHIVE_HOME, 'archive.db'))
    assert.ok(result.path.startsWith(SANDBOX), `库文件应落在沙箱里：${result.path}`)
    assert.ok(existsSync(result.path))
  } finally {
    for (const dispose of disposers.reverse()) dispose?.()
  }
})
