import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockStorage } from "../../mocks/storage";

// Mock the WorkersAIProvider to control LLM responses
vi.mock("../../../src/llm/workers-ai", () => ({
	WorkersAIProvider: vi.fn().mockImplementation(() => ({
		name: "workers-ai",
		model: "@cf/moonshotai/kimi-k2.6",
		complete: vi.fn(),
	})),
	REFLECTION_MODELS: {
		primary: "@cf/moonshotai/kimi-k2.6",
		fast: "@cf/zai-org/glm-4.7-flash",
		fallback: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		legacy: "@cf/qwen/qwq-32b",
	},
}));

import { WorkersAIProvider } from "../../../src/llm/workers-ai";
import {
	MAX_DEEP_ANALYSIS_ITERATIONS,
	MAX_QUICK_SCAN_ITERATIONS,
	compactHistory,
	runAgenticReflection,
	runDeepAnalysisOnly,
} from "../../../src/reflection/agentic";

describe("runAgenticReflection", () => {
	let mockStorage: ReturnType<typeof createMockStorage>;
	let mockEnv: any;
	let mockLLMComplete: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockStorage = createMockStorage();

		// Set up some test files
		mockStorage._files.set("memory/learnings.md", {
			content: "# Learnings\n\n- Test learning",
			updated_at: "2026-02-04T10:00:00Z",
		});

		mockEnv = {
			MEMORY_BUCKET: {} as any,
			MEMORY_INDEX: {
				idFromName: vi.fn().mockReturnValue("test-id"),
				get: vi.fn().mockReturnValue({
					fetch: vi.fn().mockResolvedValue({
						ok: true,
						json: () => Promise.resolve([]),
					}),
				}),
			} as any,
			AI: {} as any,
			MEMORY_AUTH_TOKEN: "test-token",
			REFLECTION_MODEL: "@cf/moonshotai/kimi-k2.6",
			REFLECTION_MODEL_FAST: "@cf/zai-org/glm-4.7-flash",
		};

		// Get the mock complete function
		mockLLMComplete = vi.fn();
		vi.mocked(WorkersAIProvider).mockImplementation(
			() =>
				({
					name: "workers-ai",
					model: "@cf/moonshotai/kimi-k2.6",
					complete: mockLLMComplete,
				}) as any,
		);
	});

	it("should complete reflection with finishQuickScan and finishReflection", async () => {
		// Quick scan finishes immediately
		mockLLMComplete.mockResolvedValueOnce({
			response: "Quick scan complete",
			toolCalls: [
				{
					id: "call_test",
					name: "finishQuickScan",
					arguments: { autoApplied: 0, flaggedForDeepAnalysis: 0 },
				},
			],
		});

		// Deep analysis finishes immediately
		mockLLMComplete.mockResolvedValueOnce({
			response: "Deep analysis complete",
			toolCalls: [
				{
					id: "call_test",
					name: "finishReflection",
					arguments: {
						summary: "Memory is in good shape",
						proposedChanges: 0,
						autoApplied: 0,
					},
				},
			],
		});

		const result = await runAgenticReflection(mockEnv, mockStorage);

		expect(result.success).toBe(true);
		expect(result.summary).toBe("Memory is in good shape");
		expect(result.quickScanIterations).toBeGreaterThan(0);
		expect(result.deepAnalysisIterations).toBeGreaterThan(0);
	});

	it("should preserve call metadata across a multi-turn quick scan", async () => {
		// First turn has no prose: the old `if (result.response)` guard dropped
		// this assistant turn entirely, including its tool call.
		mockLLMComplete.mockResolvedValueOnce({
			response: "",
			toolCalls: [
				{
					id: "call_list",
					name: "listFiles",
					arguments: { path: "memory", recursive: true },
				},
			],
		});

		mockLLMComplete.mockResolvedValueOnce({
			response: "Done scanning",
			toolCalls: [
				{
					id: "call_finish_quick",
					name: "finishQuickScan",
					arguments: { autoApplied: 0, flaggedForDeepAnalysis: 0 },
				},
			],
		});

		mockLLMComplete.mockResolvedValueOnce({
			response: "Deep analysis",
			toolCalls: [
				{
					id: "call_finish_deep",
					name: "finishReflection",
					arguments: {
						summary: "Scanned files, no issues found",
						proposedChanges: 0,
						autoApplied: 0,
					},
				},
			],
		});

		const result = await runAgenticReflection(mockEnv, mockStorage);

		expect(result.success).toBe(true);
		expect(result.quickScanIterations).toBe(2);

		const secondTurnMessages = mockLLMComplete.mock.calls[1][0];
		expect(secondTurnMessages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "assistant",
					content: "",
					tool_calls: [expect.objectContaining({ id: "call_list", name: "listFiles" })],
				}),
				expect.objectContaining({
					role: "tool",
					tool_call_id: "call_list",
				}),
			]),
		);
	});

	it("should pass flagged issues from quick scan to deep analysis", async () => {
		// Quick scan flags an issue
		mockLLMComplete.mockResolvedValueOnce({
			response: "Found complex issue",
			toolCalls: [
				{
					id: "call_test",
					name: "flagForDeepAnalysis",
					arguments: {
						path: "memory/learnings.md",
						issue: "Contains outdated model information",
					},
				},
			],
		});

		mockLLMComplete.mockResolvedValueOnce({
			response: "Done",
			toolCalls: [
				{
					id: "call_test",
					name: "finishQuickScan",
					arguments: { autoApplied: 0, flaggedForDeepAnalysis: 1 },
				},
			],
		});

		// Deep analysis should receive the flagged issue
		mockLLMComplete.mockResolvedValueOnce({
			response: "Analyzing flagged issue",
			toolCalls: [
				{
					id: "call_test",
					name: "proposeEdit",
					arguments: {
						path: "memory/learnings.md",
						action: "replace",
						content: "# Updated Learnings\n\n- Current info",
						reason: "Updated outdated model information",
					},
				},
			],
		});

		mockLLMComplete.mockResolvedValueOnce({
			response: "Done",
			toolCalls: [
				{
					id: "call_test",
					name: "finishReflection",
					arguments: {
						summary: "Fixed outdated information",
						proposedChanges: 1,
						autoApplied: 0,
					},
				},
			],
		});

		const result = await runAgenticReflection(mockEnv, mockStorage);

		expect(result.success).toBe(true);
		expect(result.flaggedIssues).toHaveLength(1);
		expect(result.proposedEdits).toHaveLength(1);
	});

	it("should respect iteration limits", async () => {
		// Always return a non-finishing tool call
		mockLLMComplete.mockResolvedValue({
			response: "Still working",
			toolCalls: [
				{
					id: "call_test",
					name: "listFiles",
					arguments: { path: "memory" },
				},
			],
		});

		const result = await runAgenticReflection(mockEnv, mockStorage);

		// Stops at the caps, and says it ran out of turns rather than finishing.
		expect(result.success).toBe(true);
		expect(result.quickScanIterations).toBe(MAX_QUICK_SCAN_ITERATIONS);
		expect(result.deepAnalysisIterations).toBe(MAX_DEEP_ANALYSIS_ITERATIONS);
		expect(result.quickScanFinished).toBe(false);
		expect(result.deepAnalysisFinished).toBe(false);
		expect(result.summary).toContain("ran out of turns");
	});

	it("hands both phases a file inventory so they don't spend a turn listing", async () => {
		mockLLMComplete.mockResolvedValue({ response: "done", toolCalls: undefined });

		await runAgenticReflection(mockEnv, mockStorage);

		const quickPrompt = mockLLMComplete.mock.calls[0][0][0].content as string;
		const deepPrompt = mockLLMComplete.mock.calls[1][0][0].content as string;
		expect(quickPrompt).toContain("memory/learnings.md");
		expect(deepPrompt).toContain("memory/learnings.md");
	});

	it("warns near the end of the budget and narrows tools on the final turn", async () => {
		mockLLMComplete.mockResolvedValue({
			response: "",
			toolCalls: [{ id: "c", name: "readFile", arguments: { path: "memory/learnings.md" } }],
		});

		await runDeepAnalysisOnly(mockEnv, mockStorage);

		const calls = mockLLMComplete.mock.calls;
		expect(calls).toHaveLength(MAX_DEEP_ANALYSIS_ITERATIONS);

		const lastMessages = calls[calls.length - 1][0] as Array<{ role: string; content: string }>;
		const lastUser = [...lastMessages].reverse().find((m) => m.role === "user");
		expect(lastUser?.content).toContain("final turn");

		const lastTools = (calls[calls.length - 1][1].tools as Array<{ name: string }>).map(
			(t) => t.name,
		);
		expect(lastTools.sort()).toEqual(["finishReflection", "flagIssue", "proposeEdit"]);

		// Earlier turns get the full tool set.
		const firstTools = (calls[0][1].tools as Array<{ name: string }>).map((t) => t.name);
		expect(firstTools).toContain("readFile");
	});

	it("does not treat an empty stop as finishing", async () => {
		mockLLMComplete.mockResolvedValue({ response: "", toolCalls: undefined });

		const result = await runDeepAnalysisOnly(mockEnv, mockStorage);

		// One initial try plus two retries, then it gives up as unfinished.
		expect(mockLLMComplete).toHaveBeenCalledTimes(3);
		expect(result.deepAnalysisFinished).toBe(false);
		const retryPrompt = mockLLMComplete.mock.calls[1][0].at(-1).content as string;
		expect(retryPrompt).toContain("stopped without an answer");
	});

	it("sends a halfway checkpoint when nothing has been recorded", async () => {
		mockLLMComplete.mockResolvedValue({
			response: "",
			toolCalls: [{ id: "c", name: "readFile", arguments: { path: "memory/learnings.md" } }],
		});

		await runDeepAnalysisOnly(mockEnv, mockStorage);

		const prompts = (mockLLMComplete.mock.calls.at(-1) as any[])[0]
			.filter((m: { role: string }) => m.role === "user")
			.map((m: { content: string }) => m.content);
		expect(prompts.filter((p: string) => p.startsWith("Checkpoint:"))).toHaveLength(1);
	});

	it("runs every tool call in a turn, even alongside finishReflection", async () => {
		mockLLMComplete.mockResolvedValueOnce({
			response: "",
			toolCalls: [
				{
					id: "c1",
					name: "flagIssue",
					arguments: { path: "memory/learnings.md", issue: "stale entry" },
				},
				{
					id: "c2",
					name: "finishReflection",
					arguments: { summary: "one issue", proposedChanges: 0, autoApplied: 0 },
				},
			],
		});

		const result = await runDeepAnalysisOnly(mockEnv, mockStorage);

		expect(result.deepAnalysisFinished).toBe(true);
		expect(result.flaggedIssues).toEqual([{ path: "memory/learnings.md", issue: "stale entry" }]);
		expect(result.summary).toBe("one issue");
	});

	it("should handle LLM response with no tool calls", async () => {
		// Quick scan - no tool calls means done
		mockLLMComplete.mockResolvedValueOnce({
			response: "Everything looks fine",
			toolCalls: undefined,
		});

		// Deep analysis - no tool calls means done
		mockLLMComplete.mockResolvedValueOnce({
			response: "Memory is well organized",
			toolCalls: undefined,
		});

		const result = await runAgenticReflection(mockEnv, mockStorage);

		expect(result.success).toBe(true);
		expect(result.summary).toContain("Memory is well organized");
	});
});

describe("runDeepAnalysisOnly", () => {
	let mockStorage: ReturnType<typeof createMockStorage>;
	let mockEnv: any;
	let mockLLMComplete: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockStorage = createMockStorage();

		mockEnv = {
			MEMORY_BUCKET: {} as any,
			MEMORY_INDEX: {
				idFromName: vi.fn().mockReturnValue("test-id"),
				get: vi.fn().mockReturnValue({
					fetch: vi.fn().mockResolvedValue({
						ok: true,
						json: () => Promise.resolve([]),
					}),
				}),
			} as any,
			AI: {} as any,
			MEMORY_AUTH_TOKEN: "test-token",
		};

		mockLLMComplete = vi.fn();
		vi.mocked(WorkersAIProvider).mockImplementation(
			() =>
				({
					name: "workers-ai",
					model: "@cf/moonshotai/kimi-k2.6",
					complete: mockLLMComplete,
				}) as any,
		);
	});

	it("should skip quick scan and run only deep analysis", async () => {
		mockLLMComplete.mockResolvedValueOnce({
			response: "Deep analysis only",
			toolCalls: [
				{
					id: "call_test",
					name: "finishReflection",
					arguments: {
						summary: "Analysis complete",
						proposedChanges: 0,
						autoApplied: 0,
					},
				},
			],
		});

		const result = await runDeepAnalysisOnly(mockEnv, mockStorage);

		expect(result.success).toBe(true);
		expect(result.quickScanIterations).toBe(0); // Skipped
		expect(result.deepAnalysisIterations).toBeGreaterThan(0);
	});
});

describe("WorkersAIProvider tool calling", () => {
	it("should be constructable with custom model", async () => {
		const { WorkersAIProvider: RealProvider } = await vi.importActual<
			typeof import("../../../src/llm/workers-ai")
		>("../../../src/llm/workers-ai");

		const mockAI = {
			run: vi.fn().mockResolvedValue({ response: "test" }),
		};

		const provider = new RealProvider(mockAI as any, "@cf/moonshotai/kimi-k2.6");

		expect(provider.model).toBe("@cf/moonshotai/kimi-k2.6");
	});

	it("should parse tool calls from response", async () => {
		const { WorkersAIProvider: RealProvider } = await vi.importActual<
			typeof import("../../../src/llm/workers-ai")
		>("../../../src/llm/workers-ai");

		const mockAI = {
			run: vi.fn().mockResolvedValue({
				response: "",
				tool_calls: [
					{
						id: "call_test",
						name: "readFile",
						arguments: JSON.stringify({ path: "memory/test.md" }),
					},
				],
			}),
		};

		const provider = new RealProvider(mockAI as any);
		const result = await provider.complete("test", {
			tools: [
				{
					name: "readFile",
					description: "Read a file",
					parameters: {
						type: "object",
						properties: { path: { type: "string", description: "Path" } },
						required: ["path"],
					},
				},
			],
		});

		expect(result.toolCalls).toBeDefined();
		expect(result.toolCalls?.[0].name).toBe("readFile");
		expect(result.toolCalls?.[0].arguments).toEqual({ path: "memory/test.md" });
	});

	it("should handle tool call arguments as object (not JSON string)", async () => {
		const { WorkersAIProvider: RealProvider } = await vi.importActual<
			typeof import("../../../src/llm/workers-ai")
		>("../../../src/llm/workers-ai");

		const mockAI = {
			run: vi.fn().mockResolvedValue({
				response: "",
				tool_calls: [
					{
						id: "call_test",
						name: "readFile",
						arguments: { path: "memory/test.md" }, // Already an object
					},
				],
			}),
		};

		const provider = new RealProvider(mockAI as any);
		const result = await provider.complete("test");

		expect(result.toolCalls?.[0].arguments).toEqual({ path: "memory/test.md" });
	});
});

describe("compactHistory", () => {
	it("shortens the oldest tool results first and leaves small messages alone", () => {
		const messages = [
			{ role: "user" as const, content: "start" },
			{ role: "tool" as const, content: "a".repeat(5000), tool_call_id: "1" },
			{ role: "tool" as const, content: "b".repeat(5000), tool_call_id: "2" },
		];

		compactHistory(messages, 6000);

		expect(messages[0].content).toBe("start");
		expect(messages[1].content.length).toBeLessThan(500);
		expect(messages[1].content).toContain("shortened");
		expect(messages[2].content).toBe("b".repeat(5000));
		expect(messages[1].tool_call_id).toBe("1");
	});

	it("does nothing when under budget", () => {
		const messages = [{ role: "tool" as const, content: "a".repeat(100), tool_call_id: "1" }];
		compactHistory(messages, 1000);
		expect(messages[0].content).toBe("a".repeat(100));
	});
});
