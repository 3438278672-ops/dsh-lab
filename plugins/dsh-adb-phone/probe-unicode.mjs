// Probe what text-injection paths this phone actually supports.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const p = promisify(execFile)
const ADB = process.env.ADB || 'adb'
const S = '699dd23e'

async function run(label, args, encoding = 'utf8') {
  try {
    const { stdout, stderr } = await p(ADB, ['-s', S, ...args], { timeout: 30000, maxBuffer: 64 * 1024 * 1024, encoding })
    const out = String(stdout).trim()
    const err = String(stderr).trim()
    console.log(`--- ${label} [ok]\n${out.slice(0, 900)}${err ? `\n[stderr] ${err.slice(0, 400)}` : ''}\n`)
  } catch (error) {
    console.log(`--- ${label} [exit ${error.code}]\n${String(error.stdout || '').trim().slice(0, 500)}\n[stderr] ${String(error.stderr || '').trim().slice(0, 600)}\n`)
  }
}

await run('ime list -s', ['shell', 'ime list -s'])
await run('default ime', ['shell', 'settings get secure default_input_method'])
await run('cmd clipboard', ['shell', 'cmd clipboard'])
await run('cmd -l | clip', ['shell', 'cmd -l | grep -i clip'])
await run('service list | clipboard', ['shell', 'service list | grep -i clip'])
await run('input text CJK', ['shell', 'input text 你好'])
await run('keyboard-ish packages', ['shell', 'pm list packages | grep -iE "keyboard|adbkey|inputmethod"'])
await run('sdk', ['shell', 'getprop ro.build.version.sdk'])
