const EMBEDDING_MODEL = "@cf/baai/bge-m3";
const EMBEDDING_DIMENSIONS = 1024;

export interface EmbeddingResult {
	vector: number[];
	dimensions: number;
}

/**
 * Character budget for a single embedding call.
 *
 * bge-m3 accepts 8192 tokens. The previous cap of 32000 characters assumed
 * roughly 4 characters per token, which is too optimistic: memory files run
 * closer to 3.6 for prose and worse for code, JSON and non-English text.
 * `brag-sheet.md` truncated to 32000 characters still tokenised to 8908 and
 * was rejected outright, so a 40KB core memory file silently held a stale
 * vector while reporting success.
 *
 * 20000 keeps even ~2.5-characters-per-token content inside the limit. Files
 * longer than this are embedded on their opening section only — partial
 * recall, but recall.
 */
const MAX_EMBED_CHARS = 20_000;

/** Workers AI error text when the tokenised input exceeds the model limit. */
const TOO_LONG_RE = /sequence too long|too many tokens|maximum context/i;

export async function generateEmbedding(ai: Ai, text: string): Promise<EmbeddingResult> {
	// Character budgets only approximate the tokeniser, so back off on a
	// length rejection rather than failing the whole write. Halving converges
	// in a couple of attempts for any realistic tokens-per-character ratio.
	let budget = Math.min(text.length, MAX_EMBED_CHARS);
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

	// Workers AI bge-m3 returns { data: [[...numbers...]], shape: [1, 1024] }
	let vector: number[];

	if (response.data && Array.isArray(response.data) && response.data.length > 0) {
		const firstItem = response.data[0];
		if (Array.isArray(firstItem) && typeof firstItem[0] === "number") {
			// Format: { data: [[number, number, ...]] } - nested array
			vector = firstItem as number[];
		} else if (typeof firstItem === "object" && firstItem !== null && "embedding" in firstItem) {
			// Format: { data: [{ embedding: number[] }] }
			vector = (firstItem as { embedding: number[] }).embedding;
		} else if (typeof firstItem === "number") {
			// Format: { data: [number, number, ...] } - flat array
			vector = response.data as number[];
		} else {
			throw new Error(`Unexpected data array format: ${JSON.stringify(response).slice(0, 500)}`);
		}
	} else if (response.data && typeof response.data === "object" && "length" in response.data) {
		// Format: { shape: [...], data: Float32Array }
		vector = Array.from(response.data as ArrayLike<number>);
	} else {
		throw new Error(
			`Unexpected embedding response format: ${JSON.stringify(response).slice(0, 500)}`,
		);
	}

	if (!vector || vector.length === 0) {
		throw new Error("Empty embedding vector received");
	}

	return {
		vector,
		dimensions: vector.length,
	};
}

/**
 * Generate embeddings for multiple texts
 */
export async function generateEmbeddings(ai: Ai, texts: string[]): Promise<EmbeddingResult[]> {
	// Process in batches to avoid rate limits
	const batchSize = 10;
	const results: EmbeddingResult[] = [];

	for (let i = 0; i < texts.length; i += batchSize) {
		const batch = texts.slice(i, i + batchSize);
		const embeddings = await Promise.all(batch.map((text) => generateEmbedding(ai, text)));
		results.push(...embeddings);
	}

	return results;
}

export { EMBEDDING_DIMENSIONS };
