# 测试记录

本插件的验证分三层：**离线 fixture**（`npm test`，任何人可复现）、**真机自检**（装好后的工具）、**真机接管核验**（Config 状态 + 实际对话）。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 | Windows 11 x64 |
| DSH | Desktop 0.2.2-rc.3（win-x64） |
| 被测适配器 | 随 DSH 发布的 `@deepseek-ai/dsh-llm-deepseek` 0.2.2-rc.3（vendor 副本） |
| 模型 / 推理档 | `deepseek-flash`，`reasoningEffort: max` |
| Node（本地跑测试） | v24.14.0；CI 用 22.x |

## 一、离线 fixture：9 个用例

```bash
cd plugins/dsh-llm-refusal-fix
npm test
```

`tests/run.mjs` 会把 `lib/adapter.js` 和它依赖的 shipped 包（`@deepseek-ai/*`、`eventsource-parser`、`semver`）装进临时目录 `tests/.work/`，再从那里导入适配器跑 fixture——**不往插件根目录装 node_modules**，避免遮蔽 DSH 自带的同名包（`LlmError` 的 identity 是 instance 级别的，跨副本会让错误码降级成 `UNKNOWN`）。

| 用例 | 输入 | 期望 |
| --- | --- | --- |
| `refusal-with-no-content-is-a-normal-stop` | 空内容 + `stop_reason: refusal` | `{kind:'stop'}` + 1 个非空 text block（真实故障形态） |
| `refusal-carries-stop-details-explanation` | `stop_details.explanation` | 说明文本里带上 explanation |
| `refusal-after-thinking-keeps-order` | 先 thinking 再 refusal | reasoning 在前、说明 text 在后，`stop` |
| `pause-turn-is-terminal-not-malformed` | `pause_turn` | `{kind:'stop'}`，不报错 |
| `context-window-exceeded-maps-to-max-tokens` | `model_context_window_exceeded` | `{kind:'max-tokens'}` |
| `cancelled-is-terminal-not-malformed` | `cancelled` | `{kind:'stop'}` |
| `unknown-stop-reason-still-malformed` | `banana` | 仍 `MALFORMED_RESPONSE`（不放宽真损坏） |
| `plain-end-turn-unchanged` | `end_turn` | 与上游行为一致 |
| `tool-use-still-tool-calls` | `tool_use` + input_json_delta | `{kind:'tool-calls'}` |

**结果（2026-11-18）**：`9/9 cases passed`。

## 二、真机自检：`llm_refusal_fix_selftest`

装好 bundle 后在任意会话里调用该工具，输出 7 条核心 fixture 的摘要（与离线用例同一批契约，作为「这个进程里补丁真的在跑」的冒烟测试）：

**结果（2026-11-18，本机）**：`7/7 PASS`。

## 三、真机接管核验

| 检查 | 期望 | 实测 |
| --- | --- | --- |
| 插件管理 | 本 bundle 已启用（applied） | ✅ |
| Config：内置行 `@deepseek-ai/dsh-llm-deepseek-account` | `inactive` | ✅ |
| Config：本包行 `dsh-llm-refusal-fix` | `schema`（活跃） | ✅ |
| 正常对话（本会话自身） | 走修补后的 provider 正常返回 | ✅ |

## 四、原始故障证据（修复前）

2026-11-17 用本地抓包代理重放了失败回合的持久化 system prompt + user message，上游返回的合法 SSE delta：

```json
{"type":"message_delta","delta":{"stop_reason":"refusal","stop_sequence":null},"usage":{"input_tokens":14631,"output_tokens":22,"output_tokens_details":{"thinking_tokens":22}}}
```

同一 payload 3 次重放：1 拒 2 通；生产环境同一个 QQ 会话两次唤醒共 12 次尝试全部拒答。→ 上游是**采样式安全判定**，客户端把合法终止原因当协议损坏，才是 bug。

相关讨论：

- https://github.com/deepseek-ai/deepseek-harness/discussions/11337
- https://github.com/deepseek-ai/deepseek-harness/discussions/13611

## 五、未覆盖 / 待观察

- 修补后的**真实拒答**还没在线上自然复现（触发需要特定上下文）。预期：回合正常结束，助手消息里出现配置的 `refusalNotice`，而不是 `unsupported stop reason refusal` 报错；QQ 桥那边也不会再把 error 原文贴进群。
- 上游 0.2.2-rc.4 把错误码改成了 `CONTENT_REFUSED` 但仍未修可恢复性；**上游修好 `CONTINUABLE_FAILURES`/终止原因映射之后，本包即可卸载**。
