/**
 * Conversation Indexing for OpenCode Sessions
 *
 * Parses OpenCode session files and indexes individual exchanges
 * (user prompt + assistant response) for semantic search.
 *
 * OpenCode stores sessions at: ~/.local/share/opencode/storage/session/{project}/{session}.json
 * Each session file contains an array of messages with roles and content.
 */

import type { R2Storage } from "./storage/r2";

// Conversation exchange - one user prompt + assistant response pair
export interface ConversationExchange {
	id: string;
	sessionId: string;
	project: string;
	userPrompt: string;
	assistantResponse: string;
	timestamp: string;
	messageIndex: number;
}

// Stored in R2 as JSON
export interface ConversationIndex {
	exchanges: ConversationExchange[];
	lastUpdated: string;
	sessionHashes: Record<string, string>; // sessionId -> content hash for incremental updates
}

// Search result with time-weighted scoring
export interface ConversationSearchResult {
	exchange: ConversationExchange;
	score: number;
	adjustedScore: number;
}

const CONVERSATION_INDEX_PATH = "conversations/index.json";
const CONVERSATIONS_PREFIX = "conversations/sessions/";

/**
 * Parse a raw OpenCode session into exchanges
 */
export function parseOpenCodeSession(
	sessionId: string,
	project: string,
	sessionData: OpenCodeSession,
): ConversationExchange[] {
	const exchanges: ConversationExchange[] = [];
	const messages = sessionData.messages || [];

	let currentUser: { content: string; timestamp: string; index: number } | null = null;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		if (msg.role === "user" && typeof msg.content === "string") {
			// Skip tool results and system context
			if (isToolResult(msg.content) || isSystemContext(msg.content)) {
				continue;
			}
			currentUser = {
				content: extractUserText(msg.content),
				timestamp: msg.timestamp || sessionData.createdAt || new Date().toISOString(),
				index: i,
			};
		} else if (msg.role === "assistant" && currentUser) {
			const assistantText = extractAssistantText(msg.content);
			if (currentUser.content && assistantText) {
				exchanges.push({
					id: `${sessionId}-${currentUser.index}`,
					sessionId,
					project,
					userPrompt: currentUser.content.slice(0, 2000),
					assistantResponse: assistantText.slice(0, 2000),
					timestamp: currentUser.timestamp,
					messageIndex: currentUser.index,
				});
			}
			currentUser = null;
		}
	}

	return exchanges;
}

/**
 * Check if content is a tool result (not a real user prompt)
 */
function isToolResult(content: string): boolean {
	return (
		content.includes("<tool_result>") ||
		content.includes("tool_use_id") ||
		content.startsWith('{"type":"tool_result"')
	);
}

/**
 * Check if content is system/context injection
 */
function isSystemContext(content: string): boolean {
	return (
		content.startsWith("<current_time>") ||
		content.startsWith("<system-reminder>") ||
		content.startsWith("# Agent Context") ||
		content.includes("<state_files>") ||
		content.includes("<context_status>") ||
		content.length < 5
	);
}

/**
 * Extract actual user text, stripping context wrappers
 */
function extractUserText(content: string): string {
	// Handle agent context blocks: "# Agent Context\n...\nUser message: <actual message>"
	if (content.includes("\nUser message: ")) {
		const match = content.match(/\nUser message: (.+)$/s);
		if (match) return match[1].trim();
	}
	return content.trim();
}

/**
 * Extract text from assistant response (may be array of content blocks)
 */
function extractAssistantText(content: string | AssistantContent[]): string {
	if (typeof content === "string") {
		return content.slice(0, 1000);
	}

	// Array of content blocks - find first text block
	for (const block of content) {
		if (block.type === "text" && block.text) {
			return block.text.slice(0, 1000);
		}
	}
	return "";
}

/**
 * Simple hash for change detection
 */
function hashContent(content: string): string {
	let hash = 0;
	for (let i = 0; i < content.length; i++) {
		const char = content.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash;
	}
	return hash.toString(16);
}

/**
 * Load or initialize the conversation index
 */
export async function loadConversationIndex(storage: R2Storage): Promise<ConversationIndex> {
	const file = await storage.read(CONVERSATION_INDEX_PATH);
	if (file) {
		try {
			return JSON.parse(file.content);
		} catch {
			// Corrupted, start fresh
		}
	}
	return {
		exchanges: [],
		lastUpdated: new Date().toISOString(),
		sessionHashes: {},
	};
}

/**
 * Save the conversation index
 */
export async function saveConversationIndex(
	storage: R2Storage,
	index: ConversationIndex,
): Promise<void> {
	index.lastUpdated = new Date().toISOString();
	await storage.write(CONVERSATION_INDEX_PATH, JSON.stringify(index, null, 2));
}

export interface IndexSessionsResult {
	added: number;
	updated: number;
	unchanged: number;
	/**
	 * Exchanges belonging to sessions that changed in this batch. These are
	 * the only ones needing a fresh embedding.
	 */
	changedExchanges: ConversationExchange[];
	/**
	 * Exchange IDs that existed before this batch and no longer do — a
	 * rewritten session usually yields a different set. Their vectors have to
	 * be deleted or they linger as unreachable search hits.
	 */
	removedExchangeIds: string[];
}

/**
 * Index a batch of sessions (called from the sync script).
 *
 * Reports which exchanges changed rather than leaving the caller to re-embed
 * the whole index. Embedding is the expensive part — one Workers AI call per
 * exchange — and re-running it across every exchange on every sync does not
 * fit in a single Worker invocation once the corpus reaches a few hundred
 * sessions.
 */
export async function indexSessions(
	storage: R2Storage,
	sessions: Array<{ sessionId: string; project: string; data: OpenCodeSession }>,
): Promise<IndexSessionsResult> {
	const index = await loadConversationIndex(storage);
	let added = 0;
	let updated = 0;
	let unchanged = 0;
	const changedExchanges: ConversationExchange[] = [];
	const removedExchangeIds: string[] = [];

	for (const { sessionId, project, data } of sessions) {
		const contentHash = hashContent(JSON.stringify(data));
		const existingHash = index.sessionHashes[sessionId];

		if (existingHash === contentHash) {
			unchanged++;
			continue;
		}

		// Remove old exchanges for this session
		const previous = index.exchanges.filter((e) => e.sessionId === sessionId);
		const existingCount = previous.length;
		index.exchanges = index.exchanges.filter((e) => e.sessionId !== sessionId);

		// Parse and add new exchanges
		const newExchanges = parseOpenCodeSession(sessionId, project, data);
		index.exchanges.push(...newExchanges);
		index.sessionHashes[sessionId] = contentHash;
		changedExchanges.push(...newExchanges);

		// Exchange IDs are derived from message position, so a session edited
		// mid-history can drop IDs that previously existed.
		const survivingIds = new Set(newExchanges.map((e) => e.id));
		for (const old of previous) {
			if (!survivingIds.has(old.id)) removedExchangeIds.push(old.id);
		}

		// Also store the raw session data for expand_conversation
		await storage.write(
			`${CONVERSATIONS_PREFIX}${sessionId}.json`,
			JSON.stringify({ project, data, indexedAt: new Date().toISOString() }),
		);

		if (existingCount > 0) {
			updated++;
		} else {
			added++;
		}
	}

	await saveConversationIndex(storage, index);
	return { added, updated, unchanged, changedExchanges, removedExchangeIds };
}

/** Index path for an exchange's embedding. */
export function exchangeIndexPath(exchangeId: string): string {
	return `${CONVERSATIONS_PREFIX.replace("sessions/", "exchanges/")}${exchangeId}.txt`;
}

/** Text embedded for an exchange. Kept here so indexing and search agree. */
export function exchangeEmbeddingText(exchange: ConversationExchange): string {
	return `[${exchange.project}] ${exchange.userPrompt}\n\nResponse: ${exchange.assistantResponse}`;
}

/**
 * Get index stats
 */
export async function getConversationStats(
	storage: R2Storage,
): Promise<{ exchangeCount: number; sessionCount: number; lastUpdated: string }> {
	const index = await loadConversationIndex(storage);
	return {
		exchangeCount: index.exchanges.length,
		sessionCount: Object.keys(index.sessionHashes).length,
		lastUpdated: index.lastUpdated,
	};
}

/**
 * Expand a conversation - get full session context
 */
export async function expandConversation(
	storage: R2Storage,
	sessionId: string,
	exchangeId?: string,
): Promise<{
	project: string;
	exchanges: ConversationExchange[];
	messages?: Array<{ role: string; content: string }>;
} | null> {
	// Try to load raw session data
	const sessionFile = await storage.read(`${CONVERSATIONS_PREFIX}${sessionId}.json`);
	if (!sessionFile) {
		// Fall back to index only
		const index = await loadConversationIndex(storage);
		const exchanges = index.exchanges.filter((e) => e.sessionId === sessionId);
		if (exchanges.length === 0) return null;
		return {
			project: exchanges[0].project,
			exchanges,
		};
	}

	const { project, data } = JSON.parse(sessionFile.content);
	const exchanges = parseOpenCodeSession(sessionId, project, data);

	// If exchangeId specified, return context around it
	if (exchangeId) {
		const targetIdx = exchanges.findIndex((e) => e.id === exchangeId);
		if (targetIdx >= 0) {
			const start = Math.max(0, targetIdx - 2);
			const end = Math.min(exchanges.length, targetIdx + 3);
			return {
				project,
				exchanges: exchanges.slice(start, end),
			};
		}
	}

	return {
		project,
		exchanges,
		messages: data.messages?.slice(-20).map((m: OpenCodeMessage) => ({
			role: m.role,
			content: typeof m.content === "string" ? m.content.slice(0, 500) : "[complex content]",
		})),
	};
}

// OpenCode session types (for parsing)
interface OpenCodeMessage {
	role: "user" | "assistant" | "system";
	content: string | AssistantContent[];
	timestamp?: string;
}

interface AssistantContent {
	type: "text" | "tool_use" | "tool_result";
	text?: string;
}

interface OpenCodeSession {
	id?: string;
	messages?: OpenCodeMessage[];
	createdAt?: string;
	project?: string;
}
