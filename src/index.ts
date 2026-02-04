import { z } from "zod";
import { unauthorizedResponse, validateAuth } from "./auth";
import {
	expandConversation,
	getConversationStats,
	indexSessions,
	loadConversationIndex,
} from "./conversations";
import { executeCode } from "./execute";
import { runReflection } from "./reflection";
import { checkReminders, listReminders, removeReminder, scheduleReminder } from "./reminders";
import { createR2Storage } from "./storage/r2";
import { extractSnippet, truncate } from "./truncate";
import type { Env } from "./types";

// Export Durable Object class
export { MemoryIndex } from "./search/durable-object";

interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: z.ZodObject<z.ZodRawShape>;
	handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		// Handle CORS preflight
		if (request.method === "OPTIONS") {
			return new Response(null, {
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "POST, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, Authorization",
				},
			});
		}

		// Validate auth
		const authResult = validateAuth(request, env);
		if (!authResult.authorized) {
			return unauthorizedResponse(authResult.error!);
		}

		const storage = createR2Storage(env.MEMORY_BUCKET);

		// Define tools with Zod schemas and handlers
		const tools: ToolDefinition[] = [
			{
				name: "read",
				description: "Read a file from memory storage",
				inputSchema: z.object({
					path: z.string().describe("File path, e.g., 'memory/learnings.md'"),
				}),
				handler: async (args) => {
					const { path } = args as { path: string };
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
			},
			{
				name: "write",
				description: "Write content to a file. Automatically updates search index.",
				inputSchema: z.object({
					path: z.string().describe("File path, e.g., 'memory/learnings.md'"),
					content: z.string().describe("Content to write"),
				}),
				handler: async (args) => {
					const { path, content } = args as { path: string; content: string };
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
			},
			{
				name: "list",
				description: "List files in a directory",
				inputSchema: z.object({
					path: z.string().optional().describe("Directory path, defaults to root"),
					recursive: z.boolean().optional().default(false).describe("List recursively"),
				}),
				handler: async (args) => {
					const { path, recursive } = args as { path?: string; recursive?: boolean };
					const files = await storage.list(path, recursive);
					return {
						content: [{ type: "text", text: JSON.stringify({ files }) }],
					};
				},
			},
			{
				name: "search",
				description: "Search memory by meaning. Returns relevant file snippets.",
				inputSchema: z.object({
					query: z.string().describe("Natural language query"),
					limit: z.number().optional().default(5).describe("Max results to return"),
				}),
				handler: async (args) => {
					const { query, limit } = args as { query: string; limit?: number };
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
						// HNSW returns {id, score} where id is the path
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
			},
			{
				name: "history",
				description: "List previous versions of a file",
				inputSchema: z.object({
					path: z.string().describe("File path"),
					limit: z.number().optional().default(10).describe("Max versions to return"),
				}),
				handler: async (args) => {
					const { path, limit } = args as { path: string; limit?: number };
					const versions = await storage.getVersions(path, limit);
					return {
						content: [{ type: "text", text: JSON.stringify({ versions }) }],
					};
				},
			},
			{
				name: "rollback",
				description: "Restore a file to a previous version",
				inputSchema: z.object({
					path: z.string().describe("File path"),
					version_id: z.string().describe("Version ID to restore"),
				}),
				handler: async (args) => {
					const { path, version_id } = args as { path: string; version_id: string };
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
			},
			{
				name: "execute",
				description: "Execute JavaScript code against memory contents. Use for complex queries.",
				inputSchema: z.object({
					code: z
						.string()
						.describe("Async arrow function with access to memory.read(), memory.list()"),
				}),
				handler: async (args) => {
					const { code } = args as { code: string };
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

					return executeCode(code, memoryApi);
				},
			},
			// ==================== Conversation Tools ====================
			{
				name: "search_conversations",
				description:
					"Search past conversations for similar problems/solutions. Uses time-weighted scoring (recent = higher).",
				inputSchema: z.object({
					query: z.string().describe("What to search for, e.g., 'TypeScript errors', 'API design'"),
					limit: z.number().optional().default(5).describe("Max results to return"),
				}),
				handler: async (args) => {
					const { query, limit } = args as { query: string; limit?: number };
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

						// Use the main search index with conversation prefix filter
						const indexId = env.MEMORY_INDEX.idFromName("default");
						const index = env.MEMORY_INDEX.get(indexId);
						const response = await index.fetch(
							new Request("http://internal/search", {
								method: "POST",
								body: JSON.stringify({ query, limit: (limit ?? 5) * 2, timeWeight: true }),
							}),
						);
						const rawResults = (await response.json()) as Array<{ id: string; score: number }>;

						// Filter to conversation results and enrich
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
			},
			{
				name: "index_conversations",
				description:
					"Index conversation sessions from a sync script. Called by client-side scripts, not directly.",
				inputSchema: z.object({
					sessions: z
						.array(
							z.object({
								sessionId: z.string(),
								project: z.string(),
								data: z.record(z.unknown()),
							}),
						)
						.describe("Array of session objects to index"),
				}),
				handler: async (args) => {
					const { sessions } = args as {
						sessions: Array<{ sessionId: string; project: string; data: Record<string, unknown> }>;
					};
					try {
						// Index sessions and update embeddings for each exchange
						const result = await indexSessions(
							storage,
							sessions.map((s) => ({
								sessionId: s.sessionId,
								project: s.project,
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
								data: s.data as any,
							})),
						);

						// Update embeddings for new/changed exchanges
						const conversationIndex = await loadConversationIndex(storage);
						const indexId = env.MEMORY_INDEX.idFromName("default");
						const index = env.MEMORY_INDEX.get(indexId);

						let indexed = 0;
						for (const exchange of conversationIndex.exchanges) {
							// Index user prompt for search
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
			},
			{
				name: "expand_conversation",
				description: "Load full context from a past conversation session.",
				inputSchema: z.object({
					sessionId: z.string().describe("Session ID from search results"),
					exchangeId: z.string().optional().describe("Specific exchange ID to center on"),
				}),
				handler: async (args) => {
					const { sessionId, exchangeId } = args as { sessionId: string; exchangeId?: string };
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
			},
			{
				name: "conversation_stats",
				description: "Get statistics about indexed conversations.",
				inputSchema: z.object({}),
				handler: async () => {
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
			},
			// ==================== Reminder Tools ====================
			{
				name: "schedule_reminder",
				description:
					"Create a reminder. Use type 'cron' for recurring (e.g., '0 9 * * *' for 9am UTC daily) or 'once' for one-shot (ISO datetime).",
				inputSchema: z.object({
					id: z.string().describe("Unique identifier for this reminder"),
					type: z.enum(["cron", "once"]).describe("'cron' for recurring, 'once' for one-shot"),
					expression: z
						.string()
						.describe("Cron expression (e.g., '0 9 * * *') or ISO datetime for one-shot"),
					description: z.string().describe("What this reminder is for"),
					payload: z.string().describe("Message/instructions when reminder fires"),
					model: z.string().optional().describe("Optional model hint for client"),
				}),
				handler: async (args) => {
					const { id, type, expression, description, payload, model } = args as {
						id: string;
						type: "cron" | "once";
						expression: string;
						description: string;
						payload: string;
						model?: string;
					};
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
			},
			{
				name: "list_reminders",
				description: "List all scheduled reminders.",
				inputSchema: z.object({}),
				handler: async () => {
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
			},
			{
				name: "remove_reminder",
				description: "Remove a scheduled reminder.",
				inputSchema: z.object({
					id: z.string().describe("ID of the reminder to remove"),
				}),
				handler: async (args) => {
					const { id } = args as { id: string };
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
			},
			{
				name: "check_reminders",
				description:
					"Check for fired reminders. Call on startup to see if any scheduled tasks need attention.",
				inputSchema: z.object({}),
				handler: async () => {
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
			},
		];

		// Helper to convert Zod schema to JSON schema for MCP
		const zodToJsonSchema = (schema: z.ZodObject<z.ZodRawShape>) => {
			const shape = schema.shape;
			const properties: Record<string, unknown> = {};
			const required: string[] = [];

			for (const [key, value] of Object.entries(shape)) {
				let zodType = value as z.ZodTypeAny;
				const propertyDef: Record<string, unknown> = {};
				let isOptional = false;

				// Unwrap optional/default types to get to the base type
				while (zodType._def) {
					if (zodType._def.typeName === "ZodOptional") {
						isOptional = true;
						zodType = zodType._def.innerType;
					} else if (zodType._def.typeName === "ZodDefault") {
						isOptional = true;
						propertyDef.default = zodType._def.defaultValue();
						zodType = zodType._def.innerType;
					} else {
						break;
					}
				}

				// Determine the type from the base type
				const typeName = zodType._def?.typeName;
				if (typeName === "ZodString") {
					propertyDef.type = "string";
				} else if (typeName === "ZodNumber") {
					propertyDef.type = "number";
				} else if (typeName === "ZodBoolean") {
					propertyDef.type = "boolean";
				}

				// Get description if available
				const desc = (value as z.ZodTypeAny).description || zodType.description;
				if (desc) {
					propertyDef.description = desc;
				}

				properties[key] = propertyDef;

				if (!isOptional) {
					required.push(key);
				}
			}

			return {
				type: "object",
				properties,
				required: required.length > 0 ? required : undefined,
			};
		};

		// Handle MCP request
		const url = new URL(request.url);
		if (url.pathname === "/mcp" && request.method === "POST") {
			try {
				const body = (await request.json()) as {
					method: string;
					id: string | number;
					params?: { name?: string; arguments?: Record<string, unknown> };
				};

				// Handle tools/list
				if (body.method === "tools/list") {
					const toolList = tools.map((t) => ({
						name: t.name,
						description: t.description,
						inputSchema: zodToJsonSchema(t.inputSchema),
					}));
					return new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							id: body.id,
							result: { tools: toolList },
						}),
						{ headers: { "Content-Type": "application/json" } },
					);
				}

				// Handle tools/call
				if (body.method === "tools/call") {
					const { name, arguments: args } = body.params || {};
					const tool = tools.find((t) => t.name === name);
					if (!tool) {
						return new Response(
							JSON.stringify({
								jsonrpc: "2.0",
								id: body.id,
								error: { code: -32602, message: `Unknown tool: ${name}` },
							}),
							{ status: 400, headers: { "Content-Type": "application/json" } },
						);
					}

					// Validate and parse arguments
					const parseResult = tool.inputSchema.safeParse(args || {});
					if (!parseResult.success) {
						return new Response(
							JSON.stringify({
								jsonrpc: "2.0",
								id: body.id,
								error: { code: -32602, message: `Invalid arguments: ${parseResult.error.message}` },
							}),
							{ status: 400, headers: { "Content-Type": "application/json" } },
						);
					}

					const result = await tool.handler(parseResult.data);
					return new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							id: body.id,
							result,
						}),
						{ headers: { "Content-Type": "application/json" } },
					);
				}

				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						error: { code: -32601, message: "Method not found" },
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			} catch (e) {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						error: {
							code: -32700,
							message: "Parse error",
							data: e instanceof Error ? e.message : String(e),
						},
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}
		}

		// Health check endpoint
		if (url.pathname === "/health") {
			return new Response(JSON.stringify({ status: "ok", version: "0.1.0" }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		return new Response("Not Found", { status: 404 });
	},

	/**
	 * Scheduled handler for daily reflection
	 * Triggered by cron at 6am UTC daily
	 */
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(
			runReflection(env).then((result) => {
				if (result.success) {
					console.log(`Reflection completed for ${result.date}: ${result.summary}`);
				} else {
					console.error(`Reflection failed for ${result.date}: ${result.error}`);
				}
			}),
		);
	},
};
