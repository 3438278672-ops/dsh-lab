// 一次性联调：起真的 gpu-queue 服务，再用 qq-sing 的 python/gpuqueue.py 领牌/还牌
// 用法：node tools/e2e-python.mjs
//   PYTHON=<python 可执行文件>  默认 python
//   PYDIR=<dsh-qq-sing/python 目录>  默认取同仓库相邻目录
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeConfig, startQueueService } from '../index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PYTHON = process.env.PYTHON || 'python'
const PYDIR = process.env.PYDIR || resolve(HERE, '..', '..', 'dsh-qq-sing', 'python')

const dir = await mkdtemp(join(tmpdir(), 'gq-itest-'))
const cfg = mergeConfig({ dataDir: dir, servicesDir: join(dir, 'services'), port: 41990 })
const dispose = startQueueService(cfg)
await new Promise((resolve) => setTimeout(resolve, 300))

const py = String.raw`import json, os, sys, threading, time
sys.path.insert(0, os.environ["PYDIR"])
from gpuqueue import GpuQueue
q = GpuQueue(wait_seconds=20, poll_seconds=0.3, log=lambda m: print("LOG", m, flush=True))
out = {}
t0 = time.time()
t1 = q.acquire("sing", "first")
out["first"] = t1.id
got = {}
def other(kind, label):
    got[label] = q.acquire(kind, label)
th = threading.Thread(target=other, args=("draw", "second"))
th.start()
time.sleep(0.6)
t1.release()               # 还牌 → 排队的 second 应该立刻拿到
th.join(15)
t2 = got.get("second")
out["second"] = t2.id if t2 else None
t2.release()
out["waited"] = round(time.time() - t0, 2)
t3 = q.acquire("voice", "third")
out["third"] = t3.id
t3.release(); time.sleep(0.2)
out["ok"] = True
print("PYRESULT=" + json.dumps(out, ensure_ascii=False))
`
const pyFile = join(dir, 'itest.py')
await writeFile(pyFile, py, 'utf8')

const child = spawn(PYTHON, [pyFile], {
  env: {
    ...process.env,
    DSH_SERVICES_DIR: join(dir, 'services'),
    GPU_QUEUE_URL: 'http://127.0.0.1:41990',
    PYDIR,
    PYTHONIOENCODING: 'utf-8',
  },
  windowsHide: true,
})
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += chunk })
child.stderr.on('data', (chunk) => { stderr += chunk })
const code = await new Promise((resolve) => child.on('close', resolve))

console.log('--- python stdout ---')
console.log(stdout.trim())
if (stderr.trim()) console.log('--- python stderr ---\n' + stderr.trim())
console.log('--- exit', code)
const state = await (await fetch('http://127.0.0.1:41990/gpu/state')).json()
console.log('--- queue state ---')
console.log(JSON.stringify({ holder: state.holder, queue: state.queue, recent: state.recent.map((r) => `${r.id || r.ticket || '?'}:${r.how || r.reason || ''}`) }, null, 1))
dispose()
await rm(dir, { recursive: true, force: true })
