/**
 * Worker entrypoint.
 *
 * Routes:
 *   GET  /health   — public, returns server version. No auth.
 *   POST /reflect  — REST, auth required. Manually triggers a reflection
 *                    run. Returns a JSON ReflectionResult, NOT JSON-RPC.
 *                    Add ?dry_run=1 to see what it would do without writing
 *                    anything or sending the chat notification. Dry runs
 *                    also take ?focus=<id> and ?model=<workers-ai model>.
 *   POST /mcp      — MCP Streamable HTTP transport, auth required. Serves
 *                    the full MCP tool surface (read/write/search/etc).
 *                    All responses are JSON-RPC 2.0.
 *   GET/DELETE /mcp — 405. The server is stateless and has no standalone
 *                    SSE stream or sessions to delete. See the comment at
 *                    the route for why this matters.
 *
 * The scheduled handler runs the daily reflection at 6am UTC (see
 * wrangler.jsonc crons). The Durable Object class export wires
 * `MEMORY_INDEX` — see `src/search/durable-object.ts`.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import pkg from "../package.json";
import { unauthorizedResponse, validateAuth } from "./auth";
import { runReflection } from "./reflection";
import { pruneIndex, reindexLegacy } from "./search/maintenance";
import { createServer } from "./server";
import { createR2Storage } from "./storage/r2";
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
			return new Response(JSON.stringify({ status: "ok", version: pkg.version }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// Manual reflection trigger (requires auth)
		if (url.pathname === "/reflect" && request.method === "POST") {
			const authResult = await validateAuth(request, env);
			if (!authResult.authorized) {
				return unauthorizedResponse(authResult.error!);
			}

			const dryRun = ["1", "true"].includes(url.searchParams.get("dry_run") ?? "");
			// focus and model overrides are for evaluating prompts and models, so
			// they only apply to dry runs. A real run always uses the rotation.
			const result = await runReflection(env, {
				dryRun,
				focus: dryRun ? (url.searchParams.get("focus") ?? undefined) : undefined,
				model: dryRun ? (url.searchParams.get("model") ?? undefined) : undefined,
			});
			return new Response(JSON.stringify(result, null, 2), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// MCP endpoint
		if (url.pathname === "/mcp") {
			// Stateless server: no standalone SSE stream (GET) and no sessions to
			// end (DELETE). The spec lets a server answer 405 here, and clients
			// then stop asking. Before this, GET got a 200 event stream that
			// closed as soon as the response was sent. The MCP TS client treats
			// a closed GET stream as resumable and reconnects after 1s, forever,
			// with the retry counter reset each time. Every open MCP client cost
			// ~3,600 requests an hour: 765K requests in 09-15..10-15.
			if (request.method === "GET" || request.method === "DELETE") {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						error: { code: -32000, message: "Method not allowed." },
						id: null,
					}),
					{
						status: 405,
						headers: { Allow: "POST", "Content-Type": "application/json" },
					},
				);
			}

			const authResult = await validateAuth(request, env);
			if (!authResult.authorized) {
				return unauthorizedResponse(authResult.error!);
			}

			const server = createServer(env, ctx);
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
	 * Scheduled handler for daily reflection and index hygiene.
	 *
	 * Triggered by the cron at 6am UTC. Awaits the reflection directly
	 * rather than using `ctx.waitUntil` — cron handlers already keep the
	 * invocation alive until the promise resolves, and awaiting surfaces
	 * rejections as actual scheduled-handler failures (visible in the
	 * Cloudflare dashboard) instead of being swallowed inside `then()`.
	 */
	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
		// Prune first. Reflection reads the index to decide what to consolidate,
		// so it should see the same index a user's search would — not one still
		// carrying vectors for archives that a denylist rule has since excluded.
		//
		// Isolated in its own try/catch: a prune failure is a hygiene problem,
		// not a reason to skip the day's reflection.
		const storage = createR2Storage(env.MEMORY_BUCKET);
		for (const scope of ["memory", "conversations"] as const) {
			try {
				const prune = await pruneIndex(env, storage, { scope });
				if (prune.pruned > 0) {
					console.log(
						`Pruned ${prune.pruned} ${scope} vectors (${prune.remaining} remain):`,
						prune.byReason,
					);
				}
			} catch (e) {
				console.error(`Index prune (${scope}) failed:`, e);
			}

			// Finish any re-embedding left over from the move to chunked
			// vectors. A no-op once every file is chunked.
			try {
				const reindex = await reindexLegacy(env, storage, { scope, limit: 100 });
				if (reindex.reindexed.length > 0 || reindex.failed.length > 0) {
					console.log(
						`Reindexed ${reindex.reindexed.length} ${scope} files, ${reindex.failed.length} failed, ${reindex.remaining} legacy remain`,
					);
				}
			} catch (e) {
				console.error(`Index reindex (${scope}) failed:`, e);
			}
		}

		const result = await runReflection(env);
		if (result.success) {
			console.log(`Reflection completed for ${result.date}: ${result.summary}`);
		} else {
			console.error(`Reflection failed for ${result.date}: ${result.error}`);
		}
	},
};
