#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""点歌取源：理解歌名 → B 站多路搜索 → 排序 + 判置信度 → 下载音频轨。

两种模式：
  --plan            只搜不下载，输出 `PLAN=<json>`（候选 + 置信度），给确认流程用
  --bvid BVxxxx     已知 BV 号，跳过搜索直接下载（确认后走这条路）

默认（既不 --plan 也不 --bvid）保留老行为：搜索 + 直接下最高分，供旧队列兜底。

只依赖 bilibili_api + httpx（跑在 bili-duty 的 venv 里）。
成功时 stdout 打印一行 `RESULT=<json>` 或 `PLAN=<json>`；失败打印 `ERROR=` 并非 0 退出。
"""
import argparse
import asyncio
import json
import re
import sys
import traceback
from pathlib import Path

import httpx

from bilibili_api import Credential, search, user, video
from bilibili_api.search import OrderVideo, SearchObjectType

import songsearch

# 被 Node 以管道拉起时，Windows 的 stdout 默认走 cp936；PLAN/RESULT 里有中文标题，
# 不强制 UTF-8 就会在日志/确认文案里变成乱码。和 pipeline.py 保持同一约定。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


def strip_html(s: str) -> str:
    return songsearch.strip_html(s)


def parse_dur(v) -> int:
    return songsearch.parse_dur(v)


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
        # 老版本 bilibili_api 的 search_by_type 不接受 credential
        res = await search.search_by_type(
            keyword, search_type=SearchObjectType.VIDEO, order_type=order, page=1
        )
    return res or {}


async def collect(cred, parsed, skip=()):
    """按 parse 出来的查询逐个搜，合并去重。返回 (items, queries_tried, errors)。

    6 条查询每条一次搜索，总共几秒；宁可多搜几路，也不要只搜原话就下结论。
    skip 里的查询已经搜过（比如推断出歌手后补搜时不必重搜原话）。
    """
    queries = [q for q in songsearch.build_queries(parsed) if q not in set(skip)]
    items: list[dict] = []
    seen: dict[str, int] = {}
    errors: list[str] = []
    tried: list[str] = []

    def absorb(res, query):
        for rank, item in enumerate(res.get("result") or []):
            bvid = str(item.get("bvid") or "")
            if not bvid:
                continue
            if bvid in seen:
                if rank < seen[bvid]:
                    seen[bvid] = rank
                    for old in items:
                        if old.get("bvid") == bvid:
                            old["_rank"] = rank
                continue
            seen[bvid] = rank
            item = dict(item)
            item["_rank"] = rank
            item["_query"] = query
            items.append(item)

    for query in queries:
        tried.append(query)
        try:
            absorb(await bili_search(cred, query, OrderVideo.TOTALRANK), query)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{query}: {exc}")

    # 综合排序一条都没搜出来（或者全被过滤）时，最后用播放量排序兜底一次
    if len(items) < 3 and parsed.raw:
        try:
            res = await bili_search(cred, parsed.raw, OrderVideo.CLICK)
            tried.append(parsed.raw + "（按播放）")
            absorb(res, parsed.raw)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{parsed.raw}（按播放）: {exc}")

    return items, tried, errors


async def _channel_get_videos(u, keyword, pn):
    """频道内搜索；Wbi 偶发限流，重试一次再放弃。"""
    last = None
    for attempt in range(2):
        try:
            return await u.get_videos(
                keyword=keyword, ps=30, pn=pn, order=user.VideoOrder.PUBDATE
            )
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt == 0:
                await asyncio.sleep(0.8)
    raise last


def _channel_item(item, channel_name):
    return {
        "bvid": str(item.get("bvid") or ""),
        "title": item.get("title") or "",
        "author": channel_name,
        "duration": item.get("length") or item.get("duration") or 0,
        "play": item.get("play") or 0,
        "pubdate": item.get("created") or 0,
        "type": "video",
    }


async def search_channels(cred, parsed, hard_limit):
    """先搜 jayfm，没有再搜 LeoFM；两个频道都没有就返回空结论。

    返回 {ranked, queries, errors, total, channel}。
    """
    queries: list[str] = []
    errors: list[str] = []
    total = 0
    keywords = songsearch.channel_keywords(parsed)
    for channel in songsearch.CHANNELS:
        u = user.User(uid=channel["mid"], credential=cred)
        for keyword in keywords:
            queries.append(f"{channel['name']}:{keyword}")
            try:
                first = await _channel_get_videos(u, keyword, 1)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{channel['name']}「{keyword}」: {exc}")
                continue
            vlist = list(((first or {}).get("list") or {}).get("vlist") or [])
            page = (first or {}).get("page") or {}
            count = int(page.get("count") or 0)
            pages = min(2, max(1, (count + 29) // 30))
            for pn in range(2, pages + 1):
                try:
                    more = await _channel_get_videos(u, keyword, pn)
                    vlist += list(((more or {}).get("list") or {}).get("vlist") or [])
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"{channel['name']}「{keyword}」第{pn}页: {exc}")
                    break
                await asyncio.sleep(0.2)
            if not vlist:
                continue
            items = [_channel_item(item, channel["name"]) for item in vlist]
            total += len(items)
            ranked = songsearch.rank_channel_candidates(
                parsed, items, channel["key"], channel["name"], hard_limit=hard_limit
            )
            if ranked["candidates"]:
                return {
                    "ranked": ranked,
                    "queries": queries,
                    "errors": errors,
                    "total": total,
                    "channel": channel,
                }
        # 这个频道没有这首歌，继续看下一个
    return {
        "ranked": {"confidence": "low", "pick": None, "candidates": [], "reason": ""},
        "queries": queries,
        "errors": errors,
        "total": total,
        "channel": None,
    }


async def resolve_source(cred, parsed, hard_limit):
    """指定频道优先；两个频道都没有才回退普通搜索。

    返回 (parsed, ranked, tried, errors, artist, total, channel)。
    """
    if parsed.bvid:
        return parsed, {"confidence": "low", "pick": None, "candidates": [], "reason": ""}, [], [], "", 0, None

    channel = await search_channels(cred, parsed, hard_limit)
    if channel["ranked"]["candidates"]:
        return (
            parsed,
            channel["ranked"],
            channel["queries"],
            channel["errors"],
            "",
            channel["total"],
            channel["channel"],
        )

    parsed, ranked, items, tried, errors, artist = await search_ranked(
        cred, parsed, hard_limit
    )
    return (
        parsed,
        ranked,
        channel["queries"] + tried,
        channel["errors"] + errors,
        artist,
        len(items),
        None,
    )


def explain(parsed, ranked):
    """给模型看的短说明：为什么高置信/为什么不敢直接唱。"""
    pick = ranked.get("pick")
    if pick:
        bits = [b for b in pick.get("reasons", []) if not b.startswith("降权")]
        return "；".join(bits[:4]) or "命中"
    return ranked.get("reason") or "不确定"


async def search_ranked(cred, parsed, hard_limit):
    """搜 + 排序；没给歌手时先反推原唱、补一轮查询再定稿。

    返回 (实际采用的 parsed, ranked, items, tried, errors, 推断出的歌手)。
    推断的歌手只有在「确实把带歌手命中的结果顶到第一」时才采用，否则回退，
    避免瞎猜一个名字反而把正确结果压下去。
    """
    items, tried, errors = await collect(cred, parsed)
    artist = ""
    ranked = songsearch.rank_candidates(parsed, items, hard_limit=hard_limit)
    if not parsed.artist and parsed.title:
        artist, song = songsearch.infer_artist(parsed, items)
        if artist:
            hinted = songsearch.with_artist(parsed, artist, song)
            more, more_tried, more_errors = await collect(cred, hinted, skip=set(tried))
            if more:
                items = items + more
                tried = tried + more_tried
                errors = errors + more_errors
            hinted_ranked = songsearch.rank_candidates(hinted, items, hard_limit=hard_limit)
            pick = hinted_ranked.get("pick")
            if hinted_ranked["confidence"] == "high" and pick and "歌手命中" in pick["reasons"]:
                return hinted, hinted_ranked, items, tried, errors, artist
            # 推断没把结果顶上去：回退到不带歌手的排序
            artist = ""
            ranked = songsearch.rank_candidates(parsed, items, hard_limit=hard_limit)
    return parsed, ranked, items, tried, errors, artist


async def plan(cred, args, hard_limit):
    raw = args.song.strip()
    if not raw:
        raise RuntimeError("没说要唱哪首")
    parsed = songsearch.parse_query(raw)
    if not parsed.title and not parsed.bvid:
        raise RuntimeError("歌名没看懂，换个说法或者直接贴 BV 号")

    parsed, ranked, tried, errors, artist, total, channel = await resolve_source(
        cred, parsed, hard_limit
    )
    if not channel:
        # 用户要求：两位频道都没有这首歌时，回退搜索也要先问一句，不能直接唱
        base = ranked.get("reason") or ""
        ranked = dict(ranked)
        ranked["confidence"] = "low"
        ranked["pick"] = None
        ranked["reason"] = "两位频道都没有这首歌，按普通搜索结果先确认" + (
            f"（{base}）" if base else ""
        )
    result = {
        "ok": True,
        "keyword": raw,
        "parsed": parsed.as_dict(),
        "artistInferred": bool(artist),
        "queries": tried,
        "confidence": ranked["confidence"],
        "reason": ranked.get("reason") or "",
        "why": explain(parsed, ranked),
        "pick": ranked.get("pick"),
        "candidates": ranked.get("candidates") or [],
        "total": total,
        "errors": errors[:3],
        "channel": channel["name"] if channel else "",
    }
    print("PLAN=" + json.dumps(result, ensure_ascii=False), flush=True)
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
    if not raw and not args.bvid:
        raise RuntimeError("没说要唱哪首")

    creds = load_credential(args.credential)
    cred = Credential(
        sessdata=args.sessdata or creds.get("sessdata") or None,
        bili_jct=args.bili_jct or creds.get("bili_jct") or None,
        buvid3=args.buvid3 or creds.get("buvid3") or None,
        dedeuserid=args.dedeuserid or creds.get("dedeuserid") or None,
    )
    hard_limit = max(90, int(float(args.max_minutes or 9) * 60))

    # 只搜不下的确认阶段
    if args.plan:
        return await plan(cred, args, hard_limit)

    # 已知 BV（确认流程 / 直接贴 BV）跳过搜索
    bvid = (args.bvid or "").strip()
    if not bvid:
        m = re.search(r"(BV[0-9A-Za-z]{10})", raw)
        if m:
            bvid = m.group(1)
    direct = bool(bvid)

    parsed = songsearch.parse_query(raw or bvid)
    keyword = parsed.title or bvid or raw
    title = ""
    duration = 0
    picked_note = "BV 直连"

    if not bvid:
        parsed, ranked, tried, errors, artist, total, channel = await resolve_source(
            cred, parsed, hard_limit
        )
        keyword = parsed.title or keyword
        pick = ranked.get("pick") or (ranked.get("candidates") or [None])[0]
        if not pick:
            detail = errors[0] if errors else ""
            raise RuntimeError(f"B站没搜到合适的《{keyword}》{('（' + detail + '）') if detail else ''}")
        bvid = pick["bvid"]
        title = pick.get("title", "")
        duration = int(pick.get("duration") or 0)
        picked_note = rank_note(ranked, pick)
        print(
            "PLAN=" + json.dumps(
                {
                    "ok": True,
                    "keyword": raw,
                    "parsed": parsed.as_dict(),
                    "artistInferred": bool(artist),
                    "confidence": ranked["confidence"],
                    "reason": ranked.get("reason") or "",
                    "pick": pick,
                    "candidates": ranked.get("candidates") or [],
                    "queries": tried,
                    "channel": channel["name"] if channel else "",
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
            flush=True,
        )
        if ranked["confidence"] != "high":
            # 旧队列没有 BV 的兜底：还是唱最高分，但日志里留清楚这是低置信
            print(f"LOW_CONFIDENCE={ranked.get('reason') or '不确定'}", file=sys.stderr, flush=True)

    v = video.Video(bvid, credential=cred)
    try:
        info = await v.get_info()
    except Exception as e:  # noqa: BLE001
        if direct:
            detail = re.sub(r"\s*\{.*$", "", str(e), flags=re.S).strip()[:80]
            raise RuntimeError(
                f"这个 BV 号（{bvid}）打不开：视频不存在、被删或者需要登录（B站说：{detail}）"
            ) from e
        raise
    title = title or info.get("title", bvid)
    duration = int(info.get("duration") or duration or 0)
    if duration and duration > hard_limit:
        raise RuntimeError(f"《{title[:30]}》太长了（{duration // 60}分{duration % 60}秒），换首短点的吧")

    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)
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
        "picked": picked_note,
        "file": str(dest),
        "bytes": size,
    }


def rank_note(ranked: dict, pick: dict) -> str:
    if ranked.get("confidence") == "high":
        bits = [b for b in pick.get("reasons", []) if not b.startswith("降权")]
        return "高置信：" + ("、".join(bits[:3]) or "命中")
    return "低置信兜底：" + (ranked.get("reason") or "不确定")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--song", default="")
    ap.add_argument("--bvid", default="", help="已知 BV 号：跳过搜索直接下载")
    ap.add_argument("--plan", action="store_true", help="只搜不下载，输出 PLAN=<json>")
    ap.add_argument("--workdir", default="", help="下载目录（--plan 时可省略）")
    ap.add_argument("--credential", default="", help="bili-duty 的 bili_credential.json 路径")
    ap.add_argument("--max-minutes", dest="max_minutes", type=float, default=9.0)
    ap.add_argument("--sessdata", default="")
    ap.add_argument("--bili-jct", dest="bili_jct", default="")
    ap.add_argument("--buvid3", default="")
    ap.add_argument("--dedeuserid", default="")
    args = ap.parse_args()
    if not args.workdir and not args.plan:
        ap.error("--workdir is required unless --plan")
    try:
        result = asyncio.run(run(args))
        if result is not None:
            print("RESULT=" + json.dumps(result, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        print("ERROR=" + str(e).replace("\n", " ")[:300])
        sys.exit(2)


if __name__ == "__main__":
    main()
