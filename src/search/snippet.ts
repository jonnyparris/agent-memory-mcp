import { extractSnippet } from "../truncate";
import { CHUNK_CHARS, CHUNK_OVERLAP } from "./chunking";

/**
 * Build a search-result snippet around the part of a file that matched.
 *
 * Search scores a file by its best chunk, so a hit can sit 30,000 characters
 * into a long hub file. Snippets used to come from the file opening, which
 * showed the agent the top of `active-todos.md` and none of the text that
 * matched. The index now reports the best chunk (`IndexHit.chunk`), and this
 * centres the snippet on it.
 *
 * Inside the chunk (1,500 characters, wider than a snippet) it centres on
 * the densest cluster of query terms, so a keyword hit shows the keyword. If
 * no query term appears there (a pure vector match), it centres on the chunk
 * middle. With no chunk (older index response) it looks for the terms across
 * the whole file, and falls back to the file opening.
 */

/** Matches are clustered within this many characters either side. */
const CLUSTER_RADIUS = 200;

/** Words too common to locate anything. Short terms (< 3 chars) are dropped too. */
const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"are",
	"was",
	"but",
	"not",
	"you",
	"all",
	"any",
	"can",
	"had",
	"has",
	"have",
	"her",
	"his",
	"how",
	"its",
	"our",
	"out",
	"who",
	"why",
	"what",
	"when",
	"where",
	"which",
	"with",
	"this",
	"that",
	"from",
	"into",
	"about",
	"does",
	"did",
	"been",
	"were",
	"they",
	"them",
	"their",
	"there",
	"then",
	"than",
	"will",
	"would",
	"should",
	"could",
]);

/** Start offset of chunk `idx` in the file, per `chunkText`'s fixed windows. */
export function chunkStart(idx: number): number {
	return idx * (CHUNK_CHARS - CHUNK_OVERLAP);
}

/**
 * Query terms as regexes. Tokenised like `buildFtsQuery`, so `PAY-4821`
 * stays one term; its parts may be joined by `-`, `_`, `.` or whitespace,
 * matching what the FTS phrase would. Terms match at a word start and as a
 * prefix, a rough stand-in for the index's Porter stemming ("plan" finds
 * "planning").
 */
function termPatterns(query: string): RegExp[] {
	const terms = query.toLowerCase().match(/[\p{L}\p{N}]+(?:[-_.][\p{L}\p{N}]+)*/gu) ?? [];
	const out: RegExp[] = [];
	const seen = new Set<string>();
	for (const term of terms) {
		if (seen.has(term)) continue;
		seen.add(term);
		if (STOPWORDS.has(term)) continue;
		if (term.length < 3 && !/^\p{N}+$/u.test(term)) continue;
		const body = term
			.split(/[-_.]/)
			.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join("[-_.\\s]");
		out.push(new RegExp(`(?<![\\p{L}\\p{N}])${body}`, "giu"));
	}
	return out;
}

/**
 * Position in `content[from, to)` with the most distinct query terms within
 * `CLUSTER_RADIUS`. Ties go to the earliest. `null` if no term occurs.
 */
export function bestMatchPosition(
	content: string,
	query: string,
	from = 0,
	to = content.length,
): number | null {
	const window = content.slice(from, to);
	const hits: Array<{ pos: number; term: number }> = [];
	termPatterns(query).forEach((re, term) => {
		for (const m of window.matchAll(re)) hits.push({ pos: from + (m.index ?? 0), term });
	});
	if (hits.length === 0) return null;
	hits.sort((a, b) => a.pos - b.pos);

	let best = hits[0].pos;
	let bestCount = 0;
	for (const h of hits) {
		const near = new Set<number>();
		for (const o of hits) {
			if (Math.abs(o.pos - h.pos) <= CLUSTER_RADIUS) near.add(o.term);
		}
		if (near.size > bestCount) {
			bestCount = near.size;
			best = h.pos;
		}
	}
	return best;
}

/** Snippet of `content` around the matching chunk. See the module comment. */
export function searchSnippet(
	content: string,
	query: string,
	chunk?: number,
	maxLength?: number,
): string {
	let position = 0;
	if (chunk !== undefined && chunk >= 0) {
		// Clamp: the file may have changed since it was indexed.
		const start = Math.min(chunkStart(chunk), Math.max(0, content.length - 1));
		const end = Math.min(content.length, start + CHUNK_CHARS);
		position = bestMatchPosition(content, query, start, end) ?? Math.floor((start + end) / 2);
	} else {
		position = bestMatchPosition(content, query) ?? 0;
	}
	return extractSnippet(content, { position, ...(maxLength ? { maxLength } : {}) });
}
