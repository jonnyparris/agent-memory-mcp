import { afterAll, describe, expect, it } from "vitest";

/**
 * E2E tests against the deployed worker
 * Run with: MEMORY_MCP_URL=https://your-worker.workers.dev MEMORY_AUTH_TOKEN=xxx npm run test:e2e
 *
 * Point it at a throwaway instance (wrangler.e2e.jsonc), not a real memory
 * store. It still cleans up after itself: everything goes under one
 * per-run directory, and afterAll purges it (file + history snapshots).
 */

const MCP_URL = process.env.MEMORY_MCP_URL;
const AUTH_TOKEN = process.env.MEMORY_AUTH_TOKEN;

// Skip tests if env vars not set
const describeE2E = MCP_URL && AUTH_TOKEN ? describe : describe.skip;

describeE2E("E2E: Deployed Worker", () => {
	async function callMcp(method: string, params: Record<string, unknown>) {
		const response = await fetch(`${MCP_URL}/mcp`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AUTH_TOKEN}`,
				"Content-Type": "application/json",
				// MCP Streamable HTTP requires both JSON and SSE in Accept.
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: Date.now(),
				method,
				params,
			}),
		});

		return response.json();
	}

	async function callTool(name: string, args: Record<string, unknown>) {
		return callMcp("tools/call", { name, arguments: args });
	}

	/**
	 * Parse a tool's JSON payload. Some tools (search) prepend a readable
	 * summary line — `Found N matches…\n\n{json}` — so take the JSON after
	 * the first blank line when the text doesn't start with `{`.
	 */
	function toolJson<T>(response: unknown): T {
		const r = response as { result?: { content: Array<{ text: string }> }; error?: unknown };
		if (!r.result) throw new Error(`MCP error: ${JSON.stringify(r.error ?? r)}`);
		const text = r.result.content[0].text;
		const json = text.startsWith("{") ? text : text.slice(text.indexOf("\n\n") + 2);
		return JSON.parse(json) as T;
	}

	describe("health check", () => {
		it("should respond to health endpoint", async () => {
			const response = await fetch(`${MCP_URL}/health`);
			expect(response.status).toBe(200);

			const data = (await response.json()) as { status: string };
			expect(data.status).toBe("ok");
		});
	});

	describe("authentication", () => {
		it("should accept valid token", async () => {
			const result = (await callMcp("tools/list", {})) as { result?: unknown };
			expect(result.result).toBeDefined();
		});

		it("should reject invalid token", async () => {
			const response = await fetch(`${MCP_URL}/mcp`, {
				method: "POST",
				headers: {
					Authorization: "Bearer invalid-token",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/list",
					params: {},
				}),
			});

			expect(response.status).toBe(401);
		});
	});

	describe("full workflow", () => {
		const testDir = `e2e-test/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const testPath = `${testDir}/test.md`;
		const testContent = "# E2E Test\n\nThis is an end-to-end test file.";

		afterAll(async () => {
			// purge: drop the history snapshots too, so runs leave nothing behind.
			await callTool("delete", { path: testPath, purge: true });
		});

		it("should write a file", async () => {
			const data = toolJson<{ success: boolean }>(
				await callTool("write", { path: testPath, content: testContent, detect_overlaps: false }),
			);
			expect(data.success).toBe(true);
		});

		it("should read the file back", async () => {
			const data = toolJson<{ content: string }>(await callTool("read", { path: testPath }));
			expect(data.content).toBe(testContent);
		});

		it("should list the file", async () => {
			const data = toolJson<{ files: Array<{ path: string }> }>(
				await callTool("list", { path: testDir, recursive: true }),
			);
			expect(data.files.map((f) => f.path)).toContain(testPath);
		});

		it("should search for the file", async () => {
			// write waits for the index by default; no sleep needed.
			const data = toolJson<{ results: Array<{ path: string }> }>(
				await callTool("search", { query: "end-to-end test file", limit: 5 }),
			);
			expect(data.results.map((r) => r.path)).toContain(testPath);
		});

		it("should report index prune candidates without mutating the index", async () => {
			const data = toolJson<{
				scanned: number;
				pruned: number;
				remaining: number;
				dryRun: boolean;
			}>(await callTool("prune_index", { dry_run: true }));

			expect(data.dryRun).toBe(true);
			expect(data.pruned).toBe(0);
			expect(data.remaining).toBe(data.scanned);
			// Not `> 0`: that ties the test to a non-empty index. Our own file
			// is indexed, but a scanned count of 0 is a valid dry-run answer.
			expect(data.scanned).toBeGreaterThanOrEqual(0);
		});

		it("should delete the file", async () => {
			const data = toolJson<{ success: boolean }>(
				await callTool("delete", { path: testPath, purge: true }),
			);
			expect(data.success).toBe(true);
			const listed = toolJson<{ files: Array<{ path: string }> }>(
				await callTool("list", { path: testDir, recursive: true }),
			);
			expect(listed.files).toHaveLength(0);
		});
	});
});
