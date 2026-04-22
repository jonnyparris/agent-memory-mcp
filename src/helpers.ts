/**
 * Shared helpers for MCP tool handlers.
 *
 * The MCP SDK wants tools to return `{ content: [{ type: "text", text }], isError? }`.
 * Every tool was doing the same JSON.stringify + try/catch dance, so pull it
 * out here and keep the handlers focused on the actual logic.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

/**
 * Build a successful tool response. A short human-readable prefix is
 * prepended to the JSON payload so transcripts are readable without
 * parsing — the MCP client still sees valid JSON after the first blank
 * line if it cares to parse it. Omit `prefix` to return just JSON.
 */
export function okResult(data: unknown, prefix?: string): ToolResult {
	const json = JSON.stringify(data);
	const text = prefix ? `${prefix}\n\n${json}` : json;
	return { content: [{ type: "text", text }] };
}

/**
 * Build an error tool response. Always sets `isError: true` so MCP clients
 * can surface failures distinctly.
 *
 * `details` is handled polymorphically: `Error` instances contribute their
 * `message`, plain objects are merged into the body as additional fields
 * (so you can pass `{ path, version_id }` for context), and everything
 * else is coerced to a string under `details`.
 */
export function errResult(error: string, details?: unknown): ToolResult {
	const body: Record<string, unknown> = { error };
	if (details instanceof Error) {
		body.details = details.message;
	} else if (typeof details === "string") {
		body.details = details;
	} else if (details && typeof details === "object") {
		// Merge context fields directly so callers get `{ error, path }`
		// rather than a nested `{ error, details: { path } }`.
		Object.assign(body, details);
	} else if (details !== undefined) {
		body.details = String(details);
	}
	return {
		content: [{ type: "text", text: JSON.stringify(body) }],
		isError: true,
	};
}

/**
 * Register an MCP tool with automatic error handling.
 *
 * The handler returns either a plain object (serialised to JSON), a string
 * (returned as-is with no wrapping), or a `ToolResult` (passed through).
 * Any thrown error is caught and converted to an `errResult` with the tool
 * name in the message — this guarantees no tool ever returns an unhandled
 * rejection to the transport layer.
 */
/**
 * Register an MCP tool with automatic error handling.
 *
 * The handler returns either a plain object (serialised to JSON), a string
 * (returned as-is with no wrapping), or a `ToolResult` (passed through).
 * Any thrown error is caught and converted to an `errResult` with the tool
 * name in the message — this guarantees no tool ever returns an unhandled
 * rejection to the transport layer.
 *
 * The MCP SDK's `registerTool` generic has a very deep type that's painful
 * to re-export, so the config is typed loosely here and the handler gets
 * `any` for its args. The tradeoff is worth it: every tool in this repo
 * benefits from consistent error handling.
 */
export function registerTool(
	server: McpServer,
	name: string,
	// biome-ignore lint/suspicious/noExplicitAny: SDK generics are too deep to re-express
	config: { description: string; inputSchema: any },
	// biome-ignore lint/suspicious/noExplicitAny: zod inference at call sites is what we want
	handler: (args: any) => Promise<ToolResult | Record<string, unknown> | string>,
): void {
	server.registerTool(name, config, (async (args: unknown) => {
		try {
			const result = await handler(args);
			if (typeof result === "string") {
				return { content: [{ type: "text", text: result }] };
			}
			if (isToolResult(result)) {
				return result;
			}
			return okResult(result);
		} catch (e) {
			return errResult(`${name} failed`, e);
		}
		// biome-ignore lint/suspicious/noExplicitAny: see note above
	}) as any);
}

function isToolResult(value: unknown): value is ToolResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"content" in value &&
		Array.isArray((value as ToolResult).content)
	);
}
