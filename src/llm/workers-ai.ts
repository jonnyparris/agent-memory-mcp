/**
 * Workers AI LLM Provider
 *
 * Uses Cloudflare Workers AI for LLM completions.
 * Supports tool calling for agentic workflows.
 *
 * Models with tool calling support:
 * - @cf/moonshotai/kimi-k2.5 (1T params, highest quality) - PRIMARY
 * - @cf/zai-org/glm-4.7-flash (fast, lightweight) - AUTO-APPLY
 * - @cf/meta/llama-3.3-70b-instruct-fp8-fast (proven reliable) - FALLBACK
 * - @cf/qwen/qwq-32b (reasoning model, no tool calling) - LEGACY
 */

import type {
	LLMCompletionOptions,
	LLMCompletionResult,
	LLMMessage,
	LLMProvider,
	LLMTool,
	LLMToolCall,
} from "./types";

/** Workers AI text generation response shape */
interface WorkersAITextResponse {
	response?: string;
	// Some models return this format
	result?: {
		response?: string;
	};
	// Tool calls from function calling models
	tool_calls?: Array<{
		name: string;
		arguments: string | Record<string, unknown>;
	}>;
}

/** Workers AI tool format */
interface WorkersAITool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: LLMTool["parameters"];
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

		// Convert tools to Workers AI format
		const tools = options?.tools ? this.convertTools(options.tools) : undefined;

		// Build request options
		const requestOptions: Record<string, unknown> = {
			messages,
			max_tokens: options?.maxTokens,
			temperature: options?.temperature,
		};

		// Only add tools if provided (some models don't support them)
		if (tools && tools.length > 0) {
			requestOptions.tools = tools;
		}

		// Call Workers AI
		// Note: Type assertion needed because Workers AI types are incomplete
		const response = (await this.ai.run(
			this.model as Parameters<Ai["run"]>[0],
			requestOptions,
		)) as WorkersAITextResponse;

		// Handle different response formats
		const responseText = response?.response ?? response?.result?.response ?? "";

		// Parse tool calls if present
		const toolCalls = this.parseToolCalls(response?.tool_calls);

		return {
			response: responseText,
			// Workers AI doesn't expose token usage in the response
			usage: undefined,
			toolCalls,
		};
	}

	/**
	 * Convert our tool format to Workers AI format
	 */
	private convertTools(tools: LLMTool[]): WorkersAITool[] {
		return tools.map((tool) => ({
			type: "function" as const,
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		}));
	}

	/**
	 * Parse tool calls from Workers AI response
	 */
	private parseToolCalls(
		rawToolCalls?: Array<{ name: string; arguments: string | Record<string, unknown> }>,
	): LLMToolCall[] | undefined {
		if (!rawToolCalls || rawToolCalls.length === 0) {
			return undefined;
		}

		return rawToolCalls.map((call) => {
			// Arguments may be a string (JSON) or already an object
			let args: Record<string, unknown>;
			if (typeof call.arguments === "string") {
				try {
					args = JSON.parse(call.arguments);
				} catch {
					// If JSON parsing fails, treat as empty args
					args = {};
				}
			} else {
				args = call.arguments ?? {};
			}

			return {
				name: call.name,
				arguments: args,
			};
		});
	}
}

/** Model presets for different use cases */
export const REFLECTION_MODELS = {
	/** Primary model for deep analysis - highest quality */
	primary: "@cf/moonshotai/kimi-k2.5",
	/** Fast model for quick scans and auto-apply */
	fast: "@cf/zai-org/glm-4.7-flash",
	/** Fallback if primary unavailable */
	fallback: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
	/** Legacy reasoning model (no tool calling) */
	legacy: "@cf/qwen/qwq-32b",
} as const;
