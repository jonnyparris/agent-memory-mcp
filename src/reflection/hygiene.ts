/**
 * Deterministic memory hygiene.
 *
 * Replaces the old LLM "quick scan". That phase spent 5-12 model turns a night
 * reading every file to look for trailing whitespace and missing newlines, and
 * in months of runs never applied a fix. These rules are mechanical, so they
 * are done with code: instant, free, and the same every time.
 *
 * Only changes that cannot alter meaning are made:
 * - trailing spaces/tabs are stripped, except an exact two-space markdown
 *   hard line break
 * - runs of 3+ blank lines are collapsed to 2
 * - the file ends with exactly one newline
 *
 * Nothing inside a fenced code block is touched.
 */

import { indexWrite } from "../search/index-write";
import type { R2Storage } from "../storage/r2";
import type { Env } from "../types";
import type { AutoAppliedFix } from "./tool-executor";

/** Paths hygiene never touches: machine output, archives, fixtures. */
const SKIP_PREFIXES = [
	"memory/reflections/",
	"memory/meta/",
	"memory/_bench/",
	"memory/archive/",
	"_history/",
];

export function isHygieneTarget(path: string): boolean {
	if (!path.startsWith("memory/") || !path.endsWith(".md")) return false;
	return !SKIP_PREFIXES.some((p) => path.startsWith(p));
}

/** Apply the hygiene rules to one file's content. Returns the new content. */
export function tidyMarkdown(content: string): string {
	if (!content) return content;
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];
	let inFence = false;
	let fenceMarker = "";
	let blankRun = 0;

	for (const line of lines) {
		const fence = line.match(/^\s*(```+|~~~+)/);
		if (fence) {
			if (!inFence) {
				inFence = true;
				fenceMarker = fence[1][0];
			} else if (fence[1][0] === fenceMarker) {
				inFence = false;
			}
			blankRun = 0;
			out.push(line.replace(/[ \t]+$/, ""));
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}

		let tidy = line;
		const trailing = line.match(/[ \t]+$/)?.[0] ?? "";
		if (trailing && trailing !== "  ") {
			tidy = line.slice(0, line.length - trailing.length);
		}
		if (tidy.trim() === "") {
			blankRun++;
			if (blankRun > 2) continue;
			out.push("");
			continue;
		}
		blankRun = 0;
		out.push(tidy);
	}

	// A file left with an open fence is malformed; don't guess, return as-is.
	if (inFence) return content;

	return `${out.join("\n").replace(/\s+$/, "")}\n`;
}

export interface HygieneResult {
	fixes: AutoAppliedFix[];
	failures: string[];
	scanned: number;
}

/**
 * Tidy every eligible memory file. In dry-run mode nothing is written, but the
 * fixes that would be made are still reported.
 */
export async function runHygiene(
	env: Env,
	storage: R2Storage,
	options?: { dryRun?: boolean },
): Promise<HygieneResult> {
	const files = (await storage.list("memory", true)).filter((f) => isHygieneTarget(f.path));
	const fixes: AutoAppliedFix[] = [];
	const failures: string[] = [];

	for (const f of files) {
		const file = await storage.read(f.path);
		if (!file) continue;
		const tidied = tidyMarkdown(file.content);
		if (tidied === file.content || tidied.trim().length === 0) continue;

		if (!options?.dryRun) {
			try {
				const result = await indexWrite(env, storage, f.path, tidied, { detectOverlaps: false });
				if (result.embedding_error) {
					failures.push(
						`hygiene: ${f.path} — saved, but index update failed (${result.embedding_error})`,
					);
					continue;
				}
			} catch (e) {
				failures.push(`hygiene: ${f.path} — ${e instanceof Error ? e.message : String(e)}`);
				continue;
			}
		}
		fixes.push({
			path: f.path,
			fixType: "whitespace",
			reason: `Whitespace tidy (${file.content.length - tidied.length} chars removed)`,
		});
	}

	return { fixes, failures, scanned: files.length };
}
