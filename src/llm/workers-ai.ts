/**
 * Workers AI LLM Provider
 *
 * Uses Cloudflare Workers AI for LLM completions.
 * Default model: qwq-32b (reasoning model, good for reflection tasks)
 */

import type { LLMCompletionOptions, LLMCompletionResult, LLMMessage, LLMProvider } from "./types";

/** Workers AI text generation response shape */
interface WorkersAITextResponse {
	response?: string;
	// Some models return this format
	result?: {
		response?: string;
	};
}

export class WorkersAIProvider implements LLMProvider {
	readonly name = "workers-ai";
	readonly model: string;

	constructor(
		private ai: Ai,
		model = "@cf/qwen/qwq-32b",
	) {
		this.model = model;
	}

	async complete(
		prompt: string | LLMMessage[],
		options?: LLMCompletionOptions,
	): Promise<LLMCompletionResult> {
		// Build messages array
		const messages: LLMMessage[] = [];

		// Add system prompt if provided
		if (options?.systemPrompt) {
			messages.push({ role: "system", content: options.systemPrompt });
		}

		// Add user prompt or message array
		if (typeof prompt === "string") {
			messages.push({ role: "user", content: prompt });
		} else {
			messages.push(...prompt);
		}

		// Call Workers AI
		// Note: Type assertion needed because Workers AI types are incomplete
		const response = (await this.ai.run(this.model as Parameters<Ai["run"]>[0], {
			messages,
			max_tokens: options?.maxTokens,
			temperature: options?.temperature,
		})) as WorkersAITextResponse;

		// Handle different response formats
		const responseText = response?.response ?? response?.result?.response ?? "";

		return {
			response: responseText,
			// Workers AI doesn't expose token usage in the response
			usage: undefined,
		};
	}
}
