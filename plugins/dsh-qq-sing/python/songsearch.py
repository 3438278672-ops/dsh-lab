#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""点歌的「理解 + 挑源」核心：把群友的一句话变成一组查询，再给 B 站搜索结果打分。

这里只做纯函数（不联网），方便用真实搜索快照做回归测试。
网络部分在 fetch_song.py 里。

设计原则（对应这次优化的四条需求）：
1. 歌名理解：剥掉「请/帮我/唱一首」和「DJ版/翻唱版/日语版/现场版」这类修饰，
   但把修饰记成 traits —— 用户明确要 DJ 版时，就不能再把 DJ 版当负分。
2. 原唱/官方优先：MV、原唱、官方、唱片公司号是正分；试听、录音棚、Hi-res、
   黑胶、音乐分享、nightcore、slowed、加速、翻唱是负分；播放量只当 tiebreaker。
3. 时长形状：2:30–5:30 是正常歌曲；<70s 是片段/试听，>8min 是合集。
4. 低置信度不硬选：宁可返回候选让点歌人确认，也不猜一个错的去唱。
"""
from __future__ import annotations

import difflib
import math
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field, replace

# ── 版本修饰词：用户点名要的版本特征（有 traits 就不吃对应负分）────────────────
TRAIT_PATTERNS = {
    "dj": r"(?<![a-z])dj(?:版|remix|音乐)?(?![a-z])|电音版|慢摇",
    "remix": r"remix|混音版|重混",
    "cover": r"翻唱版?|cover|改编版?|ai翻唱",
    "live": r"live版?|现场版?|演唱会|音乐节",
    "instrumental": (
        r"伴奏版?|纯音乐版?|instrumental|消音版?|卡拉ok|karaoke|ktv|"
        r"小提琴版?|大提琴版?|古筝版?|二胡版?|八音盒版?|口琴版?|笛子版?|"
        r"尤克里里版?|双排键版?|器乐版?|演奏版?"
    ),
    "piano": r"钢琴版|钢琴曲",
    "acoustic": r"吉他版|不插电|acoustic",
    "female": r"女声版|女生版|女版",
    "male": r"男声版|男版",
    "japanese": r"日语版?|日文版?",
    "cantonese": r"粤语版?",
    "english": r"英文版?|英语版?",
    "slowed": r"慢速|降速|slowed|0\.8x|0\.9x",
    "sped": r"加速|升速|pitched|sped\s?up|1\.2x|1\.25x",
    "nightcore": r"nightcore|night\s?core",
    "8d": r"8d|环绕",
    "funny": r"鬼畜|整活|恶搞|搞笑|沙雕|哈基米",
}

# 命令词 / 语气词：只剥一次，剥完写回 title
COMMAND_RE = re.compile(
    r"^(?:请|麻烦|帮我|给我|能不能|可以)?\s*"
    r"(?:唱一首|唱个|唱一下|唱一遍|唱|来一首|来首|来一个|点一首|点首|点歌|"
    r"整个|搞一个|放一首|放个|我想听|想听|听听|听)\s*"
)
TAIL_RE = re.compile(r"[吧呀呗嘛啊哦喔~～…\s]+$")
QUOTE_CHARS = " \t\r\n《》「」【】〈〉\"'“”‘’"

# ── 打分用的信号 ──────────────────────────────────────────────────────────────
# 这些是「一听就不对」的源：不是歌本身，或不是原曲
STRONG_NEG = [
    (r"试听|试音|音乐分享|录音棚|hires|hi-res|hi\s?res|无损|黑胶|磁带|母带|发烧|"
     r"车载|慢摇|酒吧|夜店", 3.2, "试听/发烧碟类"),
    (r"nightcore|slowed|pitched|sped\s?up|8d|环绕|加速版|降速版|变速版|"
     r"0\.8x|1\.2x|1\.25x", 3.2, "变速/夜核类"),
    (r"伴奏|纯音乐|instrumental|消音|karaoke|卡拉ok|ktv|伴唱", 4.0, "伴奏/卡拉OK"),
    (r"教学|教程|讲解|解析|乐评|reaction|翻弹|指弹|乐器|钢琴|吉他|古筝|二胡|"
     r"小提琴|八音盒|口琴|笛子|尤克里里|双排键|鼓谱|简谱|扒谱|曲谱|乐谱|"
     r"老师|课堂|上课|课件|班主任", 3.0, "教学/器乐改编"),
    (r"合集|串烧|歌单|循环|一小时|1小时|整张|全专辑|直播回放|录播|合集", 3.0, "合集/直播"),
    (r"片段|剪辑|高能|cut|精华|预告", 1.6, "片段剪辑"),
    # 解说/盘点类：标题在聊这首歌，不是这首歌
    (r"被骗|揭秘|科普|盘点|冷知识|背后的故事|抄袭|抄了|抄的|也是.{0,3}抄|知多少|"
     r"鉴赏|赏析|品鉴|"
     r"竟然|居然|为什么.{0,4}(?:歌|唱)", 1.8, "解说/盘点"),
    # 「逼死原唱」这种就是在说别人翻唱
    (r"逼死原唱|碾压原唱|超越原唱|挑战原唱|比原唱|完爆原唱", 1.8, "翻唱/对比"),
    # 歌词视频/曲谱：歌是别人的，画面只是词
    (r"动态歌词|歌词视频|lyrics?\s?vide?o|動態歌詞|动态鼓谱", 2.2, "歌词/曲谱视频"),
]

# 用户没点的语言版本：日语版/粤语版不能算「就是这首」
LANGUAGE_NEG = [
    (r"日语|日文|日本原唱|日版", 1.6, "日语版", {"japanese"}),
    (r"粤语|粤语版", 1.6, "粤语版", {"cantonese"}),
    (r"英文版|英语版|english\s?ver", 1.6, "英文版", {"english"}),
    (r"韩语|韩文|한국", 1.6, "韩语版", set()),
    (r"女声版|女生版|女版", 0.8, "女声版", {"female"}),
    (r"男声版|男生版|男版", 0.8, "男声版", {"male"}),
]
# 有 traits 时取消的负向词（用户就要这个版本）
TRAIT_GATED = {
    "伴奏/卡拉OK": {"instrumental"},
    "教学/器乐改编": {"piano", "acoustic", "instrumental"},
    "变速/夜核类": {"slowed", "sped", "nightcore", "8d"},
}

SOFT_NEG = [
    (r"翻唱|cover|改编版?|ai翻唱", 1.7, "翻唱", {"cover"}),
    (r"唱《|演唱《|唱了《", 0.9, "演绎/翻唱", {"cover"}),
    (r"现场|live|演唱会|音乐会|跨年|音乐节|商演|合唱|大合唱|万人合唱|晚会|春晚|"
     r"livehouse|路演", 1.1, "现场", {"live"}),
    (r"鬼畜|整活|恶搞|沙雕|搞笑|哈基米", 0.9, "整活", {"funny"}),
    (r"童声|儿童|儿歌|幼儿园", 1.4, "儿歌", set()),
    (r"升调|降调|女key|男key|低音版|高音版|降b|升f", 0.7, "升降调", {"slowed"}),
    (r"纯享|完整版|full\s?ver", -0.3, "完整版", set()),
]

OFFICIAL_POS = [
    (r"官方|原唱|原版|原曲|正版", 1.0, "官方/原唱"),
    (r"\bmv\b|music\s?video|官方mv", 0.7, "MV"),
    (r"1080p|4k|高清|修复", 0.3, "高清"),
]

# UP 主名里的官方/唱片公司特征
OFFICIAL_UPLOADER_RE = re.compile(
    r"官方|唱片|音乐公司|文化(?:传媒)?|传媒|工作室|official|records|studio", re.I
)

# 教学/课堂号把歌当教具用，标题里常混着学科名
TEACHING_UPLOADER_RE = re.compile(
    r"老师|教师|课堂|教学|网课|课件|班主任|物理|化学|数学|地理|生物|考研|公开课", re.I
)

CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")

# 「X的Y」里的 X 只有在像专名时才当歌手。代词、时间、副词、连词不是名字；
# 这条规则是闭类（语法词）判断，不是为某首歌特判——「后来的我们」「我们的歌」
# 都因此不会被拆成「后来 / 我们」。
NON_ARTIST_WORDS = {
    "我们", "你们", "他们", "她们", "它们", "咱们", "大家", "自己", "别人", "人家",
    "谁", "什么", "怎么", "怎样", "为什么", "哪", "这", "那", "这个", "那个",
    "这些", "那些", "这样", "那样", "这里", "那里",
    "后来", "以前", "以后", "之前", "之后", "现在", "当时", "曾经", "最后", "终于",
    "突然", "然后", "于是", "因此", "所以", "但是", "可是", "不过", "而且", "并且",
    "或者", "如果", "因为", "虽然", "即使", "只要", "只有", "无论", "不管",
    "已经", "正在", "刚刚", "马上", "立刻", "一直", "总是", "经常", "偶尔", "有时",
    "从不", "从未", "没有", "不是", "就是", "还是", "也是", "都是", "只是", "真是",
    "算是", "好像", "似乎", "大概", "也许", "可能", "应该", "必须", "需要", "可以",
    "不能", "不会", "不要", "不用", "竟然", "居然", "原来", "其实", "当然", "确实",
    "一定", "绝对", "非常", "特别", "十分",
}


def _looks_like_artist_name(text: str) -> bool:
    """「X的Y」拆歌手前，先判断 X 像不像专名（不是完整实体识别，只挡语法词）。"""
    t = text.strip()
    if not (2 <= len(t) <= 12):
        return False
    if t in NON_ARTIST_WORDS:
        return False
    if re.search(r"[的了着过吗呢吧啊哦呀嘛]", t):
        return False
    return True


@dataclass
class ParsedSong:
    raw: str
    title: str
    artist: str = ""
    traits: set[str] = field(default_factory=set)
    bvid: str = ""
    extra: list[str] = field(default_factory=list)

    def as_dict(self):
        return {
            "raw": self.raw,
            "title": self.title,
            "artist": self.artist,
            "traits": sorted(self.traits),
            "bvid": self.bvid,
        }


# ── 文本归一化 ────────────────────────────────────────────────────────────────
def strip_html(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text or "").replace("&amp;", "&").strip()


def parse_dur(value) -> int:
    """B 站搜索结果的 duration 可能是 'mm:ss'、'hh:mm:ss' 或秒数。"""
    try:
        if isinstance(value, (int, float)):
            return int(value)
        parts = [int(float(x)) for x in str(value).strip().split(":") if x != ""]
        sec = 0
        for part in parts:
            sec = sec * 60 + part
        return sec
    except Exception:
        return 0


def to_int(value) -> int:
    """播放量/排名之类的字段偶尔是 '--' 或带逗号的字符串，统一成整数。"""
    try:
        return int(float(str(value).replace(",", "").strip()))
    except Exception:
        return 0


def canon(text: str) -> str:
    """去掉大小写/空白/标点，只留可见文字：用来做「歌名是否真的出现在标题里」。"""
    text = unicodedata.normalize("NFKC", text or "").lower()
    text = re.sub(r"[\s\W_]+", "", text, flags=re.UNICODE)
    return text


def key_tokens(text: str) -> list[str]:
    """把歌名切成可匹配的片段：连续中文 2 字以上，或拉丁词 2 字以上。"""
    text = unicodedata.normalize("NFKC", text or "").lower()
    out = []
    for match in re.finditer(r"[a-z0-9][a-z0-9'\-\s]{1,}|[\u3400-\u9fff]{2,}", text):
        token = match.group(0).strip()
        if len(token) >= 2:
            out.append(token)
    return out


def _trait_hit(text: str) -> set[str]:
    low = (text or "").lower()
    return {name for name, pattern in TRAIT_PATTERNS.items() if re.search(pattern, low, re.I)}


def _strip_traits(text: str) -> tuple[str, set[str], list[str]]:
    """剥掉版本修饰词，返回（剩下的歌名, traits, 具名版本词）。

    「若生命等候 dj德朋版」里的「德朋」是点歌人点名的版本，不能丢：
    既不算歌名，也不该被静默忽略，记进 extras 用来给同样带「德朋」的结果加分。
    """
    traits = _trait_hit(text)
    extras: list[str] = []
    cleaned = text
    for name in traits:
        cleaned = re.sub(TRAIT_PATTERNS[name], " ", cleaned, flags=re.I)
    if traits:
        # 「dj德朋版」剥掉 dj 后剩下「德朋版」：记下「德朋」，再把残渣去掉；
        # 原版/正版/完整版这些有意义的词保留在歌名里。
        def _keep_extras(match: re.Match) -> str:
            word = match.group(1)
            if word not in ("完整", "原", "正") and len(word) >= 2:
                extras.append(word)
            return " "

        cleaned = re.sub(
            r"(?:^|\s)(?!原|正|完整)([\u4e00-\u9fff]{1,4})版(?=\s|$)", _keep_extras, cleaned
        )
        # 「翻唱版」「现场版」剥掉修饰词后剩下的单个「版」也要清掉
        cleaned = re.sub(r"(?:^|\s)版(?=\s|$)", " ", cleaned)
    cleaned = re.sub(r"\s*[-—~～·|｜/]\s*$", "", cleaned)
    cleaned = re.sub(r"^[\s\-—~～·|｜/]+", "", cleaned)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned or text, traits, extras


def _split_artist(text: str) -> tuple[str, str]:
    """尽力拆出「歌手 + 歌名」。

    只在信号明确时拆：`歌手 - 歌名`、`歌手《歌名》`、`歌手 的 歌名`。
    中文/拉丁混排（「星落落 let me go」）按脚本区分。
    """
    s = text.strip()
    # 《歌名》/【歌名】前后的文字
    for left, right in (("《", "》"), ("【", "】")):
        m = re.search(re.escape(left) + r"([^" + re.escape(right) + r"]{1,40})" + re.escape(right), s)
        if m:
            title = m.group(1).strip()
            outside = (s[: m.start()] + " " + s[m.end():]).strip(" -—·|｜/…")
            outside = re.sub(r"^[的]+|[的]+$", "", outside).strip(" …")
            if outside and title:
                return outside[:30], title
            return "", title or s

    for sep in (" - ", " – ", " — ", "—", " -", "- "):
        if sep in s:
            left, right = s.split(sep, 1)
            left, right = left.strip(), right.strip()
            if not left or not right:
                continue
            # 两边脚本不同：中文那边更像歌手名
            if CJK_RE.search(left) and not CJK_RE.search(right):
                return left[:30], right[:60]
            if CJK_RE.search(right) and not CJK_RE.search(left):
                return right[:30], left[:60]
            # 都是中文：短的通常是歌手
            if len(left) <= 12 and len(right) > 2:
                return left, right
            return right, left

    # 「刘若英的后来」：只有「的」前面像专名、后面不止一个字时才拆。
    # 「后来的我们」「我们的歌」「朋友的酒」都保留整句当歌名。
    m = re.match(r"^([^\s的]{2,12})的(.{2,60})$", s)
    if m and _looks_like_artist_name(m.group(1)) and not re.search(r"\d", m.group(1)):
        return m.group(1).strip(), m.group(2).strip()

    # 空格分隔：一个纯中文名字 + 多个拉丁词（「星落落 let me go」）
    parts = [p for p in re.split(r"\s+", s) if p]
    if len(parts) >= 2:
        han = [p for p in parts if re.fullmatch(r"[\u4e00-\u9fff·]{2,8}", p)]
        latin_idx = [i for i, p in enumerate(parts) if re.fullmatch(r"[A-Za-z0-9'&.\-]+", p)]
        if len(han) == 1 and len(latin_idx) >= 2 and len(han) + len(latin_idx) == len(parts):
            song = " ".join(p for p in parts if p != han[0])
            return han[0][:30], song[:60]
        if len(parts) == 2:
            a, b = parts
            if CJK_RE.search(a) and not CJK_RE.search(b):
                return a[:30], b[:60]
            if CJK_RE.search(b) and not CJK_RE.search(a):
                return b[:30], a[:60]
    return "", s


def _strip_outer_quotes(text: str) -> str:
    """只剥「成对包住整段」的引号；像「…【立秋】」这种内部成对的不要拆。"""
    pairs = {"《": "》", "「": "」", "【": "】", "〈": "〉", "“": "”", "‘": "’", '"': '"', "'": "'"}
    s = text.strip()
    while len(s) >= 2 and s[0] in pairs and s[-1] == pairs[s[0]]:
        s = s[1:-1].strip()
    return s


def parse_query(raw: str, max_len: int = 80) -> ParsedSong:
    text = unicodedata.normalize("NFKC", str(raw or "")).strip()
    text = re.sub(r"\s+", " ", text)[:max_len]
    bvid = ""
    m = re.search(r"(BV[0-9A-Za-z]{10})", text)
    if m:
        bvid = m.group(1)
        text = (text[: m.start()] + " " + text[m.end():]).strip()

    text = COMMAND_RE.sub("", text)
    text = TAIL_RE.sub("", text)
    text = _strip_outer_quotes(text)

    artist, title = _split_artist(text)
    if not title:
        title = text
    title, traits, extras = _strip_traits(title)
    if artist:
        artist, artist_traits, artist_extras = _strip_traits(artist)
        traits |= artist_traits
        extras = list(dict.fromkeys([*extras, *artist_extras]))
    title = _strip_outer_quotes(title) or text
    return ParsedSong(
        raw=str(raw or "").strip(),
        title=title,
        artist=artist,
        traits=traits,
        bvid=bvid,
        extra=extras,
    )


def build_queries(parsed: ParsedSong) -> list[str]:
    """按「先原话、再精确歌名、最后补原唱/官方」的顺序生成查询（去重保序）。"""
    queries: list[str] = []
    base = parsed.raw.strip()

    def add(value: str):
        value = re.sub(r"\s+", " ", value).strip()
        if value and value not in queries and len(value) <= 70:
            queries.append(value)

    if base:
        add(base)
    title = parsed.title.strip()
    if title:
        add(title)
    if parsed.artist and title:
        add(f"{title} {parsed.artist}")
        add(f"{parsed.artist} {title}")
    if title and parsed.extra:
        add(f"{title} {' '.join(parsed.extra)}")
    if title and not ({"cover", "live", "instrumental"} & parsed.traits):
        add(f"{title} 原唱")
        add(f"{title} 官方")
    # 日文标题带罗马音/假名时，再试一次纯汉字部分（「なゆなゆなゆ…【立秋】」→「立秋」）；
    # 标题里有拉丁词时（「Dreaming Bride 七色ビタミン」）不抽，否则「七色」会带一堆无关结果
    han = re.findall(r"[\u4e00-\u9fff]{2,}", title)
    if han and not re.search(r"[A-Za-z]", title):
        add(han[0])
    return queries[:6]


# ── 打分 ──────────────────────────────────────────────────────────────────────
HAN_ONLY = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")


def _is_latin_single(text: str) -> bool:
    """单个拉丁词（Love / lumiere）：不能靠空格词边界认定「就是这首歌」。"""
    s = unicodedata.normalize("NFKC", text or "").strip().casefold()
    return bool(re.fullmatch(r"[a-z0-9][a-z0-9'’&.\-]*", s))


def _neighbor(text: str, index: int, step: int) -> str:
    """跳过空格后，离 index 最近的那个字符（没有再返回空串）。"""
    j = index
    while 0 <= j < len(text) and text[j].isspace():
        j += step
    return text[j] if 0 <= j < len(text) else ""


_BRACKET_NOISE = re.compile(r"[【\[（(《「〈][^】\]）)》」〉]{0,80}[】\]）)》」〉]")


def _core_title(title: str) -> str:
    """去掉【】《》()这类前缀/副标题，只为判断两条是不是同一个作品。"""
    return canon(_BRACKET_NOISE.sub(" ", title or ""))


# 「OKGO乐队」「逃跑计划乐队」这类名字，标题里常只写核心名（OK GO / 逃跑计划）
ARTIST_SUFFIX_RE = re.compile(r"(?:乐队|乐团|组合|合唱团)$")


def _artist_matches(artist: str, text: str) -> bool:
    """歌手名是否出现在 text 里；允许去掉「乐队/乐团/组合/合唱团」后缀后匹配。"""
    a = canon(artist)
    if not a:
        return False
    t = canon(text)
    if a in t:
        return True
    core = ARTIST_SUFFIX_RE.sub("", a)
    return len(core) >= 2 and core in t


def _boundary_match(title: str, song: str) -> str:
    """歌名在标题里的出现方式：quoted / delimited / embedded。

    短歌名（2–4 字）很容易被别的句子蹭到（「后来我才明白」「后来的后来」），
    必须靠书名号或词边界才算真的在说这首歌。单个拉丁词更严格：前后紧邻的
    不能是另一个词——「I Want Love」「Une Année Sans Lumiere」都只是长句里
    的一个词，不是歌名本身。
    """
    t = unicodedata.normalize("NFKC", title or "").casefold()
    s = unicodedata.normalize("NFKC", song or "").casefold()
    if not s:
        return "embedded"
    for left, right in (("《", "》"), ("「", "」"), ("〈", "〉"), ("【", "】")):
        if left + s + right in t:
            return "quoted"
    single_latin = _is_latin_single(s)
    start = 0
    while True:
        index = t.find(s, start)
        if index < 0:
            return "embedded"
        before = t[index - 1] if index > 0 else ""
        after = t[index + len(s)] if index + len(s) < len(t) else ""
        if single_latin:
            bn = _neighbor(t, index - 1, -1)
            an = _neighbor(t, index + len(s), 1)
            tail = t[index + len(s):]
            # 「Love's Not A Game」里的 Love 是另一个词的一部分，不是歌名。
            if re.match(r"['’][a-z0-9]", tail):
                start = index + 1
                continue
            if (bn and re.match(r"[a-z0-9]", bn)) or (an and re.match(r"[a-z0-9]", an)):
                start = index + 1
                continue
            return "delimited"
        if not (before and HAN_ONLY.match(before)) and not (after and HAN_ONLY.match(after)):
            return "delimited"
        start = index + 1


def _in_feat_credit(low_title: str, index: int) -> bool:
    """这个位置是不是「feat. 某某」里的客串署名。

    「lumiere」被搜成「Out of Time feat. Eric Lumiere」就是这种情况：
    Lumiere 不是歌名，只是合作歌手的名字。
    """
    window = low_title[max(0, index - 24): index]
    if not re.search(r"(?:feat\.?|ft\.?|&|×|vs\.?)", window, re.I):
        return False
    # 窗口里已经有闭合括号/书名号：说明 feat 属于上一段，不是在说这个词
    return not re.search(r"[)）】》]", window)


def _match_quality(parsed: ParsedSong, title: str) -> tuple[float, str]:
    """歌名匹配质量：完全命中 1.0 / 片段覆盖 0.67 以上算 0.8 左右。"""
    song = canon(parsed.title)
    vt = canon(title)
    if not song:
        return 0.0, ""
    if song in vt:
        low_title = unicodedata.normalize("NFKC", title or "").casefold()
        low_song = unicodedata.normalize("NFKC", parsed.title or "").casefold()
        spots = [m.start() for m in re.finditer(re.escape(low_song), low_title)]
        if spots and all(_in_feat_credit(low_title, spot) for spot in spots):
            return 0.3, "只是合作歌手"
        if len(song) <= 4 or _is_latin_single(parsed.title):
            where = _boundary_match(title, parsed.title)
            if where == "embedded":
                return 0.72, "歌名只在长句里出现"
        return 1.0, "歌名完全命中"
    tokens = key_tokens(parsed.title)
    if not tokens:
        return 0.0, ""
    hit = [t for t in tokens if canon(t) in vt]
    coverage = len(hit) / len(tokens)
    if coverage >= 0.999:
        return 0.92, "歌名分词全命中"
    if coverage > 0:
        return 0.35 + 0.45 * coverage, f"歌名命中 {len(hit)}/{len(tokens)}"
    return 0.0, ""


# ── 指定频道优先 ──────────────────────────────────────────────────────────────
# 用户指定：JLRS-jayfm / JLRS-LeoFM 的版本第一优先（jayfm 先，LeoFM 次）。
# 这两位都是「百万级录音棚试听」类账号——旧打分把「录音棚/试听/Hi-Res」当硬负分，
# 正好会把他们压掉。这里给他们单独的搜索与排序，绕开那套负向词。
CHANNELS = [
    {"key": "jayfm", "mid": 3493082817366845, "name": "JLRS-jayfm"},
    {"key": "leofm", "mid": 3493093607213343, "name": "JLRS-LeoFM"},
]

# 点歌人明确点名的版本特征：频道里必须有同款才用
VERSION_TRAITS = {
    "dj", "remix", "cover", "live", "instrumental", "piano", "acoustic",
    "female", "male", "japanese", "cantonese", "english", "slowed", "sped",
    "nightcore", "8d", "funny",
}

# 点歌人没点名版本时，频道里这些「不是原版」的版本要降权
CHANNEL_VERSION_NEG = [
    ("live", 1.4), ("cover", 1.6), ("instrumental", 2.0), ("dj", 1.6),
    ("remix", 1.4), ("piano", 1.4), ("acoustic", 1.0), ("slowed", 1.6),
    ("sped", 1.6), ("nightcore", 1.8), ("8d", 1.4), ("funny", 1.4),
    ("female", 0.6), ("male", 0.6),
]
CHANNEL_VERSION_WORD_RE = re.compile(
    r"重生版|新版|重制|重置|改编版|混音版|现场版|演唱会版|翻唱版", re.I
)


def channel_keywords(parsed: ParsedSong) -> list[str]:
    """在指定频道里搜什么词：先歌名，再「歌手 歌名」，最后拆词兜底。"""
    out: list[str] = []

    def add(value: str):
        value = re.sub(r"\s+", " ", value or "").strip()
        if value and value not in out and len(value) <= 40:
            out.append(value)

    if parsed.title:
        add(parsed.title)
    if parsed.artist and parsed.title:
        add(f"{parsed.artist} {parsed.title}")
    # 「后来 刘若英」这种没分隔的，整串搜不到时用单个词再搜一次
    tokens = key_tokens(parsed.title)
    if len(tokens) > 1:
        for token in tokens[:2]:
            if len(canon(token)) >= 2:
                add(token)
    if parsed.title and len(parsed.title) > 20:
        add(parsed.title[:20])
    return out[:3]


def _any_token_boundary(title: str, parsed: ParsedSong) -> bool:
    """多词歌名（「后来 刘若英」）里，至少有一个词是书名号/边界命中。"""
    for token in key_tokens(parsed.title):
        if len(canon(token)) >= 2 and _boundary_match(title, token) in ("quoted", "delimited"):
            return True
    return False


def channel_accept(parsed: ParsedSong, title: str) -> bool:
    """频道视频标题是不是「真的这首歌」。

    必须边界命中（书名号/分界），不能是「后来的我们」这种长句蹭到短歌名。
    """
    if not parsed.title:
        return False
    match, _ = _match_quality(parsed, title)
    if match >= 0.99:
        return _boundary_match(title, parsed.title) != "embedded"
    # 歌名被拆成多个词、但每个词都命中（「后来 刘若英」）：至少有一个词有边界
    if match >= 0.9:
        return _any_token_boundary(title, parsed)
    return False


def _channel_view(parsed, item, channel_key, channel_name, index, hard_limit):
    title = strip_html(str(item.get("title") or ""))
    if not channel_accept(parsed, title):
        return None
    duration = parse_dur(item.get("duration") or item.get("length"))
    if duration and (duration < 60 or duration > hard_limit):
        return None

    traits = _trait_hit(title)
    want = parsed.traits & VERSION_TRAITS
    # 点歌人明确要 DJ版/现场版/日语版时，频道里没有同款就不算命中，交给回退
    if want and not (traits & want):
        return None

    match, why = _match_quality(parsed, title)
    where = _boundary_match(title, parsed.title)
    score = 4.0 * match
    reasons = [f"指定频道:{channel_name}", why]
    if where == "quoted":
        score += 0.4
        reasons.append("书名号命中")

    if parsed.artist:
        if _artist_matches(parsed.artist, title):
            score += 1.2
            reasons.append("歌手命中")
        else:
            score -= 0.8
            reasons.append("标题没写歌手")

    if want:
        score += 2.0
        reasons.append("版本命中")
    else:
        for trait, weight in CHANNEL_VERSION_NEG:
            if trait in traits:
                score -= weight
                reasons.append(f"降权:{trait}")
        if CHANNEL_VERSION_WORD_RE.search(title):
            score -= 1.0
            reasons.append("降权:重制版")

    play = to_int(item.get("play"))
    score += min(0.6, 0.1 * math.log10(play + 10))
    score -= min(0.4, index * 0.02)
    if channel_key == "jayfm":
        score += 0.1
    bvid = str(item.get("bvid") or "")
    return {
        "bvid": bvid,
        "title": title,
        "uploader": channel_name,
        "duration": duration,
        "play": play,
        "url": f"https://www.bilibili.com/video/{bvid}" if bvid else "",
        "score": round(score, 2),
        "match": round(match, 2),
        "reasons": reasons,
        "rejects": [],
    }


def rank_channel_candidates(
    parsed: ParsedSong,
    items: list[dict],
    channel_key: str = "",
    channel_name: str = "",
    *,
    hard_limit: int = 9 * 60,
) -> dict:
    """频道搜索结果排序：先保证是这首歌，再按版本/歌手/播放量排。"""
    views: list[dict] = []
    seen: set[str] = set()
    for index, item in enumerate(items):
        bvid = str(item.get("bvid") or "")
        if not bvid or bvid in seen:
            continue
        view = _channel_view(parsed, item, channel_key, channel_name, index, hard_limit)
        if view:
            seen.add(bvid)
            views.append(view)
    views.sort(key=lambda v: v["score"], reverse=True)
    top = views[:5]
    if not top:
        return {"confidence": "low", "pick": None, "candidates": [], "reason": ""}
    best = top[0]
    reason = ""
    if len(top) > 1 and best["score"] - top[1]["score"] < 0.5:
        reason = "频道里有多个版本，先确认"
    confidence = "high" if not reason else "low"
    return {
        "confidence": confidence,
        "pick": best if confidence == "high" else None,
        "candidates": top,
        "reason": reason,
    }


def score_item(parsed: ParsedSong, item: dict, rank: int = 0) -> dict:
    """给单条搜索结果打分。返回 {score, match, reasons, rejects, ...}。"""
    title = strip_html(str(item.get("title") or ""))
    uploader = strip_html(str(item.get("author") or item.get("uploader") or ""))
    tags = strip_html(str(item.get("tag") or item.get("tags") or ""))
    desc = strip_html(str(item.get("desc") or item.get("description") or ""))
    text = " ".join([title, tags])
    title_low = title.lower()
    low = text.lower()
    full = " ".join([title, tags, desc]).lower()

    score = 0.0
    match, why = _match_quality(parsed, title)
    if match >= 0.9:
        score += 3.2 * match
    elif match > 0:
        score += 1.2 * match
    else:
        score -= 1.8
    reasons = [why] if why else []

    # 歌手名：标题 / UP 主里出现都算
    if parsed.artist:
        artist = parsed.artist.strip()
        if artist and (_artist_matches(artist, title) or _artist_matches(artist, uploader)):
            score += 2.0
            reasons.append("歌手命中")
        else:
            score -= 1.3
            reasons.append("歌手没对上")

    # 「官方/MV/高清」只看标题：标签里人人都写 MV、无损，跟着标签走会误加分
    for pattern, weight, label in OFFICIAL_POS:
        if re.search(pattern, title_low, re.I):
            score += weight
            reasons.append(label)

    if OFFICIAL_UPLOADER_RE.search(uploader):
        score += 0.5
        reasons.append("官方/音乐号")

    # 点歌人点名的版本词（「德朋版」的「德朋」）：标题里真有才加分
    for token in parsed.extra:
        if len(canon(token)) >= 2 and canon(token) in canon(title):
            score += 1.5
            reasons.append(f"版本词命中:{token}")

    rejects: list[str] = ["只是合作歌手"] if why == "只是合作歌手" else []
    # 教学号拿歌曲当教具（「平面镜成像：love okgo 乐队 mv」这种），不是来发歌的
    if TEACHING_UPLOADER_RE.search(uploader):
        score -= 2.0
        rejects.append("教学号")
        reasons.append("排除:教学号")

    for pattern, weight, label in STRONG_NEG:
        if not re.search(pattern, title_low, re.I):
            continue
        gated = TRAIT_GATED.get(label)
        if gated and (parsed.traits & gated):
            continue
        score -= weight
        rejects.append(label)
        reasons.append(f"排除:{label}")

    for pattern, weight, label, gated in LANGUAGE_NEG:
        if gated and (parsed.traits & gated):
            continue
        if re.search(pattern, title_low, re.I):
            score -= weight
            reasons.append(f"降权:{label}")

    for pattern, weight, label, gated in SOFT_NEG:
        if not re.search(pattern, title_low, re.I):
            continue
        if gated and (parsed.traits & gated):
            continue
        score -= weight
        reasons.append(f"降权:{label}")

    # 描述里承认是翻唱：标题没写但简介写了，也要降
    if re.search(r"翻唱|cover", full) and not re.search(r"翻唱|cover", low) and "cover" not in parsed.traits:
        score -= 0.6
        reasons.append("简介是翻唱")

    duration = parse_dur(item.get("duration"))
    if 150 <= duration <= 330:
        score += 0.8
    elif 90 <= duration <= 420:
        score += 0.2
    elif duration and duration < 90:
        score -= 1.0
        reasons.append("太短")
    elif duration > 420:
        score -= 1.0
        reasons.append("太长")

    play = to_int(item.get("play"))
    score += min(1.8, 0.4 * math.log10(play + 10))
    score -= min(1.2, 0.2 * max(0, rank))

    if len(title) > 70:
        score -= 0.4
    if item.get("is_union_video"):
        score -= 0.8
        reasons.append("合集/多P")

    return {
        "score": round(score, 2),
        "match": round(match, 2),
        "reasons": reasons,
        "rejects": rejects,
        "duration": duration,
        "title": title,
        "uploader": uploader,
    }


def _view(parsed: ParsedSong, item: dict, rank: int) -> dict:
    detail = score_item(parsed, item, rank)
    bvid = str(item.get("bvid") or "")
    return {
        "bvid": bvid,
        "title": detail["title"],
        "uploader": detail["uploader"],
        "duration": detail["duration"],
        "play": to_int(item.get("play")),
        "url": f"https://www.bilibili.com/video/{bvid}" if bvid else "",
        "score": detail["score"],
        "match": detail["match"],
        "reasons": detail["reasons"],
        "rejects": detail["rejects"],
    }


def rank_candidates(
    parsed: ParsedSong,
    items: list[dict],
    *,
    hard_limit: int = 9 * 60,
) -> dict:
    """把各次查询的结果合成一个排序好的候选表，并判断置信度。

    返回 {confidence: 'high'|'low', pick, candidates, reason}
    """
    seen: set[str] = set()
    views: list[dict] = []
    for index, item in enumerate(items):
        if item.get("type") and item.get("type") != "video":
            continue
        bvid = str(item.get("bvid") or "")
        if not bvid or bvid in seen:
            continue
        duration = parse_dur(item.get("duration"))
        if duration and (duration < 70 or duration > hard_limit):
            continue
        seen.add(bvid)
        rank = item.get("_rank")
        views.append(_view(parsed, item, to_int(rank) if rank is not None else index))

    views.sort(key=lambda v: v["score"], reverse=True)
    top = views[:5]
    if not top:
        return {"confidence": "low", "pick": None, "candidates": [], "reason": "一条候选都没有"}

    best = top[0]
    # 只有「同样可信的第二名」才需要靠分差判犹豫：
    # 名字对不上、带硬伤、歌手没对上、时长不对的，本来就不该跟第一名争。
    challenger = None
    for other in top[1:]:
        if other["match"] < 0.9 or other["rejects"]:
            continue
        if parsed.artist and "歌手命中" not in other["reasons"]:
            continue
        if other["duration"] and (other["duration"] < 90 or other["duration"] > 480):
            continue
        # 同一个作品的不同版本/转载：时长几乎一样，且标题几乎一样或同一个 UP 传的，
        # 都不算「另一个可能」——否则会一直卡在「前两名分太近」。
        # 比标题时同时看去掉【】《》()前缀后的核心标题：同一首歌常被不同 UP 加上
        # 不同的梗前缀，如「《古惑仔の小曲》…若生命等候」和「《出来の小曲》…」。
        same_duration = (
            best["duration"]
            and other["duration"]
            and abs(other["duration"] - best["duration"]) <= 5
        )
        if same_duration:
            similar = difflib.SequenceMatcher(
                None, canon(best["title"]), canon(other["title"])
            ).ratio()
            if similar < 0.8:
                similar = difflib.SequenceMatcher(
                    None, _core_title(best["title"]), _core_title(other["title"])
                ).ratio()
            same_uploader = best["uploader"] and best["uploader"] == other["uploader"]
            if similar >= 0.8 or same_uploader:
                continue
        challenger = other
        break
    reason = ""
    if best["match"] < 0.8:
        reason = "歌名对不上"
    elif best["rejects"]:
        reason = "最好的结果也带「" + "、".join(best["rejects"]) + "」"
    elif best["score"] < 2.4:
        reason = "最高分也不高"
    elif challenger and best["score"] - challenger["score"] < 0.6:
        reason = "前两名分太近"
    elif parsed.artist and "歌手命中" not in best["reasons"]:
        reason = "歌手没对上"
    elif best["duration"] and (best["duration"] < 90 or best["duration"] > 480):
        reason = "时长不像一首完整的歌"

    confidence = "high" if not reason else "low"
    return {
        "confidence": confidence,
        "pick": best if confidence == "high" else None,
        "candidates": top,
        "reason": reason,
    }



# ── 从搜索结果里反推「原唱歌手」────────────────────────────────────────────────
# 没给歌手时（「后来」「电灯胆」），只看歌名很容易被翻唱/解说视频骗到。
# 做法：从多条标题里统计「《歌名》旁边的名字」，出现次数明显领先的那个当原唱，
# 再拿它去补一次查询、重排；只有它确实把某个带「歌手命中」的结果顶到第一才采用。
ARTIST_STOP = (
    "原唱", "翻唱", "官方", "完整", "版本", "高清", "无损", "现场", "合唱", "经典",
    "老歌", "新歌", "歌曲", "音乐", "歌词", "伴奏", "日语", "粤语", "国语", "女声",
    "男声", "童声", "这首", "一首", "群星", "合集", "精选", "热门", "神曲", "抖音",
    "网络", "好听", "催泪", "泪目", "纯享", "试听", "母带", "黑胶", "录音棚", "百万",
    "豪装", "分享", "教学", "教程", "解析", "直播", "录播", "跨年", "晚会", "春晚",
    "演唱会", "音乐节", "翻自", "改编", "mv", "4k", "1080p", "live", "remix", "dj",
    "cover", "reaction", "鬼畜", "整活", "动态", "广场舞", "铃声", "串烧", "片段",
)


def _valid_artist(cand: str) -> bool:
    cand = cand.strip(" ·-—|:：,，。的")
    if not (2 <= len(cand) <= 12):
        return False
    if re.search(r"\d", cand):
        return False
    low = cand.lower()
    if any(word in low for word in ARTIST_STOP):
        return False
    # 名字里出现标点/空白太多，多半是从句
    if len(re.findall(r"[\s·,，。!！?？]", cand)) > 1:
        return False
    return bool(CJK_RE.search(cand)) or bool(re.fullmatch(r"[A-Za-z][A-Za-z0-9 .&'\-]{1,20}", cand))


def _artist_candidates(title: str, song: str) -> list[str]:
    """从一条标题里抽可能的歌手名（宁缺毋滥）。"""
    s = re.escape(song)
    pairs = (("《", "》"), ("「", "」"), ("【", "】"))
    out: list[str] = []
    # 《歌名》后面跟的名字：《后来》刘若英 / 《后来》- 刘若英
    for left, right in pairs:
        for m in re.finditer(
            re.escape(left) + r"\s*" + s + r"\s*" + re.escape(right)
            + r"\s*[·\-—:：]?\s*([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9·.&' ]{1,14})",
            title,
        ):
            out.append(re.sub(r"(?:唱|演唱|翻唱|的|版|原唱)+$", "", m.group(1).strip()))
        # 名字在《歌名》前面：刘若英《后来》/ 陈慧娴唱《后来》
        for m in re.finditer(
            r"([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9·.&' ]{1,14})\s*"
            + re.escape(left) + r"\s*" + s + r"\s*" + re.escape(right),
            title,
        ):
            out.append(re.sub(r"(?:唱|演唱|翻唱|的|版|原唱)+$", "", m.group(1).strip()))
    # 邓丽欣 - 电灯胆 / 电灯胆 - 邓丽欣
    for m in re.finditer(
        r"([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9·.&' ]{1,14})\s*[-–—]\s*" + s, title
    ):
        out.append(m.group(1).strip())
    for m in re.finditer(
        s + r"\s*[-–—]\s*([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9·.&' ]{1,14})", title
    ):
        out.append(m.group(1).strip())
    # 刘若英的后来
    for m in re.finditer(r"([\u4e00-\u9fff·]{2,8})的\s*" + s, title):
        out.append(m.group(1).strip())
    return [c for c in out if c]


def _song_anchor(parsed: ParsedSong, titles: list[str]) -> str:
    """歌名里有两三个词时，挑被书名号括得最多的那个当「真正的歌名」。

    「电灯胆 邓丽欣」这种没写分隔的输入，靠搜索结果反推：如果《电灯胆》出现
    得比《邓丽欣》多得多，那歌名就是电灯胆，另一个是歌手。
    """
    tokens = [t for t in key_tokens(parsed.title) if len(canon(t)) >= 2]
    if 2 <= len(tokens) <= 3:
        counts = {
            token: sum(1 for title in titles if f"《{token}》" in title or f"「{token}」" in title)
            for token in tokens
        }
        best = max(counts, key=counts.get)
        if counts[best] >= 2:
            return best
    return parsed.title.strip()


def infer_artist(parsed: ParsedSong, items: list[dict], top_n: int = 40) -> tuple[str, str]:
    """统计候选歌手；只有票数≥2 且明显领先时才返回 (歌手, 歌名)（避免瞎猜）。"""
    if parsed.artist or not parsed.title:
        return "", ""
    titles = [strip_html(str(item.get("title") or "")) for item in items[:top_n]]
    song = _song_anchor(parsed, titles)
    if len(canon(song)) < 2:
        return "", ""
    counts: Counter = Counter()
    for title in titles:
        if canon(song) not in canon(title):
            continue
        for cand in _artist_candidates(title, song):
            cand = cand.strip(" ·-—|:：,，。的")
            if not cand or canon(cand) == canon(song):
                continue
            if _valid_artist(cand):
                counts[cand] += 1
    if not counts:
        return "", ""
    ranked = counts.most_common(3)
    top, votes = ranked[0]
    second = ranked[1][1] if len(ranked) > 1 else 0
    if votes < 2:
        return "", ""
    if second and votes < second * 2 and votes - second < 2:
        return "", ""
    return top, song


def with_artist(parsed: ParsedSong, artist: str, song: str = "") -> ParsedSong:
    title = song.strip() or parsed.title
    return replace(parsed, title=title, artist=artist)
