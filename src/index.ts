/**
 * Worker entrypoint.
 *
 * Routes:
 *   GET  /health   — public, returns server version. No auth.
 *   POST /reflect  — REST, auth required. Manually triggers a reflection
 *                    run. Returns a JSON ReflectionResult, NOT JSON-RPC.
 *   ANY  /mcp      — MCP Streamable HTTP transport, auth required. Serves
 *                    the full MCP tool surface (read/write/search/etc).
 *                    All responses are JSON-RPC 2.0.
 *
 * The scheduled handler runs the daily reflection at 6am UTC (see
 * wrangler.jsonc crons). The Durable Object class export wires
 * `MEMORY_INDEX` — see `src/search/durable-object.ts`.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { unauthorizedResponse, validateAuth } from "./auth";
import { runReflection } from "./reflection";
import { createServer } from "./server";
import type { Env } from "./types";

// Export Durable Object class
export { MemoryIndex } from "./search/durable-object";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Handle CORS preflight
		if (request.method === "OPTIONS") {
			return new Response(null, {
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, Authorization",
				},
			});
		}

		// Health check endpoint (no auth required)
		if (url.pathname === "/health") {
			return new Response(JSON.stringify({ status: "ok", version: "0.1.0" }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// Manual reflection trigger (requires auth)
		if (url.pathname === "/reflect" && request.method === "POST") {
			const authResult = await validateAuth(request, env);
			if (!authResult.authorized) {
				return unauthorizedResponse(authResult.error!);
			}

			const result = await runReflection(env);
			return new Response(JSON.stringify(result, null, 2), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// MCP endpoint
		if (url.pathname === "/mcp") {
			const authResult = await validateAuth(request, env);
			if (!authResult.authorized) {
				return unauthorizedResponse(authResult.error!);
			}

			const server = createServer(env);
			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			});

			await server.connect(transport);
			const response = await transport.handleRequest(request);
			ctx.waitUntil(transport.close());

			return response;
		}

		return new Response("Not Found", { status: 404 });
	},

	/**
	 * Scheduled handler for daily reflection.
	 *
	 * Triggered by the cron at 6am UTC. Awaits the reflection directly
	 * rather than using `ctx.waitUntil` — cron handlers already keep the
	 * invocation alive until the promise resolves, and awaiting surfaces
	 * rejections as actual scheduled-handler failures (visible in the
	 * Cloudflare dashboard) instead of being swallowed inside `then()`.
	 */
	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
		const result = await runReflection(env);
		if (result.success) {
			console.log(`Reflection completed for ${result.date}: ${result.summary}`);
		} else {
			console.error(`Reflection failed for ${result.date}: ${result.error}`);
		}
	},
};
