import { describe, expect, it } from "vitest";
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
