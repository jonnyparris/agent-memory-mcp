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
			deepAnalysisIterations: 1,
			deepAnalysisFinished: true,
			focus: { id: "orphans", title: "Links and orphans" },
			model: "@cf/test/model",
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

	it("does not call a run that ran out of turns 'looks good'", async () => {
		mocks.runAgenticReflection.mockResolvedValue({
			success: true,
			summary: "Deep analysis ran out of turns",
			proposedEdits: [],
			autoAppliedFixes: [],
			flaggedIssues: [],
			writeFailures: [],
			deepAnalysisIterations: 25,
			deepAnalysisFinished: false,
			focus: { id: "orphans", title: "Links and orphans" },
			model: "@cf/test/model",
		});

		const result = await runReflection({
			MEMORY_BUCKET: {},
			USE_AGENTIC_REFLECTION: "true",
		} as never);

		expect(result.incomplete).toBe(true);
		expect(result.summary).not.toContain("looks good");
		expect(result.summary).toContain("did not finish");
		expect(result.summary).toContain("after 25 turns");
	});

	it("refuses a replace that would gut the file at apply time", async () => {
		await mocks.storage?.write("memory/learnings.md", "x".repeat(10000));
		mocks.indexWrite.mockResolvedValue({ success: true, tags: [], links: [] });

		const result = await runReflection({
			MEMORY_BUCKET: {},
			USE_AGENTIC_REFLECTION: "true",
		} as never);

		expect(mocks.indexWrite).not.toHaveBeenCalled();
		expect((await mocks.storage?.read("memory/learnings.md"))?.content).toBe("x".repeat(10000));
		expect(result.flaggedIssues).toEqual([
			expect.objectContaining({
				path: "memory/learnings.md",
				issue: expect.stringContaining("rewrite of this file and was refused"),
			}),
		]);
	});
});
