import { defineConfig } from "vitest/config";

/**
 * E2E config — runs `test/e2e/` against a deployed worker over the network.
 *
 * Kept separate from `vitest.config.ts` because the default suite excludes
 * `test/e2e/**` (so `npm test` never hits the network), and that exclude
 * also filters out the explicit `vitest run test/e2e` path filter — vitest
 * then exits 1 with "No test files found". E2E also doesn't need the
 * Workers pool: it's plain `fetch` from Node with `process.env` config.
 *
 * Run with:
 *   MEMORY_MCP_URL=https://your-worker.workers.dev MEMORY_AUTH_TOKEN=xxx npm run test:e2e
 * Without both env vars the suite is skipped (exit 0).
 */
export default defineConfig({
	test: {
		include: ["test/e2e/**/*.test.ts"],
		environment: "node",
		testTimeout: 30_000,
	},
});
