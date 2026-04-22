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
				miniflare: {
					compatibilityDate: "2025-01-29",
					compatibilityFlags: ["nodejs_compat"],
					// Test-time auth token — integration tests read this via
					// `env.MEMORY_AUTH_TOKEN` to build the Bearer header.
					bindings: {
						MEMORY_AUTH_TOKEN: "test-token",
					},
					r2Buckets: ["MEMORY_BUCKET"],
					// Wire the DO as a SQLite-backed class (matches the
					// `new_sqlite_classes` migration in wrangler.jsonc) so
					// the DO's `ensureReady` can run `ctx.storage.sql.exec`
					// without blowing up with "SQL is not enabled".
					durableObjects: {
						MEMORY_INDEX: {
							className: "MemoryIndex",
							useSQLite: true,
						},
					},
				},
				// Point the pool at the Worker entry — the pool handles TS
				// transpilation itself, so a plain `.ts` path is fine.
				main: "./src/index.ts",
				wrangler: {
					configPath: "./wrangler.jsonc",
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
