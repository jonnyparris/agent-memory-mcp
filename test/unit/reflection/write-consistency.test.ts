import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockStorage } from "../../mocks/storage";

const mocks = vi.hoisted(() => ({
	indexWrite: vi.fn(),
	runAgenticReflection: vi.fn(),
	storage: undefined as ReturnType<typeof createMockStorage> | undefined,
}));

vi.mock("../../../src/search/index-write", () => ({
	indexWrite: mocks.indexWrite,
}));

vi.mock("../../../src/reflection/agentic", () => ({
	runAgenticReflection: mocks.runAgenticReflection,
}));

vi.mock("../../../src/storage/r2", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../../src/storage/r2")>();
	return {
		...original,
		createR2Storage: () => mocks.storage,
	};
});

import { runReflection } from "../../../src/reflection";

describe("reflection write consistency", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.storage = createMockStorage();
		mocks.runAgenticReflection.mockResolvedValue({
			success: true,
			summary: "proposed one update",
			proposedEdits: [
				{
					path: "memory/learnings.md",
					action: "replace",
					content: "updated content",
					reason: "refresh a fact",
				},
			],
			autoAppliedFixes: [],
			flaggedIssues: [],
			writeFailures: [],
			quickScanIterations: 1,
			deepAnalysisIterations: 1,
		});
	});

	it("reports storage success plus index failure as a partial failure", async () => {
		mocks.indexWrite.mockImplementation(async (_env, storage, path, content) => {
			await storage.write(path, content);
			return {
				success: true,
				tags: [],
				links: [],
				embedding_error: "embedding service unavailable",
			};
		});

		const result = await runReflection({
			MEMORY_BUCKET: {},
			USE_AGENTIC_REFLECTION: "true",
		} as never);

		expect(mocks.indexWrite).toHaveBeenCalledOnce();
		expect(await mocks.storage?.read("memory/learnings.md")).toEqual(
			expect.objectContaining({ content: "updated content" }),
		);
		expect(result.success).toBe(false);
		expect(result.edits).toEqual([]);
		expect(result.autoApplied).toBe(0);
		expect(result.failedEdits).toEqual([
			expect.stringContaining("content was saved, but the search index update failed"),
		]);
		expect(result.failedEdits?.[0]).toContain("Reindex this file");
		expect(result.error).toContain("Reflection completed with partial failures");
		expect(result.error).toContain("Reindex this file");

		const archivedMarkdown = await mocks.storage?.read(
			`memory/reflections/archive/${result.date}.md`,
		);
		expect(archivedMarkdown?.content).toContain("## Failed Changes");
		expect(archivedMarkdown?.content).toContain("Reindex this file");

		const archivedJson = await mocks.storage?.read(
			`memory/reflections/archive/${result.date}.json`,
		);
		expect(JSON.parse(archivedJson?.content ?? "{}").failedEdits).toEqual(result.failedEdits);
	});
});
