import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	expandConversation,
	getConversationStats,
	indexSessions,
	loadConversationIndex,
} from "./conversations";
import { executeCode } from "./execute";
import { errResult, okResult, registerTool } from "./helpers";
import {
	archiveReflection,
	listPendingReflections,
	readStagedReflectionData,
} from "./reflection/staging";
import type { ProposedEdit } from "./reflection/tool-executor";
import { checkReminders, listReminders, removeReminder, scheduleReminder } from "./reminders";
import { getMemoryIndex } from "./search/client";
import { indexWrite } from "./search/index-write";
import { createR2Storage } from "./storage/r2";
import { extractSnippet, truncateWithMeta } from "./truncate";
import type { Env } from "./types";

/**
 * Build the MCP server.
 *
 * `ctx` is optional so callers like the unit tests can spin up a server
 * without a full Worker `ExecutionContext`. When present, tools that
 * support deferred work (e.g. `write` with `wait_for_index: false`) use
 * `ctx.waitUntil` to keep the embedding update alive past the response.
 * When absent, those tools fall back to awaiting inline so the work still
 * runs to completion — at the cost of higher response latency.
 */
export function createServer(env: Env, ctx?: ExecutionContext): McpServer {
	const server = new McpServer({
		name: "agent-memory",
		version: "0.1.0",
	});

	const storage = createR2Storage(env.MEMORY_BUCKET);

	// ==================== Core Memory Tools ====================

	registerTool(
		server,
		"read",
		{
			description: "Read one file or up to 50 files from memory storage.",
			inputSchema: {
				path: z
					.union([z.string(), z.array(z.string())])
					.describe("File path or array of paths, e.g., 'memory/learnings.md'"),
			},
		},
		async ({ path }: { path: string | string[] }) => {
			if (Array.isArray(path)) {
				if (path.length > 50) {
					return errResult("Cannot read more than 50 paths in a single call");
				}
				const files = await Promise.all(
					path.map(async (p) => {
						const file = await storage.read(p);
						if (!file) return [p, { error: "File not found" }] as const;
						const t = truncateWithMeta(file.content);
						const entry: Record<string, unknown> = {
							content: t.content,
							updated_at: file.updated_at,
							size: file.size,
						};
						if (t.truncated) {
							entry.truncated = true;
							entry.original_size = t.original_size;
						}
						return [p, entry] as const;
					}),
				);
				const found = files.filter(([, v]) => !("error" in v)).length;
				return okResult({ files: Object.fromEntries(files) }, `Read ${found}/${path.length} files`);
			}

			const file = await storage.read(path);
			if (!file) {
				return errResult("File not found", { path });
			}
			const t = truncateWithMeta(file.content);
			// Only surface truncation metadata when truncation actually
			// happened — keeps the common-case response shape stable for
			// clients that assert on exact keys.
			const body: Record<string, unknown> = {
				content: t.content,
				updated_at: file.updated_at,
				size: file.size,
			};
			if (t.truncated) {
				body.truncated = true;
				body.original_size = t.original_size;
			}
			const prefix = t.truncated
				? `Read ${path} (${t.original_size} bytes, truncated to ${t.content.length})`
				: `Read ${path} (${file.size} bytes)`;
			return okResult(body, prefix);
		},
	);

	registerTool(
		server,
		"write",
		{
			description:
				"Write content to a file. Automatically updates the search index, extracts tags from YAML frontmatter, and indexes Obsidian-style [[wikilinks]]. Returns semantic overlap warnings for memory/ paths by default.\n\nLatency tuning: pass `wait_for_index: false` to defer the embedding update via `waitUntil` — the R2 write still completes synchronously, but the search index becomes consistent ~1–3s later. Pass `detect_overlaps: false` to skip the post-write similarity search (saves another DO round-trip plus R2 reads). Both default to the safe/correct values; flip them when you already know what you're doing (overwriting a known file, bulk edits).",
			inputSchema: {
				path: z.string().describe("File path, e.g., 'memory/learnings.md'"),
				content: z.string().describe("Content to write"),
				detect_overlaps: z
					.boolean()
					.optional()
					.default(true)
					.describe(
						"Run a similarity search after the write and surface duplicate memory/ files. Default true.",
					),
				wait_for_index: z
					.boolean()
					.optional()
					.default(true)
					.describe(
						"When true (default), the call blocks until the search index is updated. When false, the embedding update is deferred via waitUntil and the response returns as soon as R2 acknowledges the write. Forced to true when detect_overlaps is true (overlap detection has to read the fresh index).",
					),
			},
		},
		async ({
			path,
			content,
			detect_overlaps,
			wait_for_index,
		}: {
			path: string;
			content: string;
			detect_overlaps?: boolean;
			wait_for_index?: boolean;
		}) => {
			// Zod defaults the bools to true at the schema layer, but the
			// destructure may still produce undefined when the SDK strips
			// defaults — coerce explicitly so the indexWrite contract is
			// unambiguous.
			const detectOverlaps = detect_overlaps !== false;
			const waitForIndex = wait_for_index !== false;
			const result = await indexWrite(env, storage, path, content, {
				detectOverlaps,
				waitForIndex,
				ctx,
			});
			const response: Record<string, unknown> = {
				success: true,
				version_id: result.version_id,
				tags: result.tags,
				links: result.links,
			};
			if (result.embedding_error) response.embedding_error = result.embedding_error;
			if (result.index_deferred) response.index_deferred = true;
			if (result.overlaps && result.overlaps.length > 0) {
				response.overlaps = result.overlaps;
				response.overlap_hint =
					"Semantically similar content already exists in the paths above. " +
					"Consider merging or updating the existing file instead of creating redundant entries.";
			}

			const parts = [`Wrote ${path} (${content.length} bytes)`];
			if (result.tags.length > 0) parts.push(`tags: ${result.tags.join(", ")}`);
			if (result.index_deferred) parts.push("index update deferred");
			if (result.overlaps && result.overlaps.length > 0) {
				parts.push(`${result.overlaps.length} similar file(s) already exist`);
			}
			return okResult(response, parts.join(" · "));
		},
	);

	registerTool(
		server,
		"write_many",
		{
			description:
				"Write multiple files in a single MCP round-trip. Each entry is processed independently — R2 writes run in parallel, embedding updates are issued concurrently to the search index DO, and partial failures are reported per-file rather than failing the whole batch.\n\nDefaults are tuned for bulk edits: detect_overlaps is OFF by default (the caller usually already knows what they're writing), and wait_for_index is ON by default (so the next read/search sees the updated index). Override per-file in the request when you need the cheaper or slower behaviour.\n\nMax 50 files per call. Use this whenever you'd otherwise loop over write — saves N-1 MCP round-trips and lets the embedding model run all updates in parallel.",
			inputSchema: {
				files: z
					.array(
						z.object({
							path: z.string().describe("File path, e.g., 'memory/learnings.md'"),
							content: z.string().describe("Content to write"),
							detect_overlaps: z
								.boolean()
								.optional()
								.describe("Override the batch default (false). Adds a similarity search per file."),
							wait_for_index: z
								.boolean()
								.optional()
								.describe(
									"Override the batch default (true). When false, the index update for this file is deferred via waitUntil.",
								),
						}),
					)
					.min(1)
					.max(50)
					.describe("Up to 50 files to write."),
			},
		},
		async ({
			files,
		}: {
			files: Array<{
				path: string;
				content: string;
				detect_overlaps?: boolean;
				wait_for_index?: boolean;
			}>;
		}) => {
			// Run every write in parallel. indexWrite() handles its own
			// error containment (R2 success + embedding_error), so a
			// failure in one file's embedding update doesn't poison the
			// whole batch — and a hard throw (e.g. R2 outage on one path)
			// is caught here and converted into a structured per-file
			// error instead of taking the entire response down.
			const results = await Promise.all(
				files.map(async (file) => {
					try {
						const result = await indexWrite(env, storage, file.path, file.content, {
							// Bulk default: skip overlap detection unless
							// the caller explicitly asks for it. Most batch
							// operations are deterministic edits where the
							// caller already knows the file shape.
							detectOverlaps: file.detect_overlaps === true,
							// Bulk default: keep waiting for the index so
							// the response is "everything is consistent" by
							// the time it returns. Callers who want the
							// fast path opt in per-file.
							waitForIndex: file.wait_for_index !== false,
							ctx,
						});
						return {
							path: file.path,
							success: true,
							version_id: result.version_id,
							tags: result.tags,
							links: result.links,
							bytes: file.content.length,
							...(result.embedding_error ? { embedding_error: result.embedding_error } : {}),
							...(result.index_deferred ? { index_deferred: true } : {}),
							...(result.overlaps && result.overlaps.length > 0
								? { overlaps: result.overlaps }
								: {}),
						};
					} catch (e) {
						return {
							path: file.path,
							success: false,
							error: e instanceof Error ? e.message : String(e),
						};
					}
				}),
			);

			const succeeded = results.filter((r) => r.success).length;
			const failed = results.length - succeeded;
			const totalBytes = results.reduce(
				(sum, r) => sum + ("bytes" in r && typeof r.bytes === "number" ? r.bytes : 0),
				0,
			);

			const prefix =
				failed === 0
					? `Wrote ${succeeded} file(s), ${totalBytes} bytes total`
					: `Wrote ${succeeded}/${results.length} file(s) — ${failed} failed`;

			return okResult(
				{
					success: failed === 0,
					written: succeeded,
					failed,
					results,
				},
				prefix,
			);
		},
	);

	registerTool(
		server,
		"list",
		{
			description:
				"List files in a directory. Pass `tags` to restrict to files matching every tag (intersection).",
			inputSchema: {
				path: z.string().optional().describe("Directory path, defaults to root"),
				recursive: z.boolean().optional().default(false).describe("List recursively"),
				tags: z
					.array(z.string())
					.optional()
					.describe("If provided, only return files tagged with all of these"),
			},
		},
		async ({
			path,
			recursive,
			tags,
		}: {
			path?: string;
			recursive?: boolean;
			tags?: string[];
		}) => {
			const files = await storage.list(path, recursive);
			if (!tags || tags.length === 0) {
				return { files };
			}
			// Intersect the directory listing with the tag set from the DO.
			const { paths } = await getMemoryIndex(env).filesWithTags(tags);
			const allowed = new Set(paths);
			return {
				files: files.filter((f) => allowed.has(f.path)),
				filtered_by_tags: tags,
			};
		},
	);

	registerTool(
		server,
		"list_tags",
		{
			description:
				"List all tags currently indexed, with the number of files carrying each. Sorted by count desc.",
			inputSchema: {},
		},
		async () => getMemoryIndex(env).tags(),
	);

	registerTool(
		server,
		"search",
		{
			description:
				"Search memory by meaning. Returns relevant file snippets. Pass `tags` to restrict to files matching every tag. Pass `scope: 'conversations'` to search indexed chat exchanges instead of memory files, or `scope: 'all'` for both.",
			inputSchema: {
				query: z.string().describe("Natural language query"),
				limit: z.number().optional().default(5).describe("Max results to return"),
				tags: z
					.array(z.string())
					.optional()
					.describe("If provided, only match files tagged with all of these"),
				scope: z
					.enum(["memory", "conversations", "all"])
					.optional()
					.default("memory")
					.describe("What to search. Defaults to memory files only."),
			},
		},
		async ({
			query,
			limit,
			tags,
			scope,
		}: {
			query: string;
			limit?: number;
			tags?: string[];
			scope?: "memory" | "conversations" | "all";
		}) => {
			const effectiveLimit = limit ?? 5;
			const searchScope = scope ?? "memory";

			// Conversations need time-weighted scoring and overshoot since the
			// result set is filtered by path prefix after the DO returns.
			const overshoot = searchScope === "memory" ? effectiveLimit : effectiveLimit * 2;
			const index = getMemoryIndex(env);
			const rawResults = await index.search({
				query,
				limit: overshoot,
				tags,
				timeWeight: searchScope !== "memory",
			});

			const memoryHits =
				searchScope === "conversations"
					? []
					: rawResults.filter((r) => !r.id.startsWith("conversations/exchanges/"));
			const conversationHits =
				searchScope === "memory"
					? []
					: rawResults.filter((r) => r.id.startsWith("conversations/exchanges/"));

			const enrichedMemory = await Promise.all(
				memoryHits.slice(0, effectiveLimit).map(async (r) => {
					const file = await storage.read(r.id);
					return {
						path: r.id,
						snippet: file ? extractSnippet(file.content) : "",
						score: r.score,
					};
				}),
			);

			let enrichedConversations: Array<Record<string, unknown>> = [];
			if (conversationHits.length > 0) {
				const conversationIndex = await loadConversationIndex(storage);
				enrichedConversations = conversationHits.slice(0, effectiveLimit).map((r) => {
					const exchangeId = r.id.replace("conversations/exchanges/", "").replace(".txt", "");
					const exchange = conversationIndex.exchanges.find((e) => e.id === exchangeId);
					return {
						id: exchangeId,
						score: r.score,
						project: exchange?.project,
						userPrompt: exchange?.userPrompt?.slice(0, 200),
						timestamp: exchange?.timestamp,
						sessionId: exchange?.sessionId,
					};
				});
			}

			if (searchScope === "memory") {
				return okResult(
					{ results: enrichedMemory },
					`Found ${enrichedMemory.length} match${enrichedMemory.length === 1 ? "" : "es"} for "${query}"`,
				);
			}
			if (searchScope === "conversations") {
				return okResult(
					{
						results: enrichedConversations,
						hint: "Use expand_conversation with sessionId to see full context",
					},
					`Found ${enrichedConversations.length} conversation match${enrichedConversations.length === 1 ? "" : "es"} for "${query}"`,
				);
			}
			return okResult(
				{
					memory: enrichedMemory,
					conversations: enrichedConversations,
					hint: "Use expand_conversation with sessionId to see full conversation context",
				},
				`Found ${enrichedMemory.length} memory + ${enrichedConversations.length} conversation match${enrichedMemory.length + enrichedConversations.length === 1 ? "" : "es"} for "${query}"`,
			);
		},
	);

	registerTool(
		server,
		"history",
		{
			description:
				"List previous versions of a file. Requires R2 bucket versioning — returns an empty list (with a hint) if versioning is disabled on the MEMORY_BUCKET.",
			inputSchema: {
				path: z.string().describe("File path"),
				limit: z.number().optional().default(10).describe("Max versions to return"),
			},
		},
		async ({ path, limit }: { path: string; limit?: number }) => {
			const versions = await storage.getVersions(path, limit);
			if (versions.length === 0) {
				return {
					versions: [],
					versioning_enabled: false,
					hint:
						"No versions returned. This usually means R2 bucket versioning is " +
						"disabled. Enable it with `wrangler r2 bucket update agent-memory " +
						"--versioning enabled` to capture history going forward.",
				};
			}
			return { versions, versioning_enabled: true };
		},
	);

	registerTool(
		server,
		"rollback",
		{
			description:
				"Restore a file to a previous version. Requires R2 bucket versioning to be enabled.",
			inputSchema: {
				path: z.string().describe("File path"),
				version_id: z.string().describe("Version ID to restore"),
			},
		},
		async ({ path, version_id }: { path: string; version_id: string }) => {
			const fileContent = await storage.getVersion(path, version_id);
			if (!fileContent) {
				return errResult("Version not found", { path, version_id });
			}
			await storage.write(path, fileContent);
			return { success: true, restored_from: version_id };
		},
	);

	registerTool(
		server,
		"get_backlinks",
		{
			description:
				"List files that link to the given target via Obsidian-style wikilinks ([[target]]).",
			inputSchema: {
				target: z
					.string()
					.describe("Wikilink target as written inside [[...]], e.g. 'memory/learnings'"),
			},
		},
		async ({ target }: { target: string }) => {
			const { backlinks } = await getMemoryIndex(env).backlinks(target);
			return { target, backlinks };
		},
	);

	registerTool(
		server,
		"execute",
		{
			description:
				"Execute a JavaScript async function against memory contents for complex queries. " +
				"The function receives `memory.read(path)` and `memory.list(path?)` and must return a value. " +
				"SECURITY: code runs inside the Worker's V8 isolate with access to globals like `fetch`, `crypto`, " +
				"and network I/O. Only use with trusted input — this is not a sandbox against malicious code. " +
				"Execution is bounded by the Worker's CPU limits; set a timeout in your own code for long queries.",
			inputSchema: {
				code: z
					.string()
					.describe(
						"Body of an async function. Has access to `memory.read(path)` and `memory.list(path?)`. Return a value.",
					),
			},
		},
		async ({ code }: { code: string }) => {
			const memoryApi = {
				read: async (filePath: string) => {
					const file = await storage.read(filePath);
					return file?.content ?? null;
				},
				list: async (filePath?: string) => storage.list(filePath, true),
			};
			return executeCode(code, memoryApi);
		},
	);

	// ==================== Conversation Tools ====================

	// `search_conversations` remains as a thin compatibility alias over
	// `search` so existing MCP clients don't break. New clients should use
	// `search({ scope: "conversations" })`.
	registerTool(
		server,
		"search_conversations",
		{
			description:
				"Search past conversations by meaning. Prefer `search({ scope: 'conversations' })` in new code.",
			inputSchema: {
				query: z.string().describe("What to search for, e.g., 'TypeScript errors', 'API design'"),
				limit: z.number().optional().default(5).describe("Max results to return"),
			},
		},
		async ({ query, limit }: { query: string; limit?: number }) => {
			const conversationIndex = await loadConversationIndex(storage);
			if (conversationIndex.exchanges.length === 0) {
				return {
					results: [],
					message: "No conversations indexed yet. Use index_conversations to sync.",
				};
			}
			const effectiveLimit = limit ?? 5;
			const rawResults = await getMemoryIndex(env).search({
				query,
				limit: effectiveLimit * 2,
				timeWeight: true,
			});
			const results = rawResults
				.filter((r) => r.id.startsWith("conversations/exchanges/"))
				.slice(0, effectiveLimit)
				.map((r) => {
					const exchangeId = r.id.replace("conversations/exchanges/", "").replace(".txt", "");
					const exchange = conversationIndex.exchanges.find((e) => e.id === exchangeId);
					return {
						id: exchangeId,
						score: r.score,
						project: exchange?.project,
						userPrompt: exchange?.userPrompt?.slice(0, 200),
						timestamp: exchange?.timestamp,
						sessionId: exchange?.sessionId,
					};
				});
			return {
				results,
				hint: "Use expand_conversation with sessionId to see full context",
			};
		},
	);

	registerTool(
		server,
		"index_conversations",
		{
			description:
				"Index conversation sessions from a sync script. Called by client-side scripts, not directly.",
			inputSchema: {
				sessions: z
					.array(
						z.object({
							sessionId: z.string(),
							project: z.string(),
							data: z.record(z.unknown()),
						}),
					)
					.describe("Array of session objects to index"),
			},
		},
		async ({
			sessions,
		}: {
			sessions: Array<{ sessionId: string; project: string; data: Record<string, unknown> }>;
		}) => {
			const result = await indexSessions(
				storage,
				sessions.map((s) => ({
					sessionId: s.sessionId,
					project: s.project,
					// The session JSON shape is defined by whatever client produced
					// it; we validate structurally inside `indexSessions` so the
					// unknown-record cast here is safe.
					data: s.data as unknown as Parameters<typeof indexSessions>[1][number]["data"],
				})),
			);

			// Push each exchange into the semantic index. Runs sequentially so
			// we don't blow past Workers AI rate limits on large imports.
			const conversationIndex = await loadConversationIndex(storage);
			const index = getMemoryIndex(env);
			let indexed = 0;
			for (const exchange of conversationIndex.exchanges) {
				const content = `[${exchange.project}] ${exchange.userPrompt}\n\nResponse: ${exchange.assistantResponse}`;
				await index.update({
					path: `conversations/exchanges/${exchange.id}.txt`,
					content,
				});
				indexed++;
			}
			return {
				success: true,
				added: result.added,
				updated: result.updated,
				unchanged: result.unchanged,
				totalIndexed: indexed,
			};
		},
	);

	registerTool(
		server,
		"expand_conversation",
		{
			description: "Load full context from a past conversation session.",
			inputSchema: {
				sessionId: z.string().describe("Session ID from search results"),
				exchangeId: z.string().optional().describe("Specific exchange ID to center on"),
			},
		},
		async ({ sessionId, exchangeId }: { sessionId: string; exchangeId?: string }) => {
			const result = await expandConversation(storage, sessionId, exchangeId);
			if (!result) {
				return errResult("Session not found", { sessionId });
			}
			return result as Record<string, unknown>;
		},
	);

	registerTool(
		server,
		"conversation_stats",
		{
			description: "Get statistics about indexed conversations.",
			inputSchema: {},
		},
		async () => (await getConversationStats(storage)) as Record<string, unknown>,
	);

	// ==================== Reminder Tools ====================

	registerTool(
		server,
		"schedule_reminder",
		{
			description:
				"Create a reminder. Use type 'cron' for recurring (e.g., '0 9 * * *' for 9am UTC daily) or 'once' for one-shot (ISO datetime).",
			inputSchema: {
				id: z.string().describe("Unique identifier for this reminder"),
				type: z.enum(["cron", "once"]).describe("'cron' for recurring, 'once' for one-shot"),
				expression: z
					.string()
					.describe("Cron expression (e.g., '0 9 * * *') or ISO datetime for one-shot"),
				description: z.string().describe("What this reminder is for"),
				payload: z.string().describe("Message/instructions when reminder fires"),
				model: z.string().optional().describe("Optional model hint for client"),
			},
		},
		async (args: {
			id: string;
			type: "cron" | "once";
			expression: string;
			description: string;
			payload: string;
			model?: string;
		}) => {
			const reminder = await scheduleReminder(storage, args);
			return { success: true, reminder };
		},
	);

	registerTool(
		server,
		"list_reminders",
		{ description: "List all scheduled reminders.", inputSchema: {} },
		async () => ({ reminders: await listReminders(storage) }),
	);

	registerTool(
		server,
		"remove_reminder",
		{
			description: "Remove a scheduled reminder.",
			inputSchema: { id: z.string().describe("ID of the reminder to remove") },
		},
		async ({ id }: { id: string }) => {
			const removed = await removeReminder(storage, id);
			return { success: removed, message: removed ? "Removed" : "Not found" };
		},
	);

	registerTool(
		server,
		"check_reminders",
		{
			description:
				"Check for fired reminders. Call on startup to see if any scheduled tasks need attention.",
			inputSchema: {},
		},
		async () => {
			const fired = await checkReminders(storage);
			return {
				fired,
				count: fired.length,
				hint:
					fired.length > 0
						? "Process these reminders based on their payload"
						: "No reminders to process",
			};
		},
	);

	// ==================== Reflection Tools ====================

	registerTool(
		server,
		"list_pending_reflections",
		{ description: "List pending reflection files awaiting review.", inputSchema: {} },
		async () => {
			const pending = await listPendingReflections(storage);
			return {
				pending,
				count: pending.length,
				hint:
					pending.length > 0
						? "Use read to view details, apply_reflection_changes to apply proposed edits"
						: "No pending reflections",
			};
		},
	);

	registerTool(
		server,
		"apply_reflection_changes",
		{
			description:
				"Apply proposed changes from a reflection. Reads the structured JSON sidecar (preferred) or falls back to parsing the markdown, applies specified edits, and optionally archives the reflection.",
			inputSchema: {
				date: z.string().describe("Date of the reflection (YYYY-MM-DD)"),
				editIndices: z
					.array(z.number())
					.optional()
					.describe("Which edits to apply (1-indexed). Omit to apply all."),
				archive: z
					.boolean()
					.optional()
					.default(true)
					.describe("Archive the reflection after applying"),
			},
		},
		async ({
			date,
			editIndices,
			archive = true,
		}: {
			date: string;
			editIndices?: number[];
			archive?: boolean;
		}) => {
			const pendingPath = `memory/reflections/pending/${date}.md`;

			// Prefer the structured JSON sidecar. Fall back to parsing the
			// markdown for older reflections that predate the sidecar.
			let edits: ProposedEdit[];
			const sidecar = await readStagedReflectionData(storage, date);
			if (sidecar) {
				edits = sidecar.proposedEdits;
			} else {
				const file = await storage.read(pendingPath);
				if (!file) {
					return errResult("Reflection not found", { date });
				}
				edits = parseProposedEditsFromMarkdown(file.content);
			}

			if (edits.length === 0) {
				if (archive) {
					await archiveReflection(storage, pendingPath);
				}
				return {
					success: true,
					message: "No proposed edits to apply",
					archived: archive,
				};
			}

			// 1-indexed to match the numbering in the rendered markdown.
			const toApply = editIndices ? edits.filter((_, i) => editIndices.includes(i + 1)) : edits;

			const results: Array<{ path: string; action: string; success: boolean; error?: string }> = [];
			for (const edit of toApply) {
				try {
					switch (edit.action) {
						case "replace":
						case "create":
							if (edit.content) {
								await indexWrite(env, storage, edit.path, edit.content);
							}
							results.push({ path: edit.path, action: edit.action, success: true });
							break;
						case "append":
							if (edit.content) {
								const existing = await storage.read(edit.path);
								const newContent = existing ? `${existing.content}\n${edit.content}` : edit.content;
								await indexWrite(env, storage, edit.path, newContent);
							}
							results.push({ path: edit.path, action: edit.action, success: true });
							break;
						case "delete":
							await storage.delete(edit.path);
							await getMemoryIndex(env).delete(edit.path);
							results.push({ path: edit.path, action: edit.action, success: true });
							break;
					}
				} catch (e) {
					results.push({
						path: edit.path,
						action: edit.action,
						success: false,
						error: e instanceof Error ? e.message : String(e),
					});
				}
			}

			const allSucceeded = results.every((r) => r.success);
			let archived = false;
			if (archive && allSucceeded) {
				await archiveReflection(storage, pendingPath);
				archived = true;
			}

			return {
				success: allSucceeded,
				applied: results.filter((r) => r.success).length,
				failed: results.filter((r) => !r.success).length,
				results,
				archived,
			};
		},
	);

	registerTool(
		server,
		"archive_reflection",
		{
			description: "Archive a pending reflection without applying changes (mark as reviewed).",
			inputSchema: {
				date: z.string().describe("Date of the reflection (YYYY-MM-DD)"),
			},
		},
		async ({ date }: { date: string }) => {
			const pendingPath = `memory/reflections/pending/${date}.md`;
			const archivePath = await archiveReflection(storage, pendingPath);
			if (!archivePath) {
				return errResult("Reflection not found", { date });
			}
			return { success: true, archivedTo: archivePath };
		},
	);

	return server;
}

/**
 * Fallback parser for reflections without a JSON sidecar.
 *
 * Matches sections like `### 1. REPLACE: memory/learnings.md` followed by a
 * Reason line and an optional fenced code block. Kept for backwards compat
 * with reflections staged before the JSON sidecar was introduced — new
 * reflections are applied directly from the structured JSON.
 */
function parseProposedEditsFromMarkdown(content: string): ProposedEdit[] {
	const edits: ProposedEdit[] = [];
	const editPattern =
		/###\s*\d+\.\s*(REPLACE|APPEND|DELETE|CREATE):\s*(\S+)\s*\n\n\*\*Reason:\*\*\s*([^\n]+)\n(?:\n\*\*Content:\*\*\n```\n([\s\S]*?)\n```)?/g;

	for (let match = editPattern.exec(content); match !== null; match = editPattern.exec(content)) {
		const [, action, path, reason, editContent] = match;
		edits.push({
			path,
			action: action.toLowerCase() as ProposedEdit["action"],
			reason,
			content: editContent,
		});
	}
	return edits;
}
