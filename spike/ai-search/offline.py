#!/usr/bin/env python3
"""Offline baselines for the no-go path: what the current DO would score if it
did an exact scan, chunked long files, or added an FTS5-style keyword path.

Uses the spike Worker's /embed route (same bge-m3 call as src/search/embeddings.ts)
so the vectors match production. Caches vectors under $SPIKE_DATA.

  SPIKE_URL=... SPIKE_TOKEN=... SPIKE_DATA=/path/to/private/dir python3 spike/ai-search/offline.py
"""
import json, math, os, re, sys, urllib.request
from collections import Counter

URL, TOK = os.environ["SPIKE_URL"], os.environ["SPIKE_TOKEN"]
DATA = os.environ.get("SPIKE_DATA", "/tmp/agent-memory-spike")
CHUNK, OVERLAP = 1500, 150


def post(path, body):
    req = urllib.request.Request(URL + path, data=json.dumps(body).encode(), headers={
        "authorization": f"Bearer {TOK}", "content-type": "application/json",
        "user-agent": "agent-memory-spike/1.0"})
    return json.load(urllib.request.urlopen(req, timeout=300))


def cached(name, fn):
    p = os.path.join(DATA, f"cache-{name}.json")
    if os.path.exists(p):
        return json.load(open(p))
    v = fn()
    json.dump(v, open(p, "w"))
    return v


keys = json.load(open(os.path.join(DATA, "indexed.json")))  # keys uploaded by /backfill
queries = json.load(open(os.path.join(DATA, "queries.json")))


def embed_keys(chunk):
    out = {}
    step = 10 if not chunk else 3
    for i in range(0, len(keys), step):
        for r in post("/embed", {"keys": keys[i:i + step], "chunk": chunk, "overlap": OVERLAP if chunk else 0,
                                 "with_content": not chunk}):
            out[r["key"]] = r
        sys.stderr.write(".")
    sys.stderr.write("\n")
    return out


whole = cached("whole", lambda: embed_keys(0))
chunked = cached("chunked", lambda: embed_keys(CHUNK))
qvecs = cached("qvecs", lambda: post("/embed", {"texts": [q["q"] for q in queries]}))


def cos(a, b):
    return sum(x * y for x, y in zip(a, b)) / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


# BM25 over whole files, porter-ish: lowercase word tokens, keep hyphenated ids
# like ABC-123 as one token as well as their parts (what FTS5 unicode61 + a
# trigram/porter mix roughly gives you).
def toks(t):
    t = t.lower()
    base = re.findall(r"[a-z0-9]+", t)
    ids = re.findall(r"[a-z0-9]+(?:[-_.][a-z0-9]+)+", t)
    return base + ids


docs = {k: Counter(toks(whole[k]["content"])) for k in keys if "content" in whole[k]}
N = len(docs)
avgdl = sum(sum(c.values()) for c in docs.values()) / N
df = Counter(t for c in docs.values() for t in c)


def bm25(q, k1=1.2, b=0.75):
    qt = set(toks(q))
    s = {}
    for k, c in docs.items():
        dl = sum(c.values())
        sc = 0.0
        for t in qt:
            if t not in c:
                continue
            idf = math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5))
            sc += idf * c[t] * (k1 + 1) / (c[t] + k1 * (1 - b + b * dl / avgdl))
        if sc > 0:
            s[k] = sc
    return sorted(s, key=s.get, reverse=True)


def rrf(*lists, k=60):
    s = Counter()
    for l in lists:
        for i, p in enumerate(l[:50]):
            s[p] += 1 / (k + i + 1)
    return [p for p, _ in s.most_common()]


def score(ranked, gold):
    rank = next((i for i, p in enumerate(ranked) if p in gold), -1)
    return {"hit1": rank == 0, "hit5": 0 <= rank < 5, "rr": 1 / (rank + 1) if 0 <= rank < 10 else 0, "rank": rank,
            "top": ranked[:5]}


rows = []
for q, qv in zip(queries, qvecs):
    ew = sorted(keys, key=lambda k: -cos(qv, whole[k]["vecs"][0]))
    ec = sorted(keys, key=lambda k: -max(cos(qv, v) for v in chunked[k]["vecs"]))
    kw = bm25(q["q"])
    rows.append({"q": q["q"], "kind": q["kind"], "systems": {
        "exact_whole": score(ew, q["gold"]),
        "exact_chunked": score(ec, q["gold"]),
        "fts_bm25": score(kw, q["gold"]),
        "chunked_plus_fts_rrf": score(rrf(ec, kw), q["gold"]),
    }})

slices = {"all": lambda r: True, "exact": lambda r: "exact" in r["kind"], "long": lambda r: "long" in r["kind"],
          "real": lambda r: "real" in r["kind"]}
summary = {}
for name, pred in slices.items():
    sel = [r for r in rows if pred(r)]
    summary[name] = {"n": len(sel)}
    for s in rows[0]["systems"]:
        summary[name][s] = {
            "recall_at_1": round(sum(r["systems"][s]["hit1"] for r in sel) / len(sel), 3),
            "recall_at_5": round(sum(r["systems"][s]["hit5"] for r in sel) / len(sel), 3),
            "mrr_at_10": round(sum(r["systems"][s]["rr"] for r in sel) / len(sel), 3),
        }
json.dump({"summary": summary, "rows": rows, "chunk_chars": CHUNK, "overlap_chars": OVERLAP,
           "chunks_total": sum(len(chunked[k]["vecs"]) for k in keys)}, open(os.path.join(DATA, "results-offline.json"), "w"), indent=1)
for name, v in summary.items():
    print(name, "n=", v["n"])
    for s, m in v.items():
        if s != "n":
            print(f"   {s:22s} R@1 {m['recall_at_1']:.2f}  R@5 {m['recall_at_5']:.2f}  MRR {m['mrr_at_10']:.2f}")
