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
			const authResult = validateAuth(request, env);
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
			// Validate auth
			const authResult = validateAuth(request, env);
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
