#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""点歌取源：B 站搜索 → 挑一条最像“原曲”的 → 下载音频轨。

只依赖 bilibili_api + httpx（跑在 bili-duty 的 venv 里）。
成功时 stdout 打印一行 `RESULT=<json>`；失败时打印 `ERROR=<message>` 并以非 0 退出。
"""
import argparse
import asyncio
import json
import math
import os
import re
import sys
import traceback
from pathlib import Path

import httpx

from bilibili_api import Credential, search, video
from bilibili_api.search import OrderVideo, SearchObjectType

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# 明显不是“能唱的歌”的标题
BAD_TITLE = re.compile(
    r"伴奏|纯音乐|消音|卡拉ok|karaoke|instrumental|钢琴版|吉他版|教学|教程|"
    r"直播回放|合集|串烧|remix|dj版|慢速|0\.8倍|降调|升调|1小时|一小时|循环|"
    r"白噪音|asmr|解析|乐评|reaction|翻弹|二胡|古筝版|小提琴版|八音盒",
    re.I,
)
HARD_LIMIT_SEC = 8 * 60
MIN_SEC = 70


def strip_html(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s or "").replace("&amp;", "&").strip()


def parse_dur(v) -> int:
    try:
        if isinstance(v, int):
            return v
        parts = [int(float(x)) for x in str(v).strip().split(":")]
        sec = 0
        for p in parts:
            sec = sec * 60 + p
        return sec
    except Exception:
        return 0


def tokens(keyword: str):
    parts = re.split(r"[\s《》「」【】（）()、,，.。!！?？\-—_/\\|]+", keyword)
    return [p for p in parts if len(p) >= 2]


def name_hit(title: str, keyword: str) -> bool:
    toks = tokens(keyword)
    if not toks:
        return False
    return all(t in title for t in toks)


def clean_keyword(raw: str) -> str:
    s = raw.strip()
    s = re.sub(r"^(请|帮我|给我|麻烦)?(唱一首|唱个|唱一下|唱|来一首|来首|点一首|点首|点歌|整个|搞一个|放一首)\s*", "", s)
    s = re.sub(r"[吧呀呗嘛啊哦呀~～]+$", "", s)
    s = s.strip(" \t\r\n《》「」【】\"'“”‘’")
    return s or raw.strip()


def score_item(item, keyword, rank):
    title = strip_html(item.get("title", ""))
    play = int(item.get("play") or 0)
    s = -0.55 * rank + 1.15 * math.log10(play + 10)
    if name_hit(title, keyword):
        s += 2.5
    if re.search(r"翻唱|cover|改编", title, re.I):
        s -= 1.5
    if len(title) > 80:
        s -= 0.5
    return s, title


async def bili_search(cred, keyword, order):
    try:
        res = await search.search_by_type(
            keyword,
            search_type=SearchObjectType.VIDEO,
            order_type=order,
            page=1,
            credential=cred,
        )
    except TypeError:
        res = await search.search_by_type(
            keyword, search_type=SearchObjectType.VIDEO, order_type=order, page=1
        )
    return res or {}


async def pick_song(cred, keyword, hard_limit):
    attempts = [keyword, None, None]
    # 去掉“某某的”这种歌手修饰，退一步再搜
    m = re.match(r"^(.+?)的(.+)$", keyword)
    if m:
        attempts[1] = m.group(2)
        attempts[2] = m.group(1) + " " + m.group(2)
    orders = [OrderVideo.TOTALRANK, OrderVideo.CLICK, OrderVideo.TOTALRANK]

    seen = set()
    for query, order in zip([q for q in attempts if q], orders):
        res = await bili_search(cred, query, order)
        items = res.get("result") or []
        ranked = []
        for rank, item in enumerate(items):
            if item.get("type") and item.get("type") != "video":
                continue
            dur = parse_dur(item.get("duration"))
            title = strip_html(item.get("title", ""))
            if not dur or dur < MIN_SEC or dur > hard_limit:
                continue
            if BAD_TITLE.search(title):
                continue
            bvid = item.get("bvid")
            if not bvid or bvid in seen:
                continue
            seen.add(bvid)
            s, _ = score_item(item, keyword, rank)
            ranked.append((s, item))
        if ranked:
            ranked.sort(key=lambda x: x[0], reverse=True)
            return ranked[0][1]
    return None


async def get_audio_url(v, page_index=0):
    data = await v.get_download_url(page_index)
    dash = (data or {}).get("dash") or {}
    audios = dash.get("audio") or []
    if audios:
        audios.sort(key=lambda a: int(a.get("bandwidth") or 0), reverse=True)
        best = audios[0]
        urls = [best.get("baseUrl") or best.get("base_url")] + list(
            best.get("backupUrl") or best.get("backup_url") or []
        )
        return [u for u in urls if u], "m4a"
    durl = (data or {}).get("durl") or []
    if durl:
        first = durl[0]
        urls = [first.get("url")] + list(first.get("backupUrl") or [])
        return [u for u in urls if u], "mp4"
    raise RuntimeError("B站没有返回可用的音频地址（可能需要登录）")


async def download(urls, dest: Path, cookies: str):
    headers = {
        "User-Agent": UA,
        "Referer": "https://www.bilibili.com/",
        "Origin": "https://www.bilibili.com",
        "Accept": "*/*",
    }
    if cookies:
        headers["Cookie"] = cookies
    last_err = None
    async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(30.0, read=180.0)) as client:
        for url in urls:
            try:
                async with client.stream("GET", url, headers=headers) as resp:
                    if resp.status_code != 200:
                        last_err = f"HTTP {resp.status_code}"
                        continue
                    total = 0
                    with open(dest, "wb") as fh:
                        async for chunk in resp.aiter_bytes(262144):
                            if not chunk:
                                continue
                            fh.write(chunk)
                            total += len(chunk)
                            if total > 80 * 1024 * 1024:
                                raise RuntimeError("文件太大")
                if dest.exists() and dest.stat().st_size > 200 * 1024:
                    return dest.stat().st_size
                last_err = "下载文件过小"
            except Exception as e:  # noqa: BLE001
                last_err = str(e)
                try:
                    dest.unlink()
                except OSError:
                    pass
    raise RuntimeError(f"下载失败：{last_err}")


def load_credential(path):
    """从 bili-duty 的凭证文件读 SESSDATA / bili_jct / buvid3 / dedeuserid（大小写不敏感）。"""
    if not path:
        return {}
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            data = json.load(fh)
    except Exception:  # noqa: BLE001
        return {}
    if not isinstance(data, dict):
        return {}
    lowered = {str(k).lower(): v for k, v in data.items()}

    def pick(*names):
        for name in names:
            value = lowered.get(name.lower())
            if value:
                return str(value)
        return ""

    return {
        "sessdata": pick("sessdata"),
        "bili_jct": pick("bili_jct"),
        "buvid3": pick("buvid3"),
        "dedeuserid": pick("dedeuserid", "dedeuser", "uid"),
    }


def cookies_from(cred) -> str:
    d = cred.get_cookies() if hasattr(cred, "get_cookies") else {}
    if isinstance(d, dict):
        return "; ".join(f"{k}={v}" for k, v in d.items() if v)
    return ""


async def run(args):
    raw = args.song.strip()
    if not raw:
        raise RuntimeError("没说要唱哪首")

    creds = load_credential(args.credential)
    cred = Credential(
        sessdata=args.sessdata or creds.get("sessdata") or None,
        bili_jct=args.bili_jct or creds.get("bili_jct") or None,
        buvid3=args.buvid3 or creds.get("buvid3") or None,
        dedeuserid=args.dedeuserid or creds.get("dedeuserid") or None,
    )
    hard_limit = max(90, int(float(args.max_minutes or 9) * 60))

    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)

    bvid = None
    direct = False
    m = re.search(r"(BV[0-9A-Za-z]{10})", raw)
    if m:
        bvid = m.group(1)
        keyword = bvid
        direct = True
    else:
        keyword = clean_keyword(raw)

    title = ""
    duration = 0
    if not bvid:
        picked = await pick_song(cred, keyword, hard_limit)
        if not picked:
            raise RuntimeError(f"B站没搜到合适的《{keyword}》")
        bvid = picked["bvid"]
        title = strip_html(picked.get("title", ""))
        duration = parse_dur(picked.get("duration"))

    v = video.Video(bvid, credential=cred)
    try:
        info = await v.get_info()
    except Exception as e:  # noqa: BLE001
        if direct:
            detail = re.sub(r"\s*\{.*$", "", str(e), flags=re.S).strip()[:80]
            raise RuntimeError(f"这个 BV 号（{bvid}）打不开：视频不存在、被删或者需要登录（B站说：{detail}）") from e
        raise
    title = title or info.get("title", bvid)
    duration = int(info.get("duration") or duration or 0)
    if duration and duration > hard_limit:
        raise RuntimeError(f"《{title[:30]}》太长了（{duration // 60}分{duration % 60}秒），换首短点的吧")

    urls, ext = await get_audio_url(v, 0)
    dest = workdir / f"source.{ext}"
    size = await download(urls, dest, cookies_from(cred))

    return {
        "ok": True,
        "bvid": bvid,
        "title": title,
        "duration": duration,
        "singer": info.get("owner", {}).get("name", ""),
        "keyword": keyword,
        "file": str(dest),
        "bytes": size,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--song", required=True)
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--credential", default="", help="bili-duty 的 bili_credential.json 路径")
    ap.add_argument("--max-minutes", dest="max_minutes", type=float, default=9.0)
    ap.add_argument("--sessdata", default="")
    ap.add_argument("--bili-jct", dest="bili_jct", default="")
    ap.add_argument("--buvid3", default="")
    ap.add_argument("--dedeuserid", default="")
    args = ap.parse_args()
    try:
        result = asyncio.run(run(args))
        print("RESULT=" + json.dumps(result, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        print("ERROR=" + str(e).replace("\n", " ")[:300])
        sys.exit(2)


if __name__ == "__main__":
    main()
