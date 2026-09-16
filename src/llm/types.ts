/**
 * LLM Provider interface for agent-memory-mcp
 *
 * Abstracts the LLM backend to allow swapping between Workers AI,
 * Replicate, or other providers in the future.
 */

export interface LLMMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	/** Tool call ID for tool responses. Must match the id on the assistant
	 *  message's `tool_calls` entry that produced this result. */
	tool_call_id?: string;
	/**
	 * Tool calls the assistant requested on this turn.
	 *
	 * Required for multi-turn tool use: an assistant turn that made tool calls
	 * has to carry them in the history, or the next turn shows a `tool` result
	 * with nothing it belongs to and no record that the call ever happened.
	 * Omitting these made the reflection agent call `listFiles` on all ten of
	 * its iterations — each turn it was deciding to list files for the first
	 * time, because from its point of view it was.
	 */
	tool_calls?: LLMToolCall[];
}

/**
 * Tool definition for function calling
 */
export interface LLMTool {
	name: string;
	description: string;
	parameters: {
		type: "object";
		properties: Record<
			string,
			{
				type: string;
				description: string;
				enum?: string[];
			}
		>;
		required?: string[];
	};
}

/**
 * Tool call from LLM response
 */
export interface LLMToolCall {
	/**
	 * Provider-assigned call id, echoed back on the matching `tool` message.
	 *
	 * Synthesised when the provider doesn't supply one (the legacy Workers AI
	 * response shape has no ids), since the pairing matters more than the
	 * value.
	 */
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface LLMCompletionOptions {
	/** Maximum tokens to generate */
	maxTokens?: number;
	/** Temperature (0-1) for sampling */
	temperature?: number;
	/** System prompt to prepend */
	systemPrompt?: string;
	/** Tools available for the LLM to call */
	tools?: LLMTool[];
}

export interface LLMCompletionResult {
	/** Generated text response */
	response: string;
	/** Token usage if available */
	usage?: {
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
	};
	/** Tool calls requested by the LLM */
	toolCalls?: LLMToolCall[];
}

export interface LLMProvider {
	/**
	 * Complete a prompt with the LLM
	 * @param prompt - User prompt or array of messages
	 * @param options - Optional completion parameters
	 */
	complete(
		prompt: string | LLMMessage[],
		options?: LLMCompletionOptions,
	): Promise<LLMCompletionResult>;

	/** Provider name for logging */
	readonly name: string;

	/** Model identifier */
	readonly model: string;
}
