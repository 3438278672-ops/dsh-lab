"""songsearch 的「指定频道优先」与「合作歌手误配」纯函数自检（不联网）。

跑法：python tests\\test_channels.py   （退出码 0 = 全过）

用真实频道搜索到的标题做快照，覆盖：
  1. 后来 → JLRS-LeoFM 的《后来》能命中，且「后来的我们」这种长句不蹭进来；
  2. 「后来 刘若英」没分隔也能命中（分词覆盖 + 单词边界）；
  3. 泡沫 → 原版排在「重生版」前面；
  4. 点歌人要 DJ 版、频道只有原版时，频道阶段不硬塞，交给回退；
  5. jayfm 的书名号/引号标题能命中；
  6. 「lumiere」不会被「Out of Time feat. Eric Lumiere」这种客串署名骗走。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))

import songsearch as ss  # noqa: E402

passed = 0

LEO_LATER = [
    {"bvid": "BV11C4y1g7uD", "title": "在百万豪装录音棚大声听 王菲《人间》【Hi-res】", "duration": "04:47", "play": 1000},
    {"bvid": "BV1344y1w7wo", "title": "在百万豪装录音棚大声听 王心凌《彩虹的微笑》【Hi-res】", "duration": "02:52", "play": 1000},
    {"bvid": "BV1es4y177tg", "title": "在百万豪装录音棚大声听五月天《后来的我们》【Hi-res】", "duration": "05:48", "play": 1000},
    {"bvid": "BV1kG411N7dj", "title": "在百万豪装录音棚大声听Kiroro《未来へ》【Hi-res】", "duration": "05:33", "play": 1000},
    {"bvid": "BV1HP4y1X7ye", "title": "在百万豪装录音棚大声听刘若英《后来》【Hi-res】", "duration": "05:40", "play": 4385606},
]

LEO_FOAM = [
    {"bvid": "BV1Z4Lq6VEq4", "title": "何润东《我记得我爱过（《泡沫之夏》片头曲）》百万豪装录音棚大声听", "duration": "03:53", "play": 1000},
    {"bvid": "BV1tiNvzVEPn", "title": "G.E.M. 邓紫棋《泡沫（G.E.M. 重生版）》百万豪装录音棚大声听", "duration": "04:18", "play": 1000},
    {"bvid": "BV1y8411i7Dd", "title": "在百万豪装录音棚大声听 邓紫棋《泡沫》【Hi-res】", "duration": "04:17", "play": 7600000},
]

JAY_SAMPLE = [
    {"bvid": "BV1RMYF6kEze", "title": "《鸣潮》心月狐主题曲「月声尽，心灯明」百万级录音棚试听", "duration": "04:10", "play": 200000}
]


def ok(name):
    global passed
    passed += 1
    print("PASS %s" % name)


def check_later():
    parsed = ss.parse_query("后来")
    ranked = ss.rank_channel_candidates(parsed, LEO_LATER, "leofm", "JLRS-LeoFM")
    assert ranked["confidence"] == "high", ranked
    assert ranked["pick"]["bvid"] == "BV1HP4y1X7ye", ranked
    assert all("后来的我们" not in c["title"] for c in ranked["candidates"]), ranked
    ok("后来：命中 LeoFM 的《后来》，「后来的我们」不蹭分")


def check_later_artist_pair():
    parsed = ss.parse_query("后来 刘若英")
    assert "后来" in ss.channel_keywords(parsed), ss.channel_keywords(parsed)
    ranked = ss.rank_channel_candidates(parsed, LEO_LATER, "leofm", "JLRS-LeoFM")
    assert ranked["confidence"] == "high", ranked
    assert ranked["pick"]["bvid"] == "BV1HP4y1X7ye", ranked
    ok("后来 刘若英：没分隔也能靠分词+边界命中")


def check_artist_credit():
    parsed = ss.parse_query("刘若英《后来》")
    assert parsed.artist == "刘若英", parsed
    ranked = ss.rank_channel_candidates(parsed, LEO_LATER, "leofm", "JLRS-LeoFM")
    assert ranked["pick"]["bvid"] == "BV1HP4y1X7ye", ranked
    assert "歌手命中" in ranked["pick"]["reasons"], ranked
    ok("歌手：标题里的歌手名参与排序")


def check_foam_original_first():
    parsed = ss.parse_query("泡沫")
    ranked = ss.rank_channel_candidates(parsed, LEO_FOAM, "leofm", "JLRS-LeoFM")
    assert ranked["confidence"] == "high", ranked
    assert ranked["pick"]["bvid"] == "BV1y8411i7Dd", ranked
    assert "重生版" not in ranked["pick"]["title"], ranked
    assert any("重生版" in c["title"] for c in ranked["candidates"][1:]), ranked
    ok("泡沫：原版排在「重生版」前")


def check_version_gate():
    parsed = ss.parse_query("若生命等候 dj德朋版")
    assert parsed.traits == {"dj"}, parsed
    ranked = ss.rank_channel_candidates(
        parsed,
        [{"bvid": "BV1yy", "title": "黄凯芹《若生命等候》百万豪装录音棚大声听", "duration": "04:00", "play": 1000}],
        "leofm",
        "JLRS-LeoFM",
    )
    assert ranked["candidates"] == [], ranked
    ok("版本门控：要 DJ 版、频道没有同款时不硬塞")


def check_jayfm_quoted():
    parsed = ss.parse_query("月声尽")
    ranked = ss.rank_channel_candidates(parsed, JAY_SAMPLE, "jayfm", "JLRS-jayfm")
    assert ranked["confidence"] == "high", ranked
    assert ranked["pick"]["bvid"] == "BV1RMYF6kEze", ranked
    ok("jayfm：引号里的歌名能命中")


def check_feat_credit():
    parsed = ss.parse_query("lumiere")
    detail = ss.score_item(
        parsed,
        {"title": "Out of Time feat. Eric Lumiere", "duration": "03:45", "play": 500000},
    )
    assert detail["match"] < 0.8, detail
    assert "只是合作歌手" in detail["rejects"], detail
    ok("lumiere：feat. 客串署名不算歌名命中")


def check_channel_low_when_ambiguous():
    parsed = ss.parse_query("晴天")
    items = [
        {"bvid": "BV1aa", "title": "在百万豪装录音棚大声听 周杰伦《晴天》", "duration": "04:29", "play": 1000},
        {"bvid": "BV1bb", "title": "在百万豪装录音棚大声听 周杰伦《晴天》", "duration": "04:29", "play": 1000},
    ]
    ranked = ss.rank_channel_candidates(parsed, items, "leofm", "JLRS-LeoFM")
    assert ranked["confidence"] == "low", ranked
    assert ranked["pick"] is None, ranked
    assert ranked["reason"], ranked
    ok("频道多版本：分差太近时返回候选、不硬选")


def check_de_split():
    """「X的Y」只在 X 像专名时拆；歌名里自带「的」的整句保留。"""
    assert ss.parse_query("后来的我们").title == "后来的我们", ss.parse_query("后来的我们")
    assert ss.parse_query("我们的歌").title == "我们的歌", ss.parse_query("我们的歌")
    assert ss.parse_query("朋友的酒").title == "朋友的酒", ss.parse_query("朋友的酒")
    parsed = ss.parse_query("邓丽欣的电灯胆")
    assert parsed.artist == "邓丽欣", parsed
    assert parsed.title == "电灯胆", parsed
    ok("「的」拆分：专名才拆，语法词/单字尾不拆")


def check_latin_single_boundary():
    """单个拉丁词不能靠空格边界蹭：I Want Love / Une Année Sans Lumiere 都不算。"""
    parsed = ss.parse_query("lumiere")
    detail = ss.score_item(
        parsed, {"title": "Une Annee Sans Lumiere - Arcade Fire", "duration": "03:42", "play": 100000}
    )
    assert detail["match"] < 0.8, detail

    okgo = ss.parse_query("OKGO乐队 Love")
    noise = {"bvid": "BV1noise", "title": "《寂静岭3》插曲「I Want Love (Studio Mix)」百万级录音棚试听", "duration": "04:41", "play": 1000}
    possessive = {"bvid": "BV1pos", "title": "百万级录音棚听《尘白禁区》「Love's Not A Game」", "duration": "03:24", "play": 1000}
    real = {"bvid": "BV1real", "title": "OK Go - Love", "duration": "03:40", "play": 1000}
    assert ss.channel_accept(okgo, noise["title"]) is False, noise
    assert ss.channel_accept(okgo, possessive["title"]) is False, possessive
    assert ss.channel_accept(okgo, real["title"]) is True, real
    ranked = ss.rank_channel_candidates(okgo, [noise, possessive, real], "jayfm", "JLRS-jayfm")
    assert ranked["pick"]["bvid"] == "BV1real", ranked
    credit = ss.score_item(okgo, {"title": "OK GO - Love 官方MV", "duration": "03:40", "play": 1000})
    assert "歌手命中" in credit["reasons"], credit
    ok("拉丁单词：长句里的同词/feat 都不算歌名命中")


def check_duplicate_core():
    """不同 UP 加不同梗前缀、时长一致的同一版，不该判「前两名太近」。"""
    parsed = ss.parse_query("若生命等候 dj德朋版")
    items = [
        {"bvid": "BV1a", "title": "《古惑仔の小曲》《出来xxの小曲》若生命等候 (DJ德朋版) —— 黄凯芹", "duration": "02:37", "play": 10000000},
        {"bvid": "BV1b", "title": "《出来の小曲》若生命等候 (DJ德朋版) —— 黄凯芹", "duration": "02:37", "play": 1000000},
    ]
    ranked = ss.rank_candidates(parsed, items)
    assert ranked["confidence"] == "high", ranked
    assert ranked["pick"]["bvid"] == "BV1a", ranked
    ok("重复转载：梗前缀不同但核心标题/时长一致，不算第二名")


def check_instrumental_not_preferred():
    """频道里的器乐版（小提琴等）没被点名时要降权，不能和原版打平。"""
    parsed = ss.parse_query("孤勇者")
    items = [
        {"bvid": "BV1violin", "title": "《孤勇者》小提琴版｜在百万级录音棚里拉给你听", "duration": "04:13", "play": 900000},
        {"bvid": "BV1original", "title": "在百万豪装录音棚大声听 陈奕迅《孤勇者》【Hi-res】", "duration": "04:16", "play": 5000000},
    ]
    ranked = ss.rank_channel_candidates(parsed, items, "jayfm", "JLRS-jayfm")
    assert ranked["confidence"] == "high", ranked
    assert ranked["pick"]["bvid"] == "BV1original", ranked
    assert any("降权:instrumental" in r for r in ranked["candidates"][1]["reasons"]), ranked
    ok("器乐版：没点名小提琴版时降权，原版胜出")


def check_instrumental_requested():
    """点歌人点名要小提琴版时，同一个 trait 要反过来给器乐版加分。"""
    parsed = ss.parse_query("孤勇者 小提琴版")
    assert "instrumental" in parsed.traits, parsed
    assert parsed.title == "孤勇者", parsed
    items = [
        {"bvid": "BV1violin", "title": "《孤勇者》小提琴版｜在百万级录音棚里拉给你听", "duration": "04:13", "play": 900000},
        {"bvid": "BV1original", "title": "在百万豪装录音棚大声听 陈奕迅《孤勇者》【Hi-res】", "duration": "04:16", "play": 5000000},
    ]
    ranked = ss.rank_channel_candidates(parsed, items, "jayfm", "JLRS-jayfm")
    assert ranked["confidence"] == "high", ranked
    assert ranked["pick"]["bvid"] == "BV1violin", ranked
    ok("器乐版：点名小提琴版时反过来加分，选器乐版")


if __name__ == "__main__":
    check_later()
    check_later_artist_pair()
    check_artist_credit()
    check_foam_original_first()
    check_version_gate()
    check_jayfm_quoted()
    check_feat_credit()
    check_channel_low_when_ambiguous()
    check_de_split()
    check_latin_single_boundary()
    check_duplicate_core()
    check_instrumental_not_preferred()
    check_instrumental_requested()
    print("\n%d checks passed" % passed)
