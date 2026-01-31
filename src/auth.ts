import type { Env } from "./types";

export interface AuthResult {
	authorized: boolean;
	error?: string;
}

/**
 * Validate Bearer token from Authorization header
 */
export function validateAuth(request: Request, env: Env): AuthResult {
	const authHeader = request.headers.get("Authorization");

	if (!authHeader) {
		return { authorized: false, error: "Missing Authorization header" };
	}

	// Handle "Bearer " with no token (Headers API trims trailing space, so "Bearer " becomes "Bearer")
	if (authHeader === "Bearer") {
		return { authorized: false, error: "Empty token" };
	}

	if (!authHeader.startsWith("Bearer ")) {
		return {
			authorized: false,
			error: "Invalid Authorization header format. Expected: Bearer <token>",
		};
	}

	const token = authHeader.slice(7); // Remove "Bearer " prefix

	if (!token) {
		return { authorized: false, error: "Empty token" };
	}

	if (!env.MEMORY_AUTH_TOKEN) {
		return { authorized: false, error: "Server misconfigured: MEMORY_AUTH_TOKEN not set" };
	}

	// Constant-time comparison to prevent timing attacks
	if (!constantTimeEqual(token, env.MEMORY_AUTH_TOKEN)) {
		return { authorized: false, error: "Invalid token" };
	}

	return { authorized: true };
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}

	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
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
