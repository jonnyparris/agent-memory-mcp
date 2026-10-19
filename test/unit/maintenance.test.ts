import { describe, expect, it } from "vitest";
import type { IndexedPath, MemoryIndexRpc, PruneResult } from "../../src/search/durable-object";
import { pruneIndex, reindexLegacy } from "../../src/search/maintenance";
import type { R2Storage } from "../../src/storage/r2";
import type { Env } from "../../src/types";

function fakes(indexed: IndexedPath[], files: Record<string, string>) {
	const calls = { prune: [] as Array<{ missing?: string[] }>, update: [] as string[] };
	const index = {
		indexedPaths: async () => ({ paths: indexed }),
		prune: async (args: { dryRun?: boolean; missing?: string[] }): Promise<PruneResult> => {
			calls.prune.push(args);
			return {
				scanned: indexed.length,
				pruned: args.missing?.length ?? 0,
				matched: args.missing?.length ?? 0,
				remaining: indexed.length - (args.missing?.length ?? 0),
				byReason: {},
				dryRun: !!args.dryRun,
			};
		},
		update: async ({ path }: { path: string }) => {
			if (path.includes("bad")) throw new Error("embed failed");
			calls.update.push(path);
			return { success: true as const };
		},
	} as unknown as MemoryIndexRpc;
	const env = {
		MEMORY_INDEX: { idFromName: (n: string) => n, get: () => index },
	} as unknown as Env;
	const storage = {
		list: async () =>
			Object.keys(files).map((path) => ({ path, size: 1, updated_at: "2026-01-01T00:00:00Z" })),
		read: async (path: string) =>
			path in files ? { content: files[path], updated_at: "", size: 1 } : null,
	} as unknown as R2Storage;
	return { env, storage, calls };
}

const paths = (n: number, legacy = false): IndexedPath[] =>
	Array.from({ length: n }, (_, i) => ({ path: `memory/f${i}.md`, legacy }));
const filesFor = (list: IndexedPath[]) => Object.fromEntries(list.map((p) => [p.path, "x"]));

describe("pruneIndex", () => {
	it("passes paths missing from storage to the DO", async () => {
		const indexed = paths(10);
		const files = filesFor(indexed.slice(1));
		const { env, storage, calls } = fakes(indexed, files);
		const result = await pruneIndex(env, storage, {});
		expect(result.missing).toEqual(["memory/f0.md"]);
		expect(calls.prune[0].missing).toEqual(["memory/f0.md"]);
		expect(result.missing_check_skipped).toBeUndefined();
	});

	it("refuses the missing check when storage looks empty", async () => {
		const { env, storage, calls } = fakes(paths(10), {});
		const result = await pruneIndex(env, storage, {});
		expect(result.missing).toEqual([]);
		expect(calls.prune[0].missing).toEqual([]);
		expect(result.missing_check_skipped).toMatch(/empty/);
	});

	it("refuses the missing check when too much of the index looks gone", async () => {
		const indexed = paths(10);
		const { env, storage, calls } = fakes(indexed, filesFor(indexed.slice(5)));
		const result = await pruneIndex(env, storage, {});
		expect(calls.prune[0].missing).toEqual([]);
		expect(result.missing_check_skipped).toMatch(/5 of 10/);
	});
});

describe("reindexLegacy", () => {
	it("re-embeds legacy paths up to the limit and reports the rest", async () => {
		const indexed = [
			...paths(3, true),
			{ path: "memory/gone.md", legacy: true },
			{ path: "memory/bad.md", legacy: true },
			{ path: "memory/chunked.md", legacy: false },
		];
		const files = { ...filesFor(paths(3)), "memory/bad.md": "x", "memory/chunked.md": "x" };
		const { env, storage, calls } = fakes(indexed, files);

		const first = await reindexLegacy(env, storage, { limit: 2 });
		expect(first.reindexed).toEqual(["memory/f0.md", "memory/f1.md"]);
		expect(first.remaining).toBe(3);

		const all = await reindexLegacy(env, storage, { limit: 50 });
		expect(all.missing).toEqual(["memory/gone.md"]);
		expect(all.failed.map((f) => f.path)).toEqual(["memory/bad.md"]);
		expect(calls.update).not.toContain("memory/chunked.md");
	});

	it("touches nothing on a dry run", async () => {
		const { env, storage, calls } = fakes(paths(3, true), filesFor(paths(3)));
		const result = await reindexLegacy(env, storage, { dryRun: true });
		expect(result).toMatchObject({ legacy_before: 3, remaining: 3, reindexed: [] });
		expect(calls.update).toEqual([]);
	});
});
