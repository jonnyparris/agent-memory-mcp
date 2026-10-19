import { type JevAi, type OverlapAnalysis, checkForSecrets, classifyOverlap } from "../jev";
import type { R2Storage } from "../storage/r2";
import { parseTags } from "../tags";
import { extractSnippet } from "../truncate";
import type { Env } from "../types";
import { parseWikilinks } from "../wikilinks";
import { getMemoryIndex } from "./client";
import { indexSkipReason } from "./indexable";

export interface IndexWriteResult {
	success: boolean;
	version_id?: string;
	tags: string[];
	links: string[];
	embedding_error?: string;
	/**
	 * Neighbours that look like duplicates. `score` is the retrieval cosine
	 * (opening of the new file vs the neighbour's best chunk); `coverage` is
	 * the chunk-vs-chunk score the flag decision uses.
	 */
	overlaps?: Array<{ path: string; score: number; coverage: number; snippet: string }>;
	/**
	 * Jev-classified relationship for each flagged overlap (when the
	 * classification succeeded). `verdict` + a concrete `action` suggestion.
	 */
	overlap_analysis?: OverlapAnalysis[];
	/**
	 * Set when the calibrated credential gate matched (noul ≥ threshold).
	 * The R2 write succeeded but the file was NOT indexed.
	 */
	secret_warning?: string;
	/**
	 * `true` when the embedding update was deferred via `ctx.waitUntil` and
	 * has not been awaited. The R2 write has already landed; the search
	 * index will become consistent within ~1–3s.
	 */
	index_deferred?: boolean;
	/**
	 * Set when `path` is on the index denylist (see `./indexable`). The R2
	 * write succeeded but the file deliberately received no embedding, so it
	 * will never appear in `search` results. Surfaced explicitly because a
	 * silent skip is indistinguishable from a bug at the call site.
	 */
	index_skipped?: string;
	/**
	 * Version id under which the content this write *replaced* was saved.
	 * Absent on a first write (nothing was superseded). Pass it to
	 * `rollback` to undo this write.
	 */
	previous_version_id?: string;
}

export interface IndexWriteOptions {
	/**
	 * Run a similarity search after the embedding update and surface the
	 * top matches as `overlaps`. Adds an extra DO round-trip plus up to 5
	 * R2 reads, so leave off for bulk or low-stakes writes.
	 */
	detectOverlaps?: boolean;
	/**
	 * Cloudflare ExecutionContext. When provided together with
	 * `waitForIndex: false`, the embedding update runs in
	 * `ctx.waitUntil` and the function returns as soon as the R2 write
	 * lands. Without `ctx`, the index update is always awaited inline.
	 */
	ctx?: ExecutionContext;
	/**
	 * When `false` and `ctx` is provided, defer the embedding update to
	 * `ctx.waitUntil` and return immediately after the R2 write. Default:
	 * `true` (legacy behaviour — caller blocks on the index update).
	 *
	 * Mutually exclusive with `detectOverlaps: true` — overlap detection
	 * needs the index update to complete before the similarity search
	 * runs, so deferring the index would defeat the feature. When both
	 * are set, overlap detection wins and the write blocks anyway.
	 */
	waitForIndex?: boolean;
	/**
	 * Opt in to writing empty content. Refused by default: an
	 * empty-string write is almost always a caller bug, and the embedding
	 * pipeline produces no tags/links/overlap warnings to flag the
	 * mistake. Callers who genuinely want to truncate a file must set
	 * this to `true`.
	 *
	 * Snapshots (see `HISTORY_PREFIX`) now make such a write recoverable,
	 * which is why this is still only a guard and not a hard block — but
	 * recovery you never discover you need is no better than none, so the
	 * refusal stays.
	 *
	 * See https://github.com/jonnyparris/agent-memory-mcp/issues/8.
	 */
	allowEmpty?: boolean;
}

/**
 * Thrown by `indexWrite` when the caller passes empty content without
 * setting `allowEmpty: true`. Surfaced as a structured MCP error at the
 * tool boundary so the caller sees a clear remediation hint instead of
 * silently truncating a file.
 */
export class EmptyContentError extends Error {
	constructor(path: string) {
		super(
			`Refusing to write empty content to ${path}. Pass allow_empty: true to override (this overwrites the existing file with zero bytes).`,
		);
		this.name = "EmptyContentError";
	}
}

/**
 * Write a file to R2 and update the search index in one go.
 *
 * Both the `write` MCP tool and `apply_reflection_changes` need the same
 * sequence: persist to R2, parse tags + wikilinks out of the content, push
 * the embedding update to the Durable Object, and (optionally) surface
 * semantic overlap warnings so callers don't silently create duplicate
 * memory files.
 *
 * Errors in the embedding update don't fail the whole write — the file
 * still lands in R2, and the caller gets `embedding_error` to surface to
 * the user. When the index update is deferred via `waitUntil`, embedding
 * errors are logged but never propagated back to the caller (the response
 * is already returned).
 */
export async function indexWrite(
	env: Env,
	storage: R2Storage,
	path: string,
	content: string,
	options: IndexWriteOptions = {},
): Promise<IndexWriteResult> {
	// Refuse empty writes by default. Empty-string overwrites are
	// almost always a caller bug (a templating step that produced no
	// content, a partial response, a swallowed exception). They are now
	// recoverable from `_history/`, but a caller who did not mean to
	// truncate will not think to look, so keep failing loudly. Callers
	// who genuinely want to truncate a file opt in with `allowEmpty`.
	if (content.length === 0 && !options.allowEmpty) {
		throw new EmptyContentError(path);
	}

	// Snapshot the superseded content. This is the one write path a human
	// or an agent drives directly, which is exactly where a careless
	// full-file overwrite happens; the machine-written indexes
	// (`reminders/index.json`, `conversations/index.json`) call
	// `storage.write` without this and stay history-free.
	const result = await storage.write(path, content, { history: true });
	const tags = parseTags(content);
	const links = parseWikilinks(content);

	const response: IndexWriteResult = {
		success: true,
		version_id: result.version_id,
		previous_version_id: result.previous_version_id,
		tags,
		links,
	};

	// Denylisted paths still land in R2 — they just don't get a vector.
	//
	// The `delete` is not redundant. A file written before its rule existed
	// already has a stale vector, and rewriting it is the natural moment to
	// drop it, so the index converges on the current ruleset without waiting
	// for the next `prune`. Deferred via `waitUntil` where possible: bulk
	// archive writes land 200 at a time and shouldn't each pay a blocking DO
	// round-trip for what is usually a no-op.
	const skipReason = indexSkipReason(path);
	if (skipReason) {
		response.index_skipped = skipReason;
		const dropStale = getMemoryIndex(env)
			.delete(path)
			.catch((e) => {
				console.error(`Failed to drop stale vector for denylisted ${path}:`, e);
			});
		if (options.ctx) {
			options.ctx.waitUntil(dropStale);
		} else {
			await dropStale;
		}
		return response;
	}

	const wantOverlaps = options.detectOverlaps && path.startsWith("memory/");
	// `waitForIndex` defaults to true to preserve legacy behaviour. Overlap
	// detection forces inline-await regardless because it has to read the
	// freshly-updated index.
	const shouldDefer = options.ctx && options.waitForIndex === false && !wantOverlaps;

	const ai = env.AI as unknown as JevAi;

	// Calibrated credential gate — runs on every indexable write (denylisted
	// paths never reach search, so there's nothing to protect there). On a
	// confident hit the file is stored but not embedded, mirroring denylist
	// behaviour; fail-open keeps a Jev outage from blocking writes.
	const hasSecret = await checkForSecrets(ai, content);
	if (hasSecret === true) {
		response.index_skipped = "possible-credentials";
		response.secret_warning =
			"Content looks like it contains live credentials, so it was stored but NOT indexed (it will not appear in search results). Re-write the file if this is a false positive.";
		return response;
	}

	const index = getMemoryIndex(env);

	if (shouldDefer && options.ctx) {
		options.ctx.waitUntil(
			index.update({ path, content, tags, links }).catch((e) => {
				// Nothing to surface to the caller — the response has already
				// been returned. Log so the failure is visible in tail logs.
				console.error(`Deferred index update failed for ${path}:`, e);
			}),
		);
		response.index_deferred = true;
		return response;
	}

	try {
		await index.update({ path, content, tags, links });

		if (wantOverlaps) {
			// Two steps. Retrieval: the top 5 files by cosine between the new
			// file's opening 8,000 characters and each file's best chunk
			// (vector mode, so `score` is a similarity, not a fusion score).
			// Filter: flag a neighbour only when chunk-vs-chunk coverage
			// (`coverage` in ./vectors — how much of either file the other
			// already says) reaches OVERLAP_COVERAGE.
			//
			// Tuned on 151 hand-labelled pairs (34 duplicates: 8 written
			// independently, 17 old versions from `_history/`, 9 copies left by
			// moves; 117 related/unrelated/tombstone) over the live memory
			// corpus (237 indexed files, 1,185 top-5 neighbour pairs):
			// - Old filter, retrieval cosine >= 0.77: caught 31/34 duplicates
			//   and sent 18% of neighbour pairs to Jev.
			// - Coverage >= 0.74: catches 33/34 (all 8 independent ones) and
			//   sends 12% to Jev. AUC duplicate-vs-rest 0.97 vs 0.92 (95%
			//   bootstrap CI on the gain +0.01..+0.10).
			// - 0.74 sits between the highest unrelated pair (0.724) and the
			//   lowest independent duplicate (0.754). One labeller, and the
			//   threshold was picked on the same labels, so treat as indicative.
			// Harness: agent-hq scratch/ai-search-spike-2026-10-15/overlap-tune/v2.
			const OVERLAP_COVERAGE = 0.74;
			const candidates = (
				await index.search({
					query: content.slice(0, 8000),
					limit: 5,
					timeWeight: false,
					mode: "vector",
				})
			).filter((c) => c.id !== path && c.id.startsWith("memory/"));
			const cover =
				candidates.length > 0
					? await index.coverage({ path, others: candidates.map((c) => c.id) })
					: {};
			const overlaps = await Promise.all(
				candidates
					.filter((c) => (cover[c.id] ?? 0) >= OVERLAP_COVERAGE)
					.map(async (c) => {
						const file = await storage.read(c.id);
						// The snippet is the file opening on purpose, not the matching
						// chunk (c.chunk) that search results use. Jev classifies from
						// it, and the opening holds the title and summary. On 75
						// labelled pairs a matching-chunk snippet kept duplicate recall
						// (30/31) but doubled false `supersedes` on related files (3 ->
						// 6 of 33). Opening plus chunk was no better (4-5 of 33).
						return {
							path: c.id,
							score: Math.round(c.score * 1000) / 1000,
							coverage: Math.round((cover[c.id] ?? 0) * 1000) / 1000,
							snippet: file ? extractSnippet(file.content, { maxLength: 300 }) : "",
						};
					}),
			);
			if (overlaps.length > 0) {
				response.overlaps = overlaps;
				// Calibrated relationship analysis per flagged overlap — turns
				// "these look similar" into a concrete verdict + action.
				const analyses = (
					await Promise.all(
						overlaps.map((o) =>
							classifyOverlap(ai, path, content, {
								path: o.path,
								snippet: o.snippet,
								score: o.score,
							}),
						),
					)
				).filter((a): a is OverlapAnalysis => a !== null);
				if (analyses.length > 0) {
					response.overlap_analysis = analyses;
				}
			}
		}
	} catch (e) {
		response.embedding_error = e instanceof Error ? e.message : String(e);
	}

	return response;
}
