import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Type definitions for MCP responses
interface McpToolResult {
	result: {
		content: Array<{ text: string }>;
		isError?: boolean;
	};
}

interface McpToolsListResult {
	result: {
		tools: Array<{ name: string }>;
	};
}

interface McpErrorResult {
	error: {
		code: number;
		message: string;
	};
}

describe("MCP Tools", () => {
	const authHeader = `Bearer ${env.MEMORY_AUTH_TOKEN}`;

	async function callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
		const response = await SELF.fetch("http://localhost/mcp", {
			method: "POST",
			headers: {
				Authorization: authHeader,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		});

		return response.json() as Promise<McpToolResult>;
	}

	describe("tools/list", () => {
		it("should list all available tools", async () => {
			const response = await SELF.fetch("http://localhost/mcp", {
				method: "POST",
				headers: {
					Authorization: authHeader,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/list",
					params: {},
				}),
			});

			const data = (await response.json()) as McpToolsListResult;

			expect(data.result.tools).toBeDefined();
			expect(Array.isArray(data.result.tools)).toBe(true);

			const toolNames = data.result.tools.map((t) => t.name);
			expect(toolNames).toContain("read");
			expect(toolNames).toContain("write");
			expect(toolNames).toContain("list");
			expect(toolNames).toContain("search");
			expect(toolNames).toContain("history");
			expect(toolNames).toContain("rollback");
			expect(toolNames).toContain("execute");
		});
	});

	describe("write tool", () => {
		it("should write a file", async () => {
			const result = await callTool("write", {
				path: "test-tools/write-test.md",
				content: "# Test Content\n\nThis is a test.",
			});

			expect(result.result.content).toBeDefined();
			const content = JSON.parse(result.result.content[0].text);
			expect(content.success).toBe(true);
		});

		it("should handle empty content", async () => {
			const result = await callTool("write", {
				path: "test-tools/empty.md",
				content: "",
			});

			const content = JSON.parse(result.result.content[0].text);
			expect(content.success).toBe(true);
		});
	});

	describe("read tool", () => {
		it("should read an existing file", async () => {
			// First write
			await callTool("write", {
				path: "test-tools/read-test.md",
				content: "Content to read",
			});

			// Then read
			const result = await callTool("read", {
				path: "test-tools/read-test.md",
			});

			const content = JSON.parse(result.result.content[0].text);
			expect(content.content).toBe("Content to read");
			expect(content.updated_at).toBeDefined();
		});

		it("should return error for non-existent file", async () => {
			const result = await callTool("read", {
				path: "test-tools/nonexistent.md",
			});

			expect(result.result.isError).toBe(true);
			const content = JSON.parse(result.result.content[0].text);
			expect(content.error).toBe("File not found");
		});
	});

	describe("list tool", () => {
		it("should list files in directory", async () => {
			// Create some files
			await callTool("write", { path: "test-tools/list/a.md", content: "A" });
			await callTool("write", { path: "test-tools/list/b.md", content: "B" });

			const result = await callTool("list", { path: "test-tools/list" });

			const content = JSON.parse(result.result.content[0].text);
			expect(content.files.length).toBeGreaterThanOrEqual(2);
		});

		it("should list root when no path provided", async () => {
			const result = await callTool("list", {});

			const content = JSON.parse(result.result.content[0].text);
			expect(Array.isArray(content.files)).toBe(true);
		});
	});

	describe("execute tool", () => {
		it("should execute simple code", async () => {
			const result = await callTool("execute", {
				code: "return 1 + 2",
			});

			const content = JSON.parse(result.result.content[0].text);
			expect(content.result).toBe(3);
		});

		it("should have access to memory.read", async () => {
			// Write a file first
			await callTool("write", {
				path: "test-tools/execute-read.md",
				content: "Execute test content",
			});

			const result = await callTool("execute", {
				code: 'return await memory.read("test-tools/execute-read.md")',
			});

			const content = JSON.parse(result.result.content[0].text);
			expect(content.result).toBe("Execute test content");
		});

		it("should have access to memory.list", async () => {
			const result = await callTool("execute", {
				code: "const files = await memory.list('test-tools'); return files.length",
			});

			const content = JSON.parse(result.result.content[0].text);
			expect(typeof content.result).toBe("number");
		});

		it("should handle syntax errors", async () => {
			const result = await callTool("execute", {
				code: "return {{{invalid",
			});

			expect(result.result.isError).toBe(true);
			const content = JSON.parse(result.result.content[0].text);
			expect(content.error).toBe("Execution failed");
		});

		it("should handle runtime errors", async () => {
			const result = await callTool("execute", {
				code: 'throw new Error("Test error")',
			});

			expect(result.result.isError).toBe(true);
			const content = JSON.parse(result.result.content[0].text);
			expect(content.details).toContain("Test error");
		});
	});

	describe("authentication", () => {
		it("should reject requests without auth", async () => {
			const response = await SELF.fetch("http://localhost/mcp", {
				method: "POST",
				headers: {
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

		it("should reject invalid token", async () => {
			const response = await SELF.fetch("http://localhost/mcp", {
				method: "POST",
				headers: {
					Authorization: "Bearer wrong-token",
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

	describe("error handling", () => {
		it("should return error for unknown method", async () => {
			const response = await SELF.fetch("http://localhost/mcp", {
				method: "POST",
				headers: {
					Authorization: authHeader,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "unknown/method",
					params: {},
				}),
			});

			const data = (await response.json()) as McpErrorResult;
			expect(data.error.code).toBe(-32601);
		});

		it("should handle malformed JSON", async () => {
			const response = await SELF.fetch("http://localhost/mcp", {
				method: "POST",
				headers: {
					Authorization: authHeader,
					"Content-Type": "application/json",
				},
				body: "not valid json",
			});

			const data = (await response.json()) as McpErrorResult;
			expect(data.error.code).toBe(-32700);
		});
	});
});
