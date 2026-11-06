# bili-duty · B 站 MCP（加固分支）

把 B 站变成智能体可调用的一组工具：搜索、视频信息、评论、字幕、弹幕、回复、私信、动态、投稿……共 **30 个工具**。

本目录是 [AGI_Ananas/bilibili-mcp](https://github.com/AGI_Ananas/bilibili-mcp)（MIT）的本地分支。上游能力之外，重点在**给智能体用时不出事**——每一条改动都对应一次真实踩坑，完整清单见 [`NOTICE.md`](NOTICE.md) 与 `mcp_server.py` 文件头注释。

## 相对上游的 7 处修改

| # | 改了什么 | 为什么 |
| --- | --- | --- |
| ① | `_ALLOWED` + `tool()` 白名单替身 | 名单外的工具连 `tools/list` 都不出现，模型那边等于不存在——提示词劝阻不算闸门 |
| ② | 凭证读取容错（UTF-8 / dict 校验） | Windows 上 GBK 读 UTF-8 会炸，坏文件不能把整个 MCP 带崩 |
| ③ | 登录后凭证**原子写**（`.tmp` → `os.replace`） | 写一半断电/被杀，下次就登不上 |
| ④ | `bili_comments` 把抓取异常带进返回 | 风控 **-412** 以前被吞成「这条视频 0 条评论」，等于骗人 |
| ⑤ | `bili_reply` 回执带 `rpid` / `root` / `parent` | 判重表与评论复核要用 |
| ⑥ | `@` / 回复类工具输出统一形状 | 原始 `msgfeed` 字段名和 `business_id` 太绕，别让宿主去猜 |
| ⑦ | `bili_reply` 的 `bvid` 也接受纯数字 aid | 通知里常常只有 aid |

## 工具分组

- **登录与凭证**：`bili_login` / `bili_login_check` / `bili_check_credential`
- **内容**：`bili_search` / `bili_video_info` / `bili_comments` / `bili_subtitle` / `bili_danmaku` / `bili_crawl`
- **互动**：`bili_reply` / `bili_triple` / `bili_send_message` / `bili_send_dynamic`
- **投稿**：`bili_upload_video` / `bili_upload_video_multi` / `bili_send_opus` / `bili_video_zones`
- **榜单与热点**：`bili_hot_videos` / `bili_hot_buzzwords` / `bili_weekly_hot` / `bili_rank`
- **用户**：`bili_user_info` / `bili_user_videos` / `bili_favorite_lists` / `bili_favorite_content`
- **私信与通知**：`bili_dm_recent` / `bili_dm_sessions` / `bili_unread_messages` / `bili_received_replies` / `bili_received_at_and_likes`
- **兜底**：`asr.py` —— 视频没有字幕时本地转写（faster-whisper，模型走国内镜像；音频只落临时目录，转完即清）

## 安装

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
# 首次运行：调 bili_login 出二维码，手机 B 站扫码，凭证写 bili_credential.json
```

`BILI_MCP_TOOLS`（逗号分隔）控制注册哪些工具——不给就全放。给智能体用的会话建议只开只读那几个（search / video_info / comments / subtitle / danmaku）。

## 注意

- **-412 是风控，不是「没有评论」**：现在会原样透传，看到就停手，别换着法子重试。
- 投稿、发动态、发私信类工具会**真的发出去**，调用前确认。
- 请遵守 B 站服务条款；默认只读用途，别做批量爬取。
