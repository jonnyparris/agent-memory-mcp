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
