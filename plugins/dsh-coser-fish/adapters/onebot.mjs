// OneBot 11 适配层：把「引用一张图 + /鱼鱼找鸡」接进任何 OneBot 实现。
//
// 跟漫画下载一样，只跟你换一个函数：`onebot(action, params)`。
//
// 用法：
//
//   import { handleFishCommand } from './adapters/onebot.mjs';
//   const onebot = (action, params) => fetch(`http://127.0.0.1:3000/${action}`, {
//     method: 'POST',
//     headers: { 'content-type': 'application/json', authorization: 'Bearer 你的token' },
//     body: JSON.stringify(params)
//   }).then((r) => r.json());
//
//   onMessage(async (event) => {
//     const key = event.group_id ? `group:${event.group_id}` : `private:${event.user_id}`;
//     const done = await handleFishCommand({ text: event.raw_message, key, event, onebot });
//     if (done.handled) return;
//   });
//
// 它做的事：取被引用的那张图 → 反查 → 把账号用人话发回去（有账号时顺带发一张「已找到」图）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reverseSearch,
  extractAccounts,
  formatReply,
  engineLabels
} from '../src/fish-find-chicken.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  enabled: true,
  engines: ['lens', 'saucenao', 'tracemoe'],
  timeoutMs: 45000,
  maxAccounts: 3,
  strictConsensus: true,
  proxy: '',
  browserExe: '',
  foundImage: '',
  sendOnMiss: false,
  cooldownSec: 30
};

function loadConfig(overrides = {}) {
  let saved = {};
  const file = path.join(PLUGIN_ROOT, 'config.json');
  if (fs.existsSync(file)) {
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  }
  return { ...DEFAULTS, ...saved, ...overrides };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendText(onebot, key, text) {
  const [kind, id] = String(key).split(':');
  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
  const params = kind === 'group' ? { group_id: Number(id), message: text } : { user_id: Number(id), message: text };
  try { await onebot(action, params); } catch (error) { console.warn('[鱼鱼找鸡] 发文字失败：', error?.message ?? error); }
}

/** 从被引用/当前消息里取图。OneBot 的图是 url 或 file，直接抓它的 url 最省事。 */
async function imageFromSegments(segments) {
  const seg = (segments ?? []).find((s) => s?.type === 'image');
  if (!seg) return null;
  const url = seg.data?.url || seg.data?.file || '';
  if (!/^https?:\/\//i.test(url)) {
    // file 字段有时是 base64:// 或本机路径
    if (String(url).startsWith('base64://')) {
      return { bytes: Buffer.from(String(url).slice(9), 'base64'), mimeType: 'image/jpeg' };
    }
    return null;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined });
  if (!res.ok) throw new Error(`取图失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
  if (!/^image\//.test(mimeType)) throw new Error(`那个地址不是图片（${mimeType}）`);
  return { bytes: buf, mimeType };
}

/** 拿被引用的那条消息里的图；没有引用就看本条消息自己有没有图。 */
async function quotedImage(event, onebot) {
  const replyId = event?.reply?.id ?? event?.message?.[0]?.data?.id ?? 0;
  if (replyId) {
    try {
      const got = await onebot('get_msg', { message_id: Number(replyId) });
      const data = got?.data ?? got;
      const segs = data?.message ?? [];
      const img = await imageFromSegments(segs);
      if (img) return img;
    } catch (error) {
      console.warn('[鱼鱼找鸡] 取被引用的消息失败：', error?.message ?? error);
    }
  }
  return imageFromSegments(event?.message);
}

const lastUse = new Map();

/**
 * 处理一条消息里的 /鱼鱼找鸡。
 * @returns {Promise<{handled: boolean}>} handled=false 表示不归我管。
 */
export async function handleFishCommand({ text, key, event = null, onebot, config = {} }) {
  const cfg = loadConfig(config);
  const raw = String(text ?? '').trim();
  const m = raw.match(/^\/鱼鱼找鸡(?:\s+(.+))?$/);
  if (!m) return { handled: false };
  if (!cfg.enabled) {
    await sendText(onebot, key, '鱼鱼找鸡现在是关的（config.json 的 enabled）');
    return { handled: true };
  }

  // 冷却：同一个人 30 秒内别刷 —— 反查引擎有免费额度，刷爆了大家都不能用。
  const who = `${key}|${event?.user_id ?? ''}`;
  const now = Date.now();
  const gap = Math.max(0, Number(cfg.cooldownSec) || 0) * 1000;
  const last = lastUse.get(who) ?? 0;
  if (gap && now - last < gap) {
    await sendText(onebot, key, `刚查过，${Math.ceil((gap - (now - last)) / 1000)} 秒后再试`);
    return { handled: true };
  }
  lastUse.set(who, now);

  const arg = String(m[1] ?? '').trim();
  let image = null;
  if (arg && !/^[1-3]$/.test(arg) && fs.existsSync(path.resolve(arg))) {
    const file = path.resolve(arg);
    image = { bytes: fs.readFileSync(file), mimeType: file.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  } else {
    image = await quotedImage(event, onebot);
  }
  if (!image) {
    await sendText(onebot, key, '要引用有图的那条再发 /鱼鱼找鸡');
    return { handled: true };
  }

  await sendText(onebot, key, '收到，开始找鸡');
  const result = await reverseSearch(image.bytes, image.mimeType, {
    engines: cfg.engines,
    timeoutMs: cfg.timeoutMs,
    proxy: cfg.proxy || '',
    browserExe: cfg.browserExe || ''
  });
  const accounts = extractAccounts(result.candidates, { max: cfg.maxAccounts, strictNames: cfg.strictConsensus !== false });
  const text2 = formatReply({
    accounts,
    candidates: result.candidates,
    enginesUsed: result.enginesUsed,
    failures: result.failures
  });

  // 有账号、又有「已找到」图：图+文一条发出去（一条比两条稳）。
  if (accounts.length && cfg.foundImage && fs.existsSync(cfg.foundImage)) {
    const base64 = 'base64://' + fs.readFileSync(cfg.foundImage).toString('base64');
    const [kind, id] = String(key).split(':');
    const message = [
      { type: 'image', data: { file: base64 } },
      { type: 'text', data: { text: text2 } }
    ];
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params = kind === 'group' ? { group_id: Number(id), message } : { user_id: Number(id), message };
    try {
      await onebot(action, params);
      return { handled: true };
    } catch (error) {
      console.warn('[鱼鱼找鸡] 图文混排被拒，改成两条：', error?.message ?? error);
      try { await onebot(action, { ...params, message: [message[0]] }); } catch {}
      await sleep(400);
    }
  }
  await sendText(onebot, key, text2);
  return { handled: true };
}

export default { handleFishCommand, engineLabels };
