import { DurableObject } from "cloudflare:workers";
import { EMBEDDING_DIMENSIONS, generateEmbedding } from "./embeddings";
import { HNSWIndex } from "./hnsw";

interface DOEnv {
	AI: Ai;
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

		const { vector } = await generateEmbedding(this.env.AI, content);

		const embeddingBlob = new TextEncoder().encode(JSON.stringify(vector));
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO memories (path, embedding, updated_at) VALUES (?, ?, ?)",
			path,
			embeddingBlob,
			Date.now(),
		);

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

		// When a tag filter is requested, post-filter HNSW output. Pull
		// extra candidates up front so the final result set still has
		// `limit` entries after filtering — otherwise a restrictive tag set
		// would starve the response. The 10x multiplier is a pragmatic cap;
		// very selective filters may still return fewer than `limit`.
		const tagFilter = tags && tags.length > 0 ? this.resolveTagIntersection(tags) : null;
		const overshoot = tagFilter ? limit * 10 : timeWeight ? limit * 3 : limit;

		const rawAll = hnsw.search(vector, overshoot);
		const rawResults = tagFilter ? rawAll.filter((r) => tagFilter.has(r.id)) : rawAll;

		if (!timeWeight) {
			return rawResults.slice(0, limit);
		}

		// Exponential decay rerank: weight = 0.5^(age/halfLife) with a
		// 30-day half-life. 30% base score + 70% time-decayed so a
		// perfectly-matching stale file still beats a poor fresh one.
		const now = Date.now();
		const halfLifeMs = 30 * 24 * 60 * 60 * 1000;

		return rawResults
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
		const rows = [
			...this.ctx.storage.sql.exec<{ source: string }>(
				"SELECT source FROM file_links WHERE target = ? ORDER BY source ASC",
				target,
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
