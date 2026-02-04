import { DurableObject } from "cloudflare:workers";
import { EMBEDDING_DIMENSIONS, generateEmbedding } from "./embeddings";
import { HNSWIndex } from "./hnsw";

interface DOEnv {
	AI: Ai;
}

/**
 * Durable Object for managing the memory search index
 */
export class MemoryIndex extends DurableObject<DOEnv> {
	private index: HNSWIndex | null = null;
	private initialized = false;

	/**
	 * Initialize index from SQLite storage
	 */
	private async initialize(): Promise<void> {
		if (this.initialized) return;

		// Create table if not exists
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS memories (
				path TEXT PRIMARY KEY,
				embedding BLOB NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);

		// Rebuild HNSW index from stored embeddings
		this.index = new HNSWIndex(EMBEDDING_DIMENSIONS);

		const cursor = this.ctx.storage.sql.exec("SELECT path, embedding, updated_at FROM memories");

		for (const row of cursor) {
			try {
				// SQLite BLOB comes back as ArrayBuffer
				const embeddingData = row.embedding as ArrayBuffer | Uint8Array;
				const bytes =
					embeddingData instanceof Uint8Array ? embeddingData : new Uint8Array(embeddingData);
				const embedding = JSON.parse(new TextDecoder().decode(bytes));
				this.index.insert(row.path as string, embedding);
			} catch (e) {
				console.error(`Failed to load embedding for ${row.path}:`, e);
			}
		}

		this.initialized = true;
	}

	async fetch(request: Request): Promise<Response> {
		try {
			await this.initialize();
		} catch (e) {
			return new Response(JSON.stringify({ error: "Failed to initialize", details: String(e) }), {
				status: 500,
				headers: { "Content-Type": "application/json" },
			});
		}

		const url = new URL(request.url);

		if (url.pathname === "/update" && request.method === "POST") {
			return this.handleUpdate(request);
		}

		if (url.pathname === "/search" && request.method === "POST") {
			return this.handleSearch(request);
		}

		if (url.pathname === "/delete" && request.method === "POST") {
			return this.handleDelete(request);
		}

		if (url.pathname === "/stats") {
			return this.handleStats();
		}

		return new Response("Not Found", { status: 404 });
	}

	private async handleUpdate(request: Request): Promise<Response> {
		try {
			const { path, content } = (await request.json()) as { path: string; content: string };

			// Generate embedding
			const { vector } = await generateEmbedding(this.env.AI, content);

			// Store in SQLite
			const embeddingBlob = new TextEncoder().encode(JSON.stringify(vector));
			this.ctx.storage.sql.exec(
				"INSERT OR REPLACE INTO memories (path, embedding, updated_at) VALUES (?, ?, ?)",
				path,
				embeddingBlob,
				Date.now(),
			);

			// Update HNSW index
			if (this.index!.size() > 0) {
				// Remove old entry if exists
				this.index!.delete(path);
			}
			this.index!.insert(path, vector);

			return new Response(JSON.stringify({ success: true }), {
				headers: { "Content-Type": "application/json" },
			});
		} catch (e) {
			return new Response(JSON.stringify({ error: "Failed to update", details: String(e) }), {
				status: 500,
				headers: { "Content-Type": "application/json" },
			});
		}
	}

	private async handleSearch(request: Request): Promise<Response> {
		try {
			const {
				query,
				limit = 5,
				timeWeight = true,
			} = (await request.json()) as {
				query: string;
				limit?: number;
				timeWeight?: boolean;
			};

			// Generate query embedding
			const { vector } = await generateEmbedding(this.env.AI, query);

			// Search HNSW index - get more results for time-weighted reranking
			const rawResults = this.index!.search(vector, timeWeight ? limit * 3 : limit);

			if (!timeWeight) {
				return new Response(JSON.stringify(rawResults), {
					headers: { "Content-Type": "application/json" },
				});
			}

			// Apply time-weighted scoring with exponential decay (30-day half-life)
			const now = Date.now();
			const halfLifeMs = 30 * 24 * 60 * 60 * 1000; // 30 days

			const rerankedResults = rawResults
				.map((r) => {
					// Get updated_at from SQLite
					const row = [
						...this.ctx.storage.sql.exec<{ updated_at: number }>(
							"SELECT updated_at FROM memories WHERE path = ?",
							r.id,
						),
					][0];
					const updatedAt = row?.updated_at ?? now;
					const ageMs = now - updatedAt;

					// Exponential decay: weight = 0.5^(age/halfLife)
					const timeDecay = 0.5 ** (ageMs / halfLifeMs);
					const adjustedScore = r.score * (0.3 + 0.7 * timeDecay); // 30% base + 70% time-weighted

					return {
						id: r.id,
						score: r.score,
						adjustedScore,
						updatedAt,
					};
				})
				.sort((a, b) => b.adjustedScore - a.adjustedScore)
				.slice(0, limit)
				.map((r) => ({ id: r.id, score: r.adjustedScore }));

			return new Response(JSON.stringify(rerankedResults), {
				headers: { "Content-Type": "application/json" },
			});
		} catch (e) {
			return new Response(JSON.stringify({ error: "Failed to search", details: String(e) }), {
				status: 500,
				headers: { "Content-Type": "application/json" },
			});
		}
	}

	private async handleDelete(request: Request): Promise<Response> {
		const { path } = (await request.json()) as { path: string };

		// Remove from SQLite
		this.ctx.storage.sql.exec("DELETE FROM memories WHERE path = ?", path);

		// Remove from HNSW index
		this.index!.delete(path);

		return new Response(JSON.stringify({ success: true }), {
			headers: { "Content-Type": "application/json" },
		});
	}

	private handleStats(): Response {
		const count = this.ctx.storage.sql.exec<{ count: number }>(
			"SELECT COUNT(*) as count FROM memories",
		);
		const result = [...count][0];

		return new Response(
			JSON.stringify({
				indexed_files: result?.count ?? 0,
				index_size: this.index?.size() ?? 0,
			}),
			{ headers: { "Content-Type": "application/json" } },
		);
	}
}
