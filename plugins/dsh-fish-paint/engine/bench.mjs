#!/usr/bin/env node
// 鱼鱼画画（dsh-fish-paint）· 引擎验收/实测脚本
//
// 用途：启动真实 worker（venv python），按 CONTRACT §3 的 JSONL 协议跑一组生图，
// 记录 loadSec / 生图秒数 / 显存峰值 / PNG 尺寸与字节数，顺便测错误路径。
//
// 用法：
//   node engine/bench.mjs --mode offload
//   node engine/bench.mjs --mode full --cases 512 --steps 8 --case-timeout 180
//   node engine/bench.mjs --mode auto --cases 512,1024,832x1216 --sticker --out-file data/state/bench-offload.json
//
// 关键行为（2026-11-17 加）：
//   - 每个 case 有独立超时（--case-timeout，默认 300s）；超时立刻 kill 掉 worker，避免
//     「GPU 打满但永远不出图」把整轮压测卡死（Windows 下 SDXL 整卡硬塞会触发系统内存回退）。
//   - 无论成功/失败/超时，都会把 result JSON 和 worker stderr 日志落盘（不会白跑）。
//   - worker 进程退出时，未完成的请求立刻失败，而不是干等到超时。
//
// 输出：人话表格 + 可选 JSON 文件。零 npm 依赖。

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');
const VENV_PY = path.join(DATA, '.venv', 'Scripts', 'python.exe');
const MODEL = path.join(DATA, 'models', 'Illustrious-XL-v2.0.safetensors');
const WORKER = path.join(HERE, 'worker.py');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = {
    mode: 'auto',
    cases: ['512', '1024', '832x1216'],
    outFile: null,
    steps: 28,
    cfg: 5.5,
    sticker: false,
    count: 1,
    seed: 424242,
    clipSkip: 2,
    caseTimeoutSec: 300,
    readyTimeoutSec: 180,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') out.mode = argv[++i];
    else if (a === '--cases') out.cases = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out-file') out.outFile = argv[++i];
    else if (a === '--steps') out.steps = Number(argv[++i]);
    else if (a === '--cfg') out.cfg = Number(argv[++i]);
    else if (a === '--count') out.count = Number(argv[++i]);
    else if (a === '--seed') out.seed = Number(argv[++i]);
    else if (a === '--clip-skip') out.clipSkip = Number(argv[++i]);
    else if (a === '--sticker') out.sticker = true;
    else if (a === '--case-timeout') out.caseTimeoutSec = Number(argv[++i]);
    else if (a === '--help') {
      console.log(
        '用法：node engine/bench.mjs [--mode auto|full|offload] [--cases 512,1024,832x1216] ' +
          '[--sticker] [--steps 28] [--cfg 5.5] [--count 1] [--seed 424242] [--clip-skip 2] ' +
          '[--case-timeout 300] [--out-file x.json]',
      );
      process.exit(0);
    } else {
      console.error('未知参数：' + a);
      process.exit(2);
    }
  }
  if (!(out.caseTimeoutSec > 0)) {
    console.error('--case-timeout 必须是正数（秒）');
    process.exit(2);
  }
  if (!(out.count >= 1 && out.count <= 4)) {
    console.error('--count 必须是 1-4');
    process.exit(2);
  }
  return out;
}

function parseCase(s) {
  if (s.includes('x')) {
    const [w, h] = s.split('x').map(Number);
    return { width: w, height: h, label: `${w}x${h}` };
  }
  const n = Number(s);
  return { width: n, height: n, label: `${n}x${n}` };
}

// 读 PNG 头部，确认是真 PNG（签名 + IHDR 宽高 + 文件字节数）
function inspectPng(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(33);
    fs.readSync(fd, head, 0, 33, 0);
    const sig = head.subarray(0, 8).toString('hex');
    const isPng = sig === '89504e470d0a1a0a';
    const width = head.readUInt32BE(16);
    const height = head.readUInt32BE(20);
    return { isPng, width, height, bytes: fs.statSync(file).size };
  } finally {
    fs.closeSync(fd);
  }
}

// Windows 上稳妥地干掉 worker；先 SIGTERM（TerminateProcess），残留再 taskkill /T /F
async function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const pid = child.pid;
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null) resolve(true);
    else child.once('exit', () => resolve(true));
  });
  try {
    child.kill();
  } catch {}
  const done = await Promise.race([exited, sleep(3000).then(() => false)]);
  if (!done && pid) {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {}
  }
}

class Client {
  constructor(child) {
    this.child = child;
    this.buf = '';
    this.pending = new Map();
    this.logs = [];
    this.events = [];
    this.lastCase = null;
    this.exited = false;
    this.exitInfo = null;
    this.onProgress = null;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          this.logs.push('[stdout 非 JSON] ' + line);
          continue;
        }
        this.events.push(msg);
        if (msg.type === 'progress') {
          if (this.onProgress) this.onProgress(msg);
          continue;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(timer);
          if (msg.type === 'error') reject(msg);
          else resolve(msg);
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.logs.push(line);
        const peak = /显存峰值.*allocated=(\d+)MiB reserved=(\d+)MiB/.exec(line);
        if (peak && this.lastCase) {
          this.lastCase.vramAllocMiB = Number(peak[1]);
          this.lastCase.vramReservedMiB = Number(peak[2]);
        }
        const loadM = /模型加载完成：([\d.]+)s/.exec(line);
        if (loadM && this.lastCase) this.lastCase.loadLogSec = Number(loadM[1]);
      }
    });

    child.stdin.on('error', (err) => {
      // worker 提前退出时写 stdin 会 EPIPE；这里只记录，避免 unhandled 'error' 把 bench 打崩
      this.logs.push('[stdin error] ' + (err?.message || err));
    });

    child.on('exit', (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`worker 进程已退出（code=${code} signal=${signal}）`));
      }
      this.pending.clear();
    });
    child.on('error', (err) => {
      this.logs.push('[child error] ' + (err?.message || err));
    });
  }

  send(req, timeoutMs) {
    const id = req.id || `req-${Math.random().toString(16).slice(2)}`;
    req.id = id;
    return new Promise((resolve, reject) => {
      if (this.exited || !this.child.stdin.writable) {
        reject(new Error(`worker 不可写（exited=${this.exited}）`));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`请求超时（${timeoutMs}ms）：${JSON.stringify(req).slice(0, 160)}`), { timeout: true }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify(req) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  waitReady(timeoutMs) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        const ready = this.events.find((e) => e.type === 'ready');
        if (ready) {
          clearInterval(tick);
          resolve(ready);
        } else if (this.exited) {
          clearInterval(tick);
          reject(new Error('worker 在 ready 之前退出'));
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(tick);
          reject(new Error('等 ready 超时'));
        }
      }, 50);
    });
  }
}

function startWorker({ mode, model = MODEL }) {
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    FISH_PAINT_VRAM: mode,
  };
  const child = spawn(VENV_PY, [WORKER, '--model', model, '--data-dir', DATA], {
    cwd: ROOT,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new Client(child);
}

function writeArtifacts(opts, result, client) {
  if (!opts.outFile) return null;
  const abs = path.isAbsolute(opts.outFile) ? opts.outFile : path.join(ROOT, opts.outFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(result, null, 2), 'utf8');
  const logFile = abs.replace(/\.json$/i, '') + '.log';
  fs.writeFileSync(logFile, (client ? client.logs.join('\n') : '') + '\n', 'utf8');
  console.log('已写：' + abs + ' / ' + logFile);
  return abs;
}

const PROMPT_BASE = '1girl, solo, masterpiece, best quality, looking at viewer, upper body, detailed background';
const NEGATIVE =
  'lowres, bad anatomy, bad hands, text, error, worst quality, low quality, jpeg artifacts, signature, watermark, blurry';

async function runBench(opts, result, state) {
  const outDir = path.join(DATA, 'out', 'bench-' + opts.mode + '-' + Date.now());
  fs.mkdirSync(outDir, { recursive: true });
  result.outDir = outDir;

  const client = startWorker({ mode: opts.mode });
  state.client = client;

  const ready = await client.waitReady(opts.readyTimeoutSec * 1000);
  console.log(`ready：python=${ready.python} torch=${ready.torch} diffusers=${ready.diffusers} cuda=${ready.cuda}`);
  console.log(`设备：${ready.deviceName}`);
  result.ready = ready;

  // ---- 协议小测：ping / 未知 op / 坏请求 / 坏 JSON / 出错后仍存活 ----
  const pong = await client.send({ op: 'ping', id: 'p1' }, 15000);
  result.protocol.ping = pong.type === 'pong';
  try {
    await client.send({ op: 'nope', id: 'x1' }, 15000);
    result.protocol.unknownOpError = false;
  } catch (e) {
    result.protocol.unknownOpError = e.code === 'BAD_REQUEST';
  }
  try {
    // 缺 prompt：必须在真跑 GPU 之前就被 worker 拒掉
    await client.send({ width: 1024, height: 1024, outDir }, 15000);
    result.protocol.badRequestError = false;
  } catch (e) {
    result.protocol.badRequestError = e.code === 'BAD_REQUEST';
  }
  client.child.stdin.write('this is not json\n');
  await sleep(300);
  result.protocol.badJsonError = client.events.some(
    (e) => e.type === 'error' && e.code === 'BAD_REQUEST' && /JSON/i.test(e.message),
  );
  try {
    await client.send({ op: 'ping', id: 'p2' }, 15000);
    result.protocol.aliveAfterErrors = true;
  } catch {
    result.protocol.aliveAfterErrors = false;
  }

  // ---- 逐个尺寸生图 ----
  const caseList = opts.cases.map(parseCase);
  if (opts.sticker) {
    // sticker 预设：1024x1024 生成 + resize 512x512（CONTRACT §4 的 sticker 场景）
    caseList.push({
      width: 1024,
      height: 1024,
      label: 'sticker-1024>512',
      resize: { width: 512, height: 512 },
      expectWidth: 512,
      expectHeight: 512,
      extraPrompt: 'chibi, simple background, thick outline, vibrant colors',
    });
  }

  const caseTimeoutMs = opts.caseTimeoutSec * 1000;
  for (let i = 0; i < caseList.length; i++) {
    const c = caseList[i];
    const rec = { label: c.label, width: c.width, height: c.height, index: i };
    client.lastCase = rec;
    const t0 = Date.now();
    try {
      const done = await client.send(
        {
          op: 'generate',
          prompt: PROMPT_BASE + (c.extraPrompt ? ', ' + c.extraPrompt : ''),
          negative: NEGATIVE,
          width: c.width,
          height: c.height,
          steps: opts.steps,
          cfg: opts.cfg,
          count: opts.count,
          seed: opts.seed,
          clipSkip: opts.clipSkip,
          outDir,
          ...(c.resize ? { resize: c.resize } : {}),
        },
        caseTimeoutMs,
      );
      rec.wallSec = +((Date.now() - t0) / 1000).toFixed(1);
      rec.elapsedSec = done.elapsedSec;
      rec.loadSec = done.loadSec;
      rec.vramMode = done.vramMode;
      rec.model = done.model;
      const imgs = Array.isArray(done.images) ? done.images : [];
      const expectW = c.expectWidth || c.width;
      const expectH = c.expectHeight || c.height;
      rec.imageCount = imgs.length;
      rec.images = imgs.map((img) => {
        const one = { path: img.path, seed: img.seed };
        if (img.path && fs.existsSync(img.path)) {
          const png = inspectPng(img.path);
          Object.assign(one, { pngBytes: png.bytes, pngIsPng: png.isPng, pngWidth: png.width, pngHeight: png.height });
          one.ok = png.isPng === true && png.width === expectW && png.height === expectH;
        } else {
          one.ok = false;
        }
        return one;
      });
      const first = rec.images[0] || {};
      Object.assign(rec, {
        path: first.path,
        seed: first.seed,
        pngBytes: first.pngBytes,
        pngIsPng: first.pngIsPng,
        pngWidth: first.pngWidth,
        pngHeight: first.pngHeight,
      });
      rec.ok = imgs.length === opts.count && rec.images.every((x) => x.ok);
      console.log(
        `[${c.label}] ok=${rec.ok} 张数=${rec.imageCount} 生图=${rec.elapsedSec}s 墙钟=${rec.wallSec}s 加载=${rec.loadSec}s ` +
          `模式=${rec.vramMode} 显存峰值(alloc/res)=${rec.vramAllocMiB ?? '?'}/${rec.vramReservedMiB ?? '?'}MiB ` +
          `PNG=${rec.pngBytes}B ${rec.pngWidth}x${rec.pngHeight}` +
          (rec.imageCount > 1 ? ` seeds=${rec.images.map((x) => x.seed).join(',')}` : ''),
      );
    } catch (e) {
      rec.ok = false;
      rec.error = e.code || e.message;
      rec.wallSec = +((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[${c.label}] 失败（${rec.wallSec}s）：${e.code || ''} ${e.message || e}`);
      result.cases.push(rec);
      if (e.timeout || client.exited) {
        result.fatal = e.timeout ? 'case-timeout' : 'worker-exited';
        // 剩下的 case 记 skipped，别在死 worker 上瞎等
        for (let j = i + 1; j < caseList.length; j++) {
          result.cases.push({ label: caseList[j].label, index: j, ok: false, skipped: true });
        }
        break;
      }
      continue;
    }
    result.cases.push(rec);
    if (rec.vramMode) result.vramMode = rec.vramMode;
  }

  // ---- status + shutdown（worker 还活着才发）----
  if (!client.exited) {
    try {
      const st = await client.send({ op: 'status', id: 'st1' }, 20000);
      result.status = st;
      console.log(`status：loaded=${st.loaded} vramMode=${st.vramMode} gpu=${JSON.stringify(st.gpu)}`);
    } catch (e) {
      result.statusError = e.message || String(e);
      console.log('status 失败：' + (e.message || e));
    }
    try {
      await client.send({ op: 'shutdown', id: 'bye1' }, 15000);
    } catch {}
    await sleep(300);
  }
  await killTree(client.child);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(VENV_PY)) {
    console.error('venv 不存在：' + VENV_PY + '（先跑 node engine/setup.mjs --install）');
    process.exit(1);
  }
  if (!fs.existsSync(MODEL)) {
    console.error('模型不存在：' + MODEL);
    process.exit(1);
  }

  const t0 = Date.now();
  const result = {
    mode: opts.mode,
    startedAt: new Date().toISOString(),
    opts: {
      cases: opts.cases,
      steps: opts.steps,
      cfg: opts.cfg,
      count: opts.count,
      seed: opts.seed,
      clipSkip: opts.clipSkip,
      sticker: opts.sticker,
      caseTimeoutSec: opts.caseTimeoutSec,
    },
    cases: [],
    protocol: {},
    errors: [],
  };
  const state = { client: null };

  let fatal = null;
  try {
    await runBench(opts, result, state);
  } catch (e) {
    fatal = e?.code || e?.message || String(e);
    result.errors.push(String(e?.stack || e));
    console.error('bench 失败：', e?.stack || e);
  } finally {
    const client = state.client;
    if (client && !client.exited) await killTree(client.child);
    result.finishedAt = new Date().toISOString();
    result.wallSec = +((Date.now() - t0) / 1000).toFixed(1);
    const okCount = result.cases.filter((c) => c.ok).length;
    const attempted = result.cases.filter((c) => !c.skipped).length;
    result.summary = {
      okCount,
      attempted,
      total: result.cases.length,
      fatal: result.fatal || fatal || null,
      protocolOk: Object.values(result.protocol).every(Boolean) && Object.keys(result.protocol).length >= 5,
    };
    console.log(
      `\n结果：${okCount}/${attempted} 张成功；协议自检 ${JSON.stringify(result.protocol)}` +
        `；总墙钟 ${result.wallSec}s` +
        (result.summary.fatal ? `；fatal=${result.summary.fatal}` : ''),
    );
    writeArtifacts(opts, result, client);
    const exitOk = okCount === attempted && attempted === result.cases.length && result.summary.protocolOk && !result.summary.fatal;
    process.exit(exitOk ? 0 : 1);
  }
}

main();
