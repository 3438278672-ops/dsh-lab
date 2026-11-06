/**
 * dsh-adb-phone —drive an adb-connected Android phone from DeepSeek Harness.
 *
 * Host-only plugin: resolves the adb binary + device serial, then exposes a small
 * set of `phone_*` tools (screen, ui, tap, swipe, type, key, app).
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-adb-phone'
export const inject = ['tools', 'attachments']

const execFileP = promisify(execFile)
const MAX_BUFFER = 128 * 1024 * 1024
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ adb --- */

const EXE = process.platform === 'win32' ? 'adb.exe' : 'adb'
let cachedAdb = null
let cachedSerial = null

function adbPath() {
  if (cachedAdb) return cachedAdb
  const candidates = []
  if (process.env.DSH_ADB_PATH) candidates.push(process.env.DSH_ADB_PATH)
  for (const key of ['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_SDK']) {
    const root = process.env[key]
    if (root) candidates.push(path.join(root, 'platform-tools', EXE))
  }
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Android', 'platform-tools', EXE))
  if (process.env.HOME || process.env.USERPROFILE) {
    candidates.push(path.join(os.homedir(), 'AppData', 'Local', 'Android', 'platform-tools', EXE))
  }
  cachedAdb = candidates.find((p) => p && existsSync(p)) || 'adb'
  return cachedAdb
}

async function serial(options = {}) {
  // The cached serial goes stale whenever the device reconnects (USB -> TCP, reboot, a second
  // device plugged in), so callers can force a re-read with serial({ refresh: true }).
  if (cachedSerial && options.refresh !== true) return cachedSerial
  if (options.refresh === true) cachedSerial = null
  const { stdout } = await execFileP(adbPath(), ['devices'], { timeout: 15000, maxBuffer: MAX_BUFFER })
  const online = String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\S+\s+device$/.test(line))
  if (online.length === 0) {
    cachedSerial = null
    throw new Error(`No adb device is online (adb: ${adbPath()}).\n${String(stdout).trim()}`)
  }
  cachedSerial = online[0].split(/\s+/)[0]
  return cachedSerial
}

/** Run adb with this plugin's device selected. Returns raw bytes + decoded text. */
function execAdb(target, args, options) {
  return execFileP(adbPath(), ['-s', target, ...args], {
    timeout: options.timeout ?? 40000,
    maxBuffer: MAX_BUFFER,
    encoding: 'buffer',
  })
}

/** adb -s <cached serial>: on a "device not found/offline" error, re-read the serial once and retry. */
async function adb(args, options = {}) {
  let target = await serial()
  let result
  try {
    result = await execAdb(target, args, options)
  } catch (error) {
    const message = String(error?.message ?? '')
    if (!/device (?:not found|offline|unauthorized)|no devices/i.test(message)) throw error
    cachedSerial = null
    target = await serial({ refresh: true })
    result = await execAdb(target, args, options)
  }
  const { stdout, stderr } = result
  return {
    buffer: stdout,
    text: stdout.toString('utf8'),
    warn: stderr.toString('utf8').trim(),
  }
}

/** Run one command through the device shell (adb joins the argv, so pass it unquoted). */
function sh(command, options) {
  return adb(['shell', command], options)
}

/* --------------------------------------------------------------- screen --- */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * `adb exec-out` multiplexes the device stdout and stderr into one stream, so
 * screencap's "[Warning] Multiple displays— preamble can precede the PNG.
 * Cut everything outside the PNG signature/IEND envelope.
 */
function extractPng(raw) {
  const start = raw.indexOf(PNG_SIGNATURE)
  if (start < 0) return null
  const end = raw.lastIndexOf(Buffer.from('IEND'))
  const buffer = end > start ? raw.subarray(start, end + 8) : raw.subarray(start)
  if (buffer.length < 24) return null
  return { buffer, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

let screenSeq = 0

/** A 1200x2608 PNG is ~1.5 MB: keep only the newest few so temp does not grow forever. */
async function pruneShots(dir, keep) {
  const names = (await readdir(dir)).filter((entry) => /^screen-\d+\.png$/.test(entry))
  if (names.length <= keep) return
  const ordered = names.sort((a, b) => Number(a.slice(7, -4)) - Number(b.slice(7, -4)))
  for (const stale of ordered.slice(0, ordered.length - keep)) {
    await unlink(path.join(dir, stale)).catch(() => {})
  }
}

async function grabScreen() {
  const { buffer: raw } = await adb(['exec-out', 'screencap', '-p'], { timeout: 45000 })
  const png = extractPng(raw)
  if (!png) {
    throw new Error(`screencap did not return a PNG (${raw.length} bytes): ${raw.toString('utf8').slice(0, 200)}`)
  }
  const dir = path.join(os.tmpdir(), 'dsh-phone')
  await mkdir(dir, { recursive: true })
  screenSeq = (screenSeq % 1000) + 1
  const file = path.join(dir, `screen-${screenSeq}.png`)
  await writeFile(file, png.buffer)
  await pruneShots(dir, 20).catch(() => {})
  return { file, bytes: png.buffer.length, width: png.width, height: png.height, data: png.buffer }
}

/* ------------------------------------------------------------------- ui --- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeXml(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body] ?? whole
  })
}

function attributes(raw) {
  const out = {}
  const pattern = /([\w:-]+)="([^"]*)"/g
  let match
  while ((match = pattern.exec(raw)) !== null) out[match[1]] = decodeXml(match[2])
  return out
}

function parseBounds(text) {
  const match = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(text || '')
  if (!match) return null
  const [x1, y1, x2, y2] = match.slice(1).map(Number)
  if (x2 <= x1 || y2 <= y1) return null
  return { x1, y1, x2, y2, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) }
}

/**
 * Last resort for summoning an app that the system only exposes as a launcher *shortcut*:
 * go home, read the tree, and tap the icon whose label matches. 小爱 on HyperOS 3 is exactly
 * this case — `am start -n` is refused even though tapping the icon works.
 */
async function tapHomeIcon(terms) {
  await sh('input keyevent 3').catch(() => {})
  await sleep(900)
  const nodes = await dumpUi().catch(() => [])
  const hit = nodes.find((node) => terms.some((term) => `${node.label} ${node.desc}`.includes(term)))
  if (!hit) return ''
  await sh(`input tap ${hit.box.cx} ${hit.box.cy}`)
  await sleep(1400)
  return `${hit.label || hit.desc} @${hit.box.cx},${hit.box.cy}`
}

async function dumpUi() {
  const remote = '/sdcard/_dsh_ui.xml'
  let lastError = ''
  // uiautomator refuses to dump while the window is animating ("could not get idle
  // state"), which happens right after a tap. Retry a couple of times before giving up.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await sh(`uiautomator dump ${remote}`, { timeout: 30000 })
      lastError = ''
      break
    } catch (error) {
      lastError = String(error?.stderr || error?.message || error)
      if (/dumped to/i.test(lastError)) {
        lastError = ''
        break
      }
      if (!/idle state|ERROR/i.test(lastError)) throw new Error(`uiautomator dump failed: ${lastError.slice(0, 400)}`)
      await delay(400)
    }
  }
  if (lastError) throw new Error(`uiautomator dump failed: ${lastError.slice(0, 400)}`)
  const { text } = await adb(['exec-out', 'cat', remote], { timeout: 30000 })
  const xml = text.slice(text.indexOf('<hierarchy'))
  if (!xml.startsWith('<hierarchy')) throw new Error(`unexpected uiautomator output: ${text.slice(0, 200)}`)

  const nodes = []
  const pattern = /<node\b([^>]*?)\/?>/g
  let match
  while ((match = pattern.exec(xml)) !== null) {
    const a = attributes(match[1])
    const box = parseBounds(a.bounds)
    if (!box) continue
    const label = (a.text || '').trim()
    const desc = (a['content-desc'] || '').trim()
    const clickable = a.clickable === 'true'
    const scrollable = a.scrollable === 'true'
    const longClickable = a['long-clickable'] === 'true'
    if (!label && !desc && !clickable && !scrollable) continue
    nodes.push({
      kind: (a.class || '').split('.').pop(),
      label,
      desc,
      id: a['resource-id'] ? a['resource-id'].split('/').pop() : '',
      pkg: a.package || '',
      clickable,
      scrollable,
      longClickable,
      box,
    })
  }
  return nodes
}

function formatUi(nodes, max) {
  const shown = nodes.slice(0, max)
  const lines = shown.map((node, index) => {
    const flags = [node.clickable ? 'tap' : '', node.scrollable ? 'scroll' : '', node.longClickable ? 'long' : '']
      .filter(Boolean)
      .join(',')
    const parts = [`${index + 1}. ${node.kind || 'node'}`]
    if (node.label) parts.push(JSON.stringify(node.label))
    if (node.desc) parts.push(`desc=${JSON.stringify(node.desc)}`)
    if (node.id) parts.push(`#${node.id}`)
    parts.push(`@${node.box.cx},${node.box.cy}`)
    if (flags) parts.push(`[${flags}]`)
    return parts.join(' ')
  })
  const tail = nodes.length > shown.length ? `\n—${nodes.length - shown.length} more (raise max to see them)` : ''
  return { text: lines.join('\n') + tail, total: nodes.length }
}

/* --------------------------------------------------------------- focus ---- */

const ACTIVITY = /([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/

/**
 * `dumpsys window` lists every display (this phone has a rear/sub screen next to
 * the main one), so report the LAST focused window —the active display —rather
 * than the first match, which is the idle secondary launcher.
 */
function parseFocus(output) {
  const text = String(output || '')
  const windows = [...text.matchAll(/mCurrentFocus=Window\{[^}]*?([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/g)]
  if (windows.length > 0) return windows[windows.length - 1][1]
  const apps = [...text.matchAll(/mFocusedApp=ActivityRecord\{[^}]*?([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/g)]
  if (apps.length > 0) return apps[apps.length - 1][1]
  const loose = ACTIVITY.exec(text)
  return loose ? loose[1] : ''
}

const FOCUS_COMMAND = 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"'

/* --------------------------------------------------------- screen state --- */

const WAKEUP = 224

/**
 * A sleeping phone swallows input: `input tap` lands nowhere and screencap replays
 * a stale frame, with no error either way. Ask the power service first.
 */
async function screenState() {
  const { text: out } = await sh('dumpsys power | grep -m1 -E "mWakefulness="', { timeout: 15000 }).catch(() => ({ text: '' }))
  const match = /mWakefulness=(\w+)/.exec(out)
  return match ? match[1] : null
}

/** Wake the device if it is asleep. Returns what it found, and whether it woke it. */
async function ensureAwake() {
  let state = await screenState()
  if (state === null || state === 'Awake') return { state, woke: false }
  await sh(`input keyevent ${WAKEUP}`).catch(() => {})
  await delay(700)
  state = await screenState()
  return { state, woke: true }
}

/* ------------------------------------------------------------------ text --- */

function asciiOnly(text) {
  return !/[^\x20-\x7e\n\r\t]/.test(text)
}

function shellQuote(text) {
  return `'${text.replace(/ /g, '%s').replace(/'/g, `'\\''`)}'`
}

/* ------------------------------------------------------------- assistant --- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function isAssistant(owner) {
  const focus = await focusLine()
  return Boolean(owner) && focus.includes(owner)
}

async function focusLine() {
  const focus = await sh(FOCUS_COMMAND, { timeout: 25000 }).catch(() => null)
  return focus ? parseFocus(focus.text) || 'unknown focus' : 'unknown focus'
}

/** Which package answers android.intent.action.ASSIST (without running it). */
async function assistantPackage() {
  const { text: output } = await sh('cmd package query-activities -a android.intent.action.ASSIST', {
    timeout: 30000,
  }).catch(() => ({ text: '' }))
  const match = output.match(/packageName=([\w.]+)/)
  return match ? match[1] : ''
}

/**
 * Launch a package, tolerating launchers monkey cannot drive (小爱 has a LAUNCHER
 * activity but `monkey -p` still aborts). Falls back to `am start -n pkg/activity`
 * using the component that `cmd package resolve-activity` reports.
 */
async function launchPackage(pkg) {
  const { text: output, warn } = await sh(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, {
    timeout: 30000,
  }).catch((error) => ({ text: '', warn: String(error?.message || error) }))
  if (!/No activities found|aborted|CRASH|Command failed/i.test(output + warn)) return 'monkey'

  const { text: resolved } = await sh(`dumpsys package ${pkg}`, { timeout: 30000 }).catch(() => ({ text: '' }))
  const lines = resolved.split(/\r?\n/)
  const pattern = new RegExp(`(${pkg.replace(/\./g, '\\.')}/[\\w.$]+)`)
  const candidates = []
  lines.forEach((line, index) => {
    const match = line.match(pattern)
    if (!match) return
    const window = lines.slice(index, index + 6).join('\n')
    if (!/android\.intent\.action\.MAIN/.test(window)) return
    // LAUNCHER first, then MONKEY (some ROMs ship the assistant as a monkey-only entry)
    if (/android\.intent\.category\.LAUNCHER/.test(window)) candidates.unshift(match[1])
    else if (/android\.intent\.category\.MONKEY/.test(window)) candidates.push(match[1])
  })
  const unique = [...new Set(candidates)]
  if (unique.length === 0) throw new Error(`could not resolve a launcher activity for ${pkg}`)

  let lastError = ''
  for (const component of unique) {
    try {
      await sh(`am start -n ${component}`, { timeout: 30000 })
      return `am start -n ${component}`
    } catch (error) {
      lastError = String(error?.message || error).split('\n').slice(-2).join(' ')
    }
  }
  throw new Error(`no activity of ${pkg} would start (${lastError.slice(0, 160)})`)
}

/* ------------------------------------------------------------------ keys --- */

const KEYS = {
  back: 4,
  home: 3,
  enter: 66,
  recents: 187,
  power: 26,
  wakeup: 224,
  sleep: 223,
  menu: 82,
  volume_up: 24,
  volume_down: 25,
  delete: 67,
  tab: 61,
  escape: 111,
  search: 84,
  camera: 27,
  assist: 219,
  voice: 231,
}

function keyCode(key) {
  const name = String(key).trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (KEYS[name] !== undefined) return KEYS[name]
  const numeric = Number(name)
  if (Number.isInteger(numeric) && numeric > 0) return numeric
  throw new Error(`Unknown key "${key}". Use one of: ${Object.keys(KEYS).join(', ')}, or a numeric keycode.`)
}

/* --------------------------------------------------------------- unicode --- */

const ADB_IME = 'com.android.adbkeyboard/.AdbIME'

async function imeList() {
  const { text: out } = await sh('ime list -s')
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

async function currentIme() {
  const { text: out } = await sh('settings get secure default_input_method')
  return out.trim()
}

/** Borrow the ADBKeyboard IME for the duration of `fn`, then hand it back. */
async function withAdbIme(fn) {
  const imes = await imeList()
  if (!imes.includes(ADB_IME)) {
    throw new Error(
      'The ADBKeyboard IME is not installed, so this cannot be typed. Install ADBKeyboard.apk from ' +
        'github.com/senzhk/ADBKeyBoard, then run `adb shell ime enable com.android.adbkeyboard/.AdbIME`.',
    )
  }
  const previous = await currentIme()
  const borrowed = previous !== ADB_IME
  if (borrowed) {
    await sh(`ime set ${ADB_IME}`, { timeout: 20000 })
    await delay(250)
  }
  try {
    return await fn()
  } finally {
    if (borrowed && previous) await sh(`ime set ${previous}`, { timeout: 20000 }).catch(() => {})
  }
}

/**
 * `adb shell input text` maps every character through the virtual keyboard's
 * KeyCharacterMap, which has no CJK entries —the shell command NPEs on 中文.
 * Non-ASCII (and any `clear`, which is an ADBKeyboard broadcast) therefore detours
 * through that IME: switch to it, broadcast, then hand the IME back.
 */
async function typeText(payload, options = {}) {
  const ascii = asciiOnly(payload)
  if (ascii && !options.clear) {
    await sh(`input text ${shellQuote(payload)}`)
    if (options.submit) await sh('input keyevent 66')
    return 'input text'
  }
  await withAdbIme(async () => {
    if (options.clear) {
      await sh('am broadcast -a ADB_CLEAR_TEXT', { timeout: 20000 })
      await delay(200)
    }
    if (ascii) {
      await sh(`input text ${shellQuote(payload)}`)
    } else {
      await sh(`am broadcast -a ADB_INPUT_B64 --es msg ${Buffer.from(payload, 'utf8').toString('base64')}`, { timeout: 20000 })
      await delay(150)
    }
    if (options.submit) {
      await delay(120)
      await sh('input keyevent 66')
    }
    await delay(120)
  })
  return ascii ? 'input text (borrowed ADBKeyboard to clear first)' : 'ADBKeyboard'
}

/* ---------------------------------------------------------------- tools ---- */

function text(value) {
  return [{ type: 'text', text: value }]
}

const SCREEN_PARAMS = {
  type: 'object',
  properties: {
    note: { type: 'string', description: 'Optional label echoed in the result text.' },
  },
  additionalProperties: false,
}

export function apply(ctx) {
  ctx.effect(() =>
    ctx.tools.register({
      name: 'phone_screen',
      description:
        'Screenshot the adb-connected Android phone and return it as an image. Use it to see what is on screen before deciding where to tap.',
      parameters: SCREEN_PARAMS,
      timeoutMs: 90000,
      output: {
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            path: { type: 'string' },
            width: { type: 'number' },
            height: { type: 'number' },
            image: { type: 'object', additionalProperties: true },
          },
          required: ['text', 'path'],
          additionalProperties: false,
        },
        render: (_args, value) => {
          if (!value || typeof value !== 'object') return text(String(value))
          const blocks = text(value.text || '')
          if (value.image) blocks.push({ type: 'image', attachment: value.image })
          return blocks
        },
      },
      async execute(args) {
        const wake = await ensureAwake().catch(() => ({ state: null, woke: false }))
        const shot = await grabScreen()
        const model = await sh(FOCUS_COMMAND, { timeout: 20000 }).catch(() => null)
        const focus = model ? parseFocus(model.text) : ''
        const label = args?.note ? `${args.note} —` : ''
        const flags = [
          wake.state ? `screen=${wake.state}` : '',
          wake.woke ? '(woke it)' : '',
          focus ? `focus=${focus}` : '',
        ].filter(Boolean).join(' ')
        const header = `${label}${shot.width}x${shot.height} png ${shot.bytes}B ${flags}\nfile=${shot.file}`

        const attachments = ctx.get('attachments')
        if (!attachments?.saveImage) return { text: header, path: shot.file, width: shot.width, height: shot.height }
        try {
          const ref = await attachments.saveImage({ data: shot.data, mediaType: 'image/png', name: 'phone-screen.png' })
          return { text: header, path: shot.file, width: shot.width, height: shot.height, image: ref }
        } catch (error) {
          return { text: `${header}\n(image attach failed: ${String(error?.message || error).slice(0, 200)})`, path: shot.file, width: shot.width, height: shot.height }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'phone_ui',
      description:
        'Dump the phone\'s on-screen accessibility tree as compact lines: `N. Kind "text" #id @x,y [tap]`. Tap coordinates are already the element centers.',
      parameters: {
        type: 'object',
        properties: {
          max: { type: 'number', description: 'Max elements to list (default 60).' },
          query: { type: 'string', description: 'Only keep elements whose text/desc/id contains this string (case-insensitive).' },
        },
        additionalProperties: false,
      },
      timeoutMs: 90000,
      output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
      async execute(args) {
        const max = Number.isFinite(args?.max) && args.max > 0 ? Math.floor(args.max) : 60
        const need = String(args?.query || '').trim().toLowerCase()
        const nodes = await dumpUi()
        const filtered = need
          ? nodes.filter((node) => `${node.kind} ${node.label} ${node.desc} ${node.id} ${node.pkg}`.toLowerCase().includes(need))
          : nodes
        const { text: body, total } = formatUi(filtered, max)
        const head = `${nodes.length} elements on screen${need ? `, ${total} matching ${JSON.stringify(args.query)}` : ''}`
        return body ? `${head}\n${body}` : `${head}\n(nothing interactive or labeled)`
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'phone_tap',
      description: 'Tap a screen coordinate on the phone. Coordinates come from phone_screen (image pixels) or phone_ui (@x,y).',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X pixel.' },
          y: { type: 'number', description: 'Y pixel.' },
          holdMs: { type: 'number', description: 'Optional hold duration for a long press (default: a normal tap).' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
      timeoutMs: 60000,
      output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
      async execute(args) {
        const x = Math.round(Number(args.x))
        const y = Math.round(Number(args.y))
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y must be numbers')
        const wake = await ensureAwake().catch(() => ({ state: null, woke: false }))
        const hold = Number(args.holdMs)
        const long = Number.isFinite(hold) && hold > 0
        const command = long ? `input swipe ${x} ${y} ${x} ${y} ${Math.round(hold)}` : `input tap ${x} ${y}`
        await sh(command)
        return `${long ? 'long-pressed' : 'tapped'} ${x},${y}${wake.woke ? ' (woke the screen first)' : ''}`
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'phone_swipe',
      description: 'Swipe or drag on the phone from one coordinate to another, e.g. to scroll a list or dismiss a sheet.',
      parameters: {
        type: 'object',
        properties: {
          x1: { type: 'number', description: 'Start X.' },
          y1: { type: 'number', description: 'Start Y.' },
          x2: { type: 'number', description: 'End X.' },
          y2: { type: 'number', description: 'End Y.' },
          durationMs: { type: 'number', description: 'Swipe duration in ms (default 300; slow = gentle scroll).' },
        },
        required: ['x1', 'y1', 'x2', 'y2'],
        additionalProperties: false,
      },
      timeoutMs: 60000,
      output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
      async execute(args) {
        const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((key) => Math.round(Number(args[key])))
        const duration = Number.isFinite(Number(args.durationMs)) && Number(args.durationMs) > 0 ? Math.round(Number(args.durationMs)) : 300
        const wake = await ensureAwake().catch(() => ({ state: null, woke: false }))
        await sh(`input swipe ${x1} ${y1} ${x2} ${y2} ${duration}`)
        return `swiped ${x1},${y1} -> ${x2},${y2} in ${duration}ms${wake.woke ? ' (woke the screen first)' : ''}`
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'phone_type',
      description:
        'Type into the focused text field. ASCII goes through `input text`; any other script (中文, emoji, accents) goes through the ADBKeyboard bridge, which briefly borrows the input method and gives it back. Pass `clear` to empty the field first.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type.' },
          clear: { type: 'boolean', description: 'Empty the field first (broadcast via ADBKeyboard) instead of appending at the caret.' },
          submit: { type: 'boolean', description: 'Press Enter afterwards (default false).' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      timeoutMs: 90000,
      output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
      async execute(args) {
        const value = String(args.text ?? '')
        if (!value) throw new Error('text is empty')
        await ensureAwake().catch(() => {})
        const method = await typeText(value, { submit: Boolean(args.submit), clear: Boolean(args.clear) })
        const notes = [args.clear ? 'cleared the field first' : '', args.submit ? 'enter' : ''].filter(Boolean)
        return `typed ${value.length} chars via ${method}${notes.length ? ` + ${notes.join(' + ')}` : ''}`
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'phone_key',
      description:
        'Press a hardware/navigation key. Keys: back, home, enter, recents, power, wakeup, sleep, menu, volume_up, volume_down, delete, tab, escape, search, camera, assist (KEYCODE_ASSIST —usually summons the system assistant), voice (KEYCODE_VOICE_ASSIST) —or a numeric keycode.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name or numeric Android keycode.' },
          times: { type: 'number', description: 'How many times to press (default 1).' },
        },
        required: ['key'],
        additionalProperties: false,
      },
      timeoutMs: 60000,
      output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
      async execute(args) {
        const code = keyCode(args.key)
        const times = Number.isFinite(Number(args.times)) && Number(args.times) > 0 ? Math.min(Math.floor(Number(args.times)), 20) : 1
        // power/sleep/wakeup are the very keys that control the screen —don't pre-wake for those.
        if (![KEYS.power, KEYS.sleep, KEYS.wakeup].includes(code)) await ensureAwake().catch(() => {})

        // HyperOS burns KEYCODE_ASSIST/VOICE_ASSIST (no global binding), so summoning the assistant
        // needs a fallback chain: keycode -> ASSIST intent -> whatever package owns the assistant.
        if (code === KEYS.assist || code === KEYS.voice) {
          const owner = await assistantPackage()
          const before = await focusLine()
          await sh(`input keyevent ${code}`)
          await sleep(700)
          const keyed = await focusLine()
          if (keyed !== before && (await isAssistant(owner))) return `key ${args.key} (${code}) summoned ${keyed}`

          await sh('am start -a android.intent.action.ASSIST').catch(() => {})
          await sleep(900)
          const intended = await focusLine()
          if (intended !== keyed && (await isAssistant(owner))) return `key ${args.key}: no key binding, ASSIST intent opened ${intended}`
          if (owner) {
            try {
              const route = await launchPackage(owner)
              await sleep(1200)
              if (await isAssistant(owner)) return `key ${args.key}: HyperOS ignores ${code}; launched ${owner} via ${route}`
            } catch {
              // fall through to the icon route
            }
          }

          // 小爱 on this build is a launcher shortcut, not a LAUNCHER activity, so nothing above can
          // reproduce its intent. Going home and tapping the icon is the only route that works.
          const icon = await tapHomeIcon(['小爱'])
          if (!icon) return `key ${args.key}: ${code} is unbound, ASSIST intent only revealed the launcher, and no 小爱 icon was on the home screen`
          if (await isAssistant(owner)) return `key ${args.key}: ${code} is unbound and ${owner || 'the assistant'} refuses am start, so I tapped ${icon} instead`
          return `key ${args.key}: tapped ${icon}, but focus stayed ${await focusLine()}`
        }

        for (let index = 0; index < times; index += 1) await sh(`input keyevent ${code}`)
        return `key ${args.key} (${code}) x${times}`
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'phone_app',
      description:
        'App control on the phone. action=current reports the focused app, launch opens a package (short names are substring-matched), list shows installed third-party packages (optional filter), stop force-stops one.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['current', 'launch', 'list', 'stop'], description: 'What to do.' },
          target: { type: 'string', description: 'Package name or a fragment of it (launch/stop).' },
          filter: { type: 'string', description: 'action=list only: keep packages containing this substring.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      timeoutMs: 60000,
      output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
      async execute(args) {
        const action = args?.action || 'current'
        const target = String(args?.target || '').trim()
        const filter = String(args?.filter || '').trim().toLowerCase()

        if (action === 'current') {
          const focus = await sh(FOCUS_COMMAND, { timeout: 25000 }).catch(() => null)
          const parsed = focus ? parseFocus(focus.text) : ''
          if (parsed) return parsed
          const top = await sh('dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity"', { timeout: 25000 })
          const fallback = top.text.split(/\r?\n/).map((row) => row.trim()).filter(Boolean).join('\n')
          return fallback || 'unknown focus'
        }

        if (action === 'list') {
          const { text: output } = await sh('pm list packages -3', { timeout: 30000 })
          const packages = output
            .split(/\r?\n/)
            .map((row) => row.trim().replace(/^package:/, ''))
            .filter(Boolean)
            .filter((pkg) => !filter || pkg.toLowerCase().includes(filter))
            .sort()
          const shown = packages.slice(0, 200)
          const head = `${packages.length} third-party packages${filter ? ` matching ${JSON.stringify(args.filter)}` : ''}`
          const tail = packages.length > shown.length ? `\n—${packages.length - shown.length} more (narrow it with filter)` : ''
          return `${head}:\n${shown.join('\n')}${tail}`
        }

        if (!target) throw new Error(`action=${action} needs a target package`)

        let pkg = target
        if (!/\.[a-zA-Z]/.test(target)) {
          const { text: output } = await sh('pm list packages', { timeout: 30000 })
          const pool = output
            .split(/\r?\n/)
            .map((row) => row.trim().replace(/^package:/, ''))
            .filter((row) => row.toLowerCase().includes(target.toLowerCase()))
          if (pool.length === 0) throw new Error(`no package matches "${target}"`)
          if (pool.length > 1) throw new Error(`"${target}" is ambiguous:\n${pool.slice(0, 20).join('\n')}`)
          pkg = pool[0]
        }

        // pkg lands in a device shell command unquoted (`am force-stop ${pkg}`), so anything that
        // is not a plain Android package name ("com.x;reboot") must never get through.
        if (!/^[A-Za-z][A-Za-z0-9_]*?(?:\.[A-Za-z0-9_]+)+$/.test(pkg)) {
          throw new Error(`${JSON.stringify(pkg)} is not a valid package name (letters, digits, "_" and "." only)`)
        }

        if (action === 'stop') {
          await sh(`am force-stop ${pkg}`)
          return `force-stopped ${pkg}`
        }

        const route = await launchPackage(pkg)
        return `launched ${pkg} via ${route}`
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'phone_wait',
      description:
        'Wait until an element whose text / content-desc / resource-id contains this string appears (or, with gone, disappears), then report where it is. Use this instead of sleeping blindly after a tap.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Substring of the text, content-desc or resource-id (case-insensitive).' },
          gone: { type: 'boolean', description: 'Wait for it to disappear instead of appear.' },
          timeoutMs: { type: 'number', description: 'Give up after this long (default 15000, max 110000).' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      timeoutMs: 120000,
      output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
      async execute(args) {
        const needle = String(args?.text || '').trim().toLowerCase()
        if (!needle) throw new Error('text is empty')
        const wantGone = Boolean(args.gone)
        const timeout = Number.isFinite(Number(args.timeoutMs)) && Number(args.timeoutMs) > 0
          ? Math.min(Math.floor(Number(args.timeoutMs)), 110000)
          : 15000
        const started = Date.now()
        let seen = 0
        while (Date.now() - started < timeout) {
          let nodes = []
          try {
            nodes = await dumpUi()
          } catch {
            await delay(500)
            continue
          }
          seen = nodes.length
          const hit = nodes.find((node) => `${node.kind} ${node.label} ${node.desc} ${node.id}`.toLowerCase().includes(needle))
          if (!wantGone && hit) {
            const flags = [hit.clickable ? 'tap' : '', hit.scrollable ? 'scroll' : ''].filter(Boolean).join(',')
            const shown = hit.label || hit.desc
            return `found after ${Date.now() - started}ms: ${hit.kind}${shown ? ` ${JSON.stringify(shown)}` : ''}${hit.id ? ` #${hit.id}` : ''} @${hit.box.cx},${hit.box.cy}${flags ? ` [${flags}]` : ''}`
          }
          if (wantGone && !hit) return `gone after ${Date.now() - started}ms (${nodes.length} elements on screen)`
          await delay(400)
        }
        return wantGone
          ? `still visible after ${timeout}ms: ${JSON.stringify(args.text)}`
          : `timed out after ${timeout}ms: ${JSON.stringify(args.text)} never appeared (last dump: ${seen} elements)`
      },
    }),
  )
}
