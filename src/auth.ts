import type { Env } from "./types";

export interface AuthResult {
	authorized: boolean;
	error?: string;
}

/**
 * Validate Bearer token from Authorization header.
 *
 * Async because the underlying comparison uses `crypto.subtle.digest` to
 * avoid leaking information about the token length or prefix matches
 * through timing. Callers must `await` the result.
 */
export async function validateAuth(request: Request, env: Env): Promise<AuthResult> {
	const authHeader = request.headers.get("Authorization");

	if (!authHeader) {
		return { authorized: false, error: "Missing Authorization header" };
	}

	// Handle "Bearer " with no token — the Headers API trims trailing
	// whitespace, so "Bearer " becomes "Bearer".
	if (authHeader === "Bearer") {
		return { authorized: false, error: "Empty token" };
	}

	if (!authHeader.startsWith("Bearer ")) {
		return {
			authorized: false,
			error: "Invalid Authorization header format. Expected: Bearer <token>",
		};
	}

	const token = authHeader.slice(7);

	if (!token) {
		return { authorized: false, error: "Empty token" };
	}

	if (!env.MEMORY_AUTH_TOKEN) {
		return { authorized: false, error: "Server misconfigured: MEMORY_AUTH_TOKEN not set" };
	}

	if (!(await constantTimeEqual(token, env.MEMORY_AUTH_TOKEN))) {
		return { authorized: false, error: "Invalid token" };
	}

	return { authorized: true };
}

/**
 * Constant-time string comparison to prevent timing attacks.
 *
 * Uses Web Crypto's SubtleCrypto to hash both inputs with SHA-256 first, then
 * does a fixed-length comparison on the 32-byte digests. This means the
 * comparison time is independent of both the token length and where the
 * strings diverge — a naive byte-by-byte loop leaks the length via an early
 * return and leaks the prefix match length via its runtime.
 *
 * Workers expose `crypto.subtle` globally. This is async, but tokens are
 * rarely compared on hot paths (once per auth'd request), so the overhead
 * is negligible.
 */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [hashA, hashB] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(a)),
		crypto.subtle.digest("SHA-256", encoder.encode(b)),
	]);

	const viewA = new Uint8Array(hashA);
	const viewB = new Uint8Array(hashB);

	// Fixed-length XOR accumulate — both digests are always 32 bytes so the
	// loop runs the same number of iterations regardless of input length.
	let result = 0;
	for (let i = 0; i < viewA.length; i++) {
		result |= viewA[i] ^ viewB[i];
	}
	return result === 0;
}

/**
 * Create an unauthorized response
 */
export function unauthorizedResponse(error: string): Response {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			error: {
				code: -32001,
				message: error,
			},
		}),
		{
			status: 401,
			headers: { "Content-Type": "application/json" },
		},
	);
}
