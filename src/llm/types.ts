/**
 * LLM Provider interface for agent-memory-mcp
 *
 * Abstracts the LLM backend to allow swapping between Workers AI,
 * Replicate, or other providers in the future.
 */

export interface LLMMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface LLMCompletionOptions {
	/** Maximum tokens to generate */
	maxTokens?: number;
	/** Temperature (0-1) for sampling */
	temperature?: number;
	/** System prompt to prepend */
	systemPrompt?: string;
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
