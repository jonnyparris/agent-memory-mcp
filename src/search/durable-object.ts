import { DurableObject } from "cloudflare:workers";
import { backlinkTargetVariants } from "../wikilinks";
import { chunkText } from "./chunking";
import { generateEmbedding, generateEmbeddings } from "./embeddings";
import { FTS_TOKENIZE, buildFtsQuery, reciprocalRankFusion } from "./fts";
import { indexSkipReason } from "./indexable";
import {
	blobToVector,
	coverage as chunkCoverage,
	dot,
	legacyBlobToVector,
	normalise,
	vectorToBlob,
} from "./vectors";

interface DOEnv {
	AI: Ai;
}

/**
 * How many files each retriever (vector, keyword) contributes to fusion.
 *
 * Matches the spike harness. Deeper lists change little: RRF weight at rank
 * 50 is already under half the weight at rank 1.
 */
const FUSION_CANDIDATES = 50;

/** Keyword hits are per chunk, so over-fetch rows to get enough distinct files. */
const FTS_ROW_LIMIT = 500;

/** Bumped when the table layout changes. Stored in the `meta` table. */
const SCHEMA_VERSION = 2;

/** Reason recorded by `prune` for paths the caller reports as gone from storage. */
export const MISSING_FROM_STORAGE = "missing from storage";

/**
 * Retrieval mode for `search`.
 *
 * - `hybrid` (default): best-chunk cosine and FTS5 BM25, fused with RRF.
 *   `score` is the normalised RRF score; `similarity` carries the cosine.
 * - `vector`: best-chunk cosine only. `score` is the cosine similarity, so
 *   thresholds tuned on cosine (overlap detection) stay meaningful.
 */
export type SearchMode = "hybrid" | "vector";

/** One search hit. `similarity` is the best chunk's cosine with the query. */
export interface IndexHit {
	id: string;
	score: number;
	similarity?: number;
	/**
	 * Index of the chunk that best matched, for building a snippet around the
	 * hit instead of the file opening. In hybrid mode this is the best
	 * keyword chunk when the file had a keyword hit (the literal terms are
	 * there to see), otherwise the best vector chunk. Multiply by
	 * `CHUNK_CHARS - CHUNK_OVERLAP` for its start offset in the file.
	 */
	chunk?: number;
}

/** One indexed file, as reported by `indexedPaths`. */
export interface IndexedPath {
	path: string;
	/**
	 * `true` for files still carrying a single whole-file vector migrated from
	 * the pre-chunking index. They are searchable by vector but have no
	 * keyword entry until `reindex` rewrites them.
	 */
	legacy: boolean;
}

/** Outcome of a `prune` run. */
export interface PruneResult {
	/** Indexed paths examined. */
	scanned: number;
	/** Vectors actually removed (always 0 when `dryRun`). */
	pruned: number;
	/** Vectors that matched the denylist, whether or not they were removed. */
	matched: number;
	/** Vectors left in the index after the run. */
	remaining: number;
	/** Match counts keyed by denylist reason. */
	byReason: Record<string, number>;
	dryRun: boolean;
}

/**
 * Shape of the primary DO interface consumed by the Worker.
 *
 * Prefer these RPC methods over `fetch()` in new code. The fetch handler is
 * kept only as a compatibility shim for older call sites and tests.
 */
export interface MemoryIndexRpc {
	update(args: { path: string; content: string; tags?: string[]; links?: string[] }): Promise<{
		success: true;
	}>;
	search(args: {
		query: string;
		limit?: number;
		timeWeight?: boolean;
		tags?: string[];
		mode?: SearchMode;
	}): Promise<IndexHit[]>;
	/**
	 * Chunk-vs-chunk coverage between `path` and each of `others` (see
	 * `coverage` in ./vectors). Paths with no vectors are left out.
	 */
	coverage(args: { path: string; others: string[] }): Promise<Record<string, number>>;
	delete(path: string): Promise<{ success: true }>;
	prune(args?: { dryRun?: boolean; missing?: string[] }): Promise<PruneResult>;
	indexedPaths(): Promise<{ paths: IndexedPath[] }>;
	stats(): Promise<IndexStats>;
	tags(): Promise<{ tags: Array<{ tag: string; count: number }> }>;
	filesWithTags(tags: string[]): Promise<{ paths: string[] }>;
	backlinks(target: string): Promise<{ backlinks: string[] }>;
}

export interface IndexStats {
	indexed_files: number;
	/** Files held in the in-memory vector cache. Equals `indexed_files` when healthy. */
	index_size: number;
	/** Chunk vectors across all files. */
	chunks: number;
	/** Files still on a migrated whole-file vector. See `IndexedPath.legacy`. */
	legacy_files: number;
}

/**
 * Durable Object for managing the memory search index.
 *
 * Search is an exact scan plus keyword search, fused:
 *
 * - **Vectors.** Each file is split into overlapping chunks (`./chunking`) and
 *   every chunk gets a bge-m3 vector. A query is scored against every chunk
 *   with a dot product, and a file scores as its best chunk. This replaced a
 *   hand-rolled HNSW graph that missed neighbours that were there: on the
 *   spike query set an exact scan over the same whole-file vectors got
 *   recall@5 0.69 against 0.55 from the graph. At a few thousand chunks a full
 *   scan is a few million multiply-adds, a few milliseconds.
 * - **Keywords.** The same chunks go into an FTS5 table, ranked with BM25.
 * - **Fusion.** The two ranked file lists are merged with Reciprocal Rank
 *   Fusion. On the spike set this scored recall@5 0.95 and MRR 0.93.
 *
 * Exposes RPC methods (preferred) and a legacy fetch() handler that mirrors
 * the RPC surface over HTTP-shaped Requests. Both entry points share the same
 * SQLite tables and vector cache.
 */
export class MemoryIndex extends DurableObject<DOEnv> implements MemoryIndexRpc {
	/** Unit-length chunk vectors per path, loaded from SQLite on first use. */
	private vectors: Map<string, Float32Array[]> | null = null;

	// ---- initialization --------------------------------------------------

	private async ensureReady(): Promise<Map<string, Float32Array[]>> {
		if (this.vectors) return this.vectors;
		const sql = this.ctx.storage.sql;

		// One row per indexed file. `legacy` marks files whose only vector was
		// migrated from the whole-file index (see `migrateFromV1`).
		sql.exec(`
			CREATE TABLE IF NOT EXISTS files (
				path TEXT PRIMARY KEY,
				updated_at INTEGER NOT NULL,
				legacy INTEGER NOT NULL DEFAULT 0
			)
		`);

		// One row per chunk. `embedding` is a unit-length float32 vector.
		// `text` is NULL only for migrated legacy vectors, whose source text
		// was never stored.
		sql.exec(`
			CREATE TABLE IF NOT EXISTS chunks (
				path TEXT NOT NULL,
				idx INTEGER NOT NULL,
				text TEXT,
				embedding BLOB NOT NULL,
				PRIMARY KEY (path, idx)
			)
		`);

		// Keyword index over chunk text. Standalone (it keeps its own copy of
		// the text) because the corpus is a few MB and an external-content
		// table would need triggers to stay in sync.
		sql.exec(`
			CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
				text,
				path UNINDEXED,
				idx UNINDEXED,
				tokenize = '${FTS_TOKENIZE}'
			)
		`);

		sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

		// Tag index. Populated lazily by `write` via `update`.
		// (path, tag) is the primary key so the same tag on the same file
		// is idempotent across repeated writes.
		sql.exec(`
			CREATE TABLE IF NOT EXISTS file_tags (
				path TEXT NOT NULL,
				tag TEXT NOT NULL,
				PRIMARY KEY (path, tag)
			)
		`);
		sql.exec("CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag)");

		// Outgoing wikilink index. `source` is the file that contains the
		// link; `target` is the raw link text from inside [[...]]. Indexed on
		// `target` so backlink queries are a single lookup.
		sql.exec(`
			CREATE TABLE IF NOT EXISTS file_links (
				source TEXT NOT NULL,
				target TEXT NOT NULL,
				PRIMARY KEY (source, target)
			)
		`);
		sql.exec("CREATE INDEX IF NOT EXISTS idx_file_links_target ON file_links(target)");

		const version = Number(
			[...sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")][0]
				?.value ?? 0,
		);
		if (version < SCHEMA_VERSION) {
			this.ctx.storage.transactionSync(() => {
				this.migrateFromV1();
				sql.exec(
					"INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
					String(SCHEMA_VERSION),
				);
			});
		}

		const vectors = new Map<string, Float32Array[]>();
		const cursor = sql.exec<{ path: string; embedding: ArrayBuffer }>(
			"SELECT path, embedding FROM chunks ORDER BY path, idx",
		);
		for (const row of cursor) {
			const list = vectors.get(row.path);
			const v = blobToVector(row.embedding);
			if (list) list.push(v);
			else vectors.set(row.path, [v]);
		}

		this.vectors = vectors;
		return vectors;
	}

	/**
	 * Carry vectors over from the pre-chunking `memories` table.
	 *
	 * Each old whole-file vector becomes chunk 0 of a `legacy` file, so search
	 * keeps working straight after deploy, before anything is re-embedded.
	 * Legacy files have no keyword entry (the old table never stored text);
	 * `reindex` re-embeds them from storage.
	 *
	 * The `memories` table is left in place, not dropped, so rolling the
	 * deploy back finds the old index intact. It is no longer read or written.
	 */
	private migrateFromV1(): void {
		const sql = this.ctx.storage.sql;
		const hasOld = [
			...sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'"),
		].length;
		if (!hasOld) return;
		const rows = sql.exec<{ path: string; embedding: ArrayBuffer; updated_at: number }>(
			"SELECT path, embedding, updated_at FROM memories",
		);
		for (const row of rows) {
			let vector: Float32Array;
			try {
				vector = legacyBlobToVector(row.embedding);
			} catch (e) {
				console.error(`Skipping unreadable legacy vector for ${row.path}:`, e);
				continue;
			}
			sql.exec(
				"INSERT OR IGNORE INTO files (path, updated_at, legacy) VALUES (?, ?, 1)",
				row.path,
				row.updated_at,
			);
			sql.exec(
				"INSERT OR IGNORE INTO chunks (path, idx, text, embedding) VALUES (?, 0, NULL, ?)",
				row.path,
				vectorToBlob(vector),
			);
		}
	}

	/** Remove every trace of `path` from the vector and keyword tables. */
	private dropVectors(path: string): void {
		const sql = this.ctx.storage.sql;
		sql.exec("DELETE FROM files WHERE path = ?", path);
		sql.exec("DELETE FROM chunks WHERE path = ?", path);
		sql.exec("DELETE FROM chunks_fts WHERE path = ?", path);
		this.vectors?.delete(path);
	}

	// ---- RPC methods (preferred) ----------------------------------------

	async update(args: {
		path: string;
		content: string;
		tags?: string[];
		links?: string[];
	}): Promise<{ success: true }> {
		const vectors = await this.ensureReady();
		const { path, content, tags, links } = args;

		// Tags and links are committed before the embedding call, which is the
		// only step here that can realistically fail (model length limits,
		// Workers AI availability). Embedding first meant a rejected file lost
		// its tags and wikilinks too, so `brag-sheet.md` reported the tags it
		// had parsed while none of them reached the index. Persisting metadata
		// first degrades gracefully: the file stays tag-filterable and its
		// backlinks stay intact even when it has no usable vector.
		//
		// Tags are authoritative from the caller (the write tool parses
		// frontmatter), so delete-then-insert within a single update keeps
		// the stored set in sync without read-modify-write hazards.
		if (tags !== undefined) {
			this.ctx.storage.sql.exec("DELETE FROM file_tags WHERE path = ?", path);
			for (const tag of tags) {
				if (!tag) continue;
				this.ctx.storage.sql.exec(
					"INSERT OR IGNORE INTO file_tags (path, tag) VALUES (?, ?)",
					path,
					tag,
				);
			}
		}

		// Same story for outgoing wikilinks: the write tool is authoritative,
		// so wipe and reinsert on every write so stale links don't linger.
		if (links !== undefined) {
			this.ctx.storage.sql.exec("DELETE FROM file_links WHERE source = ?", path);
			for (const target of links) {
				if (!target) continue;
				this.ctx.storage.sql.exec(
					"INSERT OR IGNORE INTO file_links (source, target) VALUES (?, ?)",
					path,
					target,
				);
			}
		}

		// Embed every chunk before touching the stored ones. If Workers AI
		// fails part-way, the file keeps its previous vectors rather than
		// ending up half-indexed.
		const pieces = chunkText(content);
		const embedded = await generateEmbeddings(this.env.AI, pieces);
		const unit = embedded.map((e) => normalise(e.vector));

		this.ctx.storage.transactionSync(() => {
			this.dropVectors(path);
			const sql = this.ctx.storage.sql;
			sql.exec("INSERT INTO files (path, updated_at, legacy) VALUES (?, ?, 0)", path, Date.now());
			pieces.forEach((text, idx) => {
				sql.exec(
					"INSERT INTO chunks (path, idx, text, embedding) VALUES (?, ?, ?, ?)",
					path,
					idx,
					text,
					vectorToBlob(unit[idx]),
				);
				sql.exec("INSERT INTO chunks_fts (text, path, idx) VALUES (?, ?, ?)", text, path, idx);
			});
		});
		if (unit.length > 0) vectors.set(path, unit);

		return { success: true };
	}

	async search(args: {
		query: string;
		limit?: number;
		timeWeight?: boolean;
		tags?: string[];
		mode?: SearchMode;
	}): Promise<IndexHit[]> {
		const vectors = await this.ensureReady();
		const { query, limit = 5, timeWeight = true, tags, mode = "hybrid" } = args;

		const { vector } = await generateEmbedding(this.env.AI, query);
		const q = normalise(vector);

		// Tag filters are resolved before scoring, not after, so a tagged file
		// that would rank outside the global top-N is still found.
		const allowed = tags && tags.length > 0 ? this.resolveTagIntersection(tags) : null;

		// Array position equals the stored chunk `idx`: `ensureReady` loads
		// rows ORDER BY idx and `update` writes idx 0..n-1 with no gaps.
		const similarity = new Map<string, number>();
		const vectorChunk = new Map<string, number>();
		for (const [path, chunks] of vectors) {
			if (allowed && !allowed.has(path)) continue;
			let best = Number.NEGATIVE_INFINITY;
			let bestIdx = 0;
			chunks.forEach((c, i) => {
				const s = dot(q, c);
				if (s > best) {
					best = s;
					bestIdx = i;
				}
			});
			similarity.set(path, best);
			vectorChunk.set(path, bestIdx);
		}
		const byVector = [...similarity.entries()].sort((a, b) => b[1] - a[1]);

		if (mode === "vector") {
			return this.rankResults(
				byVector.map(([id, score]) => ({
					id,
					score,
					similarity: score,
					chunk: vectorChunk.get(id),
				})),
				limit,
				timeWeight,
			);
		}

		const vectorList = byVector.slice(0, FUSION_CANDIDATES).map(([id]) => id);
		const keywordChunk = this.keywordSearch(query, allowed);
		const fused = reciprocalRankFusion([vectorList, [...keywordChunk.keys()]]).map((r) => ({
			...r,
			similarity: similarity.get(r.id),
			chunk: keywordChunk.get(r.id) ?? vectorChunk.get(r.id),
		}));
		return this.rankResults(fused, limit, timeWeight);
	}

	async coverage(args: { path: string; others: string[] }): Promise<Record<string, number>> {
		const vectors = await this.ensureReady();
		const mine = vectors.get(args.path);
		const out: Record<string, number> = {};
		if (!mine) return out;
		for (const other of args.others) {
			const theirs = vectors.get(other);
			if (theirs) out[other] = chunkCoverage(mine, theirs);
		}
		return out;
	}

	/**
	 * Rank files by BM25 over their chunks, best chunk per file.
	 *
	 * Returns at most `FUSION_CANDIDATES` paths, in rank order (Map insertion
	 * order), each mapped to the index of its best-ranked chunk. A malformed MATCH expression
	 * is logged and treated as no keyword hits, so the vector half still
	 * answers. `buildFtsQuery` quotes every term, so this should not happen.
	 */
	private keywordSearch(query: string, allowed: Set<string> | null): Map<string, number> {
		const out = new Map<string, number>();
		const match = buildFtsQuery(query);
		if (!match) return out;
		try {
			const rows = this.ctx.storage.sql.exec<{ path: string; idx: number }>(
				"SELECT path, idx FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?",
				match,
				FTS_ROW_LIMIT,
			);
			for (const row of rows) {
				if (out.has(row.path) || (allowed && !allowed.has(row.path))) continue;
				out.set(row.path, Number(row.idx));
				if (out.size >= FUSION_CANDIDATES) break;
			}
		} catch (e) {
			console.error(`Keyword search failed for ${JSON.stringify(match)}:`, e);
		}
		return out;
	}

	/**
	 * Apply optional recency weighting and truncate to `limit`.
	 *
	 * Shared by the vector and hybrid paths so both rank identically.
	 *
	 * Only the top `limit * 3` candidates by relevance are re-weighted, as
	 * before. Weighting the whole list would let a fresh but weak match
	 * overtake strong old ones purely on age.
	 */
	private rankResults(results: IndexHit[], limit: number, timeWeight: boolean): IndexHit[] {
		const sorted = [...results].sort((a, b) => b.score - a.score);
		if (!timeWeight) return sorted.slice(0, limit);

		// Exponential decay rerank: weight = 0.5^(age/halfLife) with a
		// 30-day half-life. 30% base score + 70% time-decayed so a
		// perfectly-matching stale file still beats a poor fresh one.
		const now = Date.now();
		const halfLifeMs = 30 * 24 * 60 * 60 * 1000;
		const candidates = sorted.slice(0, limit * 3);
		if (candidates.length === 0) return [];

		// One lookup per candidate. A single `IN (...)` would be tidier, but DO
		// SQLite caps bound parameters at 100 and `limit * 3` can exceed it.
		const updatedAt = new Map<string, number>();
		for (const c of candidates) {
			const row = [
				...this.ctx.storage.sql.exec<{ updated_at: number }>(
					"SELECT updated_at FROM files WHERE path = ?",
					c.id,
				),
			][0];
			if (row) updatedAt.set(c.id, row.updated_at);
		}

		return candidates
			.map((r) => {
				const ageMs = now - (updatedAt.get(r.id) ?? now);
				const timeDecay = 0.5 ** (ageMs / halfLifeMs);
				return { ...r, score: r.score * (0.3 + 0.7 * timeDecay) };
			})
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}

	async delete(path: string): Promise<{ success: true }> {
		await this.ensureReady();
		this.ctx.storage.transactionSync(() => {
			this.dropVectors(path);
			this.ctx.storage.sql.exec("DELETE FROM file_tags WHERE path = ?", path);
			this.ctx.storage.sql.exec("DELETE FROM file_links WHERE source = ?", path);
		});
		return { success: true };
	}

	/**
	 * Drop vectors for paths the denylist excludes or that storage no longer has.
	 *
	 * Rules in `./indexable` only govern writes, so any file indexed before
	 * its rule existed keeps a stale vector indefinitely. This re-tests every
	 * indexed path and removes the ones that now fail. R2 is untouched: the
	 * files stay readable via `read` and `list`, they just stop competing for
	 * recall.
	 *
	 * The DO cannot tell on its own whether a path still exists: the
	 * conversations instance indexes virtual paths that were never R2 keys.
	 * So the caller lists storage and passes the paths it found missing in
	 * `missing`; they are removed under the reason `MISSING_FROM_STORAGE`.
	 * Paths in `missing` that are not indexed are ignored.
	 *
	 * Call with `dryRun` first on a live index; the counts are the only
	 * preview available.
	 */
	async prune(args: { dryRun?: boolean; missing?: string[] } = {}): Promise<PruneResult> {
		await this.ensureReady();
		const { dryRun = false } = args;
		const missing = new Set(args.missing ?? []);

		const rows = [...this.ctx.storage.sql.exec<{ path: string }>("SELECT path FROM files")];

		const matched: Array<{ path: string; reason: string }> = [];
		for (const row of rows) {
			const reason =
				indexSkipReason(row.path) ?? (missing.has(row.path) ? MISSING_FROM_STORAGE : null);
			if (reason) matched.push({ path: row.path, reason });
		}

		const byReason: Record<string, number> = {};
		for (const m of matched) {
			byReason[m.reason] = (byReason[m.reason] ?? 0) + 1;
		}

		if (dryRun) {
			return {
				scanned: rows.length,
				pruned: 0,
				matched: matched.length,
				remaining: rows.length,
				byReason,
				dryRun: true,
			};
		}

		this.ctx.storage.transactionSync(() => {
			for (const m of matched) {
				this.dropVectors(m.path);
				this.ctx.storage.sql.exec("DELETE FROM file_tags WHERE path = ?", m.path);
				this.ctx.storage.sql.exec("DELETE FROM file_links WHERE source = ?", m.path);
			}
		});

		return {
			scanned: rows.length,
			pruned: matched.length,
			matched: matched.length,
			remaining: rows.length - matched.length,
			byReason,
			dryRun: false,
		};
	}

	async indexedPaths(): Promise<{ paths: IndexedPath[] }> {
		await this.ensureReady();
		const rows = this.ctx.storage.sql.exec<{ path: string; legacy: number }>(
			"SELECT path, legacy FROM files ORDER BY path",
		);
		return { paths: [...rows].map((r) => ({ path: r.path, legacy: r.legacy === 1 })) };
	}

	async stats(): Promise<IndexStats> {
		const vectors = await this.ensureReady();
		const one = (q: string) => [...this.ctx.storage.sql.exec<{ count: number }>(q)][0]?.count ?? 0;
		return {
			indexed_files: one("SELECT COUNT(*) AS count FROM files"),
			index_size: vectors.size,
			chunks: one("SELECT COUNT(*) AS count FROM chunks"),
			legacy_files: one("SELECT COUNT(*) AS count FROM files WHERE legacy = 1"),
		};
	}

	async tags(): Promise<{ tags: Array<{ tag: string; count: number }> }> {
		await this.ensureReady();
		const rows = [
			...this.ctx.storage.sql.exec<{ tag: string; count: number }>(
				"SELECT tag, COUNT(*) as count FROM file_tags GROUP BY tag ORDER BY count DESC, tag ASC",
			),
		];
		return { tags: rows };
	}

	async filesWithTags(tags: string[]): Promise<{ paths: string[] }> {
		await this.ensureReady();
		if (!Array.isArray(tags) || tags.length === 0) {
			return { paths: [] };
		}
		return { paths: [...this.resolveTagIntersection(tags)].sort() };
	}

	async backlinks(target: string): Promise<{ backlinks: string[] }> {
		await this.ensureReady();
		const variants = backlinkTargetVariants(target);
		if (variants.length === 0) return { backlinks: [] };
		const placeholders = variants.map(() => "?").join(", ");
		const rows = [
			...this.ctx.storage.sql.exec<{ source: string }>(
				`SELECT DISTINCT source FROM file_links WHERE target IN (${placeholders}) ORDER BY source ASC`,
				...variants,
			),
		];
		return { backlinks: rows.map((r) => r.source) };
	}

	// ---- legacy fetch handler (compat shim) -----------------------------

	async fetch(request: Request): Promise<Response> {
		try {
			await this.ensureReady();
		} catch (e) {
			return jsonResponse({ error: "Failed to initialize", details: String(e) }, 500);
		}

		const url = new URL(request.url);

		try {
			if (url.pathname === "/update" && request.method === "POST") {
				const body = (await request.json()) as Parameters<MemoryIndex["update"]>[0];
				return jsonResponse(await this.update(body));
			}
			if (url.pathname === "/search" && request.method === "POST") {
				const body = (await request.json()) as Parameters<MemoryIndex["search"]>[0];
				return jsonResponse(await this.search(body));
			}
			if (url.pathname === "/delete" && request.method === "POST") {
				const { path } = (await request.json()) as { path: string };
				return jsonResponse(await this.delete(path));
			}
			if (url.pathname === "/prune" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as {
					dryRun?: boolean;
					missing?: string[];
				};
				return jsonResponse(await this.prune(body));
			}
			if (url.pathname === "/stats") {
				return jsonResponse(await this.stats());
			}
			if (url.pathname === "/tags") {
				return jsonResponse(await this.tags());
			}
			if (url.pathname === "/files-with-tags" && request.method === "POST") {
				const { tags } = (await request.json()) as { tags: string[] };
				return jsonResponse(await this.filesWithTags(tags));
			}
			if (url.pathname === "/backlinks" && request.method === "GET") {
				const target = url.searchParams.get("target");
				if (!target) {
					return jsonResponse({ error: "target parameter required" }, 400);
				}
				return jsonResponse(await this.backlinks(target));
			}
		} catch (e) {
			return jsonResponse({ error: "Request failed", details: String(e) }, 500);
		}

		return new Response("Not Found", { status: 404 });
	}

	// ---- private helpers -------------------------------------------------

	/**
	 * Return the set of paths that have every requested tag (intersection).
	 *
	 * Tags are normalised to lowercase to match the storage representation
	 * written by the `write` tool. Empty tag lists are handled by callers.
	 */
	private resolveTagIntersection(tags: string[]): Set<string> {
		const normalised = tags.map((t) => t.toLowerCase());
		const placeholders = normalised.map(() => "?").join(",");
		const rows = [
			...this.ctx.storage.sql.exec<{ path: string }>(
				`SELECT path FROM file_tags
				 WHERE tag IN (${placeholders})
				 GROUP BY path
				 HAVING COUNT(DISTINCT tag) = ?`,
				...normalised,
				normalised.length,
			),
		];
		return new Set(rows.map((r) => r.path));
	}
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
