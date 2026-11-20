/**
 * Split a large memory file by moving whole sections into a sibling file.
 *
 * The nightly reflection used to flag every file over ~50KB and stop there:
 * moving content out of a file is a `replace` that drops most of it, and the
 * shrink guard refuses that (rightly — a model-written rewrite of a big file is
 * usually "the page I read"). The same files were flagged run after run.
 *
 * A split is different: the model only names the sections (by exact heading)
 * and the target file. This module cuts the text by character offsets and
 * moves it verbatim, so nothing the model writes ends up in either file
 * except the pointer line. `computeSplit` is pure and checks its own output
 * before returning; `applySplit` re-reads both files and writes the target
 * before the source, so a failure part-way leaves a copy, never a loss, and a
 * retry skips sections the target already holds.
 */

import type { IndexWriteResult } from "../search/index-write";
import { indexWrite } from "../search/index-write";
import { isReadWrapper } from "../search/read-wrapper";
import type { R2Storage } from "../storage/r2";
import type { Env } from "../types";

/**
 * Smallest source a split may touch, in characters. The prompt says "~50KB";
 * this sits a little lower because UTF-8 bytes run above characters for
 * files with non-ASCII text, and a split just under the line is still useful.
 */
export const SPLIT_MIN_CHARS = 40_000;

/** Most splits one run may stage, and most sections one split may move. */
export const MAX_SPLITS_PER_RUN = 3;
export const MAX_SPLIT_HEADINGS = 200;
/** Longest heading a split accepts, and the most outline text returned in one error. */
const MAX_HEADING_CHARS = 500;
const OUTLINE_MAX_CHARS = 20_000;

/** Folders a split may not write into: this job's own output and snapshots. */
const FORBIDDEN_PREFIXES = ["memory/reflections/", "memory/meta/", "_history/"];

/**
 * Files another program rewrites by name. Work HQ reads this month's journal
 * archive, appends spilled days and writes the whole file back without a
 * precondition, so a split of it could be undone by Work HQ's next flush, or
 * lose a day Work HQ appends between our read and write. Closed months are
 * never written again and can be split.
 */
export function writerOwnedNow(path: string, date: string): boolean {
	const m = /(^|\/)work-hq-journal-archive-(\d{4}-\d{2})\.md$/.exec(path);
	return !!m && m[2] === date.slice(0, 7);
}

export class SplitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SplitError";
	}
}

export interface SplitInput {
	sourcePath: string;
	targetPath: string;
	source: string;
	/** Current target content, or null when the target does not exist yet. */
	target: string | null;
	headings: string[];
	/** YYYY-MM-DD, written into the pointer. */
	date: string;
}

export interface SplitOutput {
	source: string;
	target: string;
	/** Sections moved by this call (excludes ones the target already held). */
	moved: string[];
	/** Sections the target already held verbatim (a retry after a partial failure). */
	alreadyInTarget: string[];
	movedChars: number;
}

interface Heading {
	level: number;
	/** Heading line with trailing whitespace (and \r) removed. */
	text: string;
	start: number;
}

/** Strip a trailing \r and spaces so CRLF files compare like LF ones. */
function norm(line: string): string {
	return line.replace(/\s+$/, "");
}

/** Offset just past a leading YAML frontmatter block, or 0. */
function frontmatterEnd(text: string): number {
	const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(text);
	return m ? m[0].length : 0;
}

/**
 * ATX headings at column 0, outside frontmatter and fenced code.
 * Throws on an unclosed fence: guessing where code ends could cut a file in
 * the middle of a block.
 */
export function scanHeadings(text: string): Heading[] {
	const headings: Heading[] = [];
	let pos = frontmatterEnd(text);
	let fence: { char: string; len: number } | null = null;
	while (pos < text.length) {
		const nl = text.indexOf("\n", pos);
		const end = nl < 0 ? text.length : nl + 1;
		const line = text.slice(pos, nl < 0 ? text.length : nl);
		const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (fence) {
			if (f && f[1][0] === fence.char && f[1].length >= fence.len && norm(line).trim() === f[1]) {
				fence = null;
			}
		} else if (f) {
			fence = { char: f[1][0], len: f[1].length };
		} else {
			const h = /^(#{1,6})[ \t]+\S/.exec(line);
			if (h) headings.push({ level: h[1].length, text: norm(line), start: pos });
		}
		pos = end;
	}
	if (fence) {
		throw new SplitError("the file has an unclosed code fence; refusing to guess section ends");
	}
	return headings;
}

/** End offset of section i: the next heading of the same or a higher level, or EOF. */
function sectionEnd(hs: Heading[], i: number, textLength: number): number {
	for (let j = i + 1; j < hs.length; j++) {
		if (hs[j].level <= hs[i].level) return hs[j].start;
	}
	return textLength;
}

/** "## Heading (12,345 chars)" lines, so a model can retry without re-reading the file. */
export function headingOutline(text: string, limit = MAX_SPLIT_HEADINGS): string {
	let hs: Heading[];
	try {
		hs = scanHeadings(text);
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
	// Full heading text (the model copies these lines back), but a bounded
	// total: this goes into a tool result on every failed proposeSplit.
	const lines: string[] = [];
	let total = 0;
	for (let i = 0; i < hs.length && i < limit; i++) {
		const size = sectionEnd(hs, i, text.length) - hs[i].start;
		const line = `${hs[i].text} (${size.toLocaleString("en-US")} chars)`;
		if (total + line.length > OUTLINE_MAX_CHARS) break;
		lines.push(line);
		total += line.length + 1;
	}
	const rest = hs.length - lines.length;
	return rest > 0
		? `${lines.join("\n")}\n… ${rest} more headings not shown; read the file for their exact text`
		: lines.join("\n");
}

/**
 * True when `target` holds `section` as a section of its own: at a heading
 * line, exact text, ending at the end of the file or a line break. A plain
 * substring match would count a quote of the text (mid-line, in a code
 * block) as "already moved" and drop the section from the source.
 */
export function targetHasSection(target: string, section: string): boolean {
	const want = section.replace(/\s+$/, "");
	let hs: Heading[];
	try {
		hs = scanHeadings(target);
	} catch {
		return false;
	}
	const head = norm(want.split("\n", 1)[0]);
	return hs.some((h) => {
		if (h.text !== head || target.slice(h.start, h.start + want.length) !== want) return false;
		const next = target.charAt(h.start + want.length);
		return next === "" || next === "\n" || next === "\r";
	});
}

/**
 * Validate a memory path for a model-controlled write: canonical POSIX,
 * under memory/, markdown, outside this job's own folders.
 */
export function pathProblem(path: unknown): string | null {
	if (typeof path !== "string" || !path) return "path is required";
	if (path.length > 512) return "path is too long";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
	if (/[\u0000-\u001f\u007f\\]/.test(path)) return "path has a backslash or control character";
	if (path.startsWith("/")) return "path must be relative";
	const segs = path.split("/");
	if (segs.some((s) => s === "" || s === "." || s === "..")) {
		return "path has an empty, '.' or '..' segment";
	}
	if (!path.startsWith("memory/")) return "path must be under memory/";
	if (!path.endsWith(".md")) return "path must be a .md file";
	if (FORBIDDEN_PREFIXES.some((p) => path.startsWith(p))) {
		return "path is in a folder reflection may not write";
	}
	return null;
}

/** Validate the two paths of a split. Returns an error message or null. */
export function splitPathProblem(
	sourcePath: string,
	targetPath: string,
	date: string,
): string | null {
	const s = pathProblem(sourcePath);
	if (s) return `source: ${s}`;
	const t = pathProblem(targetPath);
	if (t) return `to: ${t}`;
	// The pointer is a wikilink; these characters would break it.
	if (/[[\]|#^]/.test(sourcePath) || /[[\]|#^]/.test(targetPath)) {
		return "paths may not contain [ ] | # or ^";
	}
	if (sourcePath === targetPath) return "to must differ from path";
	// Named after the source, next to it: refresh-log.md -> refresh-log-2026-10.md,
	// brag-sheet.md -> brag-sheet/2026-H2.md. Never an unrelated note.
	const base = sourcePath.slice(0, -".md".length);
	if (!targetPath.startsWith(`${base}-`) && !targetPath.startsWith(`${base}/`)) {
		return `to must be named after the source: ${base}-<suffix>.md or ${base}/<name>.md`;
	}
	if (writerOwnedNow(sourcePath, date) || writerOwnedNow(targetPath, date)) {
		return "Work HQ rewrites this month's journal archive; split it after the month ends";
	}
	return null;
}

/** The frontmatter "tags:" field of the source, with any list lines under it. */
function frontmatterTags(text: string): string | null {
	const end = frontmatterEnd(text);
	if (!end) return null;
	const lines = text.slice(0, end).split(/\r?\n/);
	const i = lines.findIndex((l) => /^tags:/.test(l));
	if (i < 0) return null;
	const out = [norm(lines[i])];
	for (let j = i + 1; j < lines.length && /^([ \t]+\S|-[ \t])/.test(lines[j]); j++) {
		out.push(norm(lines[j]));
	}
	return out.join("\n");
}

function title(sourcePath: string, hs: Heading[]): string {
	const h1 = hs.find((h) => h.level === 1);
	const base = h1
		? h1.text.replace(/^#\s+/, "")
		: sourcePath.split("/").pop()?.replace(/\.md$/, "");
	return `${base} — split`;
}

function linkTo(path: string): string {
	return `[[${path.replace(/\.md$/, "")}]]`;
}

/**
 * Work out the new source and target. Pure; throws SplitError when the split
 * is not safe to make.
 */
export function computeSplit(input: SplitInput): SplitOutput {
	const { sourcePath, targetPath, source, target, date } = input;
	const pathErr = splitPathProblem(sourcePath, targetPath, date);
	if (pathErr) throw new SplitError(pathErr);
	if (isReadWrapper(source)) {
		throw new SplitError("the source holds the read tool's display text, not file content");
	}
	if (target !== null && isReadWrapper(target)) {
		throw new SplitError("the target holds the read tool's display text, not file content");
	}
	if (target !== null) {
		try {
			scanHeadings(target);
		} catch {
			throw new SplitError(
				`${targetPath} has an unclosed code fence; flag it for a human to fix, don't split into another file`,
			);
		}
	}
	if (source.length < SPLIT_MIN_CHARS) {
		throw new SplitError(
			`the source is ${source.length.toLocaleString("en-US")} characters; splits start at ${SPLIT_MIN_CHARS.toLocaleString("en-US")}`,
		);
	}
	const wanted = (Array.isArray(input.headings) ? input.headings : []).map((h) =>
		typeof h === "string" ? norm(h) : "",
	);
	if (wanted.length === 0 || wanted.some((h) => !h)) {
		throw new SplitError("headings must be a non-empty list of exact heading lines");
	}
	if (wanted.some((h) => h.length > MAX_HEADING_CHARS)) {
		throw new SplitError(
			`a heading is over ${MAX_HEADING_CHARS} characters; flag this file instead`,
		);
	}
	if (wanted.length > MAX_SPLIT_HEADINGS) {
		throw new SplitError(`at most ${MAX_SPLIT_HEADINGS} headings per split; split again next run`);
	}
	if (new Set(wanted).size !== wanted.length) {
		throw new SplitError("headings lists the same heading twice");
	}

	const hs = scanHeadings(source);
	const picked: { i: number; start: number; end: number }[] = [];
	for (const w of wanted) {
		const matches = hs.map((h, i) => [h, i] as const).filter(([h]) => h.text === w);
		if (matches.length !== 1) {
			throw new SplitError(
				`heading ${JSON.stringify(w)} ${matches.length ? `appears ${matches.length} times` : "is not in the file"}. Headings in the file:\n${headingOutline(source)}`,
			);
		}
		const i = matches[0][1];
		picked.push({ i, start: hs[i].start, end: sectionEnd(hs, i, source.length) });
	}
	picked.sort((a, b) => a.start - b.start);
	for (let k = 1; k < picked.length; k++) {
		if (picked[k].start < picked[k - 1].end) {
			throw new SplitError(
				`${JSON.stringify(hs[picked[k].i].text)} is inside ${JSON.stringify(hs[picked[k - 1].i].text)}; pick one of them`,
			);
		}
	}

	// Something must stay besides the title, intro and pointers: at least one
	// section (a heading below H1) that is not moved.
	const staysSection = hs.some(
		(h) => h.level >= 2 && !picked.some((p) => h.start >= p.start && h.start < p.end),
	);
	if (!staysSection) {
		throw new SplitError("that moves every section; leave the newest or live ones in place");
	}

	const eol = source.includes("\r\n") ? "\r\n" : "\n";
	// Runs of adjacent picks share one pointer.
	const runs: { start: number; end: number; heads: string[] }[] = [];
	for (const p of picked) {
		const last = runs[runs.length - 1];
		if (last && last.end === p.start) {
			last.end = p.end;
			last.heads.push(hs[p.i].text);
		} else runs.push({ start: p.start, end: p.end, heads: [hs[p.i].text] });
	}

	const sections = picked.map((p) => source.slice(p.start, p.end));
	const alreadyInTarget =
		target === null ? [] : sections.filter((s) => targetHasSection(target, s));
	const moved = sections.filter((s) => !alreadyInTarget.includes(s));

	// New source: kept slices with a pointer where each run was.
	let out = "";
	let cursor = 0;
	const kept: string[] = [];
	for (const r of runs) {
		const before = source.slice(cursor, r.start);
		kept.push(before);
		const names = r.heads.map((h) => h.replace(/^#+\s+/, ""));
		const label =
			names.length <= 3
				? names.join("; ")
				: `${names[0]}; … ${names.length - 2} more …; ${names[names.length - 1]}`;
		const sep =
			before === "" || before.endsWith(`${eol}${eol}`)
				? ""
				: before.endsWith(eol)
					? eol
					: `${eol}${eol}`;
		out += `${before}${sep}Moved to ${linkTo(targetPath)} on ${date}: ${label}.${eol}${eol}`;
		cursor = r.end;
	}
	kept.push(source.slice(cursor));
	out += source.slice(cursor);

	// New target.
	let newTarget: string;
	const body = moved.map((s) => s.replace(/\s+$/, "")).join(`${eol}${eol}`);
	if (moved.length === 0) {
		newTarget = target ?? "";
	} else if (target === null) {
		const tags = frontmatterTags(source);
		const fm = tags ? `---${eol}${tags.replace(/\n/g, eol)}${eol}---${eol}${eol}` : "";
		newTarget = `${fm}# ${title(sourcePath, hs)}${eol}${eol}Sections moved verbatim out of ${linkTo(sourcePath)} on ${date}.${eol}${eol}${body}${eol}`;
	} else {
		newTarget = `${target.replace(/\s+$/, "")}${eol}${eol}${body}${eol}`;
	}

	// Self-check: every kept and moved byte is accounted for, in order.
	let rebuilt = "";
	for (let k = 0; k < runs.length; k++) {
		rebuilt += kept[k] + source.slice(runs[k].start, runs[k].end);
	}
	rebuilt += kept[kept.length - 1];
	if (rebuilt !== source) {
		throw new SplitError("internal check failed: the split does not rebuild the source");
	}
	if (moved.length > 0 && !newTarget.endsWith(`${body}${eol}`)) {
		throw new SplitError(
			"internal check failed: the moved sections are not at the end of the target",
		);
	}
	for (const s of sections) {
		if (!targetHasSection(newTarget, s)) {
			throw new SplitError("internal check failed: a moved section is missing from the target");
		}
	}
	for (const k of kept) {
		if (!out.includes(k)) {
			throw new SplitError("internal check failed: kept text is missing from the source");
		}
	}

	return {
		source: out,
		target: newTarget,
		moved,
		alreadyInTarget,
		movedChars: sections.reduce((n, s) => n + s.length, 0),
	};
}

function indexProblem(path: string, result: IndexWriteResult): string | null {
	return result.embedding_error ? `${path} (${result.embedding_error})` : null;
}

export interface SplitEdit {
	path: string;
	to?: string;
	headings?: string[];
}

export interface AppliedSplit {
	/** False when the split had already been applied (a re-run): nothing written. */
	wrote: boolean;
	/** Set when both files were saved but the search index update failed. */
	indexError?: string;
}

/**
 * True when every heading of the split is gone from the source, each is a
 * section of the target, and the source carries the pointer: a re-run of an
 * edit that already landed.
 */
function alreadyApplied(source: string, target: string | null, edit: SplitEdit): boolean {
	if (target === null || !edit.to || !edit.headings?.length) return false;
	let srcHeads: Set<string>;
	let tgtHeads: Set<string>;
	try {
		srcHeads = new Set(scanHeadings(source).map((h) => h.text));
		tgtHeads = new Set(scanHeadings(target).map((h) => h.text));
	} catch {
		return false;
	}
	return (
		source.includes(`Moved to ${linkTo(edit.to)}`) &&
		edit.headings.every((h) => !srcHeads.has(norm(h)) && tgtHeads.has(norm(h)))
	);
}

/**
 * Apply a split against the files as they are now. Target first, then the
 * source; each write re-checks that its file has not changed since the split
 * was computed. A failure after the target write leaves the sections in both
 * files (nothing lost), and a retry skips the copies already in the target.
 * A search-index failure does not stop it: the text matters more, and
 * stopping between the two writes would leave the sections in both files
 * every night the index is down. It comes back as `indexError`.
 */
export async function applySplit(
	env: Env,
	storage: R2Storage,
	edit: SplitEdit,
	date: string,
): Promise<AppliedSplit> {
	if (!edit.to) throw new SplitError("split has no target (to)");
	const pathErr = splitPathProblem(edit.path, edit.to, date);
	if (pathErr) throw new SplitError(pathErr);
	const src = await storage.read(edit.path);
	if (!src) throw new SplitError(`source not found: ${edit.path}`);
	const tgt = await storage.read(edit.to);
	if (alreadyApplied(src.content, tgt?.content ?? null, edit)) return { wrote: false };
	const result = computeSplit({
		sourcePath: edit.path,
		targetPath: edit.to,
		source: src.content,
		target: tgt?.content ?? null,
		headings: edit.headings ?? [],
		date,
	});

	const indexErrors: string[] = [];
	if (result.moved.length > 0) {
		const tgtNow = await storage.read(edit.to);
		if ((tgtNow?.content ?? null) !== (tgt?.content ?? null)) {
			throw new SplitError(`${edit.to} changed while the split was being applied; nothing written`);
		}
		const w = await indexWrite(env, storage, edit.to, result.target, { detectOverlaps: false });
		const p = indexProblem(edit.to, w);
		if (p) indexErrors.push(p);
	}
	const srcNow = await storage.read(edit.path);
	if (srcNow?.content !== src.content) {
		throw new SplitError(
			`${edit.path} changed while the split was being applied; the moved sections are in ${edit.to} and still in the source`,
		);
	}
	const w = await indexWrite(env, storage, edit.path, result.source, { detectOverlaps: false });
	const p = indexProblem(edit.path, w);
	if (p) indexErrors.push(p);
	return indexErrors.length
		? {
				wrote: true,
				indexError: `split done and both files saved, but the search index update failed for ${indexErrors.join(", ")}. Reindex these files before relying on search.`,
			}
		: { wrote: true };
}

/**
 * Why a create or replace may not run beside the splits in `edits`, or null.
 * It was written from the file before the split moved sections out of it (or
 * into it), so applying it would undo the move or overwrite the moved text.
 * One rule for staging and both apply loops.
 */
export function splitConflict(
	edit: { action: string; path: string },
	edits: { action: string; path: string; to?: string }[],
): string | null {
	if (edit.action !== "replace" && edit.action !== "create") return null;
	const hit = edits.find(
		(e) => e.action === "split" && (e.path === edit.path || e.to === edit.path),
	);
	return hit
		? `a split (${hit.path} -> ${hit.to}) touches ${edit.path} in the same reflection`
		: null;
}
