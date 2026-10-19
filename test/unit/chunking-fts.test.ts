import { describe, expect, it } from "vitest";
import { CHUNK_CHARS, CHUNK_OVERLAP, chunkText } from "../../src/search/chunking";
import { buildFtsQuery, reciprocalRankFusion } from "../../src/search/fts";
import { blobToVector, cosineSimilarity, normalise, vectorToBlob } from "../../src/search/vectors";

describe("chunkText", () => {
	it("returns nothing for empty text and one chunk for short text", () => {
		expect(chunkText("")).toEqual([]);
		expect(chunkText("hello")).toEqual(["hello"]);
		expect(chunkText("a".repeat(CHUNK_CHARS))).toHaveLength(1);
	});

	it("overlaps consecutive chunks and covers the whole text", () => {
		const text = Array.from({ length: 4000 }, (_, i) => String.fromCharCode(65 + (i % 26))).join(
			"",
		);
		const chunks = chunkText(text);
		expect(chunks).toHaveLength(3);
		const step = CHUNK_CHARS - CHUNK_OVERLAP;
		chunks.forEach((c, i) => expect(c).toBe(text.slice(i * step, i * step + CHUNK_CHARS)));
		expect(chunks.at(-1)?.endsWith(text.slice(-10))).toBe(true);
		for (let i = 1; i < chunks.length; i++) {
			expect(chunks[i].slice(0, CHUNK_OVERLAP)).toBe(chunks[i - 1].slice(-CHUNK_OVERLAP));
		}
	});

	it("matches the spike harness slicing", () => {
		// offline.py: for i in range(0, len, 1350): piece = t[i:i+1500]; stop once i+1500 >= len
		const text = "x".repeat(2851);
		expect(chunkText(text).map((c) => c.length)).toEqual([1500, 1500, 151]);
	});
});

describe("buildFtsQuery", () => {
	it("quotes terms and ORs them", () => {
		expect(buildFtsQuery("Browser Run limits")).toBe('"browser" OR "run" OR "limits"');
	});

	it("keeps identifiers together as phrases", () => {
		expect(buildFtsQuery("PAY-123 in agent_memory.ts")).toBe(
			'"pay 123" OR "in" OR "agent memory ts"',
		);
	});

	it("drops FTS5 syntax and returns null when nothing is left", () => {
		expect(buildFtsQuery('"(a) NOT b*:^')).toBe('"a" OR "not" OR "b"');
		expect(buildFtsQuery("  -- ** ")).toBeNull();
	});

	it("dedupes terms", () => {
		expect(buildFtsQuery("dodo Dodo DODO")).toBe('"dodo"');
	});
});

describe("reciprocalRankFusion", () => {
	it("scores a path ranked first in every list as 1", () => {
		const fused = reciprocalRankFusion([
			["a", "b"],
			["a", "c"],
		]);
		expect(fused[0]).toEqual({ id: "a", score: 1 });
		expect(fused.map((f) => f.id)).toEqual(["a", "b", "c"]);
	});

	it("ranks agreement above a single first place", () => {
		const fused = reciprocalRankFusion([
			["x", "both"],
			["y", "both"],
		]);
		expect(fused[0].id).toBe("both");
	});
});

describe("vectors", () => {
	it("round-trips float32 blobs and normalises", () => {
		const v = normalise([3, 4]);
		expect(Array.from(v)).toEqual([expect.closeTo(0.6, 6), expect.closeTo(0.8, 6)]);
		expect(Array.from(blobToVector(vectorToBlob(v)))).toEqual(Array.from(v));
		expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
		expect(Array.from(normalise([0, 0]))).toEqual([0, 0]);
	});
});
