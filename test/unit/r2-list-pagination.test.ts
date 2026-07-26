import { describe, expect, it } from "vitest";
import { createR2Storage } from "../../src/storage/r2";

/**
 * R2 pagination behaviour for `list`.
 *
 * R2 does not guarantee that a page is full before it sets `truncated`, so a
 * single `bucket.list()` can return a handful of keys and still have the rest
 * behind a cursor. `list` ignored that and returned whatever the first call
 * produced, which silently under-reported the bucket — an audit of ~960
 * objects saw 397 for one prefix and 685 for another, and files that read
 * fine never appeared in any listing.
 *
 * A real bucket needs >1000 objects to exhibit this, so the pages are faked.
 */
function makePagedBucket(keys: string[], pageSize: number) {
	const calls: Array<string | undefined> = [];

	const bucket = {
		async list(options?: { prefix?: string; delimiter?: string; cursor?: string }) {
			calls.push(options?.cursor);

			const prefix = options?.prefix ?? "";
			const matching = keys.filter((k) => k.startsWith(prefix));
			const start = options?.cursor ? Number(options.cursor) : 0;
			const slice = matching.slice(start, start + pageSize);
			const next = start + pageSize;
			const truncated = next < matching.length;

			return {
				objects: slice.map((key) => ({
					key,
					size: key.length,
					uploaded: new Date("2026-07-26T00:00:00Z"),
					etag: `etag-${key}`,
				})),
				delimitedPrefixes: [],
				truncated,
				cursor: truncated ? String(next) : undefined,
			};
		},
	};

	return { bucket, calls };
}

describe("R2Storage.list pagination", () => {
	it("drains the cursor and returns every object", async () => {
		const keys = Array.from(
			{ length: 2500 },
			(_, i) => `memory/file-${String(i).padStart(4, "0")}.md`,
		);
		const { bucket, calls } = makePagedBucket(keys, 1000);
		const storage = createR2Storage(bucket as unknown as R2Bucket);

		const files = await storage.list("memory", true);

		expect(files).toHaveLength(2500);
		// Three pages: 1000 + 1000 + 500.
		expect(calls).toHaveLength(3);
		expect(files[0].path).toBe("memory/file-0000.md");
		expect(files[files.length - 1].path).toBe("memory/file-2499.md");
	});

	it("stops after one call when the first page is complete", async () => {
		const { bucket, calls } = makePagedBucket(["memory/a.md", "memory/b.md"], 1000);
		const storage = createR2Storage(bucket as unknown as R2Bucket);

		const files = await storage.list("memory", true);

		expect(files).toHaveLength(2);
		expect(calls).toEqual([undefined]);
	});

	it("returns a short page's full contents when more remain behind the cursor", async () => {
		// The failure mode that hid files: a page far below any limit that
		// still reports truncated.
		const keys = ["memory/a.md", "memory/b.md", "memory/c.md", "memory/d.md"];
		const { bucket } = makePagedBucket(keys, 2);
		const storage = createR2Storage(bucket as unknown as R2Bucket);

		const files = await storage.list("memory", true);

		expect(files.map((f) => f.path)).toEqual(keys);
	});

	it("deduplicates delimited prefixes across pages", async () => {
		let call = 0;
		const bucket = {
			async list() {
				call++;
				const first = call === 1;
				return {
					objects: [],
					delimitedPrefixes: first ? ["memory/patterns/"] : ["memory/patterns/", "memory/plans/"],
					truncated: first,
					cursor: first ? "1" : undefined,
				};
			},
		};
		const storage = createR2Storage(bucket as unknown as R2Bucket);

		const files = await storage.list("memory", false);

		expect(files.map((f) => f.path)).toEqual(["memory/patterns/", "memory/plans/"]);
	});
});
