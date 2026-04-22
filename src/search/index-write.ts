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
}

/**
 * Write a file to R2 and update the search index in one go.
 *
 * Both the `write` MCP tool and `apply_reflection_changes` need the same
 * sequence: persist to R2, parse tags + wikilinks out of the content, push
 * the embedding update to the Durable Object, and surface semantic overlap
 * warnings so callers don't silently create duplicate memory files.
 *
 * Errors in embedding update don't fail the whole write — the file still
 * lands in R2, and the caller gets `embedding_error` to surface to the user.
 */
export async function indexWrite(
	env: Env,
	storage: R2Storage,
	path: string,
	content: string,
	options: { detectOverlaps?: boolean } = {},
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

	try {
		const index = getMemoryIndex(env);
		await index.update({ path, content, tags, links });

		// Overlap detection runs a similarity search after the write so callers
		// see "this overlaps with X" hints. Gated behind an option because it
		// adds an extra DO round-trip — on by default for interactive writes,
		// off for bulk reflection edits that already know what they're doing.
		if (options.detectOverlaps && path.startsWith("memory/")) {
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
