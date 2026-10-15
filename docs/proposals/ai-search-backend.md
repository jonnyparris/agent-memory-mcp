# Proposal: use Cloudflare AI Search for the search index

Status: **spike done (2026-10-15). Verdict: no-go for now.** Nothing in this PR
changes runtime behaviour. See [Spike results](#spike-results-2026-10-15).

## Summary

Today, search runs on code we wrote ourselves: an HNSW graph inside the
`MemoryIndex` Durable Object, with bge-m3 vectors stored as JSON blobs in
SQLite. This document asks whether [Cloudflare AI Search](https://developers.cloudflare.com/ai-search/)
should replace the vector part of that stack, while tags and wikilinks stay in
the Durable Object.

The original recommendation was to run a time-boxed spike before deciding.
The spike is done. AI Search finds the right file far more often than the
current index. But almost all of that gain comes from chunking and keyword
search, and we can build both inside the Durable Object. AI Search also takes
over two minutes to make a new file searchable by vector, which breaks
overlap detection on write. So: don't migrate. Fix the current index instead.

## What we have now

| Piece | Where | Notes |
| --- | --- | --- |
| Embeddings | `src/search/embeddings.ts` | `@cf/baai/bge-m3`, 1024 dims, **one vector per file** |
| ANN index | `src/search/hnsw.ts` (374 lines) | Hand-rolled HNSW, rebuilt in memory from SQLite on cold start |
| Storage | `src/search/durable-object.ts` | `memories(path, embedding BLOB, updated_at)` table |
| Tag filter | same DO | `file_tags` table; exact cosine scan of the tagged set |
| Backlinks | same DO | `file_links` table |
| Recency | `rankResults()` | 30-day half-life, `score * (0.3 + 0.7 * decay)` |
| Scopes | `src/search/client.ts` | Two DO instances: `default` (memory) and `conversations` |

Known weak spots, mostly documented in the code comments:

1. **No chunking.** Files over 20,000 characters are embedded on their opening
   section only (`MAX_EMBED_CHARS`). Content further down a large hub file
   cannot be found.
2. **Semantic only.** There is no keyword path. Exact terms such as ticket
   keys, hostnames, people's names, and error strings rely on the embedding
   model to match them, and it often doesn't.
3. **We maintain an ANN implementation.** `HNSWIndex.delete` unlinks nodes
   without re-linking their neighbours, so `prune` has to rebuild the graph to
   avoid stranding regions. The cold start deserialises every vector from JSON.
4. **No reranking.** Results are cosine plus a recency multiplier.

## What AI Search would give us

From the current docs (checked 2026-09):

- **Chunking and embedding are managed.** Long files are split into chunks, so
  point 1 goes away.
- **Hybrid retrieval.** Vector plus BM25 keyword search, fused with RRF or max.
  `hybrid` is the default `retrieval_type`. This fixes point 2.
- **Optional reranking and query rewriting**, configured per instance.
- **Metadata filters**: `filename`, `folder`, `timestamp` are built in, plus up
  to 5 custom fields, with `$eq/$ne/$in/$nin/$lt/$lte/$gt/$gte`.
- **Recency boosting**: `boost_by: [{ field: "timestamp", direction: "desc" }]`,
  set per instance or per request.
- **A Workers binding** (`ai_search` / `ai_search_namespaces`) with
  `search()` and an Items API (`items.upload`, `uploadAndPoll`, `delete`,
  `list`).
- **Built-in storage indexes files on upload**, with no sync job to wait for.
- **Generally available since 2026-10-01. Billing starts 2026-11-01.** See
  the cost section below.

## What does not map cleanly

These are the reasons this is a proposal and not a PR that swaps the backend.

1. **Tags are arrays, and AI Search cannot filter arrays.** The filter docs say
   string arrays are stored but not indexed. We also only get 5 custom fields,
   and only the first 64 bytes of a string are filterable. So the tag
   intersection logic has to stay in the DO. One option: resolve tags to a
   path set in SQLite, then pass `filename: { $in: [...] }`. The `$in` size
   limit is not documented and needs testing.
2. **Write-then-search freshness.** `write` runs overlap detection straight
   after the write, so it needs the new file in the index at once. An R2 data
   source syncs on a schedule (1 hour at best, or a manual job at most every
   30 seconds). That is too slow. Built-in storage with `uploadAndPoll` is the
   only option that fits, and it means each memory file is stored twice: in
   our R2 bucket and in AI Search's storage. R2 stays the source of truth.
3. **Chunk results, not file results.** `search()` returns chunks. We would
   have to group them by `item.key` and decide how to score a file (best
   chunk, or a sum). Existing callers (`search`, `search_conversations`,
   reflection's `search_memory` tool, overlap detection) all expect
   `{ id: path, score }`.
4. **Scores change meaning.** Cosine scores and hybrid/RRF scores are not
   comparable. Any thresholds tuned against cosine, including the overlap and
   Jev classification paths, need re-tuning.
5. **Recency changes shape.** Our decay is multiplicative and keeps a 30%
   floor. `boost_by` is additive and only re-orders the top 50 candidates.
   Close, but not the same.
6. **Deletes are by item ID.** `items.delete()` takes the AI Search item ID,
   not the path. We would need a `path -> item_id` column in the DO, or a
   lookup through `items.list()`.
7. **Overlap detection is file-vs-file.** Today we embed the new file and
   compare vectors. With AI Search we would send the file text (or its start)
   as the query. Hybrid search might actually do better here, but it needs
   measuring.
8. **Cost and self-hosting story.** The README promises $0–5 a month on the
   user's own account. Pricing is now published and fits that promise. See
   the cost section below.
9. **Local dev and tests.** The binding needs `remote: true` for
   `wrangler dev`. Unit tests would need a mock in `test/mocks`.

## Cost (updated 2026-10-15)

AI Search went GA on 2026-10-01. Billing starts 2026-11-01
([limits & pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/)).

Included per account, per month: 5M ingestion tokens, 10 GB-month storage,
1,000 semantic queries, 1,000 full-text queries. Above that:

| Usage | Price |
| --- | --- |
| Ingestion | $0.75 per million tokens (counted on final chunks, overlap included) |
| Storage | $2.00 per GB-month |
| Semantic, vector, hybrid queries | $0.75 per 1,000 |
| Full-text queries | $0.10 per 1,000 |

Embedding and reranking on Workers AI are included. They no longer show up
on the Workers AI bill. Generation and query rewriting are still billed
separately.

Real usage on the reference deployment (`agent-memory-mcp`,
2026-09-15 to 2026-10-15):

- **Corpus:** 528 files, about 4.9 MB. About 1.2M tokens, maybe 1.5M with
  chunk overlap. The backfill fits inside one month's included ingestion.
- **`MemoryIndex` DO requests:** 2,752 a month, across both scopes. Each
  search, update, and delete is one request. This is the ceiling on what
  AI Search would see.
- **Worst case, all writes:** 2,752 updates × about 2.3k tokens each
  ≈ 6.3M tokens. Add the backfill and that's about 2.8M tokens over the
  included amount, so about $2.
- **Worst case, all searches:** 2,752 hybrid queries, 1,752 over the
  included amount, so about $1.30.
- **Storage:** a few MB. Free.

So the real bill lands somewhere between $0 and about $3.50 a month.
The $0–5 promise holds. Each write sends the whole file again, so write
volume, not query volume, is the number to watch. The included usage is
per account, so two deployments on one account (for example
`agent-memory-mcp` and `agent-memory-mcp-duvland`) share it.

Pricing is no longer a blocker. The other points in the section above
still apply: tag arrays still can't be filtered, and `$in` still matches
only scalar values.

## Spike results (2026-10-15)

The harness is in [`spike/ai-search/`](../../spike/ai-search/). The query set
and raw results name people and tickets, so they are kept out of this repo.

### Setup

- One AI Search instance with built-in storage, `@cf/baai/bge-m3` (the same
  model as today), default chunking (256 tokens, 10 overlap), hybrid with RRF.
  Two custom metadata fields: `path` and `mtime`.
- Corpus: everything the memory-scope index would hold. That's the R2 bucket
  minus `conversations/`, `_history/`, and the `indexable.ts` denylist:
  **242 files, 3.0 MB**. The cost section above counted 528 files and 4.9 MB.
  That was the whole bucket, so the real cost is lower than estimated.
- 236 files uploaded. 6 were held back by the credential gate. 2 were flagged,
  and for 4 the gate returned no answer. The spike fails closed, production
  fails open. The upload made 4,338 chunks and took about 5 minutes to index.
- **42 queries.** 30 are real queries taken from agent session history. 12 are
  written by hand. 10 of them depend on exact terms (ticket keys, hostnames,
  tool names). 6 have their answer more than 20,000 characters into a large
  hub file. Each query has a set of files that count as a correct answer.
- Baseline: the live index, called through the MCP `search` tool with
  `limit: 10`.
- "No-go path" baselines run offline with the same bge-m3 call
  (`spike/ai-search/offline.py`).

### Recall

A query is a hit at k when any correct file is in the top k.

| System | R@1 | R@5 | MRR@10 |
| --- | --- | --- | --- |
| **HNSW, live (today)** | 0.41 | **0.55** | 0.46 |
| Exact cosine, whole file (what HNSW should return) | 0.57 | 0.69 | 0.63 |
| Exact cosine, 1,500-char chunks, best chunk per file | 0.81 | 0.95 | 0.86 |
| BM25 over files (an FTS5 stand-in) | 0.86 | 0.95 | 0.91 |
| **Chunks + BM25, fused with RRF** | 0.88 | **0.95** | **0.91** |
| AI Search `vector` | 0.79 | 0.98 | 0.86 |
| AI Search `hybrid` (keyword AND, the default) | 0.76 | 0.95 | 0.84 |
| **AI Search `hybrid`, keyword OR** | 0.86 | **0.95** | **0.91** |
| AI Search `hybrid` + `bge-reranker-base` | 0.79 | 0.95 | 0.86 |
| AI Search `hybrid` OR + reranker | 0.79 | 0.95 | 0.86 |

By query type (R@5):

| Slice | HNSW | Chunks + BM25 | AI Search hybrid OR |
| --- | --- | --- | --- |
| Exact terms (n=10) | 0.40 | 1.00 | 1.00 |
| Answer deep in a long file (n=6) | 0.17 | 1.00 | 1.00 |
| Real queries (n=30) | 0.50 | 0.97 | 0.97 |

What this tells us:

1. **The current index has a graph bug.** An exact scan over the same vectors
   gets R@5 0.69. The HNSW graph gets 0.55. On three of the misses, a
   tag-filtered search (which does an exact scan) scored the right file at
   0.69 to 0.73. The unfiltered HNSW search never returned it, and its top hit
   scored about 0.50. So the graph is not finding nearest neighbours that are
   there. The live index also returned at least one path that is no longer in
   R2, so stale vectors are not being pruned.
2. **Chunking is the biggest win.** It moves R@5 from 0.69 to 0.95 with the
   same model. Every long-file query is found once files are chunked.
3. **Keyword search fixes exact terms.** It adds about 5 MRR points over
   chunks alone.
4. **AI Search doesn't beat a local chunk + BM25 index.** Its best mode
   (hybrid with keyword OR) ties chunks + BM25 on R@5 and MRR. The default
   keyword AND mode is slightly worse. The reranker made R@1 worse and added
   about 800 ms.

Caveats. One person labelled the answer sets, partly by searching the corpus
for the key terms. That favours keyword methods, so BM25 probably looks better
than it would on vaguer queries. 42 queries is small: each query is worth
about 2.4 points. The one vague query ("how should I prepare a 1-1") failed
on every system.

### Write latency

Today a write is searchable in about 1 to 3 seconds.

| Measure (2 KB to 40 KB files) | Result |
| --- | --- |
| `uploadAndPoll`, 120 s timeout | 5 of 6 timed out with the item still `running`. 1 finished at 103 s. |
| `upload()`, then search until the file is returned by keyword | 23 to 26 s (5 runs) |
| `upload()`, then search until the file is returned by vector | 136 to 162 s (5 runs) |

The item status often still says `running` after the file is already
searchable, so `uploadAndPoll` is not a good readiness signal either. Overlap
detection on write cannot wait 2 minutes. We would have to make it
asynchronous, or do it in the DO, and either way the `write` tool response
changes. This alone is a no-go.

### `$in` filter (the tag workaround)

- Built-in `filename` is the **base name**, not the full key. Four base names
  already appear twice in the corpus (`about-me.md`, `2026-08.md`,
  `README.md`, and one research file). So we'd need our own `path` field,
  which uses one of the 5 custom slots.
- A filter value longer than 64 bytes is **rejected** (`String must contain at
  most 64 UTF-8 byte(s)`), not cut short. 28 of 236 paths are longer than
  that. Sending the first 64 bytes works. We'd then filter on the full path
  ourselves, because two paths can share the same first 64 bytes.
- Size limits. Keyword search allows **at most 40 values**, and says so in its
  error. Vector search fails somewhere between 70 and 80 short values, which
  looks like a byte limit of about 2 KB on the filter. With real paths that's
  about 40 values too. With 41 to 70 values in hybrid mode, the keyword half
  fails **silently** and you get vector-only results. 200 and 2,000 values
  fail outright.
- Today's largest tag has 17 files, and tag-filtered queries on four tags
  (6 to 17 files) returned only files from the tag. So it works for now, but
  any tag over about 40 files would have to be split into several searches
  and merged.

### Decision

**No-go.** The go criteria were: hybrid beats HNSW on recall clearly, *and*
write latency is acceptable. The first holds against today's HNSW, but not
against a fixed local index. The second fails. The tag workaround holds only
until a tag passes about 40 files.

Do this instead, in order:

1. **Replace HNSW with an exact scan.** At about 240 files and 2,300 chunks,
   a full cosine scan is about 2.4M multiply-adds per query, which takes
   milliseconds. This fixes the graph bug and removes `hnsw.ts`.
2. **Chunk files** (about 1,500 characters with 10% overlap). Store one vector
   per chunk and score each file by its best chunk. Drop `MAX_EMBED_CHARS`.
3. **Add an FTS5 table over chunks** and fuse it with vector results using RRF
   (k = 60). Keep the current `{ id: path, score }` return shape.
4. **Re-tune the overlap threshold** (0.72 today) against chunk scores.
5. **Prune vectors whose path is no longer in R2.**

Look at AI Search again if vector visibility after a write drops below about
5 seconds, or if the `$in` limits go up.

## Suggested shape if we go ahead

- Keep `MemoryIndex` as the owner of tags, wikilinks, and the
  `path -> item_id` map. Remove only the vectors and HNSW from it.
- Two AI Search instances to match today's split: `agent-memory` and
  `agent-memory-conversations`. Keeping them separate still stops one scope
  from crowding out the other.
- Add a `SEARCH_BACKEND` var (`hnsw` | `ai-search`). Put both backends behind
  the existing `MemoryIndexRpc.search` / `update` / `delete` interface so
  call sites don't change.
- Backfill with a one-off script that walks R2 and calls `items.upload`.
- Keep the credential-skip and denylist rules (`indexable.ts`) in front of
  uploads, exactly as today.

## Spike plan (about 1–2 days)

1. Create one AI Search instance with built-in storage on a test account.
   Upload a copy of the real `memory/` tree.
2. Write 30–50 real queries with expected files. Include exact-term queries
   (ticket keys, names), long-file queries (content past 20k characters), and
   tag-filtered queries.
3. Compare recall@5 and MRR for: current HNSW, AI Search `vector`, AI Search
   `hybrid`, and `hybrid` + reranking.
4. Measure `uploadAndPoll` latency for a typical memory write. That decides
   whether overlap detection on write is still workable.
5. Test `filename: { $in: [...] }` with 50, 200, and 2,000 paths.

**Go** if hybrid beats HNSW on recall clearly, and the write latency is
acceptable. **No-go** if either of those fails, or if the tag-filter
workaround doesn't hold up. If it's a no-go, the cheaper fixes are still
worth doing: chunk long files, and add a SQLite FTS5 keyword path next to the
HNSW graph.

## Open questions

These were asked before the spike. The no-go means they don't need an answer
now.

- Is storing every memory twice (R2 + AI Search storage) acceptable for a
  personal memory store, or should we wait for faster R2 data-source sync?
- Do we want AI Search's `chatCompletions()` at all, or only `search()`?
- Should the AI Search backend be the default for new deployments, or opt-in?
