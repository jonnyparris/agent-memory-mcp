import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	expandConversation,
	getConversationStats,
	indexSessions,
	loadConversationIndex,
} from "./conversations";
import { executeCode } from "./execute";
import { archiveReflection, listPendingReflections } from "./reflection/staging";
import type { ProposedEdit } from "./reflection/tool-executor";
import { checkReminders, listReminders, removeReminder, scheduleReminder } from "./reminders";
import { createR2Storage } from "./storage/r2";
import { extractSnippet, truncate } from "./truncate";
import type { Env } from "./types";

export function createServer(env: Env): McpServer {
	const server = new McpServer({
		name: "agent-memory",
		version: "0.1.0",
	});

	const storage = createR2Storage(env.MEMORY_BUCKET);

	// ==================== Core Memory Tools ====================

	server.registerTool(
		"read",
		{
			description: "Read a file from memory storage",
			inputSchema: {
				path: z.string().describe("File path, e.g., 'memory/learnings.md'"),
			},
		},
		async ({ path }) => {
			const file = await storage.read(path);
			if (!file) {
				return {
					content: [{ type: "text", text: JSON.stringify({ error: "File not found", path }) }],
					isError: true,
				};
			}
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							content: truncate(file.content),
							updated_at: file.updated_at,
							size: file.size,
						}),
					},
				],
			};
		},
	);

	server.registerTool(
		"write",
		{
			description: "Write content to a file. Automatically updates search index.",
			inputSchema: {
				path: z.string().describe("File path, e.g., 'memory/learnings.md'"),
				content: z.string().describe("Content to write"),
			},
		},
		async ({ path, content }) => {
			const result = await storage.write(path, content);

			// Update embeddings in Durable Object
			let embeddingError: string | undefined;
			try {
				const indexId = env.MEMORY_INDEX.idFromName("default");
				const index = env.MEMORY_INDEX.get(indexId);
				const updateResponse = await index.fetch(
					new Request("http://internal/update", {
						method: "POST",
						body: JSON.stringify({ path, content }),
					}),
				);
				if (!updateResponse.ok) {
					const errorData = await updateResponse.text();
					embeddingError = `DO returned ${updateResponse.status}: ${errorData}`;
				}
			} catch (e) {
				embeddingError = String(e);
			}

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							success: true,
							version_id: result.version_id,
							embedding_error: embeddingError,
						}),
					},
				],
			};
		},
	);

	server.registerTool(
		"list",
		{
			description: "List files in a directory",
			inputSchema: {
				path: z.string().optional().describe("Directory path, defaults to root"),
				recursive: z.boolean().optional().default(false).describe("List recursively"),
			},
		},
		async ({ path, recursive }) => {
			const files = await storage.list(path, recursive);
			return {
				content: [{ type: "text", text: JSON.stringify({ files }) }],
			};
		},
	);

	server.registerTool(
		"search",
		{
			description: "Search memory by meaning. Returns relevant file snippets.",
			inputSchema: {
				query: z.string().describe("Natural language query"),
				limit: z.number().optional().default(5).describe("Max results to return"),
			},
		},
		async ({ query, limit }) => {
			try {
				const indexId = env.MEMORY_INDEX.idFromName("default");
				const index = env.MEMORY_INDEX.get(indexId);
				const response = await index.fetch(
					new Request("http://internal/search", {
						method: "POST",
						body: JSON.stringify({ query, limit }),
					}),
				);
				const results = await response.json();

				// Check if DO returned an error
				if (results && typeof results === "object" && "error" in results) {
					return {
						content: [{ type: "text", text: JSON.stringify(results) }],
						isError: true,
					};
				}

				// Fetch snippets for each result
				const resultsArray = Array.isArray(results) ? results : [];
				const enrichedResults = await Promise.all(
					(resultsArray as Array<{ id: string; score: number }>).map(async (r) => {
						const file = await storage.read(r.id);
						return {
							path: r.id,
							snippet: file ? extractSnippet(file.content) : "",
							score: r.score,
						};
					}),
				);

				return {
					content: [{ type: "text", text: JSON.stringify({ results: enrichedResults }) }],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ error: "Search failed", details: String(e) }),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"history",
		{
			description: "List previous versions of a file",
			inputSchema: {
				path: z.string().describe("File path"),
				limit: z.number().optional().default(10).describe("Max versions to return"),
			},
		},
		async ({ path, limit }) => {
			const versions = await storage.getVersions(path, limit);
			return {
				content: [{ type: "text", text: JSON.stringify({ versions }) }],
			};
		},
	);

	server.registerTool(
		"rollback",
		{
			description: "Restore a file to a previous version",
			inputSchema: {
				path: z.string().describe("File path"),
				version_id: z.string().describe("Version ID to restore"),
			},
		},
		async ({ path, version_id }) => {
			const fileContent = await storage.getVersion(path, version_id);
			if (!fileContent) {
				return {
					content: [{ type: "text", text: JSON.stringify({ error: "Version not found" }) }],
					isError: true,
				};
			}

			await storage.write(path, fileContent);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							success: true,
							restored_from: version_id,
						}),
					},
				],
			};
		},
	);

	server.registerTool(
		"execute",
		{
			description: "Execute JavaScript code against memory contents. Use for complex queries.",
			inputSchema: {
				code: z
					.string()
					.describe("Async arrow function with access to memory.read(), memory.list()"),
			},
		},
		async ({ code }) => {
			// Create sandboxed memory API
			const memoryApi = {
				read: async (filePath: string) => {
					const file = await storage.read(filePath);
					return file?.content ?? null;
				},
				list: async (filePath?: string) => {
					return storage.list(filePath, true);
				},
			};

			const result = await executeCode(code, memoryApi);
			return {
				content: result.content,
				isError: result.isError,
			};
		},
	);

	// ==================== Conversation Tools ====================

	server.registerTool(
		"search_conversations",
		{
			description:
				"Search past conversations for similar problems/solutions. Uses time-weighted scoring (recent = higher).",
			inputSchema: {
				query: z.string().describe("What to search for, e.g., 'TypeScript errors', 'API design'"),
				limit: z.number().optional().default(5).describe("Max results to return"),
			},
		},
		async ({ query, limit }) => {
			try {
				const conversationIndex = await loadConversationIndex(storage);
				if (conversationIndex.exchanges.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									results: [],
									message: "No conversations indexed yet. Use index_conversations to sync.",
								}),
							},
						],
					};
				}

				const indexId = env.MEMORY_INDEX.idFromName("default");
				const index = env.MEMORY_INDEX.get(indexId);
				const response = await index.fetch(
					new Request("http://internal/search", {
						method: "POST",
						body: JSON.stringify({ query, limit: (limit ?? 5) * 2, timeWeight: true }),
					}),
				);
				const rawResults = (await response.json()) as Array<{ id: string; score: number }>;

				const conversationResults = rawResults
					.filter((r) => r.id.startsWith("conversations/exchanges/"))
					.slice(0, limit ?? 5)
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
					content: [
						{
							type: "text",
							text: JSON.stringify({
								results: conversationResults,
								hint: "Use expand_conversation with sessionId to see full context",
							}),
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ error: "Search failed", details: String(e) }),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
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
		async ({ sessions }) => {
			try {
				const result = await indexSessions(
					storage,
					sessions.map((s) => ({
						sessionId: s.sessionId,
						project: s.project,
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						data: s.data as any,
					})),
				);

				const conversationIndex = await loadConversationIndex(storage);
				const indexId = env.MEMORY_INDEX.idFromName("default");
				const index = env.MEMORY_INDEX.get(indexId);

				let indexed = 0;
				for (const exchange of conversationIndex.exchanges) {
					const content = `[${exchange.project}] ${exchange.userPrompt}\n\nResponse: ${exchange.assistantResponse}`;
					const path = `conversations/exchanges/${exchange.id}.txt`;

					await index.fetch(
						new Request("http://internal/update", {
							method: "POST",
							body: JSON.stringify({ path, content }),
						}),
					);
					indexed++;
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								added: result.added,
								updated: result.updated,
								unchanged: result.unchanged,
								totalIndexed: indexed,
							}),
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ error: "Indexing failed", details: String(e) }),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"expand_conversation",
		{
			description: "Load full context from a past conversation session.",
			inputSchema: {
				sessionId: z.string().describe("Session ID from search results"),
				exchangeId: z.string().optional().describe("Specific exchange ID to center on"),
			},
		},
		async ({ sessionId, exchangeId }) => {
			try {
				const result = await expandConversation(storage, sessionId, exchangeId);
				if (!result) {
					return {
						content: [{ type: "text", text: JSON.stringify({ error: "Session not found" }) }],
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ error: "Expand failed", details: String(e) }),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"conversation_stats",
		{
			description: "Get statistics about indexed conversations.",
			inputSchema: {},
		},
		async () => {
			try {
				const stats = await getConversationStats(storage);
				return {
					content: [{ type: "text", text: JSON.stringify(stats) }],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ error: "Stats failed", details: String(e) }),
						},
					],
					isError: true,
				};
			}
		},
	);

	// ==================== Reminder Tools ====================

	server.registerTool(
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
		async ({ id, type, expression, description, payload, model }) => {
			try {
				const reminder = await scheduleReminder(storage, {
					id,
					type,
					expression,
					description,
					payload,
					model,
				});
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ success: true, reminder }),
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ error: "Failed to schedule", details: String(e) }),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"list_reminders",
		{
			description: "List all scheduled reminders.",
			inputSchema: {},
		},
		async () => {
			try {
				const reminders = await listReminders(storage);
				return {
					content: [{ type: "text", text: JSON.stringify({ reminders }) }],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ error: "List failed", details: String(e) }),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"remove_reminder",
		{
			description: "Remove a scheduled reminder.",
			inputSchema: {
				id: z.string().describe("ID of the reminder to remove"),
			},
		},
		async ({ id }) => {
			try {
				const removed = await removeReminder(storage, id);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: removed,
								message: removed ? "Removed" : "Not found",
							}),
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ error: "Remove failed", details: String(e) }),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"check_reminders",
		{
			description:
				"Check for fired reminders. Call on startup to see if any scheduled tasks need attention.",
			inputSchema: {},
		},
		async () => {
			try {
				const fired = await checkReminders(storage);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								fired,
								count: fired.length,
								hint:
									fired.length > 0
										? "Process these reminders based on their payload"
										: "No reminders to process",
							}),
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ error: "Check failed", details: String(e) }),
						},
					],
					isError: true,
				};
			}
		},
	);

	// ==================== Reflection Tools ====================

	server.registerTool(
		"list_pending_reflections",
		{
			description: "List pending reflection files awaiting review.",
			inputSchema: {},
		},
		async () => {
			try {
				const pending = await listPendingReflections(storage);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								pending,
								count: pending.length,
								hint:
									pending.length > 0
										? "Use read to view details, apply_reflection_changes to apply proposed edits"
										: "No pending reflections",
							}),
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ error: "List failed", details: String(e) }),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"apply_reflection_changes",
		{
			description:
				"Apply proposed changes from a reflection. Reads the pending file, applies specified edits, and optionally archives the reflection.",
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
		async ({ date, editIndices, archive }) => {
			try {
				const pendingPath = `memory/reflections/pending/${date}.md`;
				const file = await storage.read(pendingPath);

				if (!file) {
					return {
						content: [
							{ type: "text", text: JSON.stringify({ error: "Reflection not found", date }) },
						],
						isError: true,
					};
				}

				// Parse proposed edits from the markdown
				const edits = parseProposedEdits(file.content);

				if (edits.length === 0) {
					// No edits to apply, just archive if requested
					if (archive) {
						await archiveReflection(storage, pendingPath);
					}
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									success: true,
									message: "No proposed edits to apply",
									archived: archive,
								}),
							},
						],
					};
				}

				// Filter to requested indices (1-indexed)
				const toApply = editIndices ? edits.filter((_, i) => editIndices.includes(i + 1)) : edits;

				// Apply each edit
				const results: Array<{ path: string; action: string; success: boolean; error?: string }> =
					[];

				for (const edit of toApply) {
					try {
						switch (edit.action) {
							case "replace":
							case "create":
								if (edit.content) {
									await storage.write(edit.path, edit.content);
									// Update search index
									const indexId = env.MEMORY_INDEX.idFromName("default");
									const index = env.MEMORY_INDEX.get(indexId);
									await index.fetch(
										new Request("http://internal/update", {
											method: "POST",
											body: JSON.stringify({ path: edit.path, content: edit.content }),
										}),
									);
								}
								results.push({ path: edit.path, action: edit.action, success: true });
								break;

							case "append":
								if (edit.content) {
									const existing = await storage.read(edit.path);
									const newContent = existing
										? `${existing.content}\n${edit.content}`
										: edit.content;
									await storage.write(edit.path, newContent);
								}
								results.push({ path: edit.path, action: edit.action, success: true });
								break;

							case "delete":
								await storage.delete(edit.path);
								results.push({ path: edit.path, action: edit.action, success: true });
								break;
						}
					} catch (e) {
						results.push({
							path: edit.path,
							action: edit.action,
							success: false,
							error: String(e),
						});
					}
				}

				// Archive if requested and all succeeded
				const allSucceeded = results.every((r) => r.success);
				let archived = false;
				if (archive && allSucceeded) {
					await archiveReflection(storage, pendingPath);
					archived = true;
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: allSucceeded,
								applied: results.filter((r) => r.success).length,
								failed: results.filter((r) => !r.success).length,
								results,
								archived,
							}),
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ error: "Apply failed", details: String(e) }),
						},
					],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"archive_reflection",
		{
			description: "Archive a pending reflection without applying changes (mark as reviewed).",
			inputSchema: {
				date: z.string().describe("Date of the reflection (YYYY-MM-DD)"),
			},
		},
		async ({ date }) => {
			try {
				const pendingPath = `memory/reflections/pending/${date}.md`;
				const archivePath = await archiveReflection(storage, pendingPath);

				if (!archivePath) {
					return {
						content: [
							{ type: "text", text: JSON.stringify({ error: "Reflection not found", date }) },
						],
						isError: true,
					};
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								archivedTo: archivePath,
							}),
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ error: "Archive failed", details: String(e) }),
						},
					],
					isError: true,
				};
			}
		},
	);

	return server;
}

/**
 * Parse proposed edits from a reflection markdown file
 */
function parseProposedEdits(content: string): ProposedEdit[] {
	const edits: ProposedEdit[] = [];

	// Match sections like: ### 1. REPLACE: memory/learnings.md
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
