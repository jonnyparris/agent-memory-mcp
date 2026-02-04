import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ToolExecutionContext,
	createExecutionContext,
	executeReflectionTool,
} from "../../../src/reflection/tool-executor";
import { createMockStorage } from "../../mocks/storage";

describe("executeReflectionTool", () => {
	let mockStorage: ReturnType<typeof createMockStorage>;
	let context: ToolExecutionContext;

	beforeEach(() => {
		mockStorage = createMockStorage();
		context = createExecutionContext(mockStorage, {
			MEMORY_BUCKET: {} as any,
			MEMORY_INDEX: {
				idFromName: vi.fn().mockReturnValue("test-id"),
				get: vi.fn().mockReturnValue({
					fetch: vi.fn().mockResolvedValue({
						ok: true,
						json: () =>
							Promise.resolve([
								{ path: "memory/learnings.md", score: 0.9 },
								{ path: "memory/projects.md", score: 0.8 },
							]),
					}),
				}),
			} as any,
			AI: {} as any,
			MEMORY_AUTH_TOKEN: "test-token",
		});
	});

	describe("readFile", () => {
		it("should read existing file successfully", async () => {
			mockStorage._files.set("memory/learnings.md", {
				content: "# Learnings\n- Test lesson",
				updated_at: "2026-02-04T10:00:00Z",
			});

			const result = await executeReflectionTool(
				{ name: "readFile", arguments: { path: "memory/learnings.md" } },
				context,
			);

			expect(result.success).toBe(true);
			expect((result.result as any).content).toContain("# Learnings");
		});

		it("should return error for non-existent file", async () => {
			const result = await executeReflectionTool(
				{ name: "readFile", arguments: { path: "memory/nonexistent.md" } },
				context,
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain("not found");
		});

		it("should truncate large files", async () => {
			const largeContent = "A".repeat(20000);
			mockStorage._files.set("memory/large.md", {
				content: largeContent,
				updated_at: "2026-02-04T10:00:00Z",
			});

			const result = await executeReflectionTool(
				{ name: "readFile", arguments: { path: "memory/large.md" } },
				context,
			);

			expect(result.success).toBe(true);
			expect((result.result as any).truncated).toBe(true);
			expect((result.result as any).content.length).toBeLessThan(20000);
		});
	});

	describe("listFiles", () => {
		it("should list files in directory", async () => {
			mockStorage._files.set("memory/learnings.md", {
				content: "content",
				updated_at: "2026-02-04T10:00:00Z",
			});
			mockStorage._files.set("memory/projects.md", {
				content: "content",
				updated_at: "2026-02-04T10:00:00Z",
			});

			const result = await executeReflectionTool(
				{ name: "listFiles", arguments: { path: "memory" } },
				context,
			);

			expect(result.success).toBe(true);
			expect((result.result as any).count).toBe(2);
		});

		it("should handle recursive listing", async () => {
			mockStorage._files.set("memory/learnings.md", {
				content: "content",
				updated_at: "2026-02-04T10:00:00Z",
			});
			mockStorage._files.set("memory/patterns/cloudflare.md", {
				content: "content",
				updated_at: "2026-02-04T10:00:00Z",
			});

			const result = await executeReflectionTool(
				{ name: "listFiles", arguments: { path: "memory", recursive: true } },
				context,
			);

			expect(result.success).toBe(true);
			expect((result.result as any).count).toBe(2);
		});
	});

	describe("proposeEdit", () => {
		it("should stage a replace edit for existing file", async () => {
			mockStorage._files.set("memory/learnings.md", {
				content: "old content",
				updated_at: "2026-02-04T10:00:00Z",
			});

			const result = await executeReflectionTool(
				{
					name: "proposeEdit",
					arguments: {
						path: "memory/learnings.md",
						action: "replace",
						content: "new content",
						reason: "updating content",
					},
				},
				context,
			);

			expect(result.success).toBe(true);
			expect(context.proposedEdits).toHaveLength(1);
			expect(context.proposedEdits[0].action).toBe("replace");
		});

		it("should reject edit for non-existent file (except create)", async () => {
			const result = await executeReflectionTool(
				{
					name: "proposeEdit",
					arguments: {
						path: "memory/nonexistent.md",
						action: "replace",
						content: "new content",
						reason: "test",
					},
				},
				context,
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain("not found");
		});

		it("should allow create for non-existent file", async () => {
			const result = await executeReflectionTool(
				{
					name: "proposeEdit",
					arguments: {
						path: "memory/new-file.md",
						action: "create",
						content: "new file content",
						reason: "creating new file",
					},
				},
				context,
			);

			expect(result.success).toBe(true);
			expect(context.proposedEdits).toHaveLength(1);
			expect(context.proposedEdits[0].action).toBe("create");
		});

		it("should require content for replace/append/create", async () => {
			mockStorage._files.set("memory/test.md", {
				content: "old",
				updated_at: "2026-02-04T10:00:00Z",
			});

			const result = await executeReflectionTool(
				{
					name: "proposeEdit",
					arguments: {
						path: "memory/test.md",
						action: "replace",
						reason: "no content provided",
					},
				},
				context,
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain("Content required");
		});
	});

	describe("autoApply", () => {
		it("should apply typo fix", async () => {
			mockStorage._files.set("memory/learnings.md", {
				content: "This is a tset of typos",
				updated_at: "2026-02-04T10:00:00Z",
			});

			const result = await executeReflectionTool(
				{
					name: "autoApply",
					arguments: {
						path: "memory/learnings.md",
						fixType: "typo",
						oldText: "tset",
						newText: "test",
						reason: "fixing typo",
					},
				},
				context,
			);

			expect(result.success).toBe(true);
			expect(context.autoAppliedFixes).toHaveLength(1);

			// Verify file was updated
			const updated = await mockStorage.read("memory/learnings.md");
			expect(updated?.content).toBe("This is a test of typos");
		});

		it("should add trailing newline", async () => {
			mockStorage._files.set("memory/learnings.md", {
				content: "Content without newline",
				updated_at: "2026-02-04T10:00:00Z",
			});

			const result = await executeReflectionTool(
				{
					name: "autoApply",
					arguments: {
						path: "memory/learnings.md",
						fixType: "newline",
						reason: "adding trailing newline",
					},
				},
				context,
			);

			expect(result.success).toBe(true);
			const updated = await mockStorage.read("memory/learnings.md");
			expect(updated?.content).toBe("Content without newline\n");
		});

		it("should require oldText and newText for typo fix", async () => {
			mockStorage._files.set("memory/learnings.md", {
				content: "content",
				updated_at: "2026-02-04T10:00:00Z",
			});

			const result = await executeReflectionTool(
				{
					name: "autoApply",
					arguments: {
						path: "memory/learnings.md",
						fixType: "typo",
						reason: "missing oldText",
					},
				},
				context,
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain("oldText and newText required");
		});

		it("should error if oldText not found in file", async () => {
			mockStorage._files.set("memory/learnings.md", {
				content: "some content here",
				updated_at: "2026-02-04T10:00:00Z",
			});

			const result = await executeReflectionTool(
				{
					name: "autoApply",
					arguments: {
						path: "memory/learnings.md",
						fixType: "typo",
						oldText: "nonexistent text",
						newText: "replacement",
						reason: "test",
					},
				},
				context,
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain("not found in file");
		});
	});

	describe("flagForDeepAnalysis", () => {
		it("should flag an issue for deep analysis", async () => {
			const result = await executeReflectionTool(
				{
					name: "flagForDeepAnalysis",
					arguments: {
						path: "memory/learnings.md",
						issue: "Contains outdated information about Workers AI models",
					},
				},
				context,
			);

			expect(result.success).toBe(true);
			expect(context.flaggedIssues).toHaveLength(1);
			expect(context.flaggedIssues[0].issue).toContain("outdated information");
		});
	});

	describe("finishReflection", () => {
		it("should finish reflection with summary", async () => {
			const result = await executeReflectionTool(
				{
					name: "finishReflection",
					arguments: {
						summary: "Found 2 issues and proposed fixes",
						proposedChanges: 2,
						autoApplied: 1,
					},
				},
				context,
			);

			expect(result.success).toBe(true);
			expect((result.result as any).finished).toBe(true);
			expect((result.result as any).summary).toBe("Found 2 issues and proposed fixes");
		});
	});

	describe("finishQuickScan", () => {
		it("should finish quick scan with counts", async () => {
			const result = await executeReflectionTool(
				{
					name: "finishQuickScan",
					arguments: {
						autoApplied: 3,
						flaggedForDeepAnalysis: 2,
					},
				},
				context,
			);

			expect(result.success).toBe(true);
			expect((result.result as any).finished).toBe(true);
			expect((result.result as any).phase).toBe("quick_scan");
		});
	});

	describe("unknown tool", () => {
		it("should return error for unknown tool", async () => {
			const result = await executeReflectionTool({ name: "unknownTool", arguments: {} }, context);

			expect(result.success).toBe(false);
			expect(result.error).toContain("Unknown tool");
		});
	});
});

describe("createExecutionContext", () => {
	it("should create context with empty arrays", () => {
		const mockStorage = createMockStorage();
		const context = createExecutionContext(mockStorage, {
			MEMORY_BUCKET: {} as any,
			MEMORY_INDEX: {} as any,
			AI: {} as any,
			MEMORY_AUTH_TOKEN: "test",
		});

		expect(context.proposedEdits).toEqual([]);
		expect(context.autoAppliedFixes).toEqual([]);
		expect(context.flaggedIssues).toEqual([]);
	});
});
