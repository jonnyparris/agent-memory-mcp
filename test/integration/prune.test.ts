import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { MemoryIndex } from "../../src/search/durable-object";
import { EMBEDDING_DIMENSIONS } from "../../src/search/embeddings";

/**
 * Index prune behaviour, exercised against the Durable Object directly.
 *
 * These cases need index state that the `write` tool can no longer produce:
 * a vector for a path the current denylist rejects. Reaching that state means
 * writing to the DO's SQL tables, so the tests run inside
 * `runInDurableObject` rather than driving the MCP surface.
 *
 * Rows are inserted directly instead of going through `update` because the
 * test pool deliberately leaves the `AI` binding unwired (see
 * vitest.config.ts) — `update` would fail generating an embedding before
 * reaching any of the logic under test.
 */
describe("index prune", () => {
	function indexStub() {
		const ns = env.MEMORY_INDEX;
		return ns.get(ns.idFromName("default"));
	}

	/** A dimensionally-valid embedding so the post-prune HNSW rebuild succeeds. */
	function stubEmbedding(seed: number): Uint8Array {
		const vector = new Array(EMBEDDING_DIMENSIONS).fill(seed);
		return new TextEncoder().encode(JSON.stringify(vector));
	}

	it("removes denylisted paths and keeps eligible ones", async () => {
		await runInDurableObject(
			indexStub(),
			async (instance: MemoryIndex, state: DurableObjectState) => {
				// Forces the CREATE TABLE statements in ensureReady to run.
				await instance.stats();

				const denied = [
					"memory/reflections/archive/2026-04-09.md",
					"memory/workload/backlog-groom/BRAPI/reports/BRAPI-826.json",
					"memory/workload/plans/archive/old-plan.md",
					"memory/_bench/many1.md",
				];
				const kept = ["memory/learnings.md", "memory/workload/plans/2026-07-25-proposals.md"];

				let seed = 0.01;
				for (const path of [...denied, ...kept]) {
					state.storage.sql.exec(
						"INSERT OR REPLACE INTO memories (path, embedding, updated_at) VALUES (?, ?, ?)",
						path,
						stubEmbedding(seed),
						Date.now(),
					);
					// Tags and links should be cleaned up alongside the vector.
					state.storage.sql.exec(
						"INSERT OR IGNORE INTO file_tags (path, tag) VALUES (?, ?)",
						path,
						"probe",
					);
					state.storage.sql.exec(
						"INSERT OR IGNORE INTO file_links (source, target) VALUES (?, ?)",
						path,
						"memory/learnings",
					);
					seed += 0.01;
				}

				const result = await instance.prune();

				expect(result.dryRun).toBe(false);
				expect(result.pruned).toBe(denied.length);
				expect(result.byReason).toEqual({
					"superseded reflection archive": 1,
					"machine-generated backlog-groom report": 1,
					"archived plan": 1,
					"benchmark fixture": 1,
				});

				const remaining = [
					...state.storage.sql.exec<{ path: string }>("SELECT path FROM memories"),
				].map((r) => r.path);
				for (const path of denied) expect(remaining).not.toContain(path);
				for (const path of kept) expect(remaining).toContain(path);

				// Satellite tables are cleaned up too, so `list_tags` and
				// `get_backlinks` don't keep pointing at unindexed files.
				const orphanTags = [
					...state.storage.sql.exec<{ path: string }>(
						"SELECT path FROM file_tags WHERE tag = 'probe'",
					),
				].map((r) => r.path);
				for (const path of denied) expect(orphanTags).not.toContain(path);

				const orphanLinks = [
					...state.storage.sql.exec<{ source: string }>(
						"SELECT source FROM file_links WHERE target = 'memory/learnings'",
					),
				].map((r) => r.source);
				for (const path of denied) expect(orphanLinks).not.toContain(path);
			},
		);
	});

	it("leaves the index untouched on a dry run", async () => {
		await runInDurableObject(
			indexStub(),
			async (instance: MemoryIndex, state: DurableObjectState) => {
				await instance.stats();

				const denied = "memory/_bench/dry-run-probe.md";
				state.storage.sql.exec(
					"INSERT OR REPLACE INTO memories (path, embedding, updated_at) VALUES (?, ?, ?)",
					denied,
					stubEmbedding(0.02),
					Date.now(),
				);

				const result = await instance.prune({ dryRun: true });

				expect(result.dryRun).toBe(true);
				expect(result.pruned).toBe(0);
				expect(result.matched).toBeGreaterThan(0);
				expect(result.remaining).toBe(result.scanned);
				expect(result.byReason["benchmark fixture"]).toBe(1);

				const rows = [
					...state.storage.sql.exec<{ path: string }>(
						"SELECT path FROM memories WHERE path = ?",
						denied,
					),
				];
				expect(rows).toHaveLength(1);
			},
		);
	});

	it("rebuilds a searchable index after a mass prune", async () => {
		await runInDurableObject(
			indexStub(),
			async (instance: MemoryIndex, state: DurableObjectState) => {
				await instance.stats();

				// Ballast-heavy shape: many denylisted vectors around a few keepers,
				// mirroring the real index before the first prune. The rebuild has to
				// leave the survivors reachable from the HNSW entry point.
				let seed = 0.001;
				for (let i = 0; i < 40; i++) {
					state.storage.sql.exec(
						"INSERT OR REPLACE INTO memories (path, embedding, updated_at) VALUES (?, ?, ?)",
						`memory/reflections/archive/bulk-${i}.md`,
						stubEmbedding(seed),
						Date.now(),
					);
					seed += 0.001;
				}
				for (const path of ["memory/learnings.md", "memory/preferences.md", "memory/soul.md"]) {
					state.storage.sql.exec(
						"INSERT OR REPLACE INTO memories (path, embedding, updated_at) VALUES (?, ?, ?)",
						path,
						stubEmbedding(seed),
						Date.now(),
					);
					seed += 0.001;
				}

				const result = await instance.prune();

				expect(result.pruned).toBeGreaterThanOrEqual(40);
				// `remaining` is read from the rebuilt HNSW, not from SQL, so it
				// only matches the surviving row count if the rebuild worked.
				const survivingRows = [
					...state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) as count FROM memories"),
				][0].count;
				expect(result.remaining).toBe(survivingRows);

				const stats = await instance.stats();
				expect(stats.index_size).toBe(stats.indexed_files);
			},
		);
	});
});
