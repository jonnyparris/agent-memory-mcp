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
		return await readRunHistoryStrict(storage);
	} catch (e) {
		const salvaged = e instanceof CorruptHistoryError ? e.salvaged : [];
		// Callers fall back to the records still readable (none for a storage error); say so, or a corrupt file hides itself.
		console.error(
			JSON.stringify({
				event: "run_history_read_failed",
				path: RUN_HISTORY_PATH,
				error: String(e),
			}),
		);
		return salvaged;
	}
}

class CorruptHistoryError extends Error {
	constructor(
		message: string,
		readonly content: string,
		/** Records that were still readable; kept when the file is rewritten. */
		readonly salvaged: RunRecord[] = [],
	) {
		super(message);
	}
}

function isRunRecord(r: unknown): r is RunRecord {
	if (typeof r !== "object" || r === null) return false;
	const x = r as Record<string, unknown>;
	return (
		typeof x.date === "string" &&
		/^\d{4}-\d{2}-\d{2}$/.test(x.date) &&
		typeof x.focus === "string" &&
		typeof x.finished === "boolean" &&
		typeof x.success === "boolean"
	);
}

/**
 * Like readRunHistory, but throws. A storage error is thrown as is. A file
 * that isn't a JSON array, or an array with malformed entries, is a
 * CorruptHistoryError carrying the raw text and the readable records
 * (`salvaged`); recordRun backs the raw file up before rewriting. Missing file = [].
 */
async function readRunHistoryStrict(storage: R2Storage): Promise<RunRecord[]> {
	const file = await storage.read(RUN_HISTORY_PATH);
	if (!file) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(file.content);
	} catch (e) {
		throw new CorruptHistoryError(
			`${RUN_HISTORY_PATH} is not valid JSON: ${String(e)}`,
			file.content,
		);
	}
	if (!Array.isArray(parsed)) {
		throw new CorruptHistoryError(`${RUN_HISTORY_PATH} is not a JSON array`, file.content);
	}
	const good = parsed.filter(isRunRecord);
	if (good.length !== parsed.length) {
		// Don't silently lose records: recordRun backs the raw file up before it rewrites.
		throw new CorruptHistoryError(
			`${RUN_HISTORY_PATH} has ${parsed.length - good.length} malformed entr${parsed.length - good.length === 1 ? "y" : "ies"}`,
			file.content,
			good,
		);
	}
	return good;
}

/**
 * Append a run (replacing any earlier run on the same date, e.g. a manual
 * re-run) and return the updated history, newest last.
 *
 * A storage error while reading skips the write: writing would replace the
 * whole history with this one record. A corrupt file is copied aside to
 * `reflection-runs.corrupt-<date>.json` (`-2`, `-3`… if that day's backup
 * exists) and then rewritten with the readable records, so history heals
 * instead of freezing. If no free backup name can be confirmed, nothing is written.
 */
export async function recordRun(storage: R2Storage, record: RunRecord): Promise<RunRecord[]> {
	let existing: RunRecord[];
	try {
		existing = await readRunHistoryStrict(storage);
	} catch (e) {
		if (!(e instanceof CorruptHistoryError)) {
			console.error(
				JSON.stringify({
					event: "run_history_read_failed",
					path: RUN_HISTORY_PATH,
					error: String(e),
					skippedWrite: true,
				}),
			);
			return [record];
		}
		let backup: string | undefined;
		try {
			for (let n = 1; n < 100 && !backup; n++) {
				const name = RUN_HISTORY_PATH.replace(
					/\.json$/,
					`.corrupt-${record.date}${n === 1 ? "" : `-${n}`}.json`,
				);
				if (!(await storage.read(name))) backup = name;
			}
			if (!backup) throw new Error("no free backup name");
			await storage.write(backup, e.content);
		} catch (we) {
			console.error(
				JSON.stringify({
					event: "run_history_backup_failed",
					path: backup,
					error: String(we),
					skippedWrite: true,
				}),
			);
			return [record];
		}
		console.error(
			JSON.stringify({
				event: "run_history_corrupt_reset",
				path: RUN_HISTORY_PATH,
				backup,
				error: e.message,
			}),
		);
		existing = e.salvaged;
	}
	const history = existing.filter((r) => r.date !== record.date);
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
