/**
 * Index eligibility rules.
 *
 * Every write used to get an embedding, unconditionally. That made the vector
 * space fill up with machine-generated bulk — superseded reflection archives
 * and per-ticket backlog-groom JSON — which by mid-2026 accounted for ~68% of
 * indexed files against 12 core memory documents. The practical symptom is
 * bad *discovery*: a vague query returns a wall of near-identical JSON at
 * scores around 0.45, crowding real hits out of the top-`limit` window, while
 * a precisely-worded query still works because the caller already knew what
 * they were looking for. Semantic search that only works when you know the
 * answer isn't doing its job.
 *
 * Denylisting is deliberately separate from deletion. These files stay in R2
 * and stay readable via `read` and `list` — they just don't get a vector. The
 * archives have genuine value as history; they have no business competing for
 * recall against `learnings.md`.
 *
 * Adding a rule here does not retroactively purge anything. Existing vectors
 * are removed by `MemoryIndex.prune()`, which re-tests every indexed path
 * against these rules and drops the ones that now fail.
 */

export interface DenyRule {
	pattern: RegExp;
	reason: string;
}

/**
 * Paths matching any of these rules are never embedded.
 *
 * Ordered most-specific-first so `indexSkipReason` reports the narrowest
 * applicable reason when several rules would match.
 */
export const INDEX_DENYLIST: readonly DenyRule[] = [
	{
		// Superseded copies kept by `storage.write({ history: true })`. These
		// are excluded from `list` as well, so in practice they never reach
		// the indexer — this rule is the backstop for a manual write to a
		// history path, and for any future reindex sweep that walks raw keys.
		// An old revision of learnings.md competing with learnings.md for
		// recall is the exact failure this denylist exists to prevent.
		pattern: /^_history\//,
		reason: "version history snapshot",
	},
	{
		// 232 files as of 2026-07. Each is a point-in-time snapshot that the
		// next day's reflection supersedes; the live view lives in
		// memory/reflections/ and the workload files it feeds.
		pattern: /^memory\/reflections\/archive\//,
		reason: "superseded reflection archive",
	},
	{
		// 204 files, one JSON blob per JIRA ticket, all sharing the same key
		// set. Structurally near-identical, so they cluster tightly and act
		// as a mid-score noise floor across unrelated queries. The
		// human-authored digests in ../summaries/ and ../actions/ stay
		// indexed.
		pattern: /^memory\/workload\/backlog-groom\/.*\/reports\//,
		reason: "machine-generated backlog-groom report",
	},
	{
		// Retired plans. Superseded by whatever replaced them; kept for
		// provenance only.
		pattern: /^memory\/workload\/plans\/archive\//,
		reason: "archived plan",
	},
	{
		// The nightly-reflect journal: 36 dated files sharing a section
		// skeleton, one per run. They became the dominant noise floor as soon
		// as the backlog-groom JSON was pruned — "lessons learned and gotchas"
		// returned three of them and no core file.
		//
		// Excluding them is not a loss of information. The pipeline's whole
		// purpose is to promote durable findings into learnings.md and the
		// workload files, which stay indexed; the dated entry is the raw
		// working-out kept for provenance. Callers that want a specific run
		// read it by path — /nightly-reflect and /daily-briefing already do,
		// and none of them discover it by search.
		//
		// Deliberately narrow: only the recurring journal suffixes match. The
		// other ~35 dated files under plans/ are one-off design and
		// investigation docs and remain indexed.
		pattern:
			/^memory\/workload\/plans\/\d{4}-\d{2}-\d{2}-(late-)?(improvement-proposals|nightly-reflection|evening-reflection)\.md$/,
		reason: "nightly reflection journal",
	},
	{
		// Benchmark fixtures from index performance testing. Never prose.
		pattern: /^memory\/_bench\//,
		reason: "benchmark fixture",
	},
	{
		// Working files, mirroring the `scratch/` convention in agent-hq. They
		// are drafts by definition and routinely near-duplicate a finished
		// document elsewhere: `scratch/agent-relay-onboarding-guide.md` is a
		// stale 12939-byte draft of the 13529-byte copy under
		// `memory/workload/`, and both were being returned for the same query,
		// spending two of three result slots on one document.
		pattern: /^scratch\//,
		reason: "scratch working file",
	},
	{
		// Embedding raw markup or binary bytes produces a vector that means
		// nothing. An SVG of an architecture diagram scored 0.47 against
		// "semantic search index health" purely on markup noise.
		pattern: /\.(svg|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|eot|zip|gz|tar|mp4|mov|wasm)$/i,
		reason: "non-prose file type",
	},
];

/**
 * Why `path` is excluded from the semantic index, or `null` if it is eligible.
 *
 * Exposed alongside `shouldIndex` so the `write` tool can tell the caller
 * their file landed in R2 but deliberately received no embedding — silent
 * skipping would look like a bug the first time someone searched for it.
 */
export function indexSkipReason(path: string): string | null {
	for (const rule of INDEX_DENYLIST) {
		if (rule.pattern.test(path)) return rule.reason;
	}
	return null;
}

/** Whether `path` should receive a semantic embedding. */
export function shouldIndex(path: string): boolean {
	return indexSkipReason(path) === null;
}
