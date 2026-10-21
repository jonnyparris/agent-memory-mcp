/**
 * Vector helpers for the exact-scan index.
 *
 * Vectors are stored L2-normalised as raw float32 bytes. Normalising once at
 * write time turns cosine similarity into a plain dot product at query time,
 * and float32 blobs are a quarter the size of the JSON text the index used to
 * store, with no parse step on cold start.
 */

/** Cosine similarity between two equal-length vectors, in [-1, 1]. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denominator = Math.sqrt(normA) * Math.sqrt(normB);
	return denominator === 0 ? 0 : dot / denominator;
}

/** Copy `v` into a unit-length Float32Array. A zero vector stays zero. */
export function normalise(v: ArrayLike<number>): Float32Array {
	let norm = 0;
	for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
	norm = Math.sqrt(norm);
	const out = new Float32Array(v.length);
	if (norm === 0) return out;
	for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
	return out;
}

/** Dot product. Equals cosine similarity when both inputs are unit length. */
export function dot(a: Float32Array, b: Float32Array): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] * b[i];
	return s;
}

/**
 * How much of one file the other already covers, from their chunk vectors.
 *
 * For each chunk of `a`, take its best cosine against any chunk of `b`, and
 * average: that is "how much of `a` is already said somewhere in `b`". Do the
 * same the other way and return the larger. So the score is high when either
 * file is mostly contained in the other — a rewrite, an older version, or a
 * small note whose content already sits inside a big file.
 *
 * Overlap detection uses this to decide which neighbours to flag. On 151
 * hand-labelled memory pairs (34 duplicates) it ranked duplicates above
 * related files better than the old score — the opening 8,000 characters of
 * the new file against the best single chunk of the neighbour (AUC 0.97 vs
 * 0.92). The old score also undersold long files: two identical 16 KB files
 * scored 0.81, because an 8,000-character vector never matches one
 * 1,500-character chunk closely. Chunk against chunk, they score 1.0.
 *
 * Inputs must be unit length (as stored). Returns 0 when either side is empty.
 */
export function coverage(a: readonly Float32Array[], b: readonly Float32Array[]): number {
	return coverageDetail(a, b).coverage;
}

/**
 * `coverage`, plus `bestA`: the index of the chunk of `a` that best matches
 * any chunk of `b` (-1 when either side is empty). Overlap detection uses it
 * to pick which part of a long new file to show Jev.
 */
export function coverageDetail(
	a: readonly Float32Array[],
	b: readonly Float32Array[],
): { coverage: number; bestA: number } {
	if (a.length === 0 || b.length === 0) return { coverage: 0, bestA: -1 };
	const bestForA = new Array<number>(a.length).fill(Number.NEGATIVE_INFINITY);
	const bestForB = new Array<number>(b.length).fill(Number.NEGATIVE_INFINITY);
	for (let i = 0; i < a.length; i++) {
		for (let j = 0; j < b.length; j++) {
			const s = dot(a[i], b[j]);
			if (s > bestForA[i]) bestForA[i] = s;
			if (s > bestForB[j]) bestForB[j] = s;
		}
	}
	const mean = (xs: number[]) => xs.reduce((t, x) => t + x, 0) / xs.length;
	let bestA = 0;
	for (let i = 1; i < a.length; i++) if (bestForA[i] > bestForA[bestA]) bestA = i;
	return { coverage: Math.max(mean(bestForA), mean(bestForB)), bestA };
}

/** Serialise a vector to the bytes stored in SQLite. */
export function vectorToBlob(v: Float32Array): Uint8Array {
	return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

/** Read a vector back from SQLite. Copies, so the result owns its memory. */
export function blobToVector(raw: ArrayBuffer | Uint8Array): Float32Array {
	const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
	const copy = bytes.slice();
	return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

/** Parse a legacy JSON-encoded embedding (the pre-chunking `memories` table). */
export function legacyBlobToVector(raw: ArrayBuffer | Uint8Array): Float32Array {
	const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
	return normalise(JSON.parse(new TextDecoder().decode(bytes)) as number[]);
}
