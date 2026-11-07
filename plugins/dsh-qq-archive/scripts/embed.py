"""dsh-qq-archive 语义检索后端（可选增强层）。

用法：
  python embed.py build --db <archive.db> --out <home>/semantic
  python embed.py query --out <home>/semantic --text "上次那个做视频的群"

依赖：transformers + torch + numpy（CPU 即可）。模型 BAAI/bge-small-zh-v1.5，
首次运行会从 HF 镜像下载（约 95 MB），之后走本地缓存。

构建产物：ids.npy（消息 id）+ vectors.npy（归一化向量，点积=余弦）。
"""
import argparse
import json
import os
import sqlite3
import sys

os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')

MODEL = 'BAAI/bge-small-zh-v1.5'
QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'


def load_model():
    import torch
    from transformers import AutoModel, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(MODEL)
    model = AutoModel.from_pretrained(MODEL)
    model.eval()
    return torch, tok, model


def encode(texts, tok, model, torch, batch=64):
    import numpy as np

    out = []
    with torch.no_grad():
        for i in range(0, len(texts), batch):
            chunk = texts[i:i + batch]
            enc = tok(chunk, padding=True, truncation=True, max_length=512, return_tensors='pt')
            emb = model(**enc).last_hidden_state[:, 0]
            emb = torch.nn.functional.normalize(emb, dim=-1)
            out.append(emb.cpu().numpy().astype('float32'))
    if not out:
        return np.zeros((0, 512), dtype='float32')
    return np.concatenate(out, axis=0)


def read_messages(db_path, min_chars):
    con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    try:
        rows = con.execute(
            'select id, text from messages where length(trim(text)) >= ? order by id',
            (min_chars,),
        ).fetchall()
    finally:
        con.close()
    out = []
    for mid, text in rows:
        t = (text or '').strip()
        # 纯占位（[图片] [语音] …）没有语义价值
        if t.startswith('[') and t.endswith(']') and len(t) <= 12:
            continue
        out.append((int(mid), t))
    return out


def cmd_build(a):
    import numpy as np

    rows = read_messages(a.db, a.min_chars)
    print(f'messages: {len(rows)}', flush=True)
    if not rows:
        out = {'count': 0, 'dim': 0}
        print(json.dumps(out), flush=True)
        return
    torch, tok, model = load_model()
    ids = np.array([r[0] for r in rows], dtype='int64')
    texts = [r[1] for r in rows]
    vectors = encode(texts, tok, model, torch, batch=a.batch)
    os.makedirs(a.out, exist_ok=True)
    np.save(os.path.join(a.out, 'ids.npy'), ids)
    np.save(os.path.join(a.out, 'vectors.npy'), vectors)
    print(json.dumps({'count': int(len(ids)), 'dim': int(vectors.shape[1])}), flush=True)


def cmd_query(a):
    import numpy as np

    ids_path = os.path.join(a.out, 'ids.npy')
    vec_path = os.path.join(a.out, 'vectors.npy')
    if not (os.path.exists(ids_path) and os.path.exists(vec_path)):
        print(json.dumps({'error': '语义索引还没建，先跑 qq_archive action=semantic'}), flush=True)
        sys.exit(2)
    ids = np.load(ids_path)
    vectors = np.load(vec_path)
    torch, tok, model = load_model()
    q = encode([QUERY_PREFIX + a.text], tok, model, torch, batch=1)[0]
    scores = vectors @ q
    k = min(a.k, len(ids))
    order = np.argpartition(-scores, k - 1)[:k]
    order = order[np.argsort(-scores[order])]
    hits = [
        {'id': int(ids[i]), 'score': round(float(scores[i]), 4)}
        for i in order
        if float(scores[i]) >= a.min_score
    ]
    print(json.dumps({'hits': hits}, ensure_ascii=False), flush=True)


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)
    b = sub.add_parser('build')
    b.add_argument('--db', required=True)
    b.add_argument('--out', required=True)
    b.add_argument('--batch', type=int, default=64)
    b.add_argument('--min-chars', type=int, default=4)
    q = sub.add_parser('query')
    q.add_argument('--out', required=True)
    q.add_argument('--text', required=True)
    q.add_argument('--k', type=int, default=50)
    q.add_argument('--min-score', type=float, default=0.35)
    a = p.parse_args()
    if a.cmd == 'build':
        cmd_build(a)
    else:
        cmd_query(a)


if __name__ == '__main__':
    main()
