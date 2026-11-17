#!/usr/bin/env node
// 鱼鱼画画（dsh-fish-paint）· 引擎安装脚本
//
// 用法：
//   node engine/setup.mjs [--install] [--verify] [--json]
//     默认 --install：建 venv → 装 torch(cu124) → 装 diffusers 等依赖 → 下载模型 → 预取 SDXL 配置
//     --verify     ：装完后启动 worker.py 跑一张 512x512 冒烟图，成功 exit 0
//     --json       ：不往 stdout 打人话进度，结束时输出一行 JSON 结果
//
// 设计要点：
//   - 零 npm 依赖（只用 node: 内置模块）；
//   - 幂等：每一步先探测，已完成就跳过；
//   - 下载断点续传：<文件>.part + HTTP Range，校验字节数；
//   - 进度原子写 data/state/setup.json（tmp + rename），日志 data/state/setup.log。
//
// 本文件属于引擎侧（engine/**），不碰插件的其它文件。

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- 路径与常量

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');
const STATE_DIR = path.join(DATA, 'state');
const MODEL_DIR = path.join(DATA, 'models');
const SDXL_DIR = path.join(MODEL_DIR, 'sdxl-base');
const VENV_DIR = path.join(DATA, '.venv');
const VENV_PY = path.join(VENV_DIR, 'Scripts', 'python.exe');
const DL_DIR = path.join(STATE_DIR, 'downloads');
const STATE_FILE = path.join(STATE_DIR, 'setup.json');
const LOG_FILE = path.join(STATE_DIR, 'setup.log');
const OUT_DIR = path.join(DATA, 'out');

const MODEL_FILE = 'Illustrious-XL-v2.0.safetensors';
const MODEL_PATH = path.join(MODEL_DIR, MODEL_FILE);
const REQUIREMENTS = path.join(HERE, 'requirements.txt');
const WORKER_PY = path.join(HERE, 'worker.py');

const PY_ENV = 'FISH_PAINT_PYTHON';
let cliPython = '';

const ALIYUN = 'https://mirrors.aliyun.com/pypi/simple/';
const MS_API = 'https://www.modelscope.cn/api/v1/models';
const MS_MODEL_REPO = 'OnomaAIResearch/Illustrious-XL-v2.0';
const MS_SDXL_REPO = 'AI-ModelScope/stable-diffusion-xl-base-1.0';
const TORCH_URL =
  'https://mirror.sjtu.edu.cn/pytorch-wheels/cu124/torch-2.6.0%2Bcu124-cp312-cp312-win_amd64.whl';
const TORCH_WHEEL = path.join(DL_DIR, 'torch-2.6.0+cu124-cp312-cp312-win_amd64.whl');
// 模型字节数（ModelScope 文件列表实测值；拿不到列表时的兜底）
const MODEL_SIZE_FALLBACK = 6938040674;

// from_single_file 离线启动所需的小文件（config + tokenizer，权重全在单文件里）
const SDXL_SMALL_FILES = [
  'model_index.json',
  'scheduler/scheduler_config.json',
  'text_encoder/config.json',
  'text_encoder_2/config.json',
  'tokenizer/vocab.json',
  'tokenizer/merges.txt',
  'tokenizer/special_tokens_map.json',
  'tokenizer/tokenizer_config.json',
  'tokenizer_2/vocab.json',
  'tokenizer_2/merges.txt',
  'tokenizer_2/special_tokens_map.json',
  'tokenizer_2/tokenizer_config.json',
  'unet/config.json',
  'vae/config.json',
];

// 各阶段占总进度的区间（百分比），下载类阶段按真实字节插值
const PHASE_RANGE = {
  venv: [0, 3],
  torch: [3, 42],
  deps: [42, 58],
  model: [58, 94],
  tokenizer: [94, 98],
  verify: [98, 100],
  done: [100, 100],
  error: [0, 0],
};

const UA = 'dsh-fish-paint-setup/1.0 (node ' + process.version + ')';

// ---------------------------------------------------------------- 全局状态

let jsonMode = false;
let lastSaveAt = 0;
let lastUiPercent = -100;
let lastUiAt = 0;
let logStream = null;

const state = {
  ok: false,
  running: true,
  phase: 'venv',
  percent: 0,
  message: '准备安装',
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  error: null,
  bytes: { done: 0, total: 0 },
  sizes: { venv: 0, model: 0 },
};

// ---------------------------------------------------------------- 小工具

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

function log(line) {
  const text = `[${ts()}] ${line}`;
  writeLogStream(text + '\n');
  if (!jsonMode) console.log(text);
}

// 只落日志、不进 stdout（避免 JSON 模式被污染；也避免刷屏）
function logFileOnly(line) {
  const text = `[${ts()}] ${line}`;
  writeLogStream(text + '\n');
}

// 日志流可能在收尾阶段已 end()，而 worker 的 stderr 还可能晚到：写之前必须看状态，
// 否则 WriteStream 会抛 ERR_STREAM_WRITE_AFTER_END（unhandled error 直接把进程打崩）。
function writeLogStream(text) {
  if (logStream && !logStream.writableEnded && !logStream.destroyed) logStream.write(text);
}

function fail(msg) {
  throw new Error(msg);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function pct(phase, frac) {
  const [a, b] = PHASE_RANGE[phase] || [0, 0];
  return a + (b - a) * Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
}

function saveState(patch, force = false) {
  if (patch) Object.assign(state, patch);
  const now = Date.now();
  if (!force && now - lastSaveAt < 700) return;
  lastSaveAt = now;
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

// 阶段/进度变化：写 setup.json，并在人话模式下按 5% 节流打印
function report({ phase, percent, message, bytes } = {}) {
  const patch = {};
  if (phase) patch.phase = phase;
  if (percent != null) patch.percent = round1(Math.max(0, Math.min(100, percent)));
  if (message) patch.message = message;
  if (bytes) patch.bytes = bytes;
  if (phase) {
    saveState(patch, true);
  } else {
    saveState(patch, false);
  }
  const p = state.percent;
  const now = Date.now();
  if (!jsonMode) {
    const crossed = p - lastUiPercent >= 5 || p >= 100;
    if ((crossed && now - lastUiAt > 1200) || now - lastUiAt > 20000) {
      lastUiPercent = p;
      lastUiAt = now;
      const b = state.bytes;
      const extra = b.total ? ` ${fmtMB(b.done)}/${fmtMB(b.total)}` : '';
      console.log(`[${ts()}] ${state.percent.toFixed(1).padStart(5)}%  ${state.message}${extra}`);
    }
  }
}

function fmtMB(n) {
  return `${(n / 1048576).toFixed(0)}MB`;
}

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      try {
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) total += fs.statSync(p).size;
      } catch {
        /* 文件在扫描途中消失就跳过 */
      }
    }
  }
  return total;
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    let s = '';
    stream.setEncoding('utf8');
    stream.on('data', (c) => (s += c));
    stream.on('end', () => resolve(s));
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------- HTTP / 下载

// 发一个请求，自动跟随 3xx 重定向（保留 Range 等头）
function httpRequest(url, { method = 'GET', headers = {}, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(new Error(`非法 URL: ${url}`));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, headers, timeout: 120000 }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        httpRequest(next, { method, headers, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时（120s 无响应）')));
    req.end();
  });
}

// 探测文件总字节数（Range: bytes=0-0 → Content-Range），失败返回 null
async function probeSize(url) {
  try {
    const res = await httpRequest(url, {
      headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity', 'User-Agent': UA },
    });
    const cr = res.headers['content-range'];
    res.destroy();
    if (cr) {
      const m = /\/(\d+)\s*$/.exec(cr);
      if (m) return Number(m[1]);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 断点续传下载到 dest。
 * - 先写 dest + '.part'，完成后 rename；
 * - expectedSize 已知时严格校验字节数；
 * - onProgress(done, total) 节流回调（约 500ms）。
 */
async function downloadTo(url, dest, { expectedSize = null, onProgress = null, label = '' } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  let existing = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (expectedSize && existing === expectedSize) {
    fs.renameSync(part, dest);
    logFileOnly(`${label || path.basename(dest)} 已完整（续传完成）`);
    return existing;
  }
  if (existing > 0 && expectedSize && existing > expectedSize) {
    logFileOnly(`${part} 比预期大，截断重下`);
    fs.truncateSync(part, 0);
    existing = 0;
  }

  const go = async (offset) => {
    const headers = { 'User-Agent': UA, 'Accept-Encoding': 'identity' };
    if (offset > 0) headers.Range = `bytes=${offset}-`;
    const res = await httpRequest(url, { headers });
    const status = res.statusCode || 0;

    if (status === 416) {
      res.resume();
      const size = fs.statSync(part).size;
      if (!expectedSize || size === expectedSize) {
        fs.renameSync(part, dest);
        return size;
      }
      fs.truncateSync(part, 0);
      return go(0);
    }
    if (status !== 200 && status !== 206) {
      const body = (await readAll(res)).slice(0, 300);
      fail(`下载失败 HTTP ${status}（${label || dest}）: ${body}`);
    }

    let total = expectedSize;
    if (!total) {
      const cr = res.headers['content-range'];
      const m = cr && /\/(\d+)\s*$/.exec(cr);
      if (m) total = Number(m[1]);
      else if (res.headers['content-length']) {
        total = Number(res.headers['content-length']) + (status === 206 ? offset : 0);
      }
    }

    let append = status === 206 && offset > 0;
    if (status === 200 && offset > 0) {
      // 服务器不认 Range，只能从头来
      fs.truncateSync(part, 0);
      append = false;
    }
    const ws = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
    let done = append ? offset : 0;
    let lastTick = 0;
    res.on('data', (chunk) => {
      done += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastTick >= 500) {
        lastTick = now;
        onProgress(done, total);
      }
    });
    await new Promise((resolve, reject) => {
      res.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      res.pipe(ws);
    });
    if (onProgress) onProgress(done, total);
    return done;
  };

  logFileOnly(`开始下载 ${label || path.basename(dest)}（已有 ${existing} 字节）`);
  const size = await go(existing);
  const finalSize = fs.statSync(part).size;
  if (expectedSize && finalSize !== expectedSize) {
    fail(
      `${label || dest} 字节数不符：期望 ${expectedSize}，实际 ${finalSize}` +
        `（.part 已保留，重跑 --install 会续传）`,
    );
  }
  if (!expectedSize && finalSize === 0) {
    fail(`${label || dest} 下载结果为空`);
  }
  fs.renameSync(part, dest);
  logFileOnly(`下载完成 ${label || path.basename(dest)}：${finalSize} 字节`);
  return finalSize;
}

// ---------------------------------------------------------------- 子进程

function pythonEnv(extra = {}) {
  return {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PIP_NO_INPUT: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    ...extra,
  };
}

// 跑一个命令，输出进日志（不进 stdout），失败抛错
function runCommand(cmd, args, { label = '', env = {} } = {}) {
  const shown = [cmd, ...args]
    .map((a) => (/[\s"]/.test(a) ? `"${a}"` : a))
    .join(' ');
  logFileOnly(`$ ${shown}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: pythonEnv(env),
      windowsHide: true,
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const onData = (buf) => {
      const text = buf.toString('utf8');
      tail += text;
      if (tail.length > 200000) tail = tail.slice(-100000);
      if (logStream) {
        for (const line of text.split(/\r?\n/)) if (line.trim()) logStream.write('    ' + line + '\n');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(tail);
      else {
        const brief = tail.trim().split(/\r?\n/).slice(-8).join('\n');
        reject(new Error(`${label || '命令'}失败（exit ${code}）\n${brief}`));
      }
    });
  });
}

// 跑命令并拿 stdout（输出同时进日志）
function capture(cmd, args, opts = {}) {
  const out = [];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: pythonEnv(opts.env || {}),
      windowsHide: true,
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (buf, isErr) => {
      const text = buf.toString('utf8');
      if (!isErr) out.push(text);
      if (logStream) {
        for (const line of text.split(/\r?\n/)) if (line.trim()) {
          logStream.write(`${isErr ? '    ! ' : '    '}${line}\n`);
        }
      }
    };
    child.stdout.on('data', (b) => onData(b, false));
    child.stderr.on('data', (b) => onData(b, true));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out.join('')) : reject(new Error(`${opts.label || cmd} 失败（exit ${code}）`)),
    );
  });
}

function pythonRun(args, opts = {}) {
  return capture(VENV_PY, args, opts);
}

// ---------------------------------------------------------------- venv / torch / 依赖

async function pickPython() {
  // 不写死本机路径：--python / 环境变量优先，其次 py 启动器与 PATH 里的 python。
  // torch 2.6.0+cu124 的 Windows wheel 是 cp312，所以只要 Python 3.12。
  const explicit = (cliPython || String(process.env[PY_ENV] || '')).trim();
  const candidates = [];
  if (explicit) candidates.push({ cmd: explicit, args: [], label: `--python / ${PY_ENV}` });
  if (process.platform === 'win32') candidates.push({ cmd: 'py', args: ['-3'], label: 'py -3' });
  candidates.push({ cmd: 'python', args: [], label: 'PATH 里的 python' });
  candidates.push({ cmd: 'python3', args: [], label: 'PATH 里的 python3' });

  const tried = [];
  for (const candidate of candidates) {
    let output = '';
    try {
      output = await capture(candidate.cmd, [
        ...candidate.args,
        '-c',
        'import sys;print(sys.version.split()[0]);print(sys.executable)',
      ], { label: `探测 ${candidate.label}` });
    } catch {
      tried.push(`${candidate.label} → 不可用`);
      continue;
    }
    const [version = '', executable = ''] = output.trim().split(/\r?\n/);
    const pythonPath = (executable || candidate.cmd).trim();
    if (!/^3\.12\./.test(version.trim())) {
      tried.push(`${candidate.label} → Python ${version.trim() || '?'}（需要 3.12）`);
      logFileOnly(`跳过 ${candidate.label}：版本 ${version.trim()} 不是 3.12`);
      continue;
    }
    log(`找到 Python ${version.trim()}：${pythonPath}`);
    return pythonPath;
  }
  tried.push('没有其他候选');
  fail(
    '找不到 Python 3.12（PyTorch 2.6.0+cu124 的 Windows wheel 是 cp312）。\n' +
      '已尝试：\n- ' + tried.join('\n- ') + '\n' +
      `装好 Python 3.12 后重试，或用 --python <python.exe 路径> / 环境变量 ${PY_ENV} 指定。`,
  );
}

async function ensureVenv() {
  report({ phase: 'venv', percent: pct('venv', 0), message: '准备 Python venv' });
  if (fs.existsSync(VENV_PY)) {
    try {
      const v = await pythonRun(['-c', 'import sys;print(sys.version.split()[0])'], {
        label: '检查 venv',
      });
      log(`已有 venv（Python ${v.trim()}），跳过创建`);
      report({ phase: 'venv', percent: pct('venv', 1), message: 'Python venv 已就绪' });
      return;
    } catch {
      logFileOnly('已有 venv 目录但 python 不可用，重建');
    }
  }
  const py = await pickPython();
  if (!VENV_DIR.startsWith(ROOT)) fail('venv 路径异常，拒绝删除');
  fs.rmSync(VENV_DIR, { recursive: true, force: true });
  log('创建 venv：' + VENV_DIR);
  await runCommand(py, ['-m', 'venv', VENV_DIR], { label: '创建 venv' });
  if (!fs.existsSync(VENV_PY)) fail('venv 创建后找不到 python.exe：' + VENV_PY);
  log('升级 pip');
  await runCommand(
    VENV_PY,
    ['-m', 'pip', 'install', '--no-cache-dir', '--upgrade', 'pip', '-i', ALIYUN, '--timeout', '120'],
    { label: '升级 pip' },
  );
  report({ phase: 'venv', percent: pct('venv', 1), message: 'Python venv 已就绪' });
}

function readRequirementsSpecs() {
  const text = fs.readFileSync(REQUIREMENTS, 'utf8');
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('torch'));
}

async function torchInfo() {
  try {
    const out = await pythonRun(
      [
        '-c',
        'import torch;print(torch.__version__);print(torch.version.cuda or "");print(torch.cuda.is_available())',
      ],
      { label: '检查 torch' },
    );
    const [ver, cu, avail] = out.trim().split(/\r?\n/);
    return { ver: ver || '', cuda: cu || '', available: avail === 'True' };
  } catch {
    return null;
  }
}

function validateWheel(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    if (head.toString('latin1') !== 'PK\x03\x04') fail('torch wheel 不是合法 zip（下载损坏？删掉重试）');
  } finally {
    fs.closeSync(fd);
  }
  const size = fs.statSync(file).size;
  if (size < 1_200_000_000) fail(`torch wheel 体积异常：${size} 字节`);
}

async function ensureTorch() {
  const info = await torchInfo();
  if (info && info.ver.startsWith('2.6.0')) {
    log(`已有 torch ${info.ver}（CUDA ${info.cuda || '无'}，可用=${info.available}）`);
    if (!info.available) log('警告：torch 已装但 CUDA 不可用——请检查显卡驱动');
    report({ phase: 'torch', percent: pct('torch', 1), message: `torch ${info.ver} 已就绪` });
    return;
  }

  // 1) 自己下载 wheel（可续传、可显示进度），绕开 pip 没有进度条的下载
  if (!fs.existsSync(TORCH_WHEEL) || fs.statSync(TORCH_WHEEL).size < 1_200_000_000) {
    const total = await probeSize(TORCH_URL);
    report({
      phase: 'torch',
      percent: pct('torch', 0),
      message: '下载 torch 2.6.0+cu124' + (total ? `（${fmtMB(total)}）` : ''),
      bytes: { done: 0, total: total || 0 },
    });
    await downloadTo(TORCH_URL, TORCH_WHEEL, {
      expectedSize: total,
      label: 'torch wheel',
      onProgress: (done, t) =>
        report({
          phase: 'torch',
          percent: pct('torch', 0.9 * (t ? done / t : 0)),
          bytes: { done, total: t || 0 },
        }),
    });
  }
  validateWheel(TORCH_WHEEL);

  // 2) pip 装 wheel（依赖走阿里云镜像）
  report({ phase: 'torch', percent: pct('torch', 0.93), message: '安装 torch（pip）' });
  await runCommand(
    VENV_PY,
    [
      '-m', 'pip', 'install', '--no-cache-dir', '-i', ALIYUN, '--timeout', '180',
      TORCH_WHEEL,
    ],
    { label: '安装 torch' },
  );
  // 装完删 wheel，省 2.4G 磁盘
  try {
    fs.unlinkSync(TORCH_WHEEL);
  } catch {}
  const after = await torchInfo();
  if (!after) fail('torch 安装后无法 import');
  log(`torch 安装完成：${after.ver}（CUDA ${after.cuda || '无'}，可用=${after.available}）`);
  report({ phase: 'torch', percent: pct('torch', 1), message: `torch ${after.ver} 已就绪` });
}

async function depsReady() {
  try {
    const out = await pythonRun(
      [
        '-c',
        'import diffusers,transformers,accelerate,safetensors,PIL;' +
          'print(diffusers.__version__);print(transformers.__version__);print(accelerate.__version__)',
      ],
      { label: '检查依赖' },
    );
    const [d, t, a] = out.trim().split(/\r?\n/);
    return { diffusers: d, transformers: t, accelerate: a };
  } catch {
    return null;
  }
}

async function ensureDeps() {
  const ready = await depsReady();
  if (ready) {
    log(
      `依赖已就绪：diffusers ${ready.diffusers} / transformers ${ready.transformers} / accelerate ${ready.accelerate}`,
    );
    report({ phase: 'deps', percent: pct('deps', 1), message: 'Python 依赖已就绪' });
    return;
  }
  const specs = readRequirementsSpecs();
  if (!specs.length) fail('engine/requirements.txt 里没有可安装的依赖项');
  report({ phase: 'deps', percent: pct('deps', 0.05), message: '安装 diffusers/transformers 等依赖（pip）' });
  await runCommand(
    VENV_PY,
    ['-m', 'pip', 'install', '--no-cache-dir', '-i', ALIYUN, '--timeout', '180', ...specs],
    { label: '安装 Python 依赖' },
  );
  const after = await depsReady();
  if (!after) fail('依赖安装后 import 失败（看 data/state/setup.log）');
  log(
    `依赖安装完成：diffusers ${after.diffusers} / transformers ${after.transformers} / accelerate ${after.accelerate}`,
  );
  report({ phase: 'deps', percent: pct('deps', 1), message: 'Python 依赖已就绪' });
}

// ---------------------------------------------------------------- 模型与 SDXL 配置

function msFileUrl(repo, filePath) {
  const fp = filePath.split('/').map((s) => encodeURIComponent(s)).join('/');
  return `${MS_API}/${repo}/repo?Revision=master&FilePath=${fp}`;
}

async function msFileList(repo, root = '') {
  const url = `${MS_API}/${repo}/repo/files?Revision=master&Root=${encodeURIComponent(root)}`;
  const res = await httpRequest(url, { headers: { 'User-Agent': UA } });
  if ((res.statusCode || 0) !== 200) {
    res.resume();
    throw new Error(`ModelScope 文件列表请求失败 HTTP ${res.statusCode}（${repo}）`);
  }
  const text = await readAll(res);
  const data = JSON.parse(text);
  return data?.Data?.Files || [];
}

// 轻量校验 safetensors：8 字节小端头长度 + JSON 头
function validateSafetensors(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    const headerLen = Number(head.readBigInt64LE(0));
    const size = fs.statSync(file).size;
    if (!Number.isFinite(headerLen) || headerLen <= 0 || headerLen > 50 * 1024 * 1024 || headerLen >= size) {
      fail(`safetensors 头部异常（headerLen=${headerLen}，文件 ${size} 字节）`);
    }
    const buf = Buffer.alloc(Math.min(headerLen, 65536));
    fs.readSync(fd, buf, 0, buf.length, 8);
    const headText = buf.toString('utf8');
    if (!headText.trimStart().startsWith('{')) fail('safetensors 头部不是 JSON，文件可能损坏');
    if (headerLen > buf.length) {
      // 大头情况只看前 64K 是否像 JSON 即可（完整性靠字节数校验）
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function ensureModel() {
  let expected = MODEL_SIZE_FALLBACK;
  try {
    const files = await msFileList(MS_MODEL_REPO);
    const entry = files.find((f) => f.Name === MODEL_FILE);
    if (entry?.Size) expected = Number(entry.Size);
    log(`ModelScope 模型文件：${MODEL_FILE}（${expected} 字节）`);
  } catch (e) {
    logFileOnly(`取模型文件列表失败，用兜底大小 ${expected}：${e.message}`);
  }

  if (fs.existsSync(MODEL_PATH)) {
    const size = fs.statSync(MODEL_PATH).size;
    if (size === expected) {
      validateSafetensors(MODEL_PATH);
      log(`模型已存在且校验通过：${MODEL_PATH}（${size} 字节）`);
      state.sizes.model = size;
      report({ phase: 'model', percent: pct('model', 1), message: '模型已就绪' });
      return;
    }
    log(`模型已存在但字节数不符（${size} != ${expected}），转为 .part 续传`);
    const part = MODEL_PATH + '.part';
    if (!fs.existsSync(part) || fs.statSync(part).size < size) {
      fs.renameSync(MODEL_PATH, part);
    } else {
      fs.unlinkSync(MODEL_PATH);
    }
  }

  const url = msFileUrl(MS_MODEL_REPO, MODEL_FILE);
  const part = MODEL_PATH + '.part';
  const hasPart = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (hasPart > 0) log(`发现断点 ${hasPart} / ${expected} 字节，继续下载`);
  report({
    phase: 'model',
    percent: pct('model', hasPart / expected),
    message: '下载 Illustrious-XL-v2.0 模型',
    bytes: { done: hasPart, total: expected },
  });
  await downloadTo(url, MODEL_PATH, {
    expectedSize: expected,
    label: 'Illustrious-XL-v2.0.safetensors',
    onProgress: (done, total) =>
      report({
        phase: 'model',
        percent: pct('model', total ? done / total : 0),
        bytes: { done, total: total || 0 },
      }),
  });
  validateSafetensors(MODEL_PATH);
  const size = fs.statSync(MODEL_PATH).size;
  log(`模型下载完成并校验通过：${size} 字节`);
  state.sizes.model = size;
  report({ phase: 'model', percent: pct('model', 1), message: '模型已就绪', bytes: { done: size, total: size } });
}

async function ensureSdxlConfig() {
  report({ phase: 'tokenizer', percent: pct('tokenizer', 0.05), message: '预取 SDXL tokenizer/config（离线启动用）' });
  let downloaded = 0;
  for (let i = 0; i < SDXL_SMALL_FILES.length; i++) {
    const rel = SDXL_SMALL_FILES[i];
    const dest = path.join(SDXL_DIR, ...rel.split('/'));
    const url = msFileUrl(MS_SDXL_REPO, rel);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      // 小文件只需重复可用：JSON 能解析即可
      if (rel.endsWith('.json')) {
        try {
          JSON.parse(fs.readFileSync(dest, 'utf8'));
        } catch {
          fs.unlinkSync(dest);
        }
      }
    }
    if (!fs.existsSync(dest)) {
      const size = await downloadTo(url, dest, { label: rel });
      downloaded++;
      logFileOnly(`预取 ${rel}：${size} 字节`);
    }
    report({
      phase: 'tokenizer',
      percent: pct('tokenizer', 0.05 + (0.9 * (i + 1)) / SDXL_SMALL_FILES.length),
      message: `预取 SDXL 配置 ${i + 1}/${SDXL_SMALL_FILES.length}`,
    });
  }
  log(`SDXL tokenizer/config 就绪：${SDXL_DIR}（本次新下 ${downloaded} 个文件）`);
  report({ phase: 'tokenizer', percent: pct('tokenizer', 1), message: 'SDXL 配置已就绪' });
}

// ---------------------------------------------------------------- 安装主流程

async function install() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  saveState({ ok: false, running: true, phase: 'venv', percent: 0, error: null, bytes: { done: 0, total: 0 } }, true);

  await ensureVenv();
  await ensureTorch();
  await ensureDeps();
  state.sizes.venv = dirSize(VENV_DIR);
  logFileOnly(`venv 体积：${state.sizes.venv} 字节`);
  await ensureModel();
  await ensureSdxlConfig();

  const finalSizes = { venv: dirSize(VENV_DIR), model: fs.existsSync(MODEL_PATH) ? fs.statSync(MODEL_PATH).size : 0 };
  saveState(
    {
      ok: true,
      running: false,
      phase: 'done',
      percent: 100,
      message: '引擎安装完成，可以生图了',
      error: null,
      sizes: finalSizes,
      bytes: { done: finalSizes.model, total: finalSizes.model },
    },
    true,
  );
  log(`安装完成。venv=${fmtMB(finalSizes.venv)}，模型=${fmtMB(finalSizes.model)}（${MODEL_PATH}）`);
}

// ---------------------------------------------------------------- --verify 冒烟

function startWorkerForVerify() {
  return new Promise((resolve, reject) => {
    const child = spawn(VENV_PY, [WORKER_PY, '--model', MODEL_PATH, '--data-dir', DATA], {
      cwd: ROOT,
      windowsHide: true,
      env: pythonEnv({
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        HF_HUB_DISABLE_PROGRESS_BARS: '1',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    resolve(child);
  });
}

async function verify() {
  // 前置检查
  if (!fs.existsSync(VENV_PY)) fail('venv 不存在，先跑 node engine/setup.mjs --install');
  if (!fs.existsSync(MODEL_PATH)) fail('模型不存在，先跑 node engine/setup.mjs --install');
  if (!fs.existsSync(path.join(SDXL_DIR, 'model_index.json')))
    fail('SDXL 配置缺失，先跑 node engine/setup.mjs --install');
  if (!fs.existsSync(WORKER_PY)) fail('找不到 engine/worker.py');

  report({ phase: 'verify', percent: pct('verify', 0), message: '启动 worker 跑 512x512 冒烟图' });
  const outDir = path.join(OUT_DIR, 'verify');
  fs.mkdirSync(outDir, { recursive: true });

  const child = await startWorkerForVerify();
  child.stdin.on('error', () => {}); // worker 先退出时 stdin 写会 EPIPE，吞掉即可
  let stderrTail = '';
  const onWorkerStderr = (b) => {
    const t = b.toString('utf8');
    stderrTail += t;
    if (stderrTail.length > 20000) stderrTail = stderrTail.slice(-10000);
    for (const line of t.split(/\r?\n/)) if (line.trim()) writeLogStream('    ! ' + line + '\n');
  };
  child.stderr.on('data', onWorkerStderr);

  const result = await new Promise((resolve, reject) => {
    let buf = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill();
      } catch {}
      reject(new Error('冒烟测试超时（600s）——看 data/state/setup.log 或 worker 的 stderr'));
    }, 600000);

    const onLine = (line) => {
      const s = line.trim();
      if (!s) return;
      let msg;
      try {
        msg = JSON.parse(s);
      } catch {
        logFileOnly('worker stdout（非 JSON，已忽略）：' + s.slice(0, 300));
        return;
      }
      if (msg.type === 'ready') {
        log(
          `worker ready：pid=${msg.pid} python=${msg.python} torch=${msg.torch} diffusers=${msg.diffusers} cuda=${msg.cuda} device=${msg.deviceName}`,
        );
        child.stdin.write(
          JSON.stringify({
            id: 'verify-1',
            op: 'generate',
            prompt: '1girl, solo, masterpiece',
            negative: '',
            width: 512,
            height: 512,
            steps: 20,
            cfg: 5.5,
            seed: 42,
            count: 1,
            clipSkip: 2,
            outDir,
          }) + '\n',
        );
      } else if (msg.type === 'progress') {
        report({
          phase: 'verify',
          percent: pct('verify', 0.2 + 0.7 * (msg.step / Math.max(1, msg.total))),
          message: `冒烟图生成中 ${msg.step}/${msg.total}（${msg.stage}）`,
        });
      } else if (msg.type === 'done' && msg.id === 'verify-1') {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(msg);
      } else if (msg.type === 'error' && msg.id === 'verify-1') {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(new Error(`worker 返回错误 ${msg.code}：${msg.message}（${msg.hint || ''}）`));
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        onLine(line);
      }
    });
    child.on('error', (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error(`worker 提前退出（exit ${code}）\n${stderrTail.slice(-1500)}`));
    });
  });

  // 让 worker 正常退出，并等它真的退出：否则最后一个 stderr chunk 可能在 logStream.end() 之后到达
  try {
    child.stdin.write(JSON.stringify({ id: 'verify-bye', op: 'shutdown' }) + '\n');
  } catch {}
  try {
    child.stdin.end();
  } catch {}
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolve();
    }, 3000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  child.stderr.off('data', onWorkerStderr);

  const img = result.images?.[0] || {};
  if (!img.path || !fs.existsSync(img.path)) fail(`冒烟图没有落盘：${img.path || '(无路径)'}`);
  const pngBytes = fs.statSync(img.path).size;
  if (pngBytes < 10 * 1024) fail(`冒烟图体积异常：${pngBytes} 字节（${img.path}）`);
  log(
    `冒烟成功：${img.path}（${img.width}x${img.height}，${pngBytes} 字节，生图 ${result.elapsedSec}s，加载 ${result.loadSec}s，模式 ${result.vramMode}）`,
  );
  report({ phase: 'verify', percent: pct('verify', 1), message: '冒烟图通过' });
  return {
    ok: true,
    path: img.path,
    width: img.width,
    height: img.height,
    pngBytes,
    elapsedSec: result.elapsedSec,
    loadSec: result.loadSec,
    vramMode: result.vramMode,
    model: result.model,
  };
}

// ---------------------------------------------------------------- 入口

function printUsage() {
  console.log(`鱼鱼画画 · 引擎安装

用法：
  node engine/setup.mjs [--install] [--verify] [--json] [--python <python.exe>]

  --install   建 venv、装 torch(cu124)/diffusers、下载 Illustrious-XL-v2.0 模型（默认动作）
  --verify    启动 worker 跑一张 512x512 冒烟图，成功 exit 0
  --json      结束时往 stdout 打一行 JSON 结果（安装进度仍看 data/state/setup.json）
  --python    指定 Python 3.12 的路径（默认自动探测：py -3 / PATH 里的 python）
  --help      看这段说明

也可以用环境变量 FISH_PAINT_PYTHON 指定 Python 3.12。

进度：data/state/setup.json   日志：data/state/setup.log
`);
}

async function main() {
  const args = process.argv.slice(2);
  jsonMode = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return 0;
  }
  // --python <path> / --python=<path>：指定基础 Python（默认自动探测）
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--python') {
      cliPython = String(args[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg.startsWith('--python=')) {
      cliPython = arg.slice('--python='.length).trim();
      continue;
    }
    rest.push(arg);
  }
  if (args.includes('--python') && !cliPython) {
    console.error('--python 需要一个 python.exe 路径');
    return 2;
  }
  const unknown = rest.filter((a) => !['--install', '--verify', '--json', '--help', '-h'].includes(a));
  if (unknown.length) {
    console.error('未知参数：' + unknown.join(' '));
    printUsage();
    return 2;
  }
  const doVerify = args.includes('--verify');
  const doInstall = args.includes('--install') || !doVerify;

  fs.mkdirSync(STATE_DIR, { recursive: true });
  // 日志轮转：超过 5MB 换一个
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
  } catch {}
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  // 收尾阶段（logStream.end() 之后）偶尔还有晚到的日志：吞掉错误，别把安装进程打崩
  logStream.on('error', (e) => console.error('写 setup.log 失败：' + (e?.message || e)));
  logStream.write(`\n===== setup.mjs 启动 ${ts()} 参数：${args.join(' ') || '(默认 --install)'} =====\n`);

  let installResult = null;
  let verifyResult = null;
  let failed = false;
  try {
    if (doInstall) {
      await install();
      installResult = { ...state };
    }
    if (doVerify) {
      verifyResult = await verify();
    }
    if (jsonMode) {
      const out = { ok: true, install: installResult, verify: verifyResult };
      console.log(JSON.stringify(out));
    }
    log('全部完成');
    return 0;
  } catch (e) {
    failed = true;
    const msg = e?.message || String(e);
    saveState(
      {
        ok: false,
        running: false,
        phase: 'error',
        message: '安装失败：' + msg.split('\n')[0],
        error: msg,
      },
      true,
    );
    log('失败：' + msg);
    if (jsonMode) console.log(JSON.stringify({ ok: false, error: msg }));
    return 1;
  } finally {
    // --verify 的进度也会写 setup.json（phase=verify/running=true）；跑完必须把状态收尾，
    // 否则插件读到的永远是「正在安装」。失败时保留 error 状态，不覆盖。
    if (!failed) {
      try {
        finalizeState(doInstall, verifyResult);
      } catch (e) {
        console.error('写 setup.json 收尾状态失败：' + (e?.message || e));
      }
    }
    if (logStream) logStream.end();
  }
}

function finalizeState(doInstall, verifyResult) {
  const sizes = {
    venv: dirSize(VENV_DIR),
    model: fs.existsSync(MODEL_PATH) ? fs.statSync(MODEL_PATH).size : 0,
  };
  let message = '引擎安装完成，可以生图了';
  if (verifyResult) message = doInstall ? '引擎安装完成，冒烟图通过' : '引擎可用（冒烟图通过）';
  saveState(
    {
      ok: true,
      running: false,
      phase: 'done',
      percent: 100,
      message,
      error: null,
      sizes,
      bytes: { done: sizes.model, total: sizes.model },
    },
    true,
  );
}

main().then(
  (code) => {
    // 给日志流一点时间落盘
    setTimeout(() => process.exit(code), 60);
  },
  (e) => {
    console.error(e?.stack || String(e));
    process.exit(1);
  },
);
