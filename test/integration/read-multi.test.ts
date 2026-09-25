import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface McpToolResult {
	result: {
		content: Array<{ text: string }>;
		isError?: boolean;
	};
}

/**
 * Extract the JSON payload from a tool response's first text block.
 *
 * Tools may prepend a one-line human-readable summary before the JSON
 * body. This helper pulls out the JSON regardless of whether the prefix
 * is present — kept local to the test file so both integration suites
 * stay self-contained. Returns `any` by default for test ergonomics.
 */
function parseToolJson<T = any>(text: string): T {
	const firstBrace = text.search(/[{\[]/);
	const json = firstBrace === -1 ? text : text.slice(firstBrace);
	return JSON.parse(json) as T;
}

describe("read tool multi-file support", () => {
	const authHeader = `Bearer ${env.MEMORY_AUTH_TOKEN}`;

	async function callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
		const response = await SELF.fetch("http://localhost/mcp", {
			method: "POST",
			headers: {
				Authorization: authHeader,
				"Content-Type": "application/json",
				// MCP Streamable HTTP requires both JSON and SSE in Accept.
				Accept: "application/json, text/event-stream",
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

		const content = parseToolJson(result.result.content[0].text);
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
		expect(parseToolJson(result.result.content[0].text)).toEqual({
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

		const content = parseToolJson(result.result.content[0].text);
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

		const content = parseToolJson(result.result.content[0].text);
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
		expect(parseToolJson(result.result.content[0].text)).toEqual({ files: {} });
	});

	it("returns an error when more than 50 paths are requested", async () => {
		const result = await callTool("read", {
			path: Array.from({ length: 51 }, (_, index) => `test-tools/read-multi/limit-${index}.md`),
		});

		expect(result.result.isError).toBe(true);
		const content = parseToolJson(result.result.content[0].text);
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
		const content = parseToolJson(result.result.content[0].text);

		expect(Object.keys(content.files)).toEqual(paths);
	});

	describe("pagination", () => {
		// A 78K-character learnings.md could not be retrieved in full through
		// the MCP at all before this: `read` capped at 50K and offered no way
		// to ask for the rest. Following the documented "read, append, write
		// back" rule on it silently destroyed 28K.
		const big = Array.from({ length: 4000 }, (_, i) => `line ${i} of a long memory file`).join(
			"\n",
		);
		const bigPath = "test-tools/read-multi/big.md";

		it("advertises truncation with a usable continuation offset", async () => {
			await callTool("write", { path: bigPath, content: big, wait_for_index: false });

			const result = await callTool("read", { path: bigPath });
			const body = parseToolJson(result.result.content[0].text);

			expect(body.truncated).toBe(true);
			expect(body.original_size).toBe(big.length);
			expect(body.next_offset).toBeGreaterThan(0);
			// The in-band marker is the backstop for callers that ignore the
			// metadata and write the result straight back.
			expect(body.content).toContain("[Content truncated");
			expect(result.result.content[0].text).toContain("pass offset=");
		});

		it("retrieves a file larger than the cap in full by paging", async () => {
			await callTool("write", { path: bigPath, content: big, wait_for_index: false });

			let offset = 0;
			let assembled = "";
			let calls = 0;
			for (;;) {
				const result = await callTool("read", { path: bigPath, offset });
				const body = parseToolJson(result.result.content[0].text);
				expect(body.content).not.toContain("[Content truncated");
				assembled += body.content;
				calls++;
				expect(calls).toBeLessThan(20);
				if (body.next_offset === undefined) break;
				offset = body.next_offset;
			}

			expect(calls).toBeGreaterThan(1);
			expect(assembled).toBe(big);
		});

		it("reports the window position when paging", async () => {
			await callTool("write", { path: bigPath, content: big, wait_for_index: false });

			const result = await callTool("read", { path: bigPath, offset: 10, limit: 100 });
			const body = parseToolJson(result.result.content[0].text);

			expect(body.offset).toBe(10);
			expect(body.returned).toBeLessThanOrEqual(100);
			expect(body.total_length).toBe(big.length);
			expect(body.content).toBe(big.slice(10, 10 + body.returned));
		});

		it("caps limit so a caller cannot demand an oversized response", async () => {
			await callTool("write", { path: bigPath, content: big, wait_for_index: false });

			const result = await callTool("read", { path: bigPath, limit: 10_000_000 });
			const body = parseToolJson(result.result.content[0].text);

			expect(body.returned).toBeLessThanOrEqual(50_000);
			expect(body.truncated).toBe(true);
		});

		it("applies the window to every path in a multi-read", async () => {
			await callTool("write", {
				path: "test-tools/read-multi/page-a.md",
				content: "aaaaaaaaaa",
				wait_for_index: false,
			});
			await callTool("write", {
				path: "test-tools/read-multi/page-b.md",
				content: "bbbbbbbbbb",
				wait_for_index: false,
			});

			const result = await callTool("read", {
				path: ["test-tools/read-multi/page-a.md", "test-tools/read-multi/page-b.md"],
				offset: 2,
				limit: 3,
			});
			const files = parseToolJson(result.result.content[0].text).files;

			expect(files["test-tools/read-multi/page-a.md"].content).toBe("aaa");
			expect(files["test-tools/read-multi/page-b.md"].content).toBe("bbb");
			expect(files["test-tools/read-multi/page-a.md"].next_offset).toBe(5);
		});

		it("leaves the unpaged small-file response shape untouched", async () => {
			// Guards the back-compat promise: no new keys appear unless the
			// caller pages or the read was actually cut short.
			await callTool("write", {
				path: "test-tools/read-multi/small.md",
				content: "tiny",
				wait_for_index: false,
			});

			const result = await callTool("read", { path: "test-tools/read-multi/small.md" });
			const body = parseToolJson(result.result.content[0].text);

			expect(Object.keys(body).sort()).toEqual(["content", "size", "updated_at"]);
		});
	});
});
