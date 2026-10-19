/**
 * Split file content into overlapping chunks for embedding.
 *
 * The index used to embed one vector per file, capped at 20,000 characters.
 * Two things went wrong with that. Anything past the cap could never be
 * found, and a long hub file's single vector was an average of every topic in
 * it, so it matched no specific query well. On the AI Search spike query set
 * (docs/proposals/ai-search-backend.md), chunking alone moved recall@5 from
 * 0.69 to 0.95 with the same model, and every "answer deep in a long file"
 * query was found.
 *
 * Fixed-size character windows, not paragraph-aware splitting. That is the
 * exact scheme the spike measured, and its cached vectors can only validate
 * this code if the boundaries match. bge-m3 accepts 8192 tokens, so a
 * 1,500-character window is far inside the model limit whatever the
 * characters-per-token ratio.
 */

/** Characters per chunk. */
export const CHUNK_CHARS = 1500;

/** Characters shared between consecutive chunks (10%). */
export const CHUNK_OVERLAP = 150;

/**
 * Chunk `text` into windows of `size` characters overlapping by `overlap`.
 *
 * Returns an empty array for empty text. The last window ends exactly at the
 * end of the text, so no trailing sliver is ever emitted on its own.
 */
export function chunkText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
	if (text.length === 0) return [];
	if (overlap >= size) throw new Error(`overlap (${overlap}) must be smaller than size (${size})`);
	const out: string[] = [];
	for (let i = 0; ; i += size - overlap) {
		out.push(text.slice(i, i + size));
		if (i + size >= text.length) break;
	}
	return out;
}
