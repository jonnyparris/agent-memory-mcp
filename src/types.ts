export interface Env {
	MEMORY_BUCKET: R2Bucket;
	MEMORY_INDEX: DurableObjectNamespace;
	AI: Ai;
	MEMORY_AUTH_TOKEN: string;
	/** Chat webhook auth key (optional, for scheduled reflection notifications) */
	CHAT_WEBHOOK_AUTH_KEY?: string;
	/** Chat webhook URL (optional, for scheduled reflection notifications) */
	CHAT_WEBHOOK_URL?: string;
	/** Chat space ID to post notifications to (optional, for scheduled reflection notifications) */
	CHAT_WEBHOOK_SPACE_ID?: string;
	/** Primary model for agentic reflection (default: @cf/moonshotai/kimi-k2.5) */
	REFLECTION_MODEL?: string;
	/** Fast model for quick scans (default: @cf/zai-org/glm-4.7-flash) */
	REFLECTION_MODEL_FAST?: string;
	/** Enable agentic reflection with tool calling (default: true) */
	USE_AGENTIC_REFLECTION?: string;
}

export interface MemoryFile {
	path: string;
	content: string;
	updated_at: string;
	size: number;
}

export interface MemoryFileMetadata {
	path: string;
	size: number;
	updated_at: string;
}

export interface SearchResult {
	path: string;
	snippet: string;
	score: number;
}

export interface FileVersion {
	version_id: string;
	timestamp: string;
	size: number;
}

export interface MemoryApi {
	read(path: string): Promise<string | null>;
	list(path?: string): Promise<MemoryFileMetadata[]>;
}
