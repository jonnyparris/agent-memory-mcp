import { describe, expect, it, vi } from "vitest";
import { _internal } from "../../src/reflection";
import type { MemoryFileMetadata } from "../../src/types";

const { filterRecentFiles, buildReflectionPrompt, parseReflectionResponse } = _internal;

describe("filterRecentFiles", () => {
	const mockFiles: MemoryFileMetadata[] = [
		{ path: "memory/learnings.md", size: 1000, updated_at: "2026-01-30T10:00:00Z" },
		{ path: "memory/projects.md", size: 500, updated_at: "2026-01-29T10:00:00Z" },
		{ path: "memory/patterns/cloudflare.md", size: 800, updated_at: "2026-01-31T06:00:00Z" },
	];

	it("should return all files when no timestamp provided (first reflection)", () => {
		const result = filterRecentFiles(mockFiles, undefined);
		expect(result).toHaveLength(3);
	});

	it("should filter files modified after timestamp", () => {
		// Timestamp for Jan 30, 2026 00:00:00 UTC
		const since = new Date("2026-01-30T00:00:00Z").getTime();
		const result = filterRecentFiles(mockFiles, since);

		expect(result).toHaveLength(2);
		expect(result.map((f) => f.path)).toContain("memory/learnings.md");
		expect(result.map((f) => f.path)).toContain("memory/patterns/cloudflare.md");
	});

	it("should return empty array when no files modified after timestamp", () => {
		// Timestamp in the future
		const since = new Date("2027-01-01T00:00:00Z").getTime();
		const result = filterRecentFiles(mockFiles, since);

		expect(result).toHaveLength(0);
	});

	it("should handle empty file list", () => {
		const result = filterRecentFiles([], 1234567890);
		expect(result).toHaveLength(0);
	});
});

describe("buildReflectionPrompt", () => {
	it("should include date in prompt", () => {
		const context = {
			date: "2026-01-31",
			lastReflection: null,
			recentFiles: [],
			coreMemory: {},
			patterns: {},
		};

		const prompt = buildReflectionPrompt(context);

		expect(prompt).toContain("2026-01-31");
		expect(prompt).toContain("Daily Reflection");
	});

	it("should indicate first reflection when no previous reflection", () => {
		const context = {
			date: "2026-01-31",
			lastReflection: null,
			recentFiles: [],
			coreMemory: {},
			patterns: {},
		};

		const prompt = buildReflectionPrompt(context);

		expect(prompt).toContain("first reflection");
	});

	it("should include last reflection date when available", () => {
		const context = {
			date: "2026-01-31",
			lastReflection: { timestamp: 1234567890, date: "2026-01-30" },
			recentFiles: [],
			coreMemory: {},
			patterns: {},
		};

		const prompt = buildReflectionPrompt(context);

		expect(prompt).toContain("2026-01-30");
	});

	it("should list recent files", () => {
		const context = {
			date: "2026-01-31",
			lastReflection: null,
			recentFiles: [
				{ path: "memory/learnings.md", size: 1000, updated_at: "2026-01-30T10:00:00Z" },
				{ path: "memory/projects.md", size: 500, updated_at: "2026-01-29T10:00:00Z" },
			],
			coreMemory: {},
			patterns: {},
		};

		const prompt = buildReflectionPrompt(context);

		expect(prompt).toContain("memory/learnings.md");
		expect(prompt).toContain("memory/projects.md");
		expect(prompt).toContain("1000 bytes");
	});

	it("should include core memory content", () => {
		const context = {
			date: "2026-01-31",
			lastReflection: null,
			recentFiles: [],
			coreMemory: {
				"memory/learnings.md": "# Learnings\n- Workers AI returns nested arrays",
			},
			patterns: {},
		};

		const prompt = buildReflectionPrompt(context);

		expect(prompt).toContain("Workers AI returns nested arrays");
		expect(prompt).toContain("memory/learnings.md");
	});

	it("should include pattern files", () => {
		const context = {
			date: "2026-01-31",
			lastReflection: null,
			recentFiles: [],
			coreMemory: {},
			patterns: {
				"memory/patterns/cloudflare-workers.md":
					"# Cloudflare Workers\n- Always use DurableObject import",
			},
		};

		const prompt = buildReflectionPrompt(context);

		expect(prompt).toContain("Cloudflare Workers");
		expect(prompt).toContain("DurableObject");
	});

	it("should indicate when no patterns exist", () => {
		const context = {
			date: "2026-01-31",
			lastReflection: null,
			recentFiles: [],
			coreMemory: {},
			patterns: {},
		};

		const prompt = buildReflectionPrompt(context);

		expect(prompt).toContain("No patterns documented");
	});

	it("should include all required task sections", () => {
		const context = {
			date: "2026-01-31",
			lastReflection: null,
			recentFiles: [],
			coreMemory: {},
			patterns: {},
		};

		const prompt = buildReflectionPrompt(context);

		expect(prompt).toContain("Summary");
		expect(prompt).toContain("Consolidation");
		expect(prompt).toContain("Gaps");
		expect(prompt).toContain("Errors");
		expect(prompt).toContain("Suggestions for Human");
		expect(prompt).toContain("Suggestions for Agent");
		expect(prompt).toContain("New Ideas");
	});
});

describe("parseReflectionResponse", () => {
	it("should extract content from markdown code block", () => {
		const response = `
Here is my reflection:

\`\`\`markdown
# Reflection - 2026-01-31

## Summary
The memory system is in good shape with recent updates to learnings.

## Consolidation Suggestions
- None needed

## Knowledge Gaps
- Missing documentation on deployment process

## Errors Found
- None found

## Suggestions for Human
- Consider adding more code examples

## Suggestions for Agent
- Could use more context when searching

## New Ideas
- Build a review workflow tool
\`\`\`
`;

		const result = parseReflectionResponse(response, "2026-01-31");

		expect(result.content).toContain("# Reflection - 2026-01-31");
		expect(result.content).toContain("## Summary");
		expect(result.content).not.toContain("```markdown");
	});

	it("should extract summary from content", () => {
		const response = `
\`\`\`markdown
# Reflection - 2026-01-31

## Summary
The memory system is functioning well with comprehensive learnings documented.

## Consolidation Suggestions
- None
\`\`\`
`;

		const result = parseReflectionResponse(response, "2026-01-31");

		expect(result.summary).toContain("memory system is functioning well");
	});

	it("should handle response without code block", () => {
		const response = `# Reflection - 2026-01-31

## Summary
Direct markdown response without code block.

## Consolidation Suggestions
- None`;

		const result = parseReflectionResponse(response, "2026-01-31");

		expect(result.content).toContain("# Reflection - 2026-01-31");
		expect(result.content).toContain("Direct markdown response");
	});

	it("should truncate long summaries", () => {
		const longSummary = "A".repeat(300);
		const response = `
\`\`\`markdown
# Reflection - 2026-01-31

## Summary
${longSummary}

## Consolidation Suggestions
- None
\`\`\`
`;

		const result = parseReflectionResponse(response, "2026-01-31");

		expect(result.summary.length).toBeLessThanOrEqual(200);
	});

	it("should provide default summary when section not found", () => {
		const response = "Some malformed response without proper sections";

		const result = parseReflectionResponse(response, "2026-01-31");

		expect(result.summary).toContain("2026-01-31");
		expect(result.summary).toContain("Reflection completed");
	});

	it("should handle empty response", () => {
		const result = parseReflectionResponse("", "2026-01-31");

		expect(result.content).toBe("");
		expect(result.summary).toContain("Reflection completed for 2026-01-31");
	});
});

describe("notification card building", () => {
	// Test is in notification module but worth having here for integration
	it("should import buildReflectionCard without error", async () => {
		const { buildReflectionCard } = await import("../../src/notification");
		expect(typeof buildReflectionCard).toBe("function");
	});
});

describe("LLM provider", () => {
	it("should import WorkersAIProvider without error", async () => {
		const { WorkersAIProvider } = await import("../../src/llm/workers-ai");
		expect(typeof WorkersAIProvider).toBe("function");
	});

	it("WorkersAIProvider should implement LLMProvider interface", async () => {
		const { WorkersAIProvider } = await import("../../src/llm/workers-ai");

		// Create with mock AI
		const mockAI = {
			run: vi.fn().mockResolvedValue({ response: "test response" }),
		};

		const provider = new WorkersAIProvider(mockAI as any);

		expect(provider.name).toBe("workers-ai");
		expect(provider.model).toBe("@cf/qwen/qwq-32b");
		expect(typeof provider.complete).toBe("function");
	});

	it("WorkersAIProvider.complete should call AI.run with messages", async () => {
		const { WorkersAIProvider } = await import("../../src/llm/workers-ai");

		const mockAI = {
			run: vi.fn().mockResolvedValue({ response: "Generated response" }),
		};

		const provider = new WorkersAIProvider(mockAI as any);
		const result = await provider.complete("Test prompt");

		expect(mockAI.run).toHaveBeenCalledWith(
			"@cf/qwen/qwq-32b",
			expect.objectContaining({
				messages: expect.arrayContaining([
					expect.objectContaining({ role: "user", content: "Test prompt" }),
				]),
			}),
		);

		expect(result.response).toBe("Generated response");
	});

	it("WorkersAIProvider should include system prompt when provided", async () => {
		const { WorkersAIProvider } = await import("../../src/llm/workers-ai");

		const mockAI = {
			run: vi.fn().mockResolvedValue({ response: "test" }),
		};

		const provider = new WorkersAIProvider(mockAI as any);
		await provider.complete("User prompt", { systemPrompt: "You are a helpful assistant" });

		expect(mockAI.run).toHaveBeenCalledWith(
			"@cf/qwen/qwq-32b",
			expect.objectContaining({
				messages: expect.arrayContaining([
					expect.objectContaining({ role: "system", content: "You are a helpful assistant" }),
					expect.objectContaining({ role: "user", content: "User prompt" }),
				]),
			}),
		);
	});
});
