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

	/**
	 * Run a closure inside a Durable Object's own context, with access to the
	 * live instance and its `DurableObjectState`.
	 *
	 * This is the supported way to manipulate DO storage from a test —
	 * driving the same operations across JSRPC from outside trips the pool's
	 * isolated-storage teardown ("unable to pop Durable Objects storage").
	 *
	 * `instance` is generic rather than inferred from the stub because `env`
	 * above declares `MEMORY_INDEX` as a bare `DurableObjectNamespace`, so
	 * there is no class type to propagate. Callers annotate it at the call
	 * site. Replacing this hand-written module declaration with
	 * `@cloudflare/vitest-pool-workers/types` would give real inference; it's
	 * left alone here to avoid a broad retyping of the existing suite.
	 */
	export function runInDurableObject<T, R>(
		stub: DurableObjectStub,
		closure: (instance: T, state: DurableObjectState) => R | Promise<R>,
	): Promise<R>;
}
