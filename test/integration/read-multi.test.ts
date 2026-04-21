import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface McpToolResult {
	result: {
		content: Array<{ text: string }>;
		isError?: boolean;
	};
}

describe("read tool multi-file support", () => {
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

	it("returns the legacy shape for a single existing path", async () => {
		await callTool("write", {
			path: "test-tools/read-multi/single-existing.md",
			content: "single file content",
		});

		const result = await callTool("read", {
			path: "test-tools/read-multi/single-existing.md",
		});

		const content = JSON.parse(result.result.content[0].text);
		expect(result.result.isError).toBeUndefined();
		expect(content).toMatchObject({
			content: "single file content",
			size: "single file content".length,
		});
		expect(content.updated_at).toBeDefined();
		expect(Object.keys(content).sort()).toEqual(["content", "size", "updated_at"]);
	});

	it("returns the legacy error shape for a missing single path", async () => {
		const result = await callTool("read", {
			path: "test-tools/read-multi/missing-single.md",
		});

		expect(result.result.isError).toBe(true);
		expect(JSON.parse(result.result.content[0].text)).toEqual({
			error: "File not found",
			path: "test-tools/read-multi/missing-single.md",
		});
	});

	it("returns files keyed by path for an array of paths", async () => {
		await callTool("write", {
			path: "test-tools/read-multi/array-a.md",
			content: "A content",
		});
		await callTool("write", {
			path: "test-tools/read-multi/array-b.md",
			content: "B content",
		});

		const result = await callTool("read", {
			path: ["test-tools/read-multi/array-a.md", "test-tools/read-multi/array-b.md"],
		});

		const content = JSON.parse(result.result.content[0].text);
		expect(result.result.isError).toBeUndefined();
		expect(content).toHaveProperty("files");
		expect(content.files["test-tools/read-multi/array-a.md"]).toMatchObject({
			content: "A content",
			size: "A content".length,
		});
		expect(content.files["test-tools/read-multi/array-b.md"]).toMatchObject({
			content: "B content",
			size: "B content".length,
		});
	});

	it("returns partial failures without failing the whole array read", async () => {
		await callTool("write", {
			path: "test-tools/read-multi/mixed-existing.md",
			content: "mixed content",
		});

		const result = await callTool("read", {
			path: ["test-tools/read-multi/mixed-existing.md", "test-tools/read-multi/mixed-missing.md"],
		});

		const content = JSON.parse(result.result.content[0].text);
		expect(result.result.isError).toBeUndefined();
		expect(content.files["test-tools/read-multi/mixed-existing.md"]).toMatchObject({
			content: "mixed content",
			size: "mixed content".length,
		});
		expect(content.files["test-tools/read-multi/mixed-missing.md"]).toEqual({
			error: "File not found",
		});
	});

	it("returns an empty files object for an empty array", async () => {
		const result = await callTool("read", { path: [] });

		expect(result.result.isError).toBeUndefined();
		expect(JSON.parse(result.result.content[0].text)).toEqual({ files: {} });
	});

	it("returns an error when more than 50 paths are requested", async () => {
		const result = await callTool("read", {
			path: Array.from({ length: 51 }, (_, index) => `test-tools/read-multi/limit-${index}.md`),
		});

		expect(result.result.isError).toBe(true);
		const content = JSON.parse(result.result.content[0].text);
		expect(content.error).toContain("50");
	});

	it("preserves input order in the files response keys", async () => {
		await callTool("write", {
			path: "test-tools/read-multi/order-first.md",
			content: "first",
		});
		await callTool("write", {
			path: "test-tools/read-multi/order-second.md",
			content: "second",
		});
		await callTool("write", {
			path: "test-tools/read-multi/order-third.md",
			content: "third",
		});

		const paths = [
			"test-tools/read-multi/order-third.md",
			"test-tools/read-multi/order-first.md",
			"test-tools/read-multi/order-second.md",
		];
		const result = await callTool("read", { path: paths });
		const content = JSON.parse(result.result.content[0].text);

		expect(Object.keys(content.files)).toEqual(paths);
	});
});
