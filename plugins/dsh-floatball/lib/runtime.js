/**
 * Electron 运行时的安装：不用 dsh-orb 那份，自己下一份。
 *
 * 下载顺序：npmmirror 二进制镜像（国内快）→ 官方 GitHub releases（慢但权威兜底）。
 *
 * 一个实测过的硬约束：**electron.exe 所在路径必须是纯 ASCII**。
 * 放在 `D:\新建文件夹\...` 这种带中文的目录里，Chromium 初始化直接 STATUS_BREAKPOINT
 * （退出码 2147483651、没有 stderr、脚本一行都没跑到）；同一份 exe 复制到纯 ASCII
 * 目录就正常。所以运行时目录默认挑 `%LOCALAPPDATA%\dsh-floatball\runtime`，
 * 只有 dataDir 自己就是 ASCII 时才放在 dataDir 下面。
 *
 * 校验：zip 下完只认「解压出的 electron.exe 存在且够大」+ 一个 .complete-<ver> 标记，
 * 中途断掉的下次会重下（不做半截复用，宁可多花 100MB 流量也不留坏运行时）。
 */
import { createWriteStream } from 'node:fs'
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PLATFORM_TAG = { win32: 'win32', darwin: 'darwin', linux: 'linux' }
const ARCH_TAG = { x64: 'x64', arm64: 'arm64', ia32: 'ia32' }
const MIN_EXE_BYTES = 10 * 1024 * 1024
const MIN_ZIP_BYTES = 10 * 1024 * 1024

/** Chromium 从非 ASCII 路径启动会直接崩，这里用它决定把运行时放哪。 */
export function isAsciiPath(value) {
  return /^[\x20-\x7e]*$/.test(String(value ?? ''))
}

/** 兜底的 ASCII 运行时根目录。 */
export function defaultRuntimeRoot() {
  const local = process.env.LOCALAPPDATA
  if (local && isAsciiPath(local)) return join(local, 'dsh-floatball', 'runtime')
  return join(homedir(), '.dsh', 'dsh-floatball', 'runtime')
}

/** 运行时根目录：显式配置 > dataDir（ASCII 时）> 系统 ASCII 缓存目录。 */
export function runtimeRootOf(dataDir, runtimeRoot = '') {
  const explicit = String(runtimeRoot || '').trim()
  if (explicit) return explicit
  if (dataDir && isAsciiPath(dataDir)) return join(dataDir, 'engine', 'runtime')
  return defaultRuntimeRoot()
}

/** 例如 electron-v44.0.0-win32-x64.zip */
export function zipName(version, platform = process.platform, arch = process.arch) {
  const osTag = PLATFORM_TAG[platform]
  const archTag = ARCH_TAG[arch]
  if (!osTag || !archTag) throw new Error(`不认识的平台：${platform}/${arch}`)
  return `electron-v${version}-${osTag}-${archTag}.zip`
}

/** npmmirror 的二进制目录：<mirror>/v<ver>/<zip> */
export function mirrorUrl(mirror, version, zip) {
  return `${String(mirror).replace(/\/+$/, '')}/v${version}/${zip}`
}

/** 官方兜底：https://github.com/electron/electron/releases/download/v<ver>/<zip> */
export function githubUrl(version, zip) {
  return `https://github.com/electron/electron/releases/download/v${version}/${zip}`
}

export function electronExe(platform = process.platform) {
  return platform === 'win32' ? 'electron.exe' : 'electron'
}

export function runtimeDir(dataDir, version, runtimeRoot = '') {
  return join(runtimeRootOf(dataDir, runtimeRoot), version)
}

export function markerPath(dataDir, version, runtimeRoot = '') {
  return join(runtimeRootOf(dataDir, runtimeRoot), `.complete-${version}`)
}

async function fileSize(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : 0
  } catch {
    return 0
  }
}

/** 已经装好了吗？返回 {ok, exe, dir}；exe 是 electron.exe 绝对路径。 */
export async function runtimeStatus({
  dataDir,
  version,
  electronPath = '',
  runtimeRoot = '',
  platform = process.platform,
}) {
  if (electronPath) {
    const size = await fileSize(electronPath)
    return {
      ok: size > 0 && isAsciiPath(electronPath),
      exe: electronPath,
      dir: join(electronPath, '..'),
      custom: true,
      ascii: isAsciiPath(electronPath),
      version: 'custom',
    }
  }
  const dir = runtimeDir(dataDir, version, runtimeRoot)
  const exe = join(dir, electronExe(platform))
  const size = await fileSize(exe)
  const marker = await fileSize(markerPath(dataDir, version, runtimeRoot))
  const ascii = isAsciiPath(exe)
  return {
    ok: size > MIN_EXE_BYTES && marker > 0 && ascii,
    exe,
    dir,
    root: runtimeRootOf(dataDir, runtimeRoot),
    size,
    marker,
    ascii,
    version,
  }
}

async function download(url, dest, { log, timeoutMs = 600_000 } = {}) {
  log?.(`下载 ${url}`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
    await new Promise((resolve, reject) => {
      const stream = createWriteStream(dest)
      const reader = response.body.getReader()
      const pump = async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (!stream.write(Buffer.from(value))) {
              await new Promise((r) => stream.once('drain', r))
            }
          }
          stream.end(() => resolve())
        } catch (error) {
          stream.destroy()
          reject(error)
        }
      }
      stream.on('error', reject)
      pump().catch(reject)
    })
    return await fileSize(dest)
  } finally {
    clearTimeout(timer)
  }
}

function extractZip(zipPath, destDir, log) {
  // Windows 10+ 自带 bsdtar，能直接解 zip；失败再退回 PowerShell 的 Expand-Archive
  const run = (cmd, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' })
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`))))
    })
  return run('tar.exe', ['-xf', zipPath, '-C', destDir]).catch((error) => {
    log?.(`tar 解压失败（${error.message}），改用 Expand-Archive`)
    return run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ])
  })
}

/** 老位置（放在中文 dataDir 下）已经有运行时的话，复制到 ASCII 目录，省一次 250MB 下载。 */
async function adoptExisting(dataDir, version, targetDir, log) {
  const legacy = join(dataDir || '', 'engine', 'runtime', version)
  if (!dataDir || legacy === targetDir) return false
  const legacyExe = join(legacy, electronExe())
  if ((await fileSize(legacyExe)) < MIN_EXE_BYTES) return false
  log?.(`把已有的 Electron 运行时从 ${legacy} 复制到 ${targetDir}`)
  await cp(legacy, targetDir, { recursive: true, force: true })
  return (await fileSize(join(targetDir, electronExe()))) > MIN_EXE_BYTES
}

/**
 * 确保运行时可用：已装好就直接返回，否则先用能复用的、再下载解压。
 * 返回 {ok, exe, version, installed}
 */
export async function ensureRuntime({ dataDir, version, log, mirror, electronPath = '', runtimeRoot = '' }) {
  const status = await runtimeStatus({ dataDir, version, electronPath, runtimeRoot })
  if (status.ok) return { ...status, installed: false }

  if (electronPath) {
    // 自己指定的 electron.exe：只报错，不去下载
    throw new Error(
      isAsciiPath(electronPath)
        ? `配置的 electronPath 不可用：${electronPath}`
        : `配置的 electronPath 含非 ASCII 字符，Electron 起不来，请换一个纯英文路径：${electronPath}`,
    )
  }

  const root = runtimeRootOf(dataDir, runtimeRoot)
  const dir = join(root, version)
  if (!isAsciiPath(dir)) {
    throw new Error(`运行时目录必须是不含中文的纯 ASCII 路径（Electron 从中文路径启动会直接崩）：${dir}`)
  }
  await mkdir(dir, { recursive: true })
  await mkdir(root, { recursive: true })

  const reused = await adoptExisting(dataDir, version, dir, log).catch(() => false)
  if (reused) {
    const exe = join(dir, electronExe())
    await writeFile(markerPath(dataDir, version, runtimeRoot), JSON.stringify({ version, adopted: true, installedAt: Date.now() }), 'utf8')
    log?.(`Electron ${version} 就绪（复用旧位置）：${exe}`)
    return { ok: true, exe, dir, root, version, installed: true, adopted: true }
  }

  const zip = join(root, zipName(version))
  const mirrorBase = mirror || 'https://registry.npmmirror.com/-/binary/electron'
  const candidates = [mirrorUrl(mirrorBase, version, zipName(version)), githubUrl(version, zipName(version))]

  const errors = []
  for (const url of candidates) {
    try {
      const size = await download(url, zip, { log })
      if (size < MIN_ZIP_BYTES) throw new Error(`下载体积不对（${size}B）`)
      await extractZip(zip, dir, log)
      const exe = join(dir, electronExe())
      const exeSize = await fileSize(exe)
      if (exeSize < MIN_EXE_BYTES) throw new Error(`解压后没找到 electron.exe（${exeSize}B）`)
      const entries = await readdir(dir).catch(() => [])
      if (!entries.length) throw new Error('解压目录是空的')
      await writeFile(markerPath(dataDir, version, runtimeRoot), JSON.stringify({ version, url, installedAt: Date.now() }), 'utf8')
      await rm(zip, { force: true }).catch(() => {})
      log?.(`Electron ${version} 就绪：${exe}`)
      return { ok: true, exe, dir, root, version, installed: true, url, size: exeSize }
    } catch (error) {
      errors.push(`${url} → ${error?.message || error}`)
      log?.(`这份下不成：${error?.message || error}`)
      await rm(zip, { force: true }).catch(() => {})
    }
  }
  throw new Error(`Electron 运行时安装失败：${errors.join(' | ')}`)
}
