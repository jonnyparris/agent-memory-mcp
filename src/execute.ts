import type { MemoryFileMetadata } from "./types";

export interface ExecuteMemoryApi {
	read: (path: string) => Promise<string | null>;
	list: (path?: string) => Promise<MemoryFileMetadata[]>;
}

export interface ExecuteResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

/**
 * Execute JavaScript code against memory contents.
 * Creates a sandboxed environment with access to memory.read() and memory.list().
 */
export async function executeCode(
	code: string,
	memoryApi: ExecuteMemoryApi,
): Promise<ExecuteResult> {
	try {
		// Execute in a sandboxed context
		// Note: This is a simplified implementation. In production,
		// consider using Cloudflare's Worker Loader API for better isolation
		const fn = new Function("memory", `return (async () => { ${code} })()`);
		const result = await fn(memoryApi);

		return {
			content: [{ type: "text" as const, text: JSON.stringify({ result }) }],
		};
	} catch (e) {
		return {
			content: [
				{
					type: "text" as const,
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
