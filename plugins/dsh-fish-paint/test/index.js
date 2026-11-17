// test/index.js
//
// 为什么需要这个文件：某些 Node 版本（本机 v24.14.0 实测）把 `node --test test/`
// 的目录参数当成**入口模块**去执行，而不是展开目录里的测试文件，于是命令直接失败。
// 这个入口把 test/ 下所有 *.test.mjs 逐个 import，让 `node --test test/` 真的跑全部单测；
// 新增测试文件只要叫 *.test.mjs 就会被自动带上，不用改这里。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const files = fs
  .readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

for (const file of files) {
  await import(pathToFileURL(path.join(here, file)).href)
}
