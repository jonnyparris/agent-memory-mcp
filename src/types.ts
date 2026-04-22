import type { MemoryIndex } from "./search/durable-object";

/**
 * Worker environment bindings.
 *
 * The `MEMORY_INDEX` namespace is typed with the DO class so the RPC stub
 * returned from `getMemoryIndex` gets full type inference on method calls.
 * Wrangler-generated types live in `worker-configuration.d.ts` — this
 * interface stays as the single source of truth for what the Worker
 * actually needs at runtime.
 */
export interface Env {
	MEMORY_BUCKET: R2Bucket;
	MEMORY_INDEX: DurableObjectNamespace<MemoryIndex>;
	AI: Ai;
	MEMORY_AUTH_TOKEN: string;
	/** Chat webhook auth key (optional, for scheduled reflection notifications) */
	CHAT_WEBHOOK_AUTH_KEY?: string;
	/** Chat webhook URL (optional, for scheduled reflection notifications) */
	CHAT_WEBHOOK_URL?: string;
	/** Chat space ID to post notifications to (optional, for scheduled reflection notifications) */
	CHAT_WEBHOOK_SPACE_ID?: string;
	/** Primary model for agentic reflection (default: @cf/moonshotai/kimi-k2.6) */
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
