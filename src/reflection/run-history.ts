/**
 * Reflection run history and notification policy.
 *
 * The old behaviour sent a card every morning. For months that card said
 * "Memory looks good" while the reflection was silently failing, and a
 * message that never changes is one nobody reads. Now:
 *
 * - send when there is something to act on: edits, flags, failures, or an
 *   incomplete run
 * - stay quiet on a clean, finished run (whitespace tidies alone don't count)
 * - send a weekly heartbeat on Sundays so silence still proves it's alive
 * - raise an alert when the last few runs in a row were incomplete
 */

import type { R2Storage } from "../storage/r2";

export const RUN_HISTORY_PATH = "memory/meta/reflection-runs.json";
const MAX_RECORDS = 60;
/** Incomplete runs in a row that trigger an alert. */
export const INCOMPLETE_STREAK_ALERT = 3;

export interface RunRecord {
	date: string;
	focus: string;
	finished: boolean;
	success: boolean;
	edits: number;
	quickFixes: number;
	flagged: number;
	failed: number;
}

export async function readRunHistory(storage: R2Storage): Promise<RunRecord[]> {
	try {
		const file = await storage.read(RUN_HISTORY_PATH);
		if (!file) return [];
		const parsed = JSON.parse(file.content);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * Append a run (replacing any earlier run on the same date, e.g. a manual
 * re-run) and return the updated history, newest last.
 */
export async function recordRun(storage: R2Storage, record: RunRecord): Promise<RunRecord[]> {
	const history = (await readRunHistory(storage)).filter((r) => r.date !== record.date);
	history.push(record);
	history.sort((a, b) => a.date.localeCompare(b.date));
	const trimmed = history.slice(-MAX_RECORDS);
	try {
		await storage.write(RUN_HISTORY_PATH, `${JSON.stringify(trimmed, null, 2)}\n`);
	} catch (e) {
		console.error(JSON.stringify({ event: "run_history_write_failed", error: String(e) }));
	}
	return trimmed;
}

/** Number of consecutive incomplete runs, counting back from the newest. */
export function incompleteStreak(history: RunRecord[]): number {
	let n = 0;
	for (let i = history.length - 1; i >= 0 && !history[i].finished; i--) n++;
	return n;
}

export interface NotificationDecision {
	send: boolean;
	reason: string;
	/** Text to put at the top of the summary (alerts, weekly stats). */
	prefix?: string;
}

export function decideNotification(
	record: RunRecord,
	history: RunRecord[],
	now: Date,
): NotificationDecision {
	const prefixes: string[] = [];

	const streak = incompleteStreak(history);
	if (streak >= INCOMPLETE_STREAK_ALERT) {
		prefixes.push(
			`ALERT: reflection has not finished ${streak} runs in a row. Something is wrong with the model or the loop, not with memory. Check the worker logs.`,
		);
	}

	const isSunday = now.getUTCDay() === 0;
	if (isSunday) {
		const week = history.slice(-7);
		const sum = (k: keyof RunRecord) => week.reduce((n, r) => n + (Number(r[k]) || 0), 0);
		const unfinished = week.filter((r) => !r.finished).length;
		prefixes.push(
			`Weekly: ${week.length} runs, ${sum("edits")} edits, ${sum("flagged")} flagged, ${sum("failed")} failed, ${unfinished} unfinished.`,
		);
	}

	const prefix = prefixes.length > 0 ? prefixes.join("\n") : undefined;

	if (streak >= INCOMPLETE_STREAK_ALERT) return { send: true, reason: "incomplete streak", prefix };
	if (record.failed > 0) return { send: true, reason: "failures", prefix };
	if (!record.finished) return { send: true, reason: "incomplete", prefix };
	if (record.edits > 0 || record.flagged > 0) return { send: true, reason: "findings", prefix };
	if (isSunday) return { send: true, reason: "weekly heartbeat", prefix };
	return { send: false, reason: "clean run, nothing to report", prefix };
}
