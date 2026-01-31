import { z } from "zod";
import { unauthorizedResponse, validateAuth } from "./auth";
import { executeCode } from "./execute";
import { runReflection } from "./reflection";
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
