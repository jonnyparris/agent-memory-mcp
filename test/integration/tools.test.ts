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

// MCP Streamable HTTP transport requires both application/json and
// text/event-stream in the Accept header (even for non-streaming JSON
// responses). Centralising the header set keeps tests terse.
const MCP_HEADERS = {
	"Content-Type": "application/json",
	Accept: "application/json, text/event-stream",
} as const;

/**
 * Extract the JSON payload from a tool response's first text block.
 *
 * Tools may prepend a one-line human-readable summary (e.g. "Read foo.md
 * (123 bytes)") followed by a blank line, then the JSON body. This helper
 * pulls out the JSON regardless of whether the prefix is present. The
 * return type defaults to `any` so integration tests stay terse — they
 * assert on specific fields one at a time rather than mapping to a DTO.
 */
function parseToolJson<T = any>(text: string): T {
	const firstBrace = text.search(/[{\[]/);
	const json = firstBrace === -1 ? text : text.slice(firstBrace);
	return JSON.parse(json) as T;
}

describe("MCP Tools", () => {
	const authHeader = `Bearer ${env.MEMORY_AUTH_TOKEN}`;

	async function callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
		const response = await SELF.fetch("http://localhost/mcp", {
			method: "POST",
			headers: {
				Authorization: authHeader,
				...MCP_HEADERS,
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
					...MCP_HEADERS,
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
			expect(toolNames).toContain("write_many");
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
			const content = parseToolJson(result.result.content[0].text);
			expect(content.success).toBe(true);
		});

		it("should handle empty content", async () => {
			const result = await callTool("write", {
				path: "test-tools/empty.md",
				content: "",
			});

			const content = parseToolJson(result.result.content[0].text);
			expect(content.success).toBe(true);
		});

		it("should report index_deferred when wait_for_index is false", async () => {
			// `wait_for_index: false` opts the caller into eventual
			// consistency: the R2 write still lands synchronously, but the
			// embedding update is handed to ctx.waitUntil. The response
			// surfaces `index_deferred: true` so callers know the search
			// index won't reflect this write for ~1–3s.
			const result = await callTool("write", {
				path: "test-tools/deferred.md",
				content: "# Deferred",
				wait_for_index: false,
			});

			const content = parseToolJson(result.result.content[0].text);
			expect(content.success).toBe(true);
			expect(content.index_deferred).toBe(true);
			// Forcing waitForIndex off must also skip overlap detection,
			// since the freshly-written embedding isn't queryable yet.
			expect(content.overlaps).toBeUndefined();
		});

		it("should not defer the index when overlap detection is requested", async () => {
			// Overlap detection has to read the freshly-updated index, so
			// the implementation forces inline-await whenever it's on —
			// even if the caller asked for waitForIndex: false. This
			// preserves the safety property "asking for overlaps means you
			// get overlaps." The path must live under memory/ because
			// overlap detection itself is gated to that prefix.
			const result = await callTool("write", {
				path: "memory/test-tools/no-defer.md",
				content: "# Inline",
				wait_for_index: false,
				detect_overlaps: true,
			});

			const content = parseToolJson(result.result.content[0].text);
			expect(content.success).toBe(true);
			expect(content.index_deferred).toBeUndefined();
		});

		it("should skip overlap detection when detect_overlaps is false", async () => {
			// `detect_overlaps: false` is the cheap path: write to R2,
			// update the index, return. No similarity search, no R2 reads
			// of overlap candidates. The write_many tool defaults to this.
			const result = await callTool("write", {
				path: "memory/test-tools/no-overlaps.md",
				content: "# No overlaps",
				detect_overlaps: false,
			});

			const content = parseToolJson(result.result.content[0].text);
			expect(content.success).toBe(true);
			expect(content.overlaps).toBeUndefined();
		});
	});

	describe("write_many tool", () => {
		it("should write multiple files in one call", async () => {
			// The whole point of write_many: one MCP round-trip, N R2
			// writes in parallel. Per-file results carry their own
			// version_id and byte count so the caller can audit the batch.
			const result = await callTool("write_many", {
				files: [
					{ path: "test-tools/many/a.md", content: "# A" },
					{ path: "test-tools/many/b.md", content: "# B" },
					{ path: "test-tools/many/c.md", content: "# C" },
				],
			});

			const content = parseToolJson(result.result.content[0].text);
			expect(content.success).toBe(true);
			expect(content.written).toBe(3);
			expect(content.failed).toBe(0);
			expect(content.results).toHaveLength(3);
			for (const r of content.results) {
				expect(r.success).toBe(true);
				expect(r.bytes).toBeGreaterThan(0);
			}
		});

		it("should default to detect_overlaps: false for bulk writes", async () => {
			// Bulk default: no overlap detection. Saves N similarity
			// searches plus their R2 reads of candidate files. Callers who
			// want overlap warnings on bulk writes opt in per-file.
			const result = await callTool("write_many", {
				files: [
					{ path: "memory/test-tools/many-no-overlaps-a.md", content: "# Bulk A" },
					{ path: "memory/test-tools/many-no-overlaps-b.md", content: "# Bulk B" },
				],
			});

			const content = parseToolJson(result.result.content[0].text);
			expect(content.success).toBe(true);
			for (const r of content.results) {
				expect(r.overlaps).toBeUndefined();
			}
		});

		it("should respect per-file wait_for_index override", async () => {
			// Mixing per-file overrides in a single batch is supported —
			// each entry threads through indexWrite independently, so one
			// file can defer while another waits.
			const result = await callTool("write_many", {
				files: [
					{
						path: "test-tools/many-mixed/deferred.md",
						content: "# Deferred",
						wait_for_index: false,
					},
					{
						path: "test-tools/many-mixed/synced.md",
						content: "# Synced",
						wait_for_index: true,
					},
				],
			});

			const content = parseToolJson(result.result.content[0].text);
			expect(content.success).toBe(true);
			const byPath = Object.fromEntries(content.results.map((r: any) => [r.path, r]));
			expect(byPath["test-tools/many-mixed/deferred.md"].index_deferred).toBe(true);
			expect(byPath["test-tools/many-mixed/synced.md"].index_deferred).toBeUndefined();
		});

		it("should reject empty file lists", async () => {
			// Zod schema requires at least one file. A zero-length batch
			// is a programming error, not something to silently succeed.
			const result = await callTool("write_many", { files: [] });
			expect(result.result.isError).toBe(true);
		});

		it("should reject batches over the 50-file limit", async () => {
			const tooMany = Array.from({ length: 51 }, (_, i) => ({
				path: `test-tools/many-too-big/${i}.md`,
				content: `# ${i}`,
			}));
			const result = await callTool("write_many", { files: tooMany });
			expect(result.result.isError).toBe(true);
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

			const content = parseToolJson(result.result.content[0].text);
			expect(content.content).toBe("Content to read");
			expect(content.updated_at).toBeDefined();
		});

		it("should return error for non-existent file", async () => {
			const result = await callTool("read", {
				path: "test-tools/nonexistent.md",
			});

			expect(result.result.isError).toBe(true);
			const content = parseToolJson(result.result.content[0].text);
			expect(content.error).toBe("File not found");
		});
	});

	describe("list tool", () => {
		it("should list files in directory", async () => {
			// Create some files
			await callTool("write", { path: "test-tools/list/a.md", content: "A" });
			await callTool("write", { path: "test-tools/list/b.md", content: "B" });

			const result = await callTool("list", { path: "test-tools/list" });

			const content = parseToolJson(result.result.content[0].text);
			expect(content.files.length).toBeGreaterThanOrEqual(2);
		});

		it("should list root when no path provided", async () => {
			const result = await callTool("list", {});

			const content = parseToolJson(result.result.content[0].text);
			expect(Array.isArray(content.files)).toBe(true);
		});
	});

	describe("execute tool", () => {
		it("should execute simple code", async () => {
			const result = await callTool("execute", {
				code: "return 1 + 2",
			});

			const content = parseToolJson(result.result.content[0].text);
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

			const content = parseToolJson(result.result.content[0].text);
			expect(content.result).toBe("Execute test content");
		});

		it("should have access to memory.list", async () => {
			const result = await callTool("execute", {
				code: "const files = await memory.list('test-tools'); return files.length",
			});

			const content = parseToolJson(result.result.content[0].text);
			expect(typeof content.result).toBe("number");
		});

		it("should handle syntax errors", async () => {
			const result = await callTool("execute", {
				code: "return {{{invalid",
			});

			expect(result.result.isError).toBe(true);
			const content = parseToolJson(result.result.content[0].text);
			expect(content.error).toBe("Execution failed");
		});

		it("should handle runtime errors", async () => {
			const result = await callTool("execute", {
				code: 'throw new Error("Test error")',
			});

			expect(result.result.isError).toBe(true);
			const content = parseToolJson(result.result.content[0].text);
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
					...MCP_HEADERS,
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
					...MCP_HEADERS,
				},
				body: "not valid json",
			});

			const data = (await response.json()) as McpErrorResult;
			expect(data.error.code).toBe(-32700);
		});
	});
});
