// lib/store.js 的单测：同名 .json、<png>.meta.json sidecar、index.jsonl、listRecent 过滤。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dateKey, ensureDirs, indexPath, listRecent, readPngInfo, recordImage, todayDir } from '../lib/store.js'

/** 造一个只有 PNG 签名 + IHDR 的 24 字节头，readPngInfo 只读这个。 */
function makePng(width, height) {
  const buffer = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function makeTemp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-paint-store-'))
  return { root, dataDir: path.join(root, 'data') }
}

function seedImage(dataDir, name, width, height) {
  const dir = todayDir(dataDir)
  const file = path.join(dir, name)
  fs.writeFileSync(file, makePng(width, height))
  return file
}

test('ensureDirs 建出 data/out/state，todayDir 建当天目录', () => {
  const { dataDir } = makeTemp()
  const dirs = ensureDirs(dataDir)
  assert.ok(fs.existsSync(dirs.out))
  assert.ok(fs.existsSync(dirs.state))
  const day = todayDir(dataDir)
  assert.match(day, /out[\\/]\d{4}-\d{2}-\d{2}$/)
  assert.ok(fs.existsSync(day))
})

test('readPngInfo 从 IHDR 读宽高，非 PNG 返回 null', () => {
  const { root } = makeTemp()
  const okay = path.join(root, 'ok.png')
  fs.writeFileSync(okay, makePng(832, 1216))
  assert.deepEqual(readPngInfo(okay), { width: 832, height: 1216 })

  const bad = path.join(root, 'bad.png')
  fs.writeFileSync(bad, 'not a png')
  assert.equal(readPngInfo(bad), null)
})

test('recordImage 写同名 .json、<png>.meta.json、追加 index.jsonl', () => {
  const { dataDir } = makeTemp()
  ensureDirs(dataDir)
  const png = seedImage(dataDir, '20261117-201500-42.png', 1024, 1024)

  const record = recordImage({
    dataDir,
    image: { path: png, seed: 42 },
    meta: {
      prompt: '1girl, solo',
      negative: 'lowres',
      preset: 'anime',
      steps: 28,
      cfg: 5.5,
      model: 'Illustrious-XL-v2.0',
      engine: { vramMode: 'auto', loadSec: 1.5 },
      rating: 'nsfw',
      target: 'group:1104418054',
      note: '单测',
    },
  })

  assert.equal(record.width, 1024)
  assert.equal(record.height, 1024)
  assert.equal(record.seed, 42)
  assert.equal(record.rating, 'r18')
  assert.equal(record.path, png)

  const metaFile = png.replace(/\.png$/, '.json')
  assert.ok(fs.existsSync(metaFile), '同名 .json 应存在')
  const onDisk = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  assert.equal(onDisk.prompt, '1girl, solo')
  assert.equal(onDisk.negative, 'lowres')
  assert.equal(onDisk.preset, 'anime')
  assert.equal(onDisk.model, 'Illustrious-XL-v2.0')
  assert.deepEqual(onDisk.engine, { vramMode: 'auto', loadSec: 1.5 })
  assert.equal(onDisk.target, 'group:1104418054')
  assert.equal(onDisk.note, '单测')
  assert.ok(onDisk.createdAt)

  // r18-guard 只认 <png 绝对路径>.meta.json 这个文件名
  const sidecarPath = `${png}.meta.json`
  assert.ok(fs.existsSync(sidecarPath), 'sidecar 路径必须是 <png>.meta.json')
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'))
  assert.deepEqual(sidecar.rating, 'r18')
  assert.equal(sidecar.source, 'dsh-fish-paint')
  assert.ok(sidecar.createdAt)

  const lines = fs.readFileSync(indexPath(dataDir), 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 1)
  assert.equal(JSON.parse(lines[0]).path, png)
})

test('recordImage：sfw → rating all，缺尺寸时回退读 PNG 头', () => {
  const { dataDir } = makeTemp()
  const png = seedImage(dataDir, '20261117-201501-7.png', 832, 1216)
  const record = recordImage({ dataDir, image: { path: png, seed: 7 }, meta: { prompt: 'x', rating: 'sfw' } })
  assert.equal(record.rating, 'all')
  assert.equal(record.width, 832)
  assert.equal(record.height, 1216)
  const sidecar = JSON.parse(fs.readFileSync(`${png}.meta.json`, 'utf8'))
  assert.equal(sidecar.rating, 'all')
})

test('recordImage 拒绝没有 path 的图片', () => {
  const { dataDir } = makeTemp()
  assert.throws(() => recordImage({ dataDir, image: {}, meta: {} }), /image\.path/)
})

test('listRecent：新→旧、date / target / limit 过滤', () => {
  const { dataDir } = makeTemp()
  const first = seedImage(dataDir, '20261117-201500-1.png', 1024, 1024)
  const second = seedImage(dataDir, '20261117-201502-2.png', 1024, 1024)
  recordImage({ dataDir, image: { path: first, seed: 1 }, meta: { prompt: 'first', rating: 'sfw', target: 'group:1' } })
  recordImage({ dataDir, image: { path: second, seed: 2 }, meta: { prompt: 'second', rating: 'sfw', target: 'private:2' } })

  const recent = listRecent(dataDir)
  assert.deepEqual(
    recent.map((item) => item.prompt),
    ['second', 'first'],
  )

  assert.deepEqual(
    listRecent(dataDir, { limit: 1 }).map((item) => item.prompt),
    ['second'],
  )
  assert.deepEqual(
    listRecent(dataDir, { target: 'group:1' }).map((item) => item.prompt),
    ['first'],
  )
  assert.deepEqual(
    listRecent(dataDir, { date: dateKey() }).map((item) => item.prompt),
    ['second', 'first'],
  )
  assert.deepEqual(listRecent(dataDir, { date: '2000-01-01' }), [])
})

test('listRecent：index.jsonl 被删掉时回退扫 out/ 元数据', () => {
  const { dataDir } = makeTemp()
  const png = seedImage(dataDir, '20261117-201503-9.png', 512, 512)
  recordImage({ dataDir, image: { path: png, seed: 9 }, meta: { prompt: 'fallback', rating: 'sfw' } })

  fs.rmSync(indexPath(dataDir))
  const recent = listRecent(dataDir, { limit: 5 })
  assert.equal(recent.length, 1)
  assert.equal(recent[0].prompt, 'fallback')
  assert.equal(recent[0].path, png)
})
