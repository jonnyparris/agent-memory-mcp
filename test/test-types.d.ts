/**
 * Type declarations for test environment
 */

// Cloudflare test module
declare module "cloudflare:test" {
	export const SELF: {
		fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
	};

	export const env: {
		MEMORY_BUCKET: R2Bucket;
		MEMORY_INDEX: DurableObjectNamespace;
		AI: Ai;
		MEMORY_AUTH_TOKEN: string;
	};
}
