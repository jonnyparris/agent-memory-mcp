/**
 * Multi-turn tool-call plumbing.
 *
 * Regression cover for a bug that made the reflection agent useless without
 * failing a single test: the provider flattened every message to
 * `{ role, content }`, so an assistant turn lost its `tool_calls` and a tool
 * result lost its `tool_call_id`. The model was handed results that belonged
 * to no call and no evidence it had ever used a tool, so it re-decided from
 * scratch every iteration. A real run's trace read `1:listFiles` through
 * `10:listFiles` before hitting the iteration cap.
 *
 * These assert on the wire payload handed to AI.run, which is the only place
 * the loss was observable.
 */

import { describe, expect, it, vi } from "vitest";
import type { LLMMessage } from "../../../src/llm/types";
import { WorkersAIProvider } from "../../../src/llm/workers-ai";

function mockAI(response: unknown = { response: "ok" }) {
	return { run: vi.fn().mockResolvedValue(response) };
}

/** The messages array actually sent to Workers AI. */
function sentMessages(ai: ReturnType<typeof mockAI>) {
	return ai.run.mock.calls[0][1].messages as Array<Record<string, unknown>>;
}

describe("tool-call round trip", () => {
	it("carries the assistant's tool_calls onto the wire", async () => {
		const ai = mockAI();
		const history: LLMMessage[] = [
			{ role: "user", content: "start" },
			{
				role: "assistant",
				content: "",
				tool_calls: [{ id: "call_abc", name: "listFiles", arguments: { path: "memory/" } }],
			},
			{ role: "tool", content: '{"success":true}', tool_call_id: "call_abc" },
		];

		await new WorkersAIProvider(ai as never).complete(history);

		const assistant = sentMessages(ai).find((m) => m.role === "assistant");
		expect(assistant?.tool_calls).toEqual([
			{
				id: "call_abc",
				type: "function",
				// Arguments go over the wire as a JSON string, not an object.
				function: { name: "listFiles", arguments: '{"path":"memory/"}' },
			},
		]);
	});

	it("preserves tool_call_id so a result pairs with its call", async () => {
		const ai = mockAI();
		const history: LLMMessage[] = [
			{ role: "tool", content: '{"success":true}', tool_call_id: "call_abc" },
		];

		await new WorkersAIProvider(ai as never).complete(history);

		expect(sentMessages(ai).find((m) => m.role === "tool")?.tool_call_id).toBe("call_abc");
	});

	it("keeps two calls to the same tool distinguishable", async () => {
		// Pairing by tool name (the old behaviour) collapses these into one.
		const ai = mockAI();
		const history: LLMMessage[] = [
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{ id: "call_1", name: "readFile", arguments: { path: "a.md" } },
					{ id: "call_2", name: "readFile", arguments: { path: "b.md" } },
				],
			},
			{ role: "tool", content: '{"file":"a"}', tool_call_id: "call_1" },
			{ role: "tool", content: '{"file":"b"}', tool_call_id: "call_2" },
		];

		await new WorkersAIProvider(ai as never).complete(history);

		const ids = sentMessages(ai)
			.filter((m) => m.role === "tool")
			.map((m) => m.tool_call_id);
		expect(ids).toEqual(["call_1", "call_2"]);
	});

	it("does not attach tool fields to ordinary messages", async () => {
		const ai = mockAI();

		await new WorkersAIProvider(ai as never).complete([{ role: "user", content: "hello" }]);

		const user = sentMessages(ai).find((m) => m.role === "user");
		expect(user).toEqual({ role: "user", content: "hello" });
	});

	it("gives every parsed tool call an id, even when the provider omits one", async () => {
		// The legacy Workers AI shape has no ids; pairing still has to work.
		const ai = mockAI({
			tool_calls: [
				{ name: "listFiles", arguments: { path: "memory/" } },
				{ name: "readFile", arguments: { path: "a.md" } },
			],
		});

		const result = await new WorkersAIProvider(ai as never).complete("go");

		const ids = result.toolCalls?.map((c) => c.id) ?? [];
		expect(ids).toHaveLength(2);
		expect(ids.every(Boolean)).toBe(true);
		expect(new Set(ids).size).toBe(2);
	});
});

describe("thinking switch and finish reason", () => {
	it("sends chat_template_kwargs.thinking=false only when asked", async () => {
		const ai = mockAI();
		const provider = new WorkersAIProvider(ai as unknown as Ai, "@cf/test/model");
		await provider.complete("hi");
		await provider.complete("hi", { thinking: false });
		expect(ai.run.mock.calls[0][1].chat_template_kwargs).toBeUndefined();
		expect(ai.run.mock.calls[1][1].chat_template_kwargs).toEqual({ thinking: false });
	});

	it("surfaces finish_reason", async () => {
		const ai = mockAI({
			choices: [
				{ index: 0, message: { role: "assistant", content: null }, finish_reason: "length" },
			],
		});
		const provider = new WorkersAIProvider(ai as unknown as Ai, "@cf/test/model");
		const result = await provider.complete("hi");
		expect(result.finishReason).toBe("length");
	});
});
