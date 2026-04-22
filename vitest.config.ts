import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * Vitest configuration.
 *
 * The `@cloudflare/vitest-pool-workers` pool is what makes the
 * `cloudflare:test` module available — integration tests use it to drive
 * the Worker via `SELF.fetch(...)` and to reach `env.*` bindings. The pool
 * also handles TypeScript transpilation for the SUT so we don't need to
 * pre-compile `src/index.ts`.
 *
 * Unit tests run in the same pool. They don't need the Worker runtime but
 * using one pool config keeps the surface area small.
 *
 * Note: bindings are declared here explicitly rather than via
 * `wrangler.configPath`, because reading wrangler.jsonc would also pull in
 * the `ai` binding, which the pool treats as remote — that fails in CI
 * without a Cloudflare API token. The AI binding is stubbed below so unit
 * tests that indirectly touch it (via embedding generation in `update`)
 * don't hit the network.
 */
export default defineWorkersConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// E2E tests hit a deployed worker over the network and should be
		// invoked explicitly, not in the default suite.
		exclude: ["test/e2e/**", "node_modules/**"],
		poolOptions: {
			workers: {
				singleWorker: true,
				main: "./src/index.ts",
				miniflare: {
					compatibilityDate: "2025-01-29",
					compatibilityFlags: ["nodejs_compat"],
					// Test-time auth token — integration tests read this via
					// `env.MEMORY_AUTH_TOKEN` to build the Bearer header.
					bindings: {
						MEMORY_AUTH_TOKEN: "test-token",
					},
					r2Buckets: ["MEMORY_BUCKET"],
					// SQLite-backed DO (matches the `new_sqlite_classes`
					// migration in wrangler.jsonc).
					durableObjects: {
						MEMORY_INDEX: {
							className: "MemoryIndex",
							useSQLite: true,
						},
					},
					// The `AI` binding deliberately isn't wired up here. Unit
					// tests don't reach real AI calls (storage and DO are
					// mocked). Integration tests that do exercise write +
					// search paths currently don't assert on embedding
					// content — they just verify the DO accepts the call.
					// If an integration test starts failing on AI, it means
					// it's asserting something that needs a real embedding,
					// and we should mock it at the test level.
				},
			},
		},
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			include: ["src/**/*.ts"],
			exclude: ["src/types.ts"],
		},
	},
});
