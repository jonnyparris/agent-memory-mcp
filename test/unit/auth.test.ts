import { describe, expect, it } from "vitest";
import { unauthorizedResponse, validateAuth } from "../../src/auth";
import type { Env } from "../../src/types";

function createMockEnv(token = "test-token"): Env {
	return {
		MEMORY_AUTH_TOKEN: token,
		MEMORY_BUCKET: {} as any,
		MEMORY_INDEX: {} as any,
		AI: {} as any,
	};
}

function createRequest(authHeader?: string): Request {
	const headers = new Headers();
	if (authHeader) {
		headers.set("Authorization", authHeader);
	}
	return new Request("http://localhost/mcp", { headers });
}

describe("validateAuth", () => {
	describe("valid tokens", () => {
		it("should accept valid Bearer token", () => {
			const request = createRequest("Bearer test-token");
			const env = createMockEnv("test-token");

			const result = validateAuth(request, env);

			expect(result.authorized).toBe(true);
			expect(result.error).toBeUndefined();
		});

		it("should accept token with special characters", () => {
			const token = "abc123!@#$%^&*()_+-=[]{}|;':\",./<>?";
			const request = createRequest(`Bearer ${token}`);
			const env = createMockEnv(token);

			const result = validateAuth(request, env);

			expect(result.authorized).toBe(true);
		});

		it("should accept long tokens", () => {
			const token = "a".repeat(1000);
			const request = createRequest(`Bearer ${token}`);
			const env = createMockEnv(token);

			const result = validateAuth(request, env);

			expect(result.authorized).toBe(true);
		});
	});

	describe("missing or malformed headers", () => {
		it("should reject missing Authorization header", () => {
			const request = createRequest();
			const env = createMockEnv();

			const result = validateAuth(request, env);

			expect(result.authorized).toBe(false);
			expect(result.error).toBe("Missing Authorization header");
		});

		it("should reject non-Bearer auth scheme", () => {
			const request = createRequest("Basic dXNlcjpwYXNz");
			const env = createMockEnv();

			const result = validateAuth(request, env);

			expect(result.authorized).toBe(false);
			expect(result.error).toContain("Invalid Authorization header format");
		});

		it("should reject Bearer with no token", () => {
			const request = createRequest("Bearer ");
			const env = createMockEnv();

			const result = validateAuth(request, env);

			expect(result.authorized).toBe(false);
			expect(result.error).toBe("Empty token");
		});

		it("should reject 'Bearer' with no space", () => {
			const request = createRequest("Bearertoken");
			const env = createMockEnv();

			const result = validateAuth(request, env);

			expect(result.authorized).toBe(false);
			expect(result.error).toContain("Invalid Authorization header format");
		});
	});

	describe("invalid tokens", () => {
		it("should reject wrong token", () => {
			const request = createRequest("Bearer wrong-token");
			const env = createMockEnv("correct-token");

			const result = validateAuth(request, env);

			expect(result.authorized).toBe(false);
			expect(result.error).toBe("Invalid token");
		});

		it("should reject token with extra whitespace", () => {
			const request = createRequest("Bearer  test-token");
			const env = createMockEnv("test-token");

			const result = validateAuth(request, env);

			// Extra space becomes part of token
			expect(result.authorized).toBe(false);
			expect(result.error).toBe("Invalid token");
		});

		it("should reject similar but not identical tokens", () => {
			const request = createRequest("Bearer test-token1");
			const env = createMockEnv("test-token");

			const result = validateAuth(request, env);

			expect(result.authorized).toBe(false);
		});
	});

	describe("server misconfiguration", () => {
		it("should reject when MEMORY_AUTH_TOKEN is not set", () => {
			const request = createRequest("Bearer test-token");
			const env = createMockEnv("");

			const result = validateAuth(request, env);

			expect(result.authorized).toBe(false);
			expect(result.error).toContain("MEMORY_AUTH_TOKEN not set");
		});
	});
});

describe("unauthorizedResponse", () => {
	it("should return 401 status", () => {
		const response = unauthorizedResponse("Test error");
		expect(response.status).toBe(401);
	});

	it("should return JSON-RPC error format", async () => {
		const response = unauthorizedResponse("Test error message");
		const body = await response.json();

		expect(body).toEqual({
			jsonrpc: "2.0",
			error: {
				code: -32001,
				message: "Test error message",
			},
		});
	});

	it("should set Content-Type header", () => {
		const response = unauthorizedResponse("Test");
		expect(response.headers.get("Content-Type")).toBe("application/json");
	});
});
