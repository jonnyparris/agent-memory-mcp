import type { MemoryFileMetadata } from "./types";

export interface ExecuteMemoryApi {
	read: (path: string) => Promise<string | null>;
	list: (path?: string) => Promise<MemoryFileMetadata[]>;
}

export interface ExecuteResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

export interface ExecuteOptions {
	/**
	 * Maximum wall-clock time to wait for the code to complete, in milliseconds.
	 * The code runs in the Worker's isolate; there's no way to actually kill a
	 * runaway script, but this at least bounds how long we wait for a response
	 * before returning a timeout error. Default: 10 seconds.
	 */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Execute JavaScript code against memory contents.
 *
 * SECURITY MODEL
 * --------------
 * This is **not** a sandbox. The code runs inside `new Function(...)`, which
 * executes in the same V8 isolate as the Worker. That means user-supplied
 * code has access to:
 *
 *   - Global `fetch` (arbitrary network I/O, including egress to the internet)
 *   - Global `crypto` and other Web APIs
 *   - Any variable leaked onto `globalThis`
 *   - The `memory` object passed in (which talks to R2)
 *
 * What it does NOT have access to:
 *
 *   - Other bindings (AI, MEMORY_INDEX, MEMORY_AUTH_TOKEN) — these aren't
 *     exposed to the global scope in a Worker.
 *   - The Durable Object stub — not globally accessible.
 *   - Secrets set via `wrangler secret put` — those are on `env`, not globals.
 *
 * Guidance for operators:
 *
 *   1. Only deploy this MCP behind a trusted auth boundary. Never expose the
 *      `execute` tool to an unauthenticated endpoint.
 *   2. The Worker's own CPU limits (~50ms on free, 30s on paid) bound the
 *      worst-case runtime.
 *   3. If you're worried about network egress, use Cloudflare's outbound
 *      Worker Loader API (once it stabilises) for genuine isolation.
 *
 * The alternative — an actual sandbox — requires Worker Loader or a
 * separate isolate service, which is out of scope for this lightweight
 * memory server. The `execute` tool is convenience for the owner of the
 * deployment, not an untrusted-input boundary.
 */
export async function executeCode(
	code: string,
	memoryApi: ExecuteMemoryApi,
	options: ExecuteOptions = {},
): Promise<ExecuteResult> {
	const { timeoutMs = DEFAULT_TIMEOUT_MS } = options;

	try {
		// `new Function` is used so the code string can be an arrow-function
		// body referencing the local `memory` binding. See the SECURITY MODEL
		// note above — this is intentional trust, not an isolation boundary.
		const fn = new Function("memory", `return (async () => { ${code} })()`);

		// Race the user's code against a timer so a runaway script doesn't
		// hang the MCP request indefinitely. The promise the code returns
		// keeps running after timeout (we can't abort V8 mid-execution), but
		// the caller gets a response.
		const result = await Promise.race([
			fn(memoryApi),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error(`execute timed out after ${timeoutMs}ms`)), timeoutMs),
			),
		]);

		return {
			content: [{ type: "text", text: JSON.stringify({ result }) }],
		};
	} catch (e) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						error: "Execution failed",
						details: e instanceof Error ? e.message : String(e),
					}),
				},
			],
			isError: true,
		};
	}
}
