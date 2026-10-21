import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CHUNK_CHARS, chunkText } from "../../src/search/chunking";
import { MISSING_FROM_STORAGE, type MemoryIndex } from "../../src/search/durable-object";
import { EMBEDDING_DIMENSIONS } from "../../src/search/embeddings";
import { createMockAI } from "../mocks/workers-ai";

/**
 * MemoryIndex behaviour, exercised against the Durable Object directly.
 *
 * The test pool leaves the `AI` binding unwired (see vitest.config.ts), so
 * each test swaps a stub onto the live instance. Each test also gets its own
 * DO instance, so index state never leaks between cases.
 */

let counter = 0;
function freshStub() {
	const ns = env.MEMORY_INDEX;
	return ns.get(ns.idFromName(`test-${Date.now()}-${counter++}`));
}

type Run = (instance: MemoryIndex, state: DurableObjectState) => Promise<void>;
function withIndex(fn: Run, ai: unknown = createMockAI()): Promise<void> {
	return runInDurableObject(freshStub(), async (instance: MemoryIndex, state) => {
		(instance as unknown as { env: { AI: unknown } }).env = { AI: ai };
		await fn(instance, state);
	});
}

/** A unit vector along `axis`, optionally tilted towards `axis + 1`. */
function axisVector(axis: number, tilt = 0): number[] {
	const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
	v[axis] = Math.sqrt(1 - tilt * tilt);
	v[axis + 1] = tilt;
	return v;
}

/** AI stub that maps texts to fixed vectors, falling back to the hash mock. */
function scriptedAI(vectors: Record<string, number[]>) {
	const mock = createMockAI();
	return {
		run: async (model: string, inputs: { text: string | string[] }) => {
			const texts = Array.isArray(inputs.text) ? inputs.text : [inputs.text];
			const known = texts.map((t) => vectors[t]);
			if (known.every(Boolean)) return { data: known };
			return mock.run(model, inputs);
		},
	};
}

function seedLegacy(state: DurableObjectState, path: string, vector: number[]): void {
	state.storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS memories (
			path TEXT PRIMARY KEY,
			embedding BLOB NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
	state.storage.sql.exec(
		"INSERT OR REPLACE INTO memories (path, embedding, updated_at) VALUES (?, ?, ?)",
		path,
		new TextEncoder().encode(JSON.stringify(vector)),
		Date.now(),
	);
}

describe("MemoryIndex", () => {
	it("migrates whole-file vectors from the old memories table", async () => {
		await withIndex(
			async (instance, state) => {
				// Old-schema rows, written before the DO first initialises.
				seedLegacy(state, "memory/a.md", axisVector(0));
				seedLegacy(state, "memory/b.md", axisVector(5));

				const stats = await instance.stats();
				expect(stats).toMatchObject({ indexed_files: 2, chunks: 2, legacy_files: 2 });

				const hits = await instance.search({ query: "q", limit: 2, timeWeight: false });
				expect(hits[0].id).toBe("memory/a.md");

				// Old table is kept for rollback.
				const old = [...state.storage.sql.exec("SELECT path FROM memories")];
				expect(old).toHaveLength(2);

				const { paths } = await instance.indexedPaths();
				expect(paths).toEqual([
					{ path: "memory/a.md", legacy: true },
					{ path: "memory/b.md", legacy: true },
				]);

				// Rewriting a legacy file chunks it.
				await instance.update({ path: "memory/a.md", content: "fresh content" });
				expect((await instance.stats()).legacy_files).toBe(1);
			},
			scriptedAI({ q: axisVector(0, 0.1) }),
		);
	});

	it("chunks long files and finds exact terms deep inside them", async () => {
		await withIndex(async (instance) => {
			const filler = "General notes about planning and process. ".repeat(200);
			const content = `${filler}\nThe incident was tracked as PAY-4821 in the end.\n${filler}`;
			await instance.update({ path: "memory/hub.md", content });
			for (let i = 0; i < 20; i++) {
				await instance.update({ path: `memory/other-${i}.md`, content: `unrelated file ${i}` });
			}

			const stats = await instance.stats();
			expect(stats.chunks).toBeGreaterThan(Math.floor(content.length / CHUNK_CHARS));
			expect(stats.legacy_files).toBe(0);

			// The term sits well past the old 20,000-character embed cap's
			// equivalent position in chunk terms, and mock vectors are random,
			// so only the keyword path can find it.
			const hits = await instance.search({ query: "PAY-4821", limit: 3, timeWeight: false });
			expect(hits[0].id).toBe("memory/hub.md");
			expect(hits[0].similarity).toBeTypeOf("number");

			// The hit reports the chunk holding the term, so the snippet can
			// show it rather than the file opening.
			const expected = chunkText(content).findIndex((c) => c.includes("PAY-4821"));
			expect(expected).toBeGreaterThan(0);
			expect(hits[0].chunk).toBe(expected);
		});
	});

	it("treats FTS5 syntax in queries as plain text", async () => {
		await withIndex(async (instance) => {
			await instance.update({ path: "memory/a.md", content: "deploy NOT working: see foo-bar" });
			for (const q of ['"unbalanced', "a AND OR NOT", "col:value*", "(x", "-", "^start", "  "]) {
				await expect(instance.search({ query: q, timeWeight: false })).resolves.toBeInstanceOf(
					Array,
				);
			}
		});
	});

	it("ranks files by chunk-vs-chunk coverage, best first", async () => {
		await withIndex(
			async (instance) => {
				await instance.update({ path: "memory/a.md", content: "alpha" });
				await instance.update({ path: "memory/copy.md", content: "alpha" });
				await instance.update({ path: "memory/other.md", content: "omega" });
				await instance.update({ path: "notes/copy.md", content: "alpha" });
				const near = await instance.coverageNeighbours({ path: "memory/a.md", prefix: "memory/" });
				// Self and paths outside the prefix are skipped.
				expect(near.map((n) => n.path)).toEqual(["memory/copy.md", "memory/other.md"]);
				expect(near[0].coverage).toBeCloseTo(1, 5);
				expect(near[1].coverage).toBeCloseTo(0, 5);
				expect(
					await instance.coverageNeighbours({ path: "memory/a.md", prefix: "memory/", limit: 1 }),
				).toHaveLength(1);
				expect(await instance.coverageNeighbours({ path: "memory/nope.md" })).toEqual([]);
			},
			scriptedAI({ alpha: axisVector(0), omega: axisVector(7) }),
		);
	});

	it("finds a file that duplicates only the end of a long file", async () => {
		// The case the old opening-8,000-characters search missed: the new
		// file's tail is the whole of an existing file.
		const head = "h".repeat(9000);
		const tail = "t".repeat(1500);
		const vectors: Record<string, number[]> = { [tail]: axisVector(1) };
		vectors["u".repeat(1500)] = axisVector(2);
		for (const piece of chunkText(head + tail)) {
			vectors[piece] = /^t+$/.test(piece) ? axisVector(1) : axisVector(3);
		}
		await withIndex(async (instance) => {
			await instance.update({ path: "memory/part2.md", content: tail });
			await instance.update({ path: "memory/unrelated.md", content: "u".repeat(1500) });
			await instance.update({ path: "memory/long.md", content: head + tail });
			const near = await instance.coverageNeighbours({ path: "memory/long.md", prefix: "memory/" });
			expect(near[0].path).toBe("memory/part2.md");
			expect(near[0].coverage).toBeCloseTo(1, 5);
			// The matching chunk is the tail one, so Jev can be shown it.
			expect(near[0].chunk).toBe(chunkText(head + tail).length - 1);
		}, scriptedAI(vectors));
	});

	it("returns cosine scores in vector mode", async () => {
		await withIndex(
			async (instance) => {
				await instance.update({ path: "memory/a.md", content: "A" });
				await instance.update({ path: "memory/b.md", content: "B" });
				const hits = await instance.search({
					query: "q",
					limit: 2,
					timeWeight: false,
					mode: "vector",
				});
				expect(hits.map((h) => h.id)).toEqual(["memory/a.md", "memory/b.md"]);
				expect(hits[0].score).toBeCloseTo(0.6, 5);
				expect(hits[1].score).toBeCloseTo(0, 5);
			},
			scriptedAI({ A: axisVector(0), B: axisVector(9), q: axisVector(0, 0.8) }),
		);
	});

	it("reports the best vector chunk when there is no keyword hit", async () => {
		const content = `${"alpha ".repeat(300)}${"omega ".repeat(300)}`;
		const pieces = chunkText(content);
		expect(pieces).toHaveLength(3);
		const [c0, c1, c2] = pieces;
		await withIndex(
			async (instance) => {
				await instance.update({ path: "memory/long.md", content });
				for (const mode of ["vector", "hybrid"] as const) {
					const hits = await instance.search({ query: "q", timeWeight: false, mode });
					expect(hits[0]).toMatchObject({ id: "memory/long.md", chunk: 1 });
				}
			},
			scriptedAI({
				[c0]: axisVector(5),
				[c1]: axisVector(0),
				[c2]: axisVector(9),
				q: axisVector(0, 0.1),
			}),
		);
	});

	it("keeps the previous vectors when embedding fails", async () => {
		let fail = false;
		const mock = createMockAI();
		const ai = {
			run: async (model: string, inputs: { text: string | string[] }) => {
				if (fail) throw new Error("5000: upstream unavailable");
				return mock.run(model, inputs);
			},
		};
		await withIndex(async (instance) => {
			await instance.update({ path: "memory/a.md", content: "original text about kites" });
			fail = true;
			await expect(
				instance.update({ path: "memory/a.md", content: "replacement" }),
			).rejects.toThrow(/upstream/);
			fail = false;
			const stats = await instance.stats();
			expect(stats).toMatchObject({ indexed_files: 1, chunks: 1 });
			const hits = await instance.search({ query: "kites", timeWeight: false });
			expect(hits[0]?.id).toBe("memory/a.md");
		}, ai);
	});

	it("removes denylisted and missing paths, with tags and links", async () => {
		await withIndex(async (instance, state) => {
			const denied = [
				"memory/reflections/archive/2026-04-09.md",
				"memory/workload/backlog-groom/BRAPI/reports/BRAPI-826.json",
				"memory/workload/plans/archive/old-plan.md",
				"memory/_bench/many1.md",
			];
			const gone = "memory/workload/plans/deleted-plan.md";
			const kept = ["memory/learnings.md", "memory/workload/plans/2026-07-25-proposals.md"];

			for (const path of [...denied, gone, ...kept]) {
				await instance.update({
					path,
					content: `content of ${path}`,
					tags: ["probe"],
					links: ["memory/learnings"],
				});
			}

			const result = await instance.prune({
				missing: [gone, "memory/never-indexed.md"],
			});

			expect(result.dryRun).toBe(false);
			expect(result.pruned).toBe(denied.length + 1);
			expect(result.remaining).toBe(kept.length);
			expect(result.byReason).toEqual({
				"superseded reflection archive": 1,
				"machine-generated backlog-groom report": 1,
				"archived plan": 1,
				"benchmark fixture": 1,
				[MISSING_FROM_STORAGE]: 1,
			});

			const remaining = (await instance.indexedPaths()).paths.map((p) => p.path);
			expect(remaining.sort()).toEqual([...kept].sort());

			const tagged = (await instance.filesWithTags(["probe"])).paths;
			expect(tagged.sort()).toEqual([...kept].sort());
			const { backlinks } = await instance.backlinks("memory/learnings");
			expect(backlinks.sort()).toEqual([...kept].sort());

			const ftsRows = [
				...state.storage.sql.exec<{ path: string }>("SELECT DISTINCT path FROM chunks_fts"),
			].map((r) => r.path);
			expect(ftsRows.sort()).toEqual([...kept].sort());

			const stats = await instance.stats();
			expect(stats.index_size).toBe(stats.indexed_files);
		});
	});

	it("returns every tagged match regardless of global ranking", async () => {
		const vectors: Record<string, number[]> = { needle: axisVector(0) };
		vectors.target = axisVector(0, 0.8);
		for (let i = 0; i < 60; i++) vectors[`decoy ${i}`] = axisVector(0, i / 1000);
		await withIndex(async (instance) => {
			await instance.update({ path: "memory/tagged-needle.md", content: "target", tags: ["core"] });
			for (let i = 0; i < 60; i++) {
				await instance.update({ path: `memory/decoy-${i}.md`, content: `decoy ${i}` });
			}

			const untagged = await instance.search({ query: "needle", limit: 3, timeWeight: false });
			expect(untagged.map((r) => r.id)).not.toContain("memory/tagged-needle.md");

			const tagged = await instance.search({
				query: "needle",
				limit: 3,
				timeWeight: false,
				tags: ["core"],
			});
			expect(tagged.map((r) => r.id)).toEqual(["memory/tagged-needle.md"]);
		}, scriptedAI(vectors));
	});

	it("leaves the index untouched on a dry run", async () => {
		await withIndex(async (instance) => {
			await instance.update({ path: "memory/_bench/dry-run-probe.md", content: "x" });
			await instance.update({ path: "memory/gone.md", content: "y" });

			const result = await instance.prune({ dryRun: true, missing: ["memory/gone.md"] });

			expect(result.dryRun).toBe(true);
			expect(result.pruned).toBe(0);
			expect(result.matched).toBe(2);
			expect(result.remaining).toBe(result.scanned);
			expect(result.byReason["benchmark fixture"]).toBe(1);
			expect((await instance.indexedPaths()).paths).toHaveLength(2);
		});
	});

	it("weights recency only among the most relevant candidates", async () => {
		await withIndex(async (instance, state) => {
			await instance.update({ path: "memory/old.md", content: "kite surfing notes" });
			await instance.update({ path: "memory/new.md", content: "kite surfing notes too" });
			const year = 365 * 24 * 60 * 60 * 1000;
			state.storage.sql.exec(
				"UPDATE files SET updated_at = ? WHERE path = 'memory/old.md'",
				Date.now() - year,
			);
			const hits = await instance.search({ query: "kite surfing", limit: 2, timeWeight: true });
			expect(hits).toHaveLength(2);
			expect(hits[0].id).toBe("memory/new.md");
		});
	});
});
