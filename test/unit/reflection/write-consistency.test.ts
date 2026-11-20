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

describe("reflection split apply (cron)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.storage = createMockStorage();
		mocks.indexWrite.mockImplementation(async (_env, storage, path, content) => {
			await storage.write(path, content);
			return { success: true, tags: [], links: [] };
		});
	});

	it("applies a split and refuses a replace staged for the same file", async () => {
		const sec = (n: string) => `## ${n}\n\n- ${"y".repeat(15000)}\n\n`;
		const source = `# Log\n\nIntro.\n\n${sec("November 2")}${sec("November 1")}${sec("October 31")}`;
		await mocks.storage?.write("memory/projects/log.md", source);
		mocks.runAgenticReflection.mockResolvedValue({
			success: true,
			summary: "split one file",
			proposedEdits: [
				{
					path: "memory/projects/log.md",
					action: "split",
					to: "memory/projects/log-2026-10.md",
					headings: ["## October 31"],
					reason: "45K",
				},
				{
					path: "memory/projects/log.md",
					action: "replace",
					content: source,
					reason: "stale copy",
				},
				{
					path: "memory/projects/log-2026-10.md",
					action: "create",
					content: "clobber",
					reason: "bad",
				},
			],
			autoAppliedFixes: [],
			flaggedIssues: [],
			writeFailures: [],
			deepAnalysisIterations: 1,
			deepAnalysisFinished: true,
			focus: { id: "structure", title: "Structure and misplaced files" },
			model: "@cf/test/model",
		});

		const result = await runReflection({
			MEMORY_BUCKET: {},
			USE_AGENTIC_REFLECTION: "true",
		} as never);

		const after = (await mocks.storage?.read("memory/projects/log.md"))?.content ?? "";
		expect(after).not.toContain("## October 31");
		expect(after).toContain("Moved to [[memory/projects/log-2026-10]]");
		expect((await mocks.storage?.read("memory/projects/log-2026-10.md"))?.content).toContain(
			"## October 31",
		);
		expect(result.edits).toEqual([expect.objectContaining({ action: "split" })]);
		expect(result.flaggedIssues).toEqual([
			expect.objectContaining({
				path: "memory/projects/log.md",
				issue:
					"Reflection proposed a replace of a file a split moves sections out of or into, and it was refused: REFUSED (a split (memory/projects/log.md -> memory/projects/log-2026-10.md) touches memory/projects/log.md in the same reflection): stale copy",
			}),
			expect.objectContaining({
				path: "memory/projects/log-2026-10.md",
				issue: expect.stringContaining(
					"Reflection proposed a create of a file a split moves sections out of or into",
				),
			}),
		]);
		expect((await mocks.storage?.read("memory/projects/log-2026-10.md"))?.content).not.toContain(
			"clobber",
		);
		const archived = await mocks.storage?.read(`memory/reflections/archive/${result.date}.md`);
		expect(archived?.content).toContain(
			"SPLIT: memory/projects/log.md → memory/projects/log-2026-10.md",
		);
		expect(archived?.content).toContain("- `## October 31`");
	});

	it("records an index failure after a split as a failed edit, with both files saved", async () => {
		const sec = (n: string) => `## ${n}\n\n- ${"y".repeat(15000)}\n\n`;
		await mocks.storage?.write(
			"memory/projects/log.md",
			`# Log\n\n${sec("B")}${sec("A")}${sec("Old")}`,
		);
		mocks.indexWrite.mockImplementation(async (_env, storage, path, content) => {
			await storage.write(path, content);
			return { success: true, tags: [], links: [], embedding_error: "down" };
		});
		mocks.runAgenticReflection.mockResolvedValue({
			success: true,
			summary: "split",
			proposedEdits: [
				{
					path: "memory/projects/log.md",
					action: "split",
					to: "memory/projects/log-old.md",
					headings: ["## Old"],
					reason: "big",
				},
			],
			autoAppliedFixes: [],
			flaggedIssues: [],
			writeFailures: [],
			deepAnalysisIterations: 1,
			deepAnalysisFinished: true,
			focus: { id: "structure", title: "Structure and misplaced files" },
			model: "@cf/test/model",
		});
		const result = await runReflection({
			MEMORY_BUCKET: {},
			USE_AGENTIC_REFLECTION: "true",
		} as never);
		expect(result.failedEdits).toEqual([
			expect.stringMatching(
				/^split: memory\/projects\/log\.md -> memory\/projects\/log-old\.md — split done and both files saved/,
			),
		]);
		expect((await mocks.storage?.read("memory/projects/log.md"))?.content).not.toContain("## Old");
		expect((await mocks.storage?.read("memory/projects/log-old.md"))?.content).toContain("## Old");
	});
});
