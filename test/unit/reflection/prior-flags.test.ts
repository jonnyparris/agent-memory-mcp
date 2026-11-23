import { describe, expect, it } from "vitest";
import {
	DISPOSITIONS_PATH,
	PROMPT_MAX_PATHS,
	annotateFlags,
	loadDispositions,
	loadPriorFlags,
	parseDispositions,
	priorFlagsPrompt,
} from "../../../src/reflection/prior-flags";
import { RUN_HISTORY_PATH, type RunRecord } from "../../../src/reflection/run-history";
import type { FlaggedIssue } from "../../../src/reflection/tool-executor";
import { createMockStorage } from "../../mocks/storage";

const PLANS = "Stale plans and workload";

function run(date: string, focus: string): RunRecord {
	return {
		date,
		focus,
		finished: true,
		success: true,
		edits: 0,
		quickFixes: 0,
		flagged: 1,
		failed: 0,
	};
}

const sidecar = (flags: { path: string; issue: string }[], focus = PLANS) =>
	JSON.stringify({ focus, flaggedIssues: flags });

async function seed(storage: ReturnType<typeof createMockStorage>) {
	await storage.write(
		RUN_HISTORY_PATH,
		JSON.stringify([
			run("2026-11-02", PLANS),
			run("2026-11-08", "Links and orphans"),
			run("2026-11-09", PLANS),
			run("2026-11-16", PLANS),
			run("2026-11-23", PLANS),
		]),
	);
	await storage.write(
		"memory/reflections/archive/2026-11-02.json",
		sidecar([{ path: "memory/workload/plans/a.md", issue: "old a" }]),
	);
	await storage.write(
		"memory/reflections/archive/2026-11-08.json",
		sidecar(
			[{ path: "memory/workload/plans/a.md", issue: "other focus, ignored" }],
			"Links and orphans",
		),
	);
	await storage.write(
		"memory/reflections/archive/2026-11-09.json",
		sidecar([
			{ path: "memory/workload/plans/a.md", issue: "a again" },
			{ path: "memory/workload/plans/b.md", issue: "b once" },
		]),
	);
	await storage.write(
		"memory/reflections/archive/2026-11-16.json",
		sidecar([
			{
				path: "memory/workload/plans/a.md",
				issue:
					"Repeat (path also flagged on 2 of the last 2 runs of this focus, first 2026-11-02): a\n  newest",
			},
		]),
	);
	// Today's own run must not count as a prior run.
	await storage.write(
		"memory/reflections/archive/2026-11-23.json",
		sidecar([{ path: "memory/workload/plans/c.md", issue: "today" }]),
	);
}

describe("loadPriorFlags", () => {
	it("collects earlier runs of the same focus only, newest gist, repeat prefix stripped", async () => {
		const storage = createMockStorage();
		await seed(storage);
		const prior = await loadPriorFlags(storage, PLANS, "2026-11-23");
		expect(prior.runs).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
		expect(prior.flags.map((p) => p.path)).toEqual([
			"memory/workload/plans/a.md",
			"memory/workload/plans/b.md",
		]);
		expect(prior.flags[0].dates).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
		expect(prior.flags[0].gist).toBe("a newest");
	});

	it("looks back only `runs` runs, and none for 0", async () => {
		const storage = createMockStorage();
		await seed(storage);
		const one = await loadPriorFlags(storage, PLANS, "2026-11-23", 1);
		expect(one).toEqual({
			runs: ["2026-11-16"],
			flags: [{ path: "memory/workload/plans/a.md", dates: ["2026-11-16"], gist: "a newest" }],
		});
		expect(await loadPriorFlags(storage, PLANS, "2026-11-23", 0)).toEqual({ runs: [], flags: [] });
	});

	it("skips a sidecar whose own focus disagrees with the run history", async () => {
		const storage = createMockStorage();
		await storage.write(RUN_HISTORY_PATH, JSON.stringify([run("2026-11-16", PLANS)]));
		await storage.write(
			"memory/reflections/archive/2026-11-16.json",
			sidecar([{ path: "memory/x.md", issue: "x" }], "Links and orphans"),
		);
		expect(await loadPriorFlags(storage, PLANS, "2026-11-23")).toEqual({ runs: [], flags: [] });
	});

	it("survives a missing history, a missing sidecar and a broken sidecar", async () => {
		const storage = createMockStorage();
		expect(await loadPriorFlags(storage, PLANS, "2026-11-23")).toEqual({ runs: [], flags: [] });
		await storage.write(
			RUN_HISTORY_PATH,
			JSON.stringify([run("2026-11-09", PLANS), run("2026-11-16", PLANS)]),
		);
		await storage.write("memory/reflections/archive/2026-11-16.json", "{not json");
		expect(await loadPriorFlags(storage, PLANS, "2026-11-23")).toEqual({ runs: [], flags: [] });
	});
});

describe("dispositions", () => {
	it("parses bullets with and without backticks and an optional until date", () => {
		const d = parseDispositions(
			[
				"# Reflection dispositions",
				"- `memory/workload/plans/presently-mobile-ux-fixes.md` — kept: Ruskin to decide (until 2027-01-31)",
				"- memory/workload/learn-proposals.md - kept: Work HQ pages reads",
				"- memory/workload/plans/ — folder entry",
				"not a bullet memory/x.md — nope",
			].join("\n"),
		);
		expect(d).toEqual([
			{
				path: "memory/workload/plans/presently-mobile-ux-fixes.md",
				reason: "kept: Ruskin to decide",
				until: "2027-01-31",
			},
			{
				path: "memory/workload/learn-proposals.md",
				reason: "kept: Work HQ pages reads",
				until: undefined,
			},
			{ path: "memory/workload/plans/", reason: "folder entry", until: undefined },
		]);
	});

	it("drops expired decisions", async () => {
		const storage = createMockStorage();
		await storage.write(
			DISPOSITIONS_PATH,
			"- memory/a.md — old (until 2026-11-01)\n- memory/b.md — live\n",
		);
		expect((await loadDispositions(storage, "2026-11-23")).map((d) => d.path)).toEqual([
			"memory/b.md",
		]);
		expect(await loadDispositions(createMockStorage(), "2026-11-23")).toEqual([]);
	});
});

describe("annotateFlags", () => {
	const prior = {
		runs: ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"],
		flags: [{ path: "memory/a.md", dates: ["2026-11-09", "2026-11-16"], gist: "x" }],
	};

	it("marks repeats, drops the model's flags on decided paths, keeps system notices", () => {
		const repeat = { path: "memory/a.md", issue: "still stale" };
		const decided = { path: "memory/kept/thing.md", issue: "decided" };
		const system = {
			path: "memory/kept/other.md",
			issue: "Reflection proposed deleting this file: x",
		};
		const fresh = { path: "memory/new.md", issue: "fresh" };
		const out = annotateFlags(
			[repeat, decided, system, fresh],
			prior,
			[{ path: "memory/kept/", reason: "kept" }],
			new Set<FlaggedIssue>([repeat, decided, fresh]),
		);
		expect(out.suppressed).toEqual(["memory/kept/thing.md"]);
		expect(out.flags).toEqual([
			{
				path: "memory/a.md",
				issue:
					"Repeat (path also flagged on 2 of the last 4 runs of this focus, first 2026-11-09): still stale",
			},
			system,
			fresh,
		]);
	});

	it("does not stack the prefix", () => {
		const issue =
			"Repeat (path also flagged on 2 of the last 4 runs of this focus, first 2026-11-09): y";
		const out = annotateFlags([{ path: "memory/a.md", issue }], prior, [], new Set());
		expect(out.flags[0].issue).toBe(issue);
	});
});

describe("priorFlagsPrompt", () => {
	it("lists open prior flags and decisions, skipping prior flags that are decided", () => {
		const text = priorFlagsPrompt(
			{
				runs: ["2026-11-09"],
				flags: [
					{ path: "memory/a.md", dates: ["2026-11-09"], gist: "stale a" },
					{ path: "memory/b.md", dates: ["2026-11-09"], gist: "decided b" },
				],
			},
			[{ path: "memory/b.md", reason: "kept on purpose" }],
		);
		expect(text).toContain("The last 1 run(s) of this focus (2026-11-09)");
		expect(text).toContain("- memory/a.md (1x, first 2026-11-09): stale a");
		expect(text).not.toContain("decided b");
		expect(text).toContain("- memory/b.md: kept on purpose");
	});

	it("caps the listed paths", () => {
		const flags = Array.from({ length: PROMPT_MAX_PATHS + 3 }, (_, i) => ({
			path: `memory/p${i}.md`,
			dates: ["2026-11-09"],
			gist: "g",
		}));
		const text = priorFlagsPrompt({ runs: ["2026-11-09"], flags }, []);
		expect(text.match(/^- memory\/p/gm)).toHaveLength(PROMPT_MAX_PATHS);
		expect(text).toContain("...and 3 more");
	});

	it("is empty when there is nothing to say", () => {
		expect(priorFlagsPrompt({ runs: [], flags: [] }, [])).toBe("");
	});
});
