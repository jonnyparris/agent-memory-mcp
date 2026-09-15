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
import { runAgenticReflection, runDeepAnalysisOnly } from "../../../src/reflection/agentic";

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

		// Should complete within iteration limits (5 for quick scan + 10 for deep)
		expect(result.success).toBe(true);
		expect(result.quickScanIterations).toBeLessThanOrEqual(5);
		expect(result.deepAnalysisIterations).toBeLessThanOrEqual(10);
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
