/**
 * Keyword search helpers for the SQLite FTS5 table in `MemoryIndex`.
 *
 * Embeddings are bad at exact terms: ticket keys, hostnames, people's names,
 * error strings. On the spike query set the exact-term slice scored recall@5
 * 0.40 on the old index and 1.00 once a keyword path was fused in. FTS5 with
 * BM25 ranking is built into Durable Object SQLite, so the keyword path costs
 * one virtual table and no extra service.
 */

/** Tokeniser for the FTS5 table. Porter stemming over unicode61 word splitting. */
export const FTS_TOKENIZE = "porter unicode61";

/** Upper bound on distinct query terms, so a pasted paragraph stays cheap. */
const MAX_QUERY_TERMS = 64;

/**
 * Turn free text into an FTS5 MATCH expression, or `null` if it has no terms.
 *
 * Every term is quoted, which makes FTS5 treat it as a literal phrase. That
 * matters because raw user text is full of FTS5 syntax: `-` (NOT), `:`
 * (column filter), `*`, `^`, parentheses, and bare `AND`/`OR`/`NOT`. Quoting
 * neutralises all of it.
 *
 * Identifiers like `PAY-123` or `agent_memory.ts` stay together as a single
 * phrase (`"pay 123"`). The tokeniser splits them on punctuation, and a phrase
 * requires the parts to be adjacent, so `PAY-123` will not match a file that
 * merely contains "pay" and "123" far apart.
 *
 * Terms are ORed, not ANDed. BM25 already rewards files that match more of
 * them. AND made natural-language queries fail whenever one word was absent:
 * AI Search's default keyword AND scored MRR 0.84 on the spike set against
 * 0.91 for OR.
 */
export function buildFtsQuery(query: string): string | null {
	const terms = query.toLowerCase().match(/[\p{L}\p{N}]+(?:[-_.][\p{L}\p{N}]+)*/gu);
	if (!terms) return null;
	const phrases: string[] = [];
	const seen = new Set<string>();
	for (const term of terms) {
		const phrase = `"${term.split(/[-_.]/).join(" ")}"`;
		if (seen.has(phrase)) continue;
		seen.add(phrase);
		phrases.push(phrase);
		if (phrases.length >= MAX_QUERY_TERMS) break;
	}
	return phrases.join(" OR ");
}

/** Reciprocal Rank Fusion constant. 60 is the value from the original paper and the spike. */
export const RRF_K = 60;

/**
 * Fuse ranked path lists with Reciprocal Rank Fusion.
 *
 * Each list contributes `1 / (k + rank)` per path (rank starting at 1). RRF
 * ignores raw scores, which is the point: cosine similarity and BM25 live on
 * unrelated scales and cannot be added directly.
 *
 * Scores are normalised so that a path ranked first in every list scores
 * 1.0. With two lists, a path ranked first by one and absent from the other
 * scores 0.5. These are rank-fusion scores, not similarities.
 */
export function reciprocalRankFusion(
	lists: string[][],
	k = RRF_K,
): Array<{ id: string; score: number }> {
	const scores = new Map<string, number>();
	for (const list of lists) {
		list.forEach((id, i) => {
			scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
		});
	}
	const max = lists.length / (k + 1);
	return [...scores.entries()]
		.map(([id, score]) => ({ id, score: max > 0 ? score / max : 0 }))
		.sort((a, b) => b.score - a.score);
}
