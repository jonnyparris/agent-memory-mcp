import type { R2Storage } from "../storage/r2";
import { parseTags } from "../tags";
import { extractSnippet } from "../truncate";
import type { Env } from "../types";
import { parseWikilinks } from "../wikilinks";
import { getMemoryIndex } from "./client";

export interface IndexWriteResult {
	success: boolean;
	version_id?: string;
	tags: string[];
	links: string[];
	embedding_error?: string;
	overlaps?: Array<{ path: string; score: number; snippet: string }>;
	/**
	 * `true` when the embedding update was deferred via `ctx.waitUntil` and
	 * has not been awaited. The R2 write has already landed; the search
	 * index will become consistent within ~1–3s.
	 */
	index_deferred?: boolean;
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
	const result = await storage.write(path, content);
	const tags = parseTags(content);
	const links = parseWikilinks(content);

	const response: IndexWriteResult = {
		success: true,
		version_id: result.version_id,
		tags,
		links,
	};

	const wantOverlaps = options.detectOverlaps && path.startsWith("memory/");
	// `waitForIndex` defaults to true to preserve legacy behaviour. Overlap
	// detection forces inline-await regardless because it has to read the
	// freshly-updated index.
	const shouldDefer = options.ctx && options.waitForIndex === false && !wantOverlaps;

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
			const OVERLAP_THRESHOLD = 0.72;
			const candidates = await index.search({
				query: content.slice(0, 8000),
				limit: 5,
				timeWeight: false,
			});
			const overlaps = await Promise.all(
				candidates
					.filter(
						(c) => c.id !== path && c.id.startsWith("memory/") && c.score >= OVERLAP_THRESHOLD,
					)
					.map(async (c) => {
						const file = await storage.read(c.id);
						return {
							path: c.id,
							score: Math.round(c.score * 1000) / 1000,
							snippet: file ? extractSnippet(file.content, { maxLength: 300 }) : "",
						};
					}),
			);
			if (overlaps.length > 0) {
				response.overlaps = overlaps;
			}
		}
	} catch (e) {
		response.embedding_error = e instanceof Error ? e.message : String(e);
	}

	return response;
}
