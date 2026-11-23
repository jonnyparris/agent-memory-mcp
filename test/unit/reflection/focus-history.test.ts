import { describe, expect, it, vi } from "vitest";
import { FOCUSES, focusForDate, inFocus } from "../../../src/reflection/focus";
import {
	INCOMPLETE_STREAK_ALERT,
	type RunRecord,
	decideNotification,
	incompleteStreak,
	readRunHistory,
	recordRun,
} from "../../../src/reflection/run-history";
import { createMockStorage } from "../../mocks/storage";

describe("focus rotation", () => {
	it("covers every focus across a week", () => {
		const ids = new Set<string>();
		for (let d = 0; d < 7; d++) {
			ids.add(focusForDate(new Date(Date.UTC(2026, 8, 20 + d))).id);
		}
		expect(ids.size).toBe(FOCUSES.length);
	});

	it("honours a valid override and ignores an unknown one", () => {
		const date = new Date(Date.UTC(2026, 8, 20));
		expect(focusForDate(date, "plans").id).toBe("plans");
		expect(focusForDate(date, "nope").id).toBe(focusForDate(date).id);
	});

	it("scopes paths", () => {
		const plans = FOCUSES.find((f) => f.id === "plans");
		if (!plans) throw new Error("missing");
		expect(inFocus(plans, "memory/workload/plans/x.md")).toBe(true);
		expect(inFocus(plans, "memory/learnings.md")).toBe(false);
	});
});

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
	date: "2026-09-21",
	focus: "x",
	finished: true,
	success: true,
	edits: 0,
	quickFixes: 0,
	flagged: 0,
	failed: 0,
	...over,
});
const monday = new Date(Date.UTC(2026, 8, 21));
const sunday = new Date(Date.UTC(2026, 8, 27));

describe("decideNotification", () => {
	it("stays quiet on a clean, finished weekday run, even with tidies", () => {
		const r = run({ quickFixes: 5 });
		expect(decideNotification(r, [r], monday).send).toBe(false);
	});

	it("sends on findings, failures and incomplete runs", () => {
		for (const r of [
			run({ flagged: 1 }),
			run({ edits: 1 }),
			run({ failed: 1 }),
			run({ finished: false }),
		]) {
			expect(decideNotification(r, [r], monday).send).toBe(true);
		}
	});

	it("sends a weekly heartbeat on Sunday with stats", () => {
		const r = run();
		const d = decideNotification(r, [run({ flagged: 2 }), r], sunday);
		expect(d.send).toBe(true);
		expect(d.prefix).toContain("Weekly: 2 runs");
		expect(d.prefix).toContain("2 flagged");
	});

	it("alerts after a streak of incomplete runs", () => {
		const history = Array.from({ length: INCOMPLETE_STREAK_ALERT }, (_, i) =>
			run({ date: `2026-09-2${i}`, finished: false }),
		);
		expect(incompleteStreak(history)).toBe(INCOMPLETE_STREAK_ALERT);
		const d = decideNotification(history[history.length - 1], history, monday);
		expect(d.send).toBe(true);
		expect(d.prefix).toContain("ALERT");
	});
});

describe("recordRun", () => {
	it("appends, replaces same-date reruns, and persists", async () => {
		const storage = createMockStorage();
		await recordRun(storage, run({ date: "2026-09-20" }));
		await recordRun(storage, run({ date: "2026-09-21", flagged: 1 }));
		await recordRun(storage, run({ date: "2026-09-21", flagged: 3 }));
		const history = await readRunHistory(storage);
		expect(history.map((r) => r.date)).toEqual(["2026-09-20", "2026-09-21"]);
		expect(history[1].flagged).toBe(3);
	});
});

describe("run history read failures", () => {
	it("backs up a corrupt file, then heals it", async () => {
		const storage = createMockStorage();
		await storage.write("memory/meta/reflection-runs.json", "{}");
		const errors: string[] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((m: string) => {
			errors.push(String(m));
		});
		try {
			expect(await readRunHistory(storage)).toEqual([]);
			await recordRun(storage, run({ date: "2026-11-23" }));
		} finally {
			spy.mockRestore();
		}
		expect(
			(await storage.read("memory/meta/reflection-runs.corrupt-2026-11-23.json"))?.content,
		).toBe("{}");
		expect(
			JSON.parse((await storage.read("memory/meta/reflection-runs.json"))?.content ?? ""),
		).toHaveLength(1);
		expect(errors.some((e) => e.includes("run_history_read_failed"))).toBe(true);
		expect(errors.some((e) => e.includes("run_history_corrupt_reset"))).toBe(true);
	});

	it("skips the write when storage itself fails", async () => {
		const storage = createMockStorage();
		await storage.write(
			"memory/meta/reflection-runs.json",
			JSON.stringify([run({ date: "2026-11-22" })]),
		);
		const read = storage.read.bind(storage);
		storage.read = async () => {
			throw new Error("R2 down");
		};
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(await recordRun(storage, run({ date: "2026-11-23" }))).toHaveLength(1);
		} finally {
			spy.mockRestore();
			storage.read = read;
		}
		expect(
			JSON.parse((await storage.read("memory/meta/reflection-runs.json"))?.content ?? "")[0].date,
		).toBe("2026-11-22");
	});

	it("drops malformed entries inside a good array", async () => {
		const storage = createMockStorage();
		await storage.write(
			"memory/meta/reflection-runs.json",
			JSON.stringify([null, { date: 1 }, run({ date: "2026-11-22" })]),
		);
		expect((await readRunHistory(storage)).map((r) => r.date)).toEqual(["2026-11-22"]);
	});
});
