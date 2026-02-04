import { beforeEach, describe, expect, it } from "vitest";
import {
	type StagedReflection,
	archiveReflection,
	listPendingReflections,
	writeStagedReflection,
} from "../../../src/reflection/staging";
import { createMockStorage } from "../../mocks/storage";

describe("writeStagedReflection", () => {
	let mockStorage: ReturnType<typeof createMockStorage>;

	beforeEach(() => {
		mockStorage = createMockStorage();
	});

	it("should write reflection to pending directory", async () => {
		const reflection: StagedReflection = {
			date: "2026-02-04",
			summary: "Test reflection summary",
			proposedEdits: [],
			autoAppliedFixes: [],
			flaggedIssues: [],
			quickScanIterations: 2,
			deepAnalysisIterations: 5,
		};

		const path = await writeStagedReflection(mockStorage, reflection);

		expect(path).toBe("memory/reflections/pending/2026-02-04.md");

		const file = await mockStorage.read(path);
		expect(file?.content).toContain("# Reflection - 2026-02-04");
		expect(file?.content).toContain("Test reflection summary");
	});

	it("should include statistics in output", async () => {
		const reflection: StagedReflection = {
			date: "2026-02-04",
			summary: "Summary",
			proposedEdits: [],
			autoAppliedFixes: [],
			flaggedIssues: [],
			quickScanIterations: 3,
			deepAnalysisIterations: 7,
		};

		await writeStagedReflection(mockStorage, reflection);
		const file = await mockStorage.read("memory/reflections/pending/2026-02-04.md");

		expect(file?.content).toContain("Quick Scan Iterations | 3");
		expect(file?.content).toContain("Deep Analysis Iterations | 7");
	});

	it("should include auto-applied fixes", async () => {
		const reflection: StagedReflection = {
			date: "2026-02-04",
			summary: "Summary",
			proposedEdits: [],
			autoAppliedFixes: [
				{
					path: "memory/learnings.md",
					fixType: "typo",
					oldText: "tset",
					newText: "test",
					reason: "Fixed typo",
				},
			],
			flaggedIssues: [],
			quickScanIterations: 1,
			deepAnalysisIterations: 1,
		};

		await writeStagedReflection(mockStorage, reflection);
		const file = await mockStorage.read("memory/reflections/pending/2026-02-04.md");

		expect(file?.content).toContain("Auto-Applied Fixes");
		expect(file?.content).toContain("TYPO");
		expect(file?.content).toContain("memory/learnings.md");
		expect(file?.content).toContain("Fixed typo");
	});

	it("should include proposed edits", async () => {
		const reflection: StagedReflection = {
			date: "2026-02-04",
			summary: "Summary",
			proposedEdits: [
				{
					path: "memory/learnings.md",
					action: "replace",
					content: "# New Content\n\nUpdated learnings",
					reason: "Consolidated duplicate entries",
				},
			],
			autoAppliedFixes: [],
			flaggedIssues: [],
			quickScanIterations: 1,
			deepAnalysisIterations: 1,
		};

		await writeStagedReflection(mockStorage, reflection);
		const file = await mockStorage.read("memory/reflections/pending/2026-02-04.md");

		expect(file?.content).toContain("Proposed Changes");
		expect(file?.content).toContain("REPLACE");
		expect(file?.content).toContain("memory/learnings.md");
		expect(file?.content).toContain("Consolidated duplicate entries");
		expect(file?.content).toContain("# New Content");
	});

	it("should include delete action without content", async () => {
		const reflection: StagedReflection = {
			date: "2026-02-04",
			summary: "Summary",
			proposedEdits: [
				{
					path: "memory/old-file.md",
					action: "delete",
					reason: "File is no longer needed",
				},
			],
			autoAppliedFixes: [],
			flaggedIssues: [],
			quickScanIterations: 1,
			deepAnalysisIterations: 1,
		};

		await writeStagedReflection(mockStorage, reflection);
		const file = await mockStorage.read("memory/reflections/pending/2026-02-04.md");

		expect(file?.content).toContain("DELETE");
		expect(file?.content).toContain("memory/old-file.md");
		expect(file?.content).toContain("File is no longer needed");
	});

	it("should show message when no auto-fixes applied", async () => {
		const reflection: StagedReflection = {
			date: "2026-02-04",
			summary: "Summary",
			proposedEdits: [],
			autoAppliedFixes: [],
			flaggedIssues: [],
			quickScanIterations: 1,
			deepAnalysisIterations: 1,
		};

		await writeStagedReflection(mockStorage, reflection);
		const file = await mockStorage.read("memory/reflections/pending/2026-02-04.md");

		expect(file?.content).toContain("No auto-fixes were applied");
	});

	it("should show message when no proposed changes", async () => {
		const reflection: StagedReflection = {
			date: "2026-02-04",
			summary: "Summary",
			proposedEdits: [],
			autoAppliedFixes: [],
			flaggedIssues: [],
			quickScanIterations: 1,
			deepAnalysisIterations: 1,
		};

		await writeStagedReflection(mockStorage, reflection);
		const file = await mockStorage.read("memory/reflections/pending/2026-02-04.md");

		expect(file?.content).toContain("No changes proposed for review");
	});

	it("should list unresolved flagged issues", async () => {
		const reflection: StagedReflection = {
			date: "2026-02-04",
			summary: "Summary",
			proposedEdits: [],
			autoAppliedFixes: [],
			flaggedIssues: [
				{
					path: "memory/complex.md",
					issue: "Contains contradictory information that needs manual review",
				},
			],
			quickScanIterations: 1,
			deepAnalysisIterations: 1,
		};

		await writeStagedReflection(mockStorage, reflection);
		const file = await mockStorage.read("memory/reflections/pending/2026-02-04.md");

		expect(file?.content).toContain("Unresolved Issues");
		expect(file?.content).toContain("memory/complex.md");
		expect(file?.content).toContain("contradictory information");
	});

	it("should not show unresolved issues if they were addressed", async () => {
		const reflection: StagedReflection = {
			date: "2026-02-04",
			summary: "Summary",
			proposedEdits: [
				{
					path: "memory/complex.md",
					action: "replace",
					content: "fixed content",
					reason: "Fixed the issue",
				},
			],
			autoAppliedFixes: [],
			flaggedIssues: [
				{
					path: "memory/complex.md",
					issue: "Issue that was subsequently fixed",
				},
			],
			quickScanIterations: 1,
			deepAnalysisIterations: 1,
		};

		await writeStagedReflection(mockStorage, reflection);
		const file = await mockStorage.read("memory/reflections/pending/2026-02-04.md");

		// The flagged issue for complex.md was addressed, so shouldn't show as unresolved
		expect(file?.content).not.toContain("Unresolved Issues");
	});

	it("should include after review instructions", async () => {
		const reflection: StagedReflection = {
			date: "2026-02-04",
			summary: "Summary",
			proposedEdits: [],
			autoAppliedFixes: [],
			flaggedIssues: [],
			quickScanIterations: 1,
			deepAnalysisIterations: 1,
		};

		await writeStagedReflection(mockStorage, reflection);
		const file = await mockStorage.read("memory/reflections/pending/2026-02-04.md");

		expect(file?.content).toContain("After Review");
		expect(file?.content).toContain("archive");
	});
});

describe("listPendingReflections", () => {
	let mockStorage: ReturnType<typeof createMockStorage>;

	beforeEach(() => {
		mockStorage = createMockStorage();
	});

	it("should list pending reflections sorted by date (newest first)", async () => {
		mockStorage._files.set("memory/reflections/pending/2026-02-01.md", {
			content: "reflection 1",
			updated_at: "2026-02-01T10:00:00Z",
		});
		mockStorage._files.set("memory/reflections/pending/2026-02-03.md", {
			content: "reflection 2",
			updated_at: "2026-02-03T10:00:00Z",
		});
		mockStorage._files.set("memory/reflections/pending/2026-02-02.md", {
			content: "reflection 3",
			updated_at: "2026-02-02T10:00:00Z",
		});

		const result = await listPendingReflections(mockStorage);

		expect(result).toHaveLength(3);
		expect(result[0].date).toBe("2026-02-03");
		expect(result[1].date).toBe("2026-02-02");
		expect(result[2].date).toBe("2026-02-01");
	});

	it("should return empty array when no pending reflections", async () => {
		const result = await listPendingReflections(mockStorage);
		expect(result).toEqual([]);
	});
});

describe("archiveReflection", () => {
	let mockStorage: ReturnType<typeof createMockStorage>;

	beforeEach(() => {
		mockStorage = createMockStorage();
	});

	it("should move reflection from pending to archive", async () => {
		mockStorage._files.set("memory/reflections/pending/2026-02-04.md", {
			content: "# Reflection content",
			updated_at: "2026-02-04T10:00:00Z",
		});

		const archivePath = await archiveReflection(
			mockStorage,
			"memory/reflections/pending/2026-02-04.md",
		);

		expect(archivePath).toBe("memory/reflections/archive/2026-02-04.md");

		// Verify file moved
		const pending = await mockStorage.read("memory/reflections/pending/2026-02-04.md");
		const archived = await mockStorage.read("memory/reflections/archive/2026-02-04.md");

		expect(pending).toBeNull();
		expect(archived?.content).toBe("# Reflection content");
	});

	it("should return null for non-existent file", async () => {
		const result = await archiveReflection(
			mockStorage,
			"memory/reflections/pending/nonexistent.md",
		);
		expect(result).toBeNull();
	});

	it("should return null for invalid path format", async () => {
		mockStorage._files.set("memory/reflections/pending/invalid-name.md", {
			content: "content",
			updated_at: "2026-02-04T10:00:00Z",
		});

		const result = await archiveReflection(
			mockStorage,
			"memory/reflections/pending/invalid-name.md",
		);
		expect(result).toBeNull();
	});
});
