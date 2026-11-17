# DeepSeek-Chan（大肥鱼）人设与固定出图 prompt

用户（2026-11-17）指定的本人设图：蓝发鲸娘女仆「DeepSeek-Chan」，因为画师署名与授权为 **CC BY-NC-SA 4.0**，
原图不放仓库（在本地 `data/refs/deepseek-chan.webp`，`data/` 已被 `.gitignore` 排除）。

> 原图授权：CC BY-NC-SA 4.0；作者 上善无形 / ZzipiPine / Rafistev（见原图底部署名）。

## 固定正向 prompt

```
full body, standing, 1girl, solo, deepseek-chan, long blue hair, wavy hair,
gradient hair, ahoge, blue eyes, whale ears, fin ears, whale tail,
maid, maid headdress, frilled apron, white apron, dark blue dress, long dress,
gold trim, white thighhighs, blue mary janes, blush, smile, looking at viewer,
hands together, light blue background, soft lighting
```

小技巧：全身立绘把 `full body, standing` 放最前面、`light blue background` 带上权重 `(…:1.2~1.3)`，
否则容易只出半身、背景变成室内。插件会自动补 `masterpiece, best quality, very aesthetic, absurdres, perfect hands`
与默认负面词（含手指数/多手多指/肢体/比例硬约束，negative 只能追加、不能替换）；negative 里再补
`text, watermark, logo, multiple views, character sheet, indoor, wooden`，避免画成三视图设定集或木屋背景。

## 按用途裁剪

| 用途 | preset | 覆盖 tag |
| --- | --- | --- |
| 立绘 / 全身 | `portrait`（832×1216） | 保持 `standing, full body` |
| 头像 / 半身 | `anime`（1024²） | 用 `upper body, portrait` 替换全身 tag |
| 表情包 | `sticker`（1024²→512²） | 用 `chibi, simple background, thick outline` 替换背景/构图 tag |

角色特征锚点（改动作表情时这些不要丢）：长蓝发 + 渐变发梢 + ahoge、蓝眼、鲸耳、鲸尾、
白蕾丝女仆头饰 + 蓝蝴蝶结、深蓝金边女仆长裙、白围裙、白丝袜、蓝玛丽珍鞋。
