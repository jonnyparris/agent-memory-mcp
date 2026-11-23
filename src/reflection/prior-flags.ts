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
 * - the card says when a path was flagged before, and since when
 * - `memory/meta/reflection-dispositions.md` records "keep, decided" calls;
 *   the model's flags on those paths are dropped in code, not left to the
 *   model. System flags (refused deletes and rewrites, write failures) are
 *   never dropped. The model can't write `memory/meta/`, so it can't add a
 *   disposition to silence itself (see PROTECTED_PREFIXES in tool-executor).
 */

import type { R2Storage } from "../storage/r2";
import { readRunHistory } from "./run-history";
import { type FlaggedIssue, protectedPathError } from "./tool-executor";

export const ARCHIVE_DIR = "memory/reflections/archive";
export const DISPOSITIONS_PATH = "memory/meta/reflection-dispositions.md";
/** Earlier runs of the same focus to look back over (one a week). */
export const PRIOR_RUNS = 4;
/** Most prior paths listed in the prompt; the rest are counted. */
export const PROMPT_MAX_PATHS = 25;
const GIST_CHARS = 160;
/**
 * Any leading "Repeat (…):" label: ours, one the model copied from an old
 * card, or one it wrote itself ("Repeat (flagged 11-09, 11-16 — unchanged).").
 * Stripped before labelling, so the label is always the code's own and never
 * stacks. The parentheses must open with "[path] [also] flagged" and a number
 * ("flagged on 3 of…", "flagged 11-09…"), so "Repeat (weekly):", "Repeat
 * (flagged by Ruskin):" and "Repeat (not flagged…):" stay. One level of
 * nested parentheses and a trailing ":", ".", "," or dash are taken too.
 */
const REPEAT_PREFIX =
	/^\s*(?:repeat\s*\((?:path\s+)?(?:also\s+)?flagged\s+(?:on\s+)?\d(?:[^()]|\([^()]*\))*\)\s*[:.,\u2014\u2013-]?\s*)+/i;

export interface PriorFlag {
	path: string;
	/** Run dates that flagged this path, oldest first. */
	dates: string[];
	/** Start of the newest issue text. */
	gist: string;
}

export interface PriorFlags {
	/** Run dates looked at, oldest first. */
	runs: string[];
	flags: PriorFlag[];
}

export interface Disposition {
	path: string;
	reason: string;
	/** YYYY-MM-DD after which the decision lapses and the path can be flagged again. */
	until?: string;
}

/** Flags from the last `runs` runs with this focus title, before `today`. */
export async function loadPriorFlags(
	storage: R2Storage,
	focusTitle: string,
	today: string,
	runs = PRIOR_RUNS,
): Promise<PriorFlags> {
	if (runs <= 0) return { runs: [], flags: [] };
	const history = await readRunHistory(storage);
	const dates = [
		...new Set(history.filter((r) => r.focus === focusTitle && r.date < today).map((r) => r.date)),
	]
		.sort()
		.slice(-runs);

	const byPath = new Map<string, PriorFlag>();
	const window: string[] = [];
	for (const date of dates) {
		const path = `${ARCHIVE_DIR}/${date}.json`;
		let parsed: unknown;
		try {
			const file = await storage.read(path);
			// A run with no sidecar still counts toward "the last K runs".
			if (!file) {
				window.push(date);
				continue;
			}
			parsed = JSON.parse(file.content);
		} catch (e) {
			console.error(JSON.stringify({ event: "prior_flags_read_failed", path, error: String(e) }));
			window.push(date);
			continue;
		}
		// History and archive can drift (a manual re-run, a failed history write):
		// trust the sidecar's own focus when it has one.
		if (isRecord(parsed) && typeof parsed.focus === "string" && parsed.focus !== focusTitle)
			continue;
		window.push(date);
		if (!isRecord(parsed)) continue;
		const flags = Array.isArray(parsed.flaggedIssues) ? parsed.flaggedIssues : [];
		for (const f of flags) {
			if (!isRecord(f) || typeof f.path !== "string" || !f.path) continue;
			// Notices about this job's own state are not something the model can re-check.
			if (protectedPathError(f.path)) continue;
			const entry = byPath.get(f.path) ?? { path: f.path, dates: [], gist: "" };
			if (!entry.dates.includes(date)) entry.dates.push(date);
			entry.gist = oneLine(String(f.issue ?? "").replace(REPEAT_PREFIX, "")).slice(0, GIST_CHARS);
			byPath.set(f.path, entry);
		}
	}
	const flags = [...byPath.values()].sort(
		(a, b) => b.dates.length - a.dates.length || a.path.localeCompare(b.path),
	);
	return { runs: window, flags };
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
	} catch (e) {
		console.error(
			JSON.stringify({
				event: "dispositions_read_failed",
				path: DISPOSITIONS_PATH,
				error: String(e),
			}),
		);
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

/** The disposition covering this path (exact file, or a folder entry ending in "/"), if any. */
export function covered(path: string, dispositions: Disposition[]): Disposition | undefined {
	return dispositions.find(
		(d) => d.path === path || (d.path.endsWith("/") && path.startsWith(d.path)),
	);
}

/** The block added to the deep-analysis prompt. Empty when there is nothing to say. */
export function priorFlagsPrompt(prior: PriorFlags, dispositions: Disposition[]): string {
	const parts: string[] = [];
	const open = prior.flags.filter((p) => !covered(p.path, dispositions));
	if (open.length > 0) {
		const shown = open.slice(0, PROMPT_MAX_PATHS);
		const more = open.length - shown.length;
		parts.push(
			`The last ${prior.runs.length} run(s) of this focus (${prior.runs.join(", ")}) flagged these paths. Re-check each one first: if it is fixed, say nothing about it. If it is still true, flag it again; the card adds the repeat label itself, so don't write one, and keep the fix specific and short.\n${shown
				.map((p) => `- ${p.path} (${p.dates.length} of these runs, from ${p.dates[0]}): ${p.gist}`)
				.join("\n")}${more > 0 ? `\n- ...and ${more} more` : ""}`,
		);
	}
	if (dispositions.length > 0) {
		parts.push(
			`Decided by the human, do not flag (your flags on these are dropped):\n${dispositions
				.map((d) => `- ${d.path}: ${d.reason}`)
				.join("\n")}`,
		);
	}
	return parts.join("\n\n");
}

/**
 * Drop the model's flags on decided paths and mark paths flagged before.
 * `modelFlags` holds the flags that came from the flagIssue tool; any other
 * flag is a system notice and is never dropped.
 */
export function annotateFlags(
	flags: FlaggedIssue[],
	prior: PriorFlags,
	dispositions: Disposition[],
	modelFlags: ReadonlySet<FlaggedIssue>,
): { flags: FlaggedIssue[]; suppressed: string[] } {
	const byPath = new Map(prior.flags.map((p) => [p.path, p]));
	const kept: FlaggedIssue[] = [];
	const suppressed: string[] = [];
	for (const f of flags) {
		if (modelFlags.has(f) && covered(f.path, dispositions)) {
			suppressed.push(f.path);
			continue;
		}
		const p = byPath.get(f.path);
		const issue = f.issue.replace(REPEAT_PREFIX, "");
		if (p) kept.push({ ...f, issue: `${repeatLabel(p, prior.runs.length)} ${issue}` });
		else kept.push(issue === f.issue ? f : { ...f, issue });
	}
	return { flags: kept, suppressed };
}

/** "Repeat (also flagged on 3 of this focus's last 4 runs, from 2026-11-02):" (the window only, not all history). */
export function repeatLabel(p: PriorFlag, runs: number): string {
	return `Repeat (also flagged on ${p.dates.length} of this focus's last ${Math.max(runs, p.dates.length)} runs, from ${p.dates[0]}):`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}
