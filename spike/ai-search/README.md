# AI Search spike harness

Throwaway code for the spike in
[`docs/proposals/ai-search-backend.md`](../../docs/proposals/ai-search-backend.md).
The results are in that document. This folder is only here so the numbers can
be reproduced.

Nothing here is part of the product build. `src/` does not import it.

## Pieces

| File | What it does |
| --- | --- |
| `worker.ts`, `wrangler.jsonc` | Spike Worker. Reads the memory bucket (list and get only), copies files into one AI Search instance, and serves the routes below. Every route needs `Authorization: Bearer $SPIKE_TOKEN`. |
| `run.mjs` | Recall harness. Runs each query against the live HNSW index (through the MCP `search` tool) and against AI Search in several retrieval modes. |
| `offline.py` | The "no-go" baselines. Embeds files with the same bge-m3 call as production, then scores exact cosine, chunked cosine, BM25, and chunked + BM25 (RRF) on your machine. |
| `queries.example.json` | The shape of the query file. |

The real query set names people and tickets, so it stays out of this repo.
Point `SPIKE_DATA` at a private folder with `queries.json` in it.

## Routes

| Route | Body | Purpose |
| --- | --- | --- |
| `/setup` | `{}` | Create the `agent-memory-spike` instance (bge-m3, custom fields `path` and `mtime`) |
| `/corpus` | `{ with_keys }` | List what the memory index would hold: drops `conversations/`, `_history/`, and the denylist |
| `/backfill` | `{ keys }` | Run the credential gate (fails closed), then `items.upload` with `path`/`mtime` metadata |
| `/search` | `{ query, mode, limit, filters }` | Search and group chunks into files (best chunk wins) |
| `/in-test` | `{ query, field, n, real }` | `$in` filter with `n` values (real paths padded with fake ones) |
| `/latency` | `{ size }` | `uploadAndPoll` timing |
| `/visible` | `{ size, timeout }` | `upload`, then poll search until the file comes back (keyword and vector timed separately) |
| `/embed` | `{ texts }` or `{ keys, chunk, overlap }` | bge-m3 vectors for `offline.py` |
| `/teardown` | `{}` | Delete the instance |

## Running it

AI Search write access needs `ai-search:write`. A scoped API token works, and
so does the OAuth login from `wrangler login`.

```sh
wrangler deploy --config spike/ai-search/wrangler.jsonc
wrangler secret put SPIKE_TOKEN --config spike/ai-search/wrangler.jsonc
# POST /setup, POST /corpus {"with_keys":true}, then POST /backfill in batches of about 25
# Wait until /info shows running: 0 (about 5 minutes for 236 files)

SPIKE_URL=... SPIKE_TOKEN=... MEMORY_URL=.../mcp MEMORY_TOKEN=... SPIKE_DATA=... \
  node spike/ai-search/run.mjs > "$SPIKE_DATA/results.json"
SPIKE_URL=... SPIKE_TOKEN=... SPIKE_DATA=... python3 spike/ai-search/offline.py

# Clean up
POST /teardown
wrangler delete --config spike/ai-search/wrangler.jsonc
```
