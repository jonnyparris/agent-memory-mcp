import { describe, expect, it } from "vitest";
import { coverage, coverageDetail, normalise } from "../../src/search/vectors";

const v = (...xs: number[]) => normalise(xs);

describe("coverage", () => {
	it("is 1 for identical chunk sets", () => {
		const a = [v(1, 0, 0), v(0, 1, 0)];
		expect(coverage(a, a)).toBeCloseTo(1, 6);
	});

	it("scores a small file contained in a big one as fully covered", () => {
		// The case the old opening-vs-best-chunk score undersold: every chunk
		// of the small file appears verbatim in the big one.
		const small = [v(1, 0, 0, 0)];
		const big = [v(1, 0, 0, 0), v(0, 1, 0, 0), v(0, 0, 1, 0), v(0, 0, 0, 1)];
		expect(coverage(small, big)).toBeCloseTo(1, 6);
		expect(coverage(big, small)).toBeCloseTo(1, 6); // symmetric: takes the better direction
	});

	it("averages over chunks, so one shared chunk is not enough", () => {
		const a = [v(1, 0, 0, 0), v(0, 1, 0, 0)];
		const b = [v(1, 0, 0, 0), v(0, 0, 1, 0)];
		// a: chunk 0 matches (1), chunk 1 matches nothing (0) -> 0.5; b the same.
		expect(coverage(a, b)).toBeCloseTo(0.5, 6);
	});

	it("is 0 when either side has no vectors", () => {
		expect(coverage([], [v(1, 0)])).toBe(0);
		expect(coverage([v(1, 0)], [])).toBe(0);
	});

	it("coverageDetail reports which chunk of a best matches b", () => {
		const a = [v(0, 0, 1, 0), v(0, 1, 0, 0), v(1, 0, 0, 0)];
		const b = [v(1, 0, 0, 0)];
		expect(coverageDetail(a, b).bestA).toBe(2);
		expect(coverageDetail(a, b).coverage).toBeCloseTo(coverage(a, b), 6);
		expect(coverageDetail([], b).bestA).toBe(-1);
	});
});
