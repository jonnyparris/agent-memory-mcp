import { describe, expect, it, vi } from "vitest";
import { type ExecuteMemoryApi, executeCode } from "../../src/execute";

function createMockMemoryApi(overrides: Partial<ExecuteMemoryApi> = {}): ExecuteMemoryApi {
	return {
		read: vi.fn().mockResolvedValue(null),
		list: vi.fn().mockResolvedValue([]),
		...overrides,
	};
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
	return JSON.parse(result.content[0].text);
}

describe("executeCode", () => {
	describe("simple code execution", () => {
		it("should execute simple arithmetic", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode("return 1 + 2", memoryApi);

			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: 3 });
		});

		it("should execute code returning a string", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode('return "hello world"', memoryApi);

			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: "hello world" });
		});

		it("should execute code returning an object", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode('return { name: "test", value: 42 }', memoryApi);

			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: { name: "test", value: 42 } });
		});

		it("should execute code returning an array", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode("return [1, 2, 3].map(x => x * 2)", memoryApi);

			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: [2, 4, 6] });
		});

		it("should execute code with no return (returns undefined)", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode("const x = 5;", memoryApi);

			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: undefined });
		});

		it("should execute code with multiple statements", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode(
				`
				const a = 10;
				const b = 20;
				return a + b;
				`,
				memoryApi,
			);

			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: 30 });
		});
	});

	describe("access to memory.read()", () => {
		it("should call memory.read() with correct path", async () => {
			const mockRead = vi.fn().mockResolvedValue("file content here");
			const memoryApi = createMockMemoryApi({ read: mockRead });

			const result = await executeCode('return await memory.read("test/file.md")', memoryApi);

			expect(mockRead).toHaveBeenCalledWith("test/file.md");
			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: "file content here" });
		});

		it("should handle memory.read() returning null", async () => {
			const mockRead = vi.fn().mockResolvedValue(null);
			const memoryApi = createMockMemoryApi({ read: mockRead });

			const result = await executeCode('return await memory.read("nonexistent.md")', memoryApi);

			expect(mockRead).toHaveBeenCalledWith("nonexistent.md");
			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: null });
		});

		it("should process memory.read() result", async () => {
			const mockRead = vi.fn().mockResolvedValue("line1\nline2\nline3");
			const memoryApi = createMockMemoryApi({ read: mockRead });

			const result = await executeCode(
				`
				const content = await memory.read("test.md");
				return content.split("\\n").length;
				`,
				memoryApi,
			);

			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: 3 });
		});

		it("should handle multiple memory.read() calls", async () => {
			const mockRead = vi.fn().mockImplementation(async (path: string) => {
				if (path === "file1.md") return "content1";
				if (path === "file2.md") return "content2";
				return null;
			});
			const memoryApi = createMockMemoryApi({ read: mockRead });

			const result = await executeCode(
				`
				const c1 = await memory.read("file1.md");
				const c2 = await memory.read("file2.md");
				return c1 + " + " + c2;
				`,
				memoryApi,
			);

			expect(mockRead).toHaveBeenCalledTimes(2);
			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: "content1 + content2" });
		});
	});

	describe("access to memory.list()", () => {
		it("should call memory.list() with no path", async () => {
			const mockList = vi.fn().mockResolvedValue([
				{ path: "file1.md", size: 100, updated_at: "2024-01-01T00:00:00Z" },
				{ path: "file2.md", size: 200, updated_at: "2024-01-02T00:00:00Z" },
			]);
			const memoryApi = createMockMemoryApi({ list: mockList });

			const result = await executeCode("return await memory.list()", memoryApi);

			expect(mockList).toHaveBeenCalledWith();
			expect(result.isError).toBeUndefined();
			const parsed = parseResult(result);
			expect(parsed.result).toHaveLength(2);
			expect(parsed.result[0].path).toBe("file1.md");
		});

		it("should call memory.list() with specific path", async () => {
			const mockList = vi
				.fn()
				.mockResolvedValue([
					{ path: "notes/todo.md", size: 50, updated_at: "2024-01-01T00:00:00Z" },
				]);
			const memoryApi = createMockMemoryApi({ list: mockList });

			const result = await executeCode('return await memory.list("notes")', memoryApi);

			expect(mockList).toHaveBeenCalledWith("notes");
			expect(result.isError).toBeUndefined();
		});

		it("should filter memory.list() results", async () => {
			const mockList = vi.fn().mockResolvedValue([
				{ path: "file1.md", size: 100, updated_at: "2024-01-01T00:00:00Z" },
				{ path: "file2.txt", size: 200, updated_at: "2024-01-02T00:00:00Z" },
				{ path: "file3.md", size: 300, updated_at: "2024-01-03T00:00:00Z" },
			]);
			const memoryApi = createMockMemoryApi({ list: mockList });

			const result = await executeCode(
				`
				const files = await memory.list();
				return files.filter(f => f.path.endsWith(".md"));
				`,
				memoryApi,
			);

			expect(result.isError).toBeUndefined();
			const parsed = parseResult(result);
			expect(parsed.result).toHaveLength(2);
			expect(parsed.result.every((f: { path: string }) => f.path.endsWith(".md"))).toBe(true);
		});

		it("should combine memory.list() and memory.read()", async () => {
			const mockList = vi.fn().mockResolvedValue([
				{ path: "file1.md", size: 100, updated_at: "2024-01-01T00:00:00Z" },
				{ path: "file2.md", size: 200, updated_at: "2024-01-02T00:00:00Z" },
			]);
			const mockRead = vi.fn().mockImplementation(async (path: string) => {
				if (path === "file1.md") return "hello";
				if (path === "file2.md") return "world";
				return null;
			});
			const memoryApi = createMockMemoryApi({ list: mockList, read: mockRead });

			const result = await executeCode(
				`
				const files = await memory.list();
				const contents = await Promise.all(files.map(f => memory.read(f.path)));
				return contents.join(" ");
				`,
				memoryApi,
			);

			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: "hello world" });
		});
	});

	describe("syntax error handling", () => {
		it("should handle syntax error - missing parenthesis", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode("return (1 + 2", memoryApi);

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toBe("Execution failed");
			expect(parsed.details).toBeDefined();
		});

		it("should handle syntax error - invalid keyword", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode("returnn 42", memoryApi);

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toBe("Execution failed");
		});

		it("should handle syntax error - unexpected token", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode("return {,}", memoryApi);

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toBe("Execution failed");
		});

		it("should handle empty code", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode("", memoryApi);

			// Empty code is valid JS, returns undefined
			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: undefined });
		});
	});

	describe("runtime error handling", () => {
		it("should handle undefined variable error", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode("return undefinedVariable", memoryApi);

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toBe("Execution failed");
			expect(parsed.details).toContain("undefinedVariable");
		});

		it("should handle TypeError - calling undefined as function", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode("const x = undefined; return x()", memoryApi);

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toBe("Execution failed");
			expect(parsed.details).toBeDefined();
		});

		it("should handle TypeError - accessing property of null", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode("const x = null; return x.foo", memoryApi);

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toBe("Execution failed");
		});

		it("should handle thrown errors", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode('throw new Error("custom error message")', memoryApi);

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toBe("Execution failed");
			expect(parsed.details).toBe("custom error message");
		});

		it("should handle thrown string", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode('throw "string error"', memoryApi);

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toBe("Execution failed");
			expect(parsed.details).toBe("string error");
		});

		it("should handle memory.read() rejection", async () => {
			const mockRead = vi.fn().mockRejectedValue(new Error("Storage error"));
			const memoryApi = createMockMemoryApi({ read: mockRead });

			const result = await executeCode('return await memory.read("test.md")', memoryApi);

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toBe("Execution failed");
			expect(parsed.details).toBe("Storage error");
		});
	});

	describe("async value handling", () => {
		it("should handle direct async return", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode("return Promise.resolve(42)", memoryApi);

			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: 42 });
		});

		it("should handle async/await pattern", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode(
				`
				const delay = ms => new Promise(r => setTimeout(r, ms));
				await delay(1);
				return "done";
				`,
				memoryApi,
			);

			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: "done" });
		});

		it("should handle Promise.all", async () => {
			const mockRead = vi.fn().mockImplementation(async (path: string) => `content of ${path}`);
			const memoryApi = createMockMemoryApi({ read: mockRead });

			const result = await executeCode(
				`
				const paths = ["a.md", "b.md", "c.md"];
				const results = await Promise.all(paths.map(p => memory.read(p)));
				return results;
				`,
				memoryApi,
			);

			expect(result.isError).toBeUndefined();
			const parsed = parseResult(result);
			expect(parsed.result).toEqual(["content of a.md", "content of b.md", "content of c.md"]);
		});

		it("should handle rejected promise", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode(
				'return Promise.reject(new Error("async failure"))',
				memoryApi,
			);

			expect(result.isError).toBe(true);
			const parsed = parseResult(result);
			expect(parsed.error).toBe("Execution failed");
			expect(parsed.details).toBe("async failure");
		});

		it("should handle async iterator pattern", async () => {
			const mockList = vi.fn().mockResolvedValue([
				{ path: "file1.md", size: 100, updated_at: "2024-01-01T00:00:00Z" },
				{ path: "file2.md", size: 200, updated_at: "2024-01-02T00:00:00Z" },
			]);
			const mockRead = vi.fn().mockImplementation(async (path: string) => path.replace(".md", ""));
			const memoryApi = createMockMemoryApi({ list: mockList, read: mockRead });

			const result = await executeCode(
				`
				const files = await memory.list();
				const results = [];
				for (const file of files) {
					const content = await memory.read(file.path);
					results.push(content);
				}
				return results;
				`,
				memoryApi,
			);

			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: ["file1", "file2"] });
		});
	});

	describe("edge cases", () => {
		it("should handle code with comments", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode(
				`
				// This is a comment
				const x = 5; /* inline comment */
				return x;
				`,
				memoryApi,
			);

			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: 5 });
		});

		it("should handle code returning null", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode("return null", memoryApi);

			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: null });
		});

		it("should handle code returning boolean false", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode("return false", memoryApi);

			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: false });
		});

		it("should handle code returning zero", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode("return 0", memoryApi);

			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: 0 });
		});

		it("should handle code returning empty string", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode('return ""', memoryApi);

			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: "" });
		});

		it("should handle code returning empty array", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode("return []", memoryApi);

			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: [] });
		});

		it("should handle code returning empty object", async () => {
			const memoryApi = createMockMemoryApi();

			const result = await executeCode("return {}", memoryApi);

			expect(result.isError).toBeUndefined();
			expect(parseResult(result)).toEqual({ result: {} });
		});
	});
});
