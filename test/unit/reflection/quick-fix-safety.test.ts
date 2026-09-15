import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ToolExecutionContext,
	executeReflectionTool,
} from "../../../src/reflection/tool-executor";

/**
 * Safety rails on auto-applied quick fixes.
 *
 * These run unattended against storage that may have no versioning, so an
 * over-eager fix may be unrecoverable. Every fix type ultimately funnels into
 * `content.replace(oldText, newText ?? "")` with `oldText` chosen freely by
 * the model, so a nominally cosmetic "duplicate" fix otherwise has no
 * structural limit on how much it can delete.
 */
describe("quick fix safety", () => {
	const PATH = "memory/learnings.md";

	let written: Array<{ path: string; content: string }>;
	let context: ToolExecutionContext;
	let fileContent: string;
	let updateIndex: ReturnType<typeof vi.fn>;

	function makeContext(): ToolExecutionContext {
		return {
			storage: {
				read: vi.fn(async (path: string) =>
					path === PATH ? { content: fileContent, metadata: {} } : null,
				),
				write: vi.fn(async (path: string, content: string) => {
					written.push({ path, content });
					return { version_id: "v1" };
				}),
				list: vi.fn(async () => []),
				delete: vi.fn(async () => undefined),
			} as unknown as ToolExecutionContext["storage"],
			env: {
				// indexWrite reaches for the DO; a stub keeps these unit-level. The
				// call is asserted via storage.write, which indexWrite performs
				// first.
				MEMORY_INDEX: {
					idFromName: () => ({}),
					get: () => ({
						update: updateIndex,
						delete: async () => ({ success: true }),
						search: async () => [],
					}),
				},
			} as unknown as ToolExecutionContext["env"],
			proposedEdits: [],
			autoAppliedFixes: [],
			flaggedIssues: [],
			writeFailures: [],
		};
	}

	beforeEach(() => {
		written = [];
		updateIndex = vi.fn(async () => ({ success: true }));
		fileContent = `# Learnings\n\n${"- A real learning that matters. ".repeat(40)}\n\nstray: tag line\n\n${"- Another learning worth keeping. ".repeat(40)}\n`;
		context = makeContext();
	});

	async function applyFix(args: Record<string, unknown>) {
		return executeReflectionTool(
			{
				id: "call_auto_apply",
				name: "autoApply",
				arguments: { path: PATH, reason: "test", ...args },
			},
			context,
		);
	}

	it("allows a small deletion, such as a stray tag line", async () => {
		const result = await applyFix({ fixType: "duplicate", oldText: "stray: tag line\n" });

		expect(result.success).toBe(true);
		expect(written).toHaveLength(1);
		expect(written[0].content).not.toContain("stray: tag line");
		expect(context.autoAppliedFixes).toHaveLength(1);
	});

	it("refuses a deletion large enough to be a content decision", async () => {
		// The model picks oldText freely, so "duplicate" can name a whole
		// section. That is a judgement call, not a tidy-up.
		const bigChunk = "- A real learning that matters. ".repeat(40);
		const result = await applyFix({ fixType: "duplicate", oldText: bigChunk });

		expect(result.success).toBe(false);
		expect(result.error).toContain("Refusing to auto-apply");
		expect(result.error).toContain("proposeEdit");
		// Nothing written, and nothing recorded as applied.
		expect(written).toHaveLength(0);
		expect(context.autoAppliedFixes).toHaveLength(0);
	});

	it("refuses a duplicate fix whose oldText matches the entire file", async () => {
		// Without a guard this is an unrecoverable truncation to zero bytes.
		const result = await applyFix({ fixType: "duplicate", oldText: fileContent });

		expect(result.success).toBe(false);
		expect(written).toHaveLength(0);
	});

	it("allows a same-length replacement regardless of size", async () => {
		// The limit is on net shrinkage, so a genuine typo fix inside a long
		// span is unaffected.
		const oldText = "- A real learning that matters. ".repeat(40);
		const result = await applyFix({
			fixType: "typo",
			oldText,
			newText: oldText.replace("matters", "mattered"),
		});

		expect(result.success).toBe(true);
		expect(written).toHaveLength(1);
	});

	it("routes the write through indexWrite so the index cannot go stale", async () => {
		const result = await applyFix({ fixType: "newline" });

		expect(result.success).toBe(true);
		expect(written).toHaveLength(1);
		expect(updateIndex).toHaveBeenCalledOnce();
		expect(updateIndex).toHaveBeenCalledWith(
			expect.objectContaining({ path: PATH, content: written[0].content }),
		);
		// trimEnd also removes the trailing space this fixture ends with.
		expect(written[0].content.endsWith("keeping.\n")).toBe(true);
		expect(written[0].content).not.toMatch(/\n\n$/);
	});

	it("surfaces a partial failure when storage succeeds but indexing fails", async () => {
		updateIndex.mockRejectedValueOnce(new Error("embedding service unavailable"));

		const result = await applyFix({ fixType: "newline" });

		expect(result.success).toBe(false);
		expect(result.error).toContain("content was saved");
		expect(result.error).toContain("Reindex this file");
		expect(written).toHaveLength(1);
		expect(updateIndex).toHaveBeenCalledOnce();
		expect(context.autoAppliedFixes).toHaveLength(0);
		expect(context.writeFailures).toEqual([
			expect.stringContaining("embedding service unavailable"),
		]);
		expect(context.flaggedIssues).toEqual([
			expect.objectContaining({
				path: PATH,
				issue: expect.stringContaining("embedding service unavailable"),
			}),
		]);
	});

	it("makes no write at all when the fix would not change the content", async () => {
		fileContent = "# Already tidy\n\nOne line, one trailing newline.\n";
		context = makeContext();

		const result = await applyFix({ fixType: "newline" });

		expect(result.success).toBe(true);
		expect(written).toHaveLength(0);
	});

	it("reports a missing oldText instead of writing anything", async () => {
		const result = await applyFix({ fixType: "typo", oldText: "not in the file", newText: "x" });

		expect(result.success).toBe(false);
		expect(result.error).toContain("oldText not found");
		expect(written).toHaveLength(0);
	});
});
