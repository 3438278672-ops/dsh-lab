# NOTICE

## bilibili-mcp（上游）

`mcp_server.py` 派生自 [AGI_Ananas/bilibili-mcp](https://github.com/AGI_Ananas/bilibili-mcp)，
原项目以 MIT License 发布。本分支在保留上游能力的前提下做了 7 处修改（清单见 `mcp_server.py` 文件头注释）：

1. `_ALLOWED` + `tool()` 白名单替身：工具按名单注册，名单外的不出现在 `tools/list`
2. 凭证读取容错（`encoding="utf-8"`、`isinstance(data, dict)` 校验）
3. 登录成功后凭证**原子写**（先写 `.tmp` 再 `os.replace`）
4. `bili_comments` 把抓取异常带进返回（风控 -412 不再伪装成「0 条评论」）
5. `bili_reply` 回执带上 `rpid` / `rpid_str` / `root` / `parent`
6. `@` / 回复类工具把条目整理成统一形状（bvid、昵称、正文、rpid、root）
7. `bili_reply` 的 `bvid` 参数也接受纯数字 aid

上游 MIT 许可证全文：

```
MIT License

Copyright (c) AGI_Ananas

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## asr.py

本仓库新增，用于「没有字幕但值得判断」的视频转写，依赖 faster-whisper / yt-dlp，按 MIT 分发。
