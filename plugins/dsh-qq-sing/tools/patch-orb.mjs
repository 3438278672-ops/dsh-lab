#!/usr/bin/env node
// 把「点歌排单」卡片重新接回 dsh-orb 悬浮球页面。
//
// 为什么需要它：dsh-orb 升级/重装会覆盖 dist\helper\assets 下的 floating.html，
// 页面补丁（CSP + qqsing-queue.js）随之消失。本脚本幂等：
//   - 改 floating.html：CSP 放行 http://127.0.0.1:31877、在 shell.js 后注入 qqsing-queue.js；
//   - 把 tools/qqsing-queue.js 复制到 orb 的 assets 目录；
//   - 第一次打补丁前留 floating.html.bak-qqsing 备份。
// dsh-orb 升级后重跑一次即可恢复：node tools/patch-orb.mjs
//
// 用法：
//   node tools/patch-orb.mjs                 # 自动找 ~/.dsh/profiles/*/node_modules/dsh-orb
//   node tools/patch-orb.mjs --orb-dir D:\...\dsh-orb
//   node tools/patch-orb.mjs --dry-run       # 只检查，不写文件
//   node tools/patch-orb.mjs --force         # 已打过也重新写一遍（升级后一般不需要）
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_JS = join(HERE, 'qqsing-queue.js')
const MARK_START = '<!-- qqsing-card:start (managed by dsh-qq-sing/tools/patch-orb.mjs) -->'
const MARK_END = '<!-- qqsing-card:end -->'
const SCRIPT_TAG = '<script type="module" src="qqsing-queue.js"></script>'
const CSP_TOKEN = 'http://127.0.0.1:31877'

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}
const hasFlag = (name) => process.argv.includes(name)

function findOrbDir() {
  const explicit = argValue('--orb-dir')
  if (explicit) return resolve(explicit)
  const base = join(homedir(), '.dsh', 'profiles')
  if (!existsSync(base)) return null
  for (const profile of readdirSync(base)) {
    const dir = join(base, profile, 'node_modules', 'dsh-orb')
    if (existsSync(join(dir, 'dist', 'helper', 'assets', 'floating.html'))) return dir
  }
  return null
}

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

const dryRun = hasFlag('--dry-run')
const force = hasFlag('--force')

const orbDir = findOrbDir()
if (!orbDir) fail('找不到 dsh-orb（可用 --orb-dir 指定安装目录）')

const assets = join(orbDir, 'dist', 'helper', 'assets')
const floatingPath = join(assets, 'floating.html')
const queuePath = join(assets, 'qqsing-queue.js')
const backupPath = join(assets, 'floating.html.bak-qqsing')

if (!existsSync(floatingPath)) fail(`缺少 ${floatingPath}`)
if (!existsSync(SRC_JS)) fail(`缺少 ${SRC_JS}`)

let html = readFileSync(floatingPath, 'utf8')
const patched = html.includes(SCRIPT_TAG)
const cspOk = html.includes(CSP_TOKEN)

console.log(`orb: ${orbDir}`)
console.log(`floating.html: ${patched ? '已注入 qqsing-queue.js' : '原版'}，CSP ${cspOk ? '已放行' : '未放行'}`)

if (patched && cspOk && existsSync(queuePath) && !force) {
  // 防御：页面补丁在、但 assets 里的脚本丢了（升级常见），补写脚本即可。
  console.log('✓ 补丁已是最新，无需改动（--force 可强制重写）')
  process.exit(0)
}

// 1) CSP：connect-src 放行本机只读端点
if (!cspOk) {
  const before = html
  html = html.replace(
    /(connect-src 'self' dsh-app:\/\/app)(?=[;"])/,
    `$1 ${CSP_TOKEN}`,
  )
  if (html === before) fail('CSP 行没匹配上（dsh-orb 版本可能变了），请人工检查 floating.html:6')
}

// 2) 页面注入：只放一个 <script type="module">，卡片 DOM 由脚本自建
const block = `${MARK_START}\n    ${SCRIPT_TAG}\n    ${MARK_END}`
if (html.includes(MARK_START) && html.includes(MARK_END)) {
  html = html.replace(new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`), block)
} else if (!html.includes(SCRIPT_TAG)) {
  const anchor = '<script type="module" src="shell.js"></script>'
  if (!html.includes(anchor)) fail('找不到 shell.js 的 script 标签，无法确定注入点')
  html = html.replace(anchor, `${anchor}\n    ${block}`)
}

if (dryRun) {
  console.log('（dry-run）将写入：')
  console.log(`  ${floatingPath}`)
  console.log(`  ${queuePath}`)
  process.exit(0)
}

// 3) 备份（只在第一次、且当前文件是原版时留一份干净的）
if (!patched && !existsSync(backupPath)) {
  copyFileSync(floatingPath, backupPath)
  console.log(`✓ 已备份原版 → ${backupPath}`)
}

writeFileSync(floatingPath, html, 'utf8')
copyFileSync(SRC_JS, queuePath)
console.log(`✓ 已写入 ${floatingPath}`)
console.log(`✓ 已写入 ${queuePath}`)
console.log('')
console.log('下一步：重开悬浮球（或重启 DSH 里的 dsh-orb）让新页面生效。')
