# dsh-llm-refusal-fix

把 DeepSeek Messages 的**合法终止原因**从「协议错误」里救出来。

装上后，模型因内容安全审查拒答（`stop_reason: "refusal"`）不会再变成
`unsupported stop reason refusal` 的 `MALFORMED_RESPONSE` 错误回合，而是：

1. 回合正常结束（`{ kind: "stop" }`，不是 error）；
2. 助手消息里带一条可读说明（默认「本次请求因内容安全审查被模型拒绝回答」，可在设置里改）；
3. 只有真正损坏的流（未知 stop_reason、坏 JSON、事件类型不符）才继续报 `MALFORMED_RESPONSE`。

顺带修正同一类问题：`pause_turn`、`cancelled` 归为正常结束，
`model_context_window_exceeded` 归为 `max-tokens`（此前全部被判成协议损坏）。

## 装了什么

| 文件 | 作用 |
| --- | --- |
| `cordis.patch.yml` | 禁用内置 `llm-deepseek-account` 行，插入本 bundle 的 `llm-deepseek-account-fix` 行 |
| `lib/adapter.js` | 随 dsh 发布的 `@deepseek-ai/dsh-llm-deepseek` 能力等价副本；只改「终止原因 → Harness 终止状态」这一层契约 |
| `lib/account.js` | 随 dsh 发布的 account provider 副本；改两处：适配器从 vendored 副本导入、`settingsNs` 固定为 `llm-deepseek-account`（既有设置照旧生效） |
| `index.js` | 插件入口：注册 provider + 自检工具 |

`deepseek-account` 这个 provider 路由名保持不变，所以模型选择、账号登录、模型目录、
既有设置都不用动。

## 安装

本包是 **profile 级 bundle**：装一次，这个 profile 的所有会话都生效（不用改模型、
不用重新登录、不用改任何既有设置）。三种 spec 都能装：

```
# npm（发布后最省事）
plugin_manager install_bundle dsh-llm-refusal-fix

# tarball
plugin_manager install_bundle D:\path\dsh-llm-refusal-fix-0.1.0.tgz

# 本地目录（开发时）
plugin_manager install_bundle D:\path\dsh-llm-refusal-fix
```

装完立即生效（无需重启 DSH）。装好后环境里会多一个工具：

```
llm_refusal_fix_selftest
```

调用它（或在 agent 里让它跑）会输出 7 条 fixture 的 PASS/FAIL 汇总。全部 PASS 说明
补丁已生效；如果整包加载失败，插件管理里会看到哪一行出错。

### 验证补丁真的接管了路由

- 插件管理里本包状态应为「已启用」；
- `cordis_inspect_query`（Config）里内置 `@deepseek-ai/dsh-llm-deepseek-account`
  行应为 `inactive`，本包 `dsh-llm-refusal-fix` 行为 `schema`（活跃）；
- 正常对话照常可用，说明模型调用已经走修补后的 adapter。

### 回滚

禁用或移除本 bundle 即可：patch 行失效 → 内置 provider 行自动恢复，一切回到原样。

## 可调项

bundle 行 config（默认值即推荐值）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `refusalNotice` | `（本次请求因内容安全审查被模型拒绝回答。）` | 拒答时回给模型的那条说明文本 |
| `providerId` | `deepseek-account` | provider 路由名（接管内置行时必须保持这个值） |
| `settingsNs` | `llm-deepseek-account` | 设置命名空间（保持原值才能沿用既有账号/模型设置） |

## 测试

```bash
cd plugins/dsh-llm-refusal-fix
npm test        # 9 个离线 fixture，末行输出 9/9 cases passed
```

- 离线 fixture 见 `tests/fixtures.mjs`（终止原因 → Harness 终止状态的全部契约，含「未知值仍报 MALFORMED_RESPONSE」的反向用例）；
- 依赖装进 `tests/.work/` 临时目录，**不在插件根目录留 node_modules**（会遮蔽 dsh 自带副本，错误码 identity 会变）；
- 装好后还可以在任意会话里跑 `llm_refusal_fix_selftest`（7 条核心 fixture 的真机冒烟）；
- 完整的测试环境、真机接管核验与上游原始 SSE 证据见 [TESTING.md](TESTING.md)。

## 版本兼容

本包 vendor 的是 dsh **0.2.2 线**（开发时验证于 0.2.2-rc.3 Win x64 桌面版）的
adapter / account provider 实现。它依赖 dsh 自带的 `@deepseek-ai/*` 包（bundle 不需要
声明这些依赖），所以：

- 同一条 0.2.2.x 线上，任何 rc 版本都能用；
- 大版本变化（例如 `stopReason` 已在上游修掉、或 `LlmAdapter` 契约改了）时请先确认
  上游是否已修复：**上游一旦修好，本包就可以卸载**——本包存在的意义就是在上游修好
  之前把契约补上。
- 卸载：禁用/移除本 bundle 即恢复内置 provider（patch 行随之失效）。

## 背景

- 上游讨论：#11337 / #13611（deepseek-ai/deepseek-harness Discussions）。
- 0.2.2-rc.4 把错误码改成了 `CONTENT_REFUSED`（诊断变好），但 `CONTINUABLE_FAILURES`
  仍然没有它，回合依旧无法继续；而本包是把 refusal 归位为正常终止状态，agent loop
  不会把它当错误。

## License

MIT
