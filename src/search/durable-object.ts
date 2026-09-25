import { DurableObject } from "cloudflare:workers";
import { backlinkTargetVariants } from "../wikilinks";
import { EMBEDDING_DIMENSIONS, generateEmbedding } from "./embeddings";
import { HNSWIndex, cosineSimilarity } from "./hnsw";
import { indexSkipReason } from "./indexable";

interface DOEnv {
	AI: Ai;
}

/**
 * Largest tag-filtered candidate set scored by exact scan.
 *
 * Beyond this the scan would deserialise most of the index on every query, so
 * broad tags fall back to approximate search with an over-fetch. Tags in
 * practice select tens of files, well under the threshold.
 */
const EXACT_SCAN_MAX_CANDIDATES = 2000;

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
	}): Promise<Array<{ id: string; score: number }>>;
	delete(path: string): Promise<{ success: true }>;
	prune(args?: { dryRun?: boolean }): Promise<PruneResult>;
	stats(): Promise<{ indexed_files: number; index_size: number }>;
	tags(): Promise<{ tags: Array<{ tag: string; count: number }> }>;
	filesWithTags(tags: string[]): Promise<{ paths: string[] }>;
	backlinks(target: string): Promise<{ backlinks: string[] }>;
}

/**
 * Durable Object for managing the memory search index.
 *
 * Exposes RPC methods (preferred) and a legacy fetch() handler that mirrors
 * the RPC surface over HTTP-shaped Requests. Both entry points share the same
 * underlying SQLite tables and HNSW index.
 */
export class MemoryIndex extends DurableObject<DOEnv> implements MemoryIndexRpc {
	private hnsw: HNSWIndex | null = null;
	private initialized = false;

	// ---- initialization --------------------------------------------------

	private async ensureReady(): Promise<HNSWIndex> {
		if (this.initialized && this.hnsw) return this.hnsw;

		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS memories (
				path TEXT PRIMARY KEY,
				embedding BLOB NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);

		// Tag index. Populated lazily by `write` via `update`.
		// (path, tag) is the primary key so the same tag on the same file
		// is idempotent across repeated writes.
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS file_tags (
				path TEXT NOT NULL,
				tag TEXT NOT NULL,
				PRIMARY KEY (path, tag)
			)
		`);
		this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag)");

		// Outgoing wikilink index. `source` is the file that contains the
		// link; `target` is the raw link text from inside [[...]]. Indexed on
		// `target` so backlink queries are a single lookup.
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS file_links (
				source TEXT NOT NULL,
				target TEXT NOT NULL,
				PRIMARY KEY (source, target)
			)
		`);
		this.ctx.storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS idx_file_links_target ON file_links(target)",
		);

		const hnsw = new HNSWIndex(EMBEDDING_DIMENSIONS);
		const cursor = this.ctx.storage.sql.exec("SELECT path, embedding, updated_at FROM memories");
		for (const row of cursor) {
			try {
				const raw = row.embedding as ArrayBuffer | Uint8Array;
				const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
				const embedding = JSON.parse(new TextDecoder().decode(bytes));
				hnsw.insert(row.path as string, embedding);
			} catch (e) {
				console.error(`Failed to load embedding for ${row.path}:`, e);
			}
		}

		this.hnsw = hnsw;
		this.initialized = true;
		return hnsw;
	}

	// ---- RPC methods (preferred) ----------------------------------------

	async update(args: {
		path: string;
		content: string;
		tags?: string[];
		links?: string[];
	}): Promise<{ success: true }> {
		const hnsw = await this.ensureReady();
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

		const { vector } = await generateEmbedding(this.env.AI, content);

		const embeddingBlob = new TextEncoder().encode(JSON.stringify(vector));
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO memories (path, embedding, updated_at) VALUES (?, ?, ?)",
			path,
			embeddingBlob,
			Date.now(),
		);

		if (hnsw.size() > 0) hnsw.delete(path);
		hnsw.insert(path, vector);

		return { success: true };
	}

	async search(args: {
		query: string;
		limit?: number;
		timeWeight?: boolean;
		tags?: string[];
	}): Promise<Array<{ id: string; score: number }>> {
		const hnsw = await this.ensureReady();
		const { query, limit = 5, timeWeight = true, tags } = args;

		const { vector } = await generateEmbedding(this.env.AI, query);

		// Tag filters are resolved before scoring, not after.
		//
		// Post-filtering HNSW output meant asking the graph for `limit * 10`
		// candidates and discarding untagged ones, so a tagged file that
		// didn't crack the global top-N was invisible however well it matched.
		// In practice `search("lessons learned", tags: ["core"])` missed
		// learnings.md entirely and returned a single result for other
		// queries. Scoring the tagged set directly is exact, and for the set
		// sizes tags produce it is also cheaper than an over-fetch.
		const tagFilter = tags && tags.length > 0 ? this.resolveTagIntersection(tags) : null;

		if (tagFilter) {
			// Guard against a tag so broad that an exact scan would mean
			// deserialising most of the index. Above the threshold, fall back
			// to the approximate path with a generous over-fetch.
			if (tagFilter.size <= EXACT_SCAN_MAX_CANDIDATES) {
				const scored = this.exactScan(vector, tagFilter);
				return this.rankResults(scored, limit, timeWeight);
			}
			const overshoot = hnsw.search(vector, limit * 10);
			return this.rankResults(
				overshoot.filter((r) => tagFilter.has(r.id)),
				limit,
				timeWeight,
			);
		}

		const rawResults = hnsw.search(vector, timeWeight ? limit * 3 : limit);
		return this.rankResults(rawResults, limit, timeWeight);
	}

	/**
	 * Score `query` against a specific set of paths, exactly.
	 *
	 * Reads each candidate's stored embedding and computes cosine similarity
	 * directly, bypassing the graph. Exact by construction, so no candidate
	 * can be missed because of where it sits in the HNSW topology.
	 */
	private exactScan(query: number[], allowed: Set<string>): Array<{ id: string; score: number }> {
		const scored: Array<{ id: string; score: number }> = [];
		const cursor = this.ctx.storage.sql.exec<{ path: string; embedding: ArrayBuffer | Uint8Array }>(
			"SELECT path, embedding FROM memories",
		);

		for (const row of cursor) {
			if (!allowed.has(row.path)) continue;
			try {
				const raw = row.embedding;
				const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
				const embedding = JSON.parse(new TextDecoder().decode(bytes)) as number[];
				scored.push({ id: row.path, score: cosineSimilarity(query, embedding) });
			} catch (e) {
				console.error(`Failed to score ${row.path} during exact scan:`, e);
			}
		}

		return scored;
	}

	/**
	 * Apply optional recency weighting and truncate to `limit`.
	 *
	 * Shared by the approximate and exact paths so both rank identically.
	 */
	private rankResults(
		results: Array<{ id: string; score: number }>,
		limit: number,
		timeWeight: boolean,
	): Array<{ id: string; score: number }> {
		if (!timeWeight) {
			return [...results].sort((a, b) => b.score - a.score).slice(0, limit);
		}

		// Exponential decay rerank: weight = 0.5^(age/halfLife) with a
		// 30-day half-life. 30% base score + 70% time-decayed so a
		// perfectly-matching stale file still beats a poor fresh one.
		const now = Date.now();
		const halfLifeMs = 30 * 24 * 60 * 60 * 1000;

		return results
			.map((r) => {
				const row = [
					...this.ctx.storage.sql.exec<{ updated_at: number }>(
						"SELECT updated_at FROM memories WHERE path = ?",
						r.id,
					),
				][0];
				const updatedAt = row?.updated_at ?? now;
				const ageMs = now - updatedAt;
				const timeDecay = 0.5 ** (ageMs / halfLifeMs);
				const adjustedScore = r.score * (0.3 + 0.7 * timeDecay);
				return { id: r.id, adjustedScore };
			})
			.sort((a, b) => b.adjustedScore - a.adjustedScore)
			.slice(0, limit)
			.map((r) => ({ id: r.id, score: r.adjustedScore }));
	}

	async delete(path: string): Promise<{ success: true }> {
		const hnsw = await this.ensureReady();
		this.ctx.storage.sql.exec("DELETE FROM memories WHERE path = ?", path);
		this.ctx.storage.sql.exec("DELETE FROM file_tags WHERE path = ?", path);
		this.ctx.storage.sql.exec("DELETE FROM file_links WHERE source = ?", path);
		hnsw.delete(path);
		return { success: true };
	}

	/**
	 * Drop vectors for paths that the current denylist excludes.
	 *
	 * Rules in `./indexable` only govern writes, so any file indexed before
	 * its rule existed keeps a stale vector indefinitely. This re-tests every
	 * indexed path and removes the ones that now fail. R2 is untouched: the
	 * files stay readable via `read` and `list`, they just stop competing for
	 * recall.
	 *
	 * The HNSW graph is rebuilt from the surviving rows rather than mutated
	 * in place. `HNSWIndex.delete` unlinks a node from its neighbours without
	 * re-linking them to each other, so removing a large fraction of nodes
	 * one-by-one leaves a sparsely-connected graph and can strand whole
	 * regions from the entry point — degrading recall for the files we kept.
	 * A rebuild is O(n log n) on a few hundred vectors and reuses the
	 * embeddings already in SQL, so it costs no Workers AI calls.
	 *
	 * Call with `dryRun` first on a live index; the counts are the only
	 * preview available.
	 */
	async prune(args: { dryRun?: boolean } = {}): Promise<PruneResult> {
		await this.ensureReady();
		const { dryRun = false } = args;

		const rows = [...this.ctx.storage.sql.exec<{ path: string }>("SELECT path FROM memories")];

		const matched: Array<{ path: string; reason: string }> = [];
		for (const row of rows) {
			const reason = indexSkipReason(row.path);
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

		for (const m of matched) {
			this.ctx.storage.sql.exec("DELETE FROM memories WHERE path = ?", m.path);
			this.ctx.storage.sql.exec("DELETE FROM file_tags WHERE path = ?", m.path);
			this.ctx.storage.sql.exec("DELETE FROM file_links WHERE source = ?", m.path);
		}

		// Force a cold rebuild from the surviving SQL rows.
		this.hnsw = null;
		this.initialized = false;
		const hnsw = await this.ensureReady();

		return {
			scanned: rows.length,
			pruned: matched.length,
			matched: matched.length,
			remaining: hnsw.size(),
			byReason,
			dryRun: false,
		};
	}

	async stats(): Promise<{ indexed_files: number; index_size: number }> {
		const hnsw = await this.ensureReady();
		const row = [
			...this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) as count FROM memories"),
		][0];
		return {
			indexed_files: row?.count ?? 0,
			index_size: hnsw.size(),
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
				const body = (await request.json().catch(() => ({}))) as { dryRun?: boolean };
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
