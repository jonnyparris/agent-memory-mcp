/**
 * What earlier runs of the same focus already flagged, and what the human
 * decided about it.
 *
 * Each focus runs once a week, and every run started blind. The plans focus
 * flagged the same April plans on 7 Mondays in a row (2026-09-28 → 11-23) and
 * the card read the same each week, so nothing marked a finding as old news
 * or as already decided. Now:
 *
 * - the model gets the last few runs' flags for its focus, so it re-checks
 *   them instead of rediscovering them
 * - the card says when a flag is a repeat and since when
 * - `memory/meta/reflection-dispositions.md` records "keep, decided" calls;
 *   flags on those paths are dropped in code, not left to the model
 */

import type { R2Storage } from "../storage/r2";
import { readRunHistory } from "./run-history";
import type { FlaggedIssue } from "./tool-executor";

export const ARCHIVE_DIR = "memory/reflections/archive";
export const DISPOSITIONS_PATH = "memory/meta/reflection-dispositions.md";
/** Earlier runs of the same focus to look back over (one a week). */
export const PRIOR_RUNS = 4;
const GIST_CHARS = 160;
/** The prefix annotateFlags adds; stripped before a flag is reused as a gist. */
const REPEAT_PREFIX = /^Repeat \(flagged on [^)]*\): /;

export interface PriorFlag {
	path: string;
	/** Run dates that flagged this path, oldest first. */
	dates: string[];
	/** Start of the newest issue text. */
	gist: string;
}

export interface Disposition {
	path: string;
	reason: string;
	/** YYYY-MM-DD after which the decision lapses and the path can be flagged again. */
	until?: string;
}

/** Flags from the last PRIOR_RUNS runs with this focus title, before `today`. */
export async function loadPriorFlags(
	storage: R2Storage,
	focusTitle: string,
	today: string,
	runs = PRIOR_RUNS,
): Promise<PriorFlag[]> {
	const history = await readRunHistory(storage);
	const dates = history
		.filter((r) => r.focus === focusTitle && r.date < today)
		.map((r) => r.date)
		.sort()
		.slice(-runs);

	const byPath = new Map<string, PriorFlag>();
	for (const date of dates) {
		let flags: FlaggedIssue[] = [];
		try {
			const file = await storage.read(`${ARCHIVE_DIR}/${date}.json`);
			if (!file) continue;
			const parsed = JSON.parse(file.content);
			if (Array.isArray(parsed?.flaggedIssues)) flags = parsed.flaggedIssues;
		} catch {
			continue;
		}
		for (const f of flags) {
			if (typeof f?.path !== "string" || !f.path) continue;
			const entry = byPath.get(f.path) ?? { path: f.path, dates: [], gist: "" };
			if (!entry.dates.includes(date)) entry.dates.push(date);
			entry.gist = oneLine(String(f.issue ?? "").replace(REPEAT_PREFIX, "")).slice(0, GIST_CHARS);
			byPath.set(f.path, entry);
		}
	}
	return [...byPath.values()].sort(
		(a, b) => b.dates.length - a.dates.length || a.path.localeCompare(b.path),
	);
}

/**
 * Parse the dispositions file. One decision per bullet:
 *
 *     - memory/workload/plans/foo.md — kept: still live, Ruskin 11-23 (until 2027-01-31)
 *
 * Backticks around the path are fine. The "(until …)" part is optional.
 * Expired entries are dropped.
 */
export async function loadDispositions(storage: R2Storage, today: string): Promise<Disposition[]> {
	let content = "";
	try {
		content = (await storage.read(DISPOSITIONS_PATH))?.content ?? "";
	} catch {
		return [];
	}
	return parseDispositions(content).filter((d) => !d.until || d.until >= today);
}

export function parseDispositions(content: string): Disposition[] {
	const out: Disposition[] = [];
	for (const line of content.split("\n")) {
		const m = /^\s*[-*]\s+`?(memory\/[^\s`]+)`?\s+[—–-]+\s+(.+?)\s*$/.exec(line);
		if (!m) continue;
		const until = /\(until (\d{4}-\d{2}-\d{2})\)\s*$/.exec(m[2]);
		out.push({
			path: m[1],
			reason: until ? m[2].slice(0, until.index).trim() : m[2],
			until: until?.[1],
		});
	}
	return out;
}

/** True if a disposition covers this path (exact file, or a folder entry ending in "/"). */
export function covered(path: string, dispositions: Disposition[]): Disposition | undefined {
	return dispositions.find(
		(d) => d.path === path || (d.path.endsWith("/") && path.startsWith(d.path)),
	);
}

/** The block added to the deep-analysis prompt. Empty when there is nothing to say. */
export function priorFlagsPrompt(prior: PriorFlag[], dispositions: Disposition[]): string {
	const parts: string[] = [];
	const open = prior.filter((p) => !covered(p.path, dispositions));
	if (open.length > 0) {
		parts.push(
			`Earlier runs of this focus flagged these. Re-check each one first: if it is fixed, say nothing about it. If it is still true, flag it again; the card marks it as a repeat, so keep the fix specific and short.\n${open
				.map((p) => `- ${p.path} (${p.dates.length}x, first ${p.dates[0]}): ${p.gist}`)
				.join("\n")}`,
		);
	}
	if (dispositions.length > 0) {
		parts.push(
			`Decided by the human, do not flag (their flags are dropped anyway):\n${dispositions
				.map((d) => `- ${d.path}: ${d.reason}`)
				.join("\n")}`,
		);
	}
	return parts.join("\n\n");
}

/**
 * Drop flags the human already decided on and mark repeats. Returns the
 * kept flags plus the paths that were dropped.
 */
export function annotateFlags(
	flags: FlaggedIssue[],
	prior: PriorFlag[],
	dispositions: Disposition[],
): { flags: FlaggedIssue[]; suppressed: string[] } {
	const byPath = new Map(prior.map((p) => [p.path, p]));
	const kept: FlaggedIssue[] = [];
	const suppressed: string[] = [];
	for (const f of flags) {
		if (covered(f.path, dispositions)) {
			suppressed.push(f.path);
			continue;
		}
		const p = byPath.get(f.path);
		if (p && !REPEAT_PREFIX.test(f.issue)) {
			kept.push({
				...f,
				issue: `Repeat (flagged on ${p.dates.length} earlier run${p.dates.length === 1 ? "" : "s"} since ${p.dates[0]}): ${f.issue}`,
			});
		} else {
			kept.push(f);
		}
	}
	return { flags: kept, suppressed };
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}
