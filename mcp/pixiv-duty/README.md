# pixiv-duty · Pixiv MCP server

把 Pixiv App API 包成一组 stdio MCP 工具，给智能体做**只读筛选**：搜索、看详情、下载缩图、读中文小说、检查图片完整性。

配合 `duty.md` 使用——那是给智能体的作业章程（筛选纪律、硬边界、工具预算），MCP 只负责网络和字节。

## 工具（7 个）

| 工具 | 说明 |
| --- | --- |
| `px_auth` | 登录状态 / 客户端常量 / 重置。`action=status｜client｜reset` |
| `px_search` | 批量搜索，`queries` 用 `\|\|` 分隔（最多 3 个）；`kind` / `days` / `limit` / `sort` |
| `px_detail` | 批量详情，`ids` 逗号分隔（最多 12 个）；`kind=novel｜illust｜auto` |
| `px_fetch` | 下载图片到本地缓存，`items` 是 `[{"id":123,"pages":[1,2]}]` |
| `px_novel` | 小说正文：`action=outline｜read｜pick｜full｜blocks｜vibe` |
| `px_tags` | 按种子词看相邻标签（带翻译与出现次数） |
| `px_verify` | 校验本地图片能否解码，`paths` 用 `\|\|` 分隔 |

## 三条硬约束（都是踩出来的）

1. **refresh_token 每次刷新都会轮换**，旧值立即失效。所以每次调用后都要比对 `api.refresh_token` 与文件里的值，变了就原子落盘；刷新前后加文件锁，防止两个进程同时刷新、互相作废。
2. **App API 串行 + 最小间隔 1.5 秒**。这不是客气，是账号级风控：token 被吊销是不可恢复的（只能换号重走 OAuth）。
3. **所有错误归一成 dict**，不向上抛协议异常——上层永远能拿到 `{ok:false, code, message}` 和人话提示。

## 安装

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt

# 放入 credential.json（登录一次后可复用很久）
echo {"refresh_token":"<你的 refresh_token>"} > credential.json

# 挂到 DSH（cordis.patch.yml）
#   command: cmd.exe  args: [/c, D:\path\to\pixiv-duty\run-mcp.cmd]
```

`run-mcp.cmd` 会把 `PIXIV_DUTY_HOME` 指到自己所在目录，清掉代理变量（沙箱代理对 pixiv 会 502），并用 `.venv` 里的 Python 启动。

## 白名单

`PIXIV_MCP_TOOLS`（逗号分隔）。不给 = 全放；给了 = 只注册名单里的工具，名单外的**连名字都不会出现在 `tools/list`**。这是注册层的闸门，不是提示词劝阻。

## 声明

只读用途：不点赞、不收藏、不关注、不评论、不发私信。保存只为个人收藏，不二次分发。请遵守 Pixiv 服务条款。
