# Proposal: use Cloudflare AI Search for the search index

Status: **proposal, for discussion.** Nothing in this PR changes runtime behaviour.

## Summary

Today, search runs on code we wrote ourselves: an HNSW graph inside the
`MemoryIndex` Durable Object, with bge-m3 vectors stored as JSON blobs in
SQLite. This document asks whether [Cloudflare AI Search](https://developers.cloudflare.com/ai-search/)
should replace the vector part of that stack, while tags and wikilinks stay in
the Durable Object.

My recommendation: run a time-boxed spike behind a flag. Measure recall on a
fixed set of queries. Decide after that. Do not do a big-bang migration.

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
- **Free during open beta**, within limits (Free plan: 100k files per instance,
  20k queries per month).

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
   user's own account. AI Search is free in beta, but pricing is "to be
   announced with 30 days' notice". The 20k queries a month on the Free plan
   also needs a check against real usage (search, overlap detection,
   reflection).
9. **Local dev and tests.** The binding needs `remote: true` for
   `wrangler dev`. Unit tests would need a mock in `test/mocks`.

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

- Is storing every memory twice (R2 + AI Search storage) acceptable for a
  personal memory store, or should we wait for faster R2 data-source sync?
- Do we want AI Search's `chatCompletions()` at all, or only `search()`?
- Should the AI Search backend be the default for new deployments, or opt-in?
