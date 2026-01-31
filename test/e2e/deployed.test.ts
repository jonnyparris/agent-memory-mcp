import { describe, expect, it } from "vitest";

/**
 * E2E tests against the deployed worker
 * Run with: MEMORY_MCP_URL=https://your-worker.workers.dev MEMORY_AUTH_TOKEN=xxx npm run test:e2e
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
		const testPath = `e2e-test/${Date.now()}/test.md`;
		const testContent = "# E2E Test\n\nThis is an end-to-end test file.";

		it("should write a file", async () => {
			const result = (await callTool("write", {
				path: testPath,
				content: testContent,
			})) as { result: { content: Array<{ text: string }> } };

			const data = JSON.parse(result.result.content[0].text) as { success: boolean };
			expect(data.success).toBe(true);
		});

		it("should read the file back", async () => {
			const result = (await callTool("read", { path: testPath })) as {
				result: { content: Array<{ text: string }> };
			};

			const data = JSON.parse(result.result.content[0].text) as { content: string };
			expect(data.content).toBe(testContent);
		});

		it("should list the file", async () => {
			const result = (await callTool("list", {
				path: `e2e-test/${Date.now().toString().slice(0, -3)}`,
				recursive: true,
			})) as { result: { content: Array<{ text: string }> } };

			const data = JSON.parse(result.result.content[0].text) as { files: Array<{ path: string }> };
			expect(data.files.some((f: { path: string }) => f.path.includes("test.md"))).toBe(true);
		});

		it("should search for the file", async () => {
			// Wait a bit for embedding to be processed
			await new Promise((r) => setTimeout(r, 2000));

			const result = (await callTool("search", {
				query: "end-to-end test file",
				limit: 5,
			})) as { result: { content: Array<{ text: string }> } };

			const data = JSON.parse(result.result.content[0].text) as { results: unknown[] };
			expect(data.results.length).toBeGreaterThan(0);
		});

		it("should execute code against memory", async () => {
			const result = (await callTool("execute", {
				code: `
          const content = await memory.read("${testPath}");
          return content ? content.length : 0;
        `,
			})) as { result: { content: Array<{ text: string }> } };

			const data = JSON.parse(result.result.content[0].text) as { result: number };
			expect(data.result).toBe(testContent.length);
		});
	});
});
