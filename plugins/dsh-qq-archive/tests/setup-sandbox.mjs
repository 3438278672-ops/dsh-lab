// 测试隔离沙箱：`npm test` 通过 `--import` 在每个测试进程（runner 与它派生的
// 测试子进程）里预加载本文件。
//
// 契约：
//   - 整个测试套跑在 $TMPDIR 下的临时目录里（HOME / USERPROFILE 都指过去），
//     任何仍按 homedir() 拼默认路径的代码也只会落到沙箱，碰不到用户真实档案；
//   - QQ_ARCHIVE_HOME 指向沙箱内的数据目录，插件 / 测试漏传 home 时
//     resolveHome() 会解析到这里；
//   - 子进程通过 QQ_ARCHIVE_TEST_SANDBOX 标记识别沙箱，不重复创建、不删除；
//   - runner 进程退出时删掉整个沙箱。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.QQ_ARCHIVE_TEST_SANDBOX) {
  const sandbox = mkdtempSync(join(tmpdir(), 'qq-archive-test-'))
  process.env.QQ_ARCHIVE_TEST_SANDBOX = sandbox
  process.env.QQ_ARCHIVE_HOME = join(sandbox, 'qq-archive')
  process.env.HOME = sandbox
  process.env.USERPROFILE = sandbox
  process.on('exit', () => {
    try {
      rmSync(sandbox, { recursive: true, force: true })
    } catch {
      /* 删不掉就留着，下次跑到提示 */
    }
  })
}
