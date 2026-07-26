import { describe, expect, it } from "vitest";
import { INDEX_DENYLIST, indexSkipReason, shouldIndex } from "../../src/search/indexable";

describe("index denylist", () => {
	describe("excluded paths", () => {
		const denied: Array<[string, string]> = [
			["memory/reflections/archive/2026-04-09.md", "superseded reflection archive"],
			["memory/reflections/archive/nested/deep.md", "superseded reflection archive"],
			[
				"memory/workload/backlog-groom/BRAPI/reports/BRAPI-826.json",
				"machine-generated backlog-groom report",
			],
			[
				"memory/workload/backlog-groom/OTHER/reports/sub/X-1.md",
				"machine-generated backlog-groom report",
			],
			["memory/workload/plans/archive/old-plan.md", "archived plan"],
			["memory/_bench/many1.md", "benchmark fixture"],
			["plans/signal-agent-architecture.svg", "non-prose file type"],
			["memory/diagrams/flow.PNG", "non-prose file type"],
			["memory/assets/font.woff2", "non-prose file type"],
		];

		it.each(denied)("excludes %s", (path, reason) => {
			expect(shouldIndex(path)).toBe(false);
			expect(indexSkipReason(path)).toBe(reason);
		});
	});

	describe("included paths", () => {
		const allowed = [
			// Core memory — the files that must always win recall.
			"memory/learnings.md",
			"memory/preferences.md",
			"memory/people.md",
			"memory/soul.md",
			"memory/brag-sheet.md",
			// Live reflections, as opposed to the archive beneath them.
			"memory/reflections/pending/2026-07-25.md",
			// Human-authored backlog-groom output sits beside the machine reports
			// and must survive the reports rule.
			"memory/workload/backlog-groom/BRAPI/summaries/2026-03-06-batch-5.md",
			"memory/workload/backlog-groom/BRAPI/actions/close-candidates.md",
			// Current plans stay indexed; only plans/archive/ is excluded.
			"memory/workload/plans/2026-07-25-improvement-proposals.md",
			"memory/patterns/worker-rpc.md",
			"memory/reference/em-leveling-guide.md",
		];

		it.each(allowed)("includes %s", (path) => {
			expect(shouldIndex(path)).toBe(true);
			expect(indexSkipReason(path)).toBeNull();
		});
	});

	it("does not treat a path merely containing 'archive' as archived", () => {
		expect(shouldIndex("memory/projects/archive-migration-notes.md")).toBe(true);
		expect(shouldIndex("memory/workload/plans/archived-thinking.md")).toBe(true);
	});

	it("distinguishes reports directories from files named report", () => {
		expect(shouldIndex("memory/workload/backlog-groom/BRAPI/report-summary.md")).toBe(true);
	});

	it("reports the narrowest matching reason when rules overlap", () => {
		// Matches both the reflection-archive rule and the non-prose rule;
		// denylist order puts the more descriptive path rule first.
		expect(indexSkipReason("memory/reflections/archive/diagram.svg")).toBe(
			"superseded reflection archive",
		);
	});

	it("gives every rule a non-empty reason", () => {
		for (const rule of INDEX_DENYLIST) {
			expect(rule.reason.length).toBeGreaterThan(0);
		}
	});
});
