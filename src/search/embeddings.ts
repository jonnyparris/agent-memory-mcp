const EMBEDDING_MODEL = "@cf/baai/bge-m3";
const EMBEDDING_DIMENSIONS = 1024;

export interface EmbeddingResult {
	vector: number[];
	dimensions: number;
}

/**
 * Character cap for a single query embedding.
 *
 * Files are no longer embedded whole: `update` splits them into 1,500-character
 * chunks (see `./chunking`), so this cap only applies to search queries and to
 * the opening section used as the overlap-detection query. 8,000 characters
 * is enough for both and stays inside bge-m3's 8192-token limit for ordinary
 * prose. The length back-off below covers denser text.
 */
const MAX_QUERY_CHARS = 8_000;

/** Texts per Workers AI call when embedding chunks. */
const EMBED_BATCH_SIZE = 20;

/** Workers AI error text when the tokenised input exceeds the model limit. */
const TOO_LONG_RE = /sequence too long|too many tokens|maximum context/i;

export async function generateEmbedding(ai: Ai, text: string): Promise<EmbeddingResult> {
	// Character budgets only approximate the tokeniser, so back off on a
	// length rejection rather than failing the whole write. Halving converges
	// in a couple of attempts for any realistic tokens-per-character ratio.
	let budget = Math.min(text.length, MAX_QUERY_CHARS);
	let response: Record<string, unknown> | undefined;

	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			response = (await ai.run(EMBEDDING_MODEL, {
				text: text.slice(0, budget),
			})) as Record<string, unknown>;
			break;
		} catch (e) {
			const isLengthError = TOO_LONG_RE.test(e instanceof Error ? e.message : String(e));
			if (!isLengthError || attempt === 2) throw e;
			budget = Math.floor(budget / 2);
		}
	}

	if (!response) {
		throw new Error("Embedding model returned no response");
	}

	const vector = parseEmbeddingResponse(response)[0];

	if (!vector || vector.length === 0) {
		throw new Error("Empty embedding vector received");
	}

	return {
		vector,
		dimensions: vector.length,
	};
}

/**
 * Pull the vectors out of a Workers AI bge-m3 response, one per input text.
 *
 * The documented shape is `{ data: number[][], shape: [n, 1024] }`, but mocks
 * and older SDKs have produced `{ data: [{ embedding }] }`, a flat array for a
 * single input, and typed arrays. All are accepted.
 */
function parseEmbeddingResponse(response: Record<string, unknown>): number[][] {
	const data = response.data;
	if (Array.isArray(data) && data.length > 0) {
		const first = data[0];
		if (Array.isArray(first) || ArrayBuffer.isView(first)) {
			return data.map((row) => Array.from(row as ArrayLike<number>));
		}
		if (typeof first === "object" && first !== null && "embedding" in first) {
			return data.map((row) => (row as { embedding: number[] }).embedding);
		}
		if (typeof first === "number") {
			return [data as number[]];
		}
		throw new Error(`Unexpected data array format: ${JSON.stringify(response).slice(0, 500)}`);
	}
	if (data && typeof data === "object" && "length" in data) {
		return [Array.from(data as ArrayLike<number>)];
	}
	throw new Error(
		`Unexpected embedding response format: ${JSON.stringify(response).slice(0, 500)}`,
	);
}

/**
 * Embed many texts, `EMBED_BATCH_SIZE` per Workers AI call.
 *
 * Used for file chunks. A batch that comes back with the wrong number of
 * vectors, or is rejected as too long, is retried one text at a time through
 * `generateEmbedding`, which has its own length back-off. Any other error is
 * thrown: callers must not store a partial set of chunk vectors.
 */
export async function generateEmbeddings(ai: Ai, texts: string[]): Promise<EmbeddingResult[]> {
	const results: EmbeddingResult[] = [];
	for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
		const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
		let vectors: number[][] | null = null;
		try {
			const response = (await ai.run(EMBEDDING_MODEL, { text: batch })) as Record<string, unknown>;
			const parsed = parseEmbeddingResponse(response);
			if (parsed.length === batch.length && parsed.every((v) => v.length > 0)) vectors = parsed;
		} catch (e) {
			if (!TOO_LONG_RE.test(e instanceof Error ? e.message : String(e))) throw e;
		}
		if (vectors) {
			for (const vector of vectors) results.push({ vector, dimensions: vector.length });
		} else {
			for (const text of batch) results.push(await generateEmbedding(ai, text));
		}
	}
	return results;
}

export { EMBEDDING_DIMENSIONS };
