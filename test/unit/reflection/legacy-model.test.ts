import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockStorage } from "../../mocks/storage";

const mocks = vi.hoisted(() => ({
	storage: undefined as ReturnType<typeof createMockStorage> | undefined,
}));

vi.mock("../../../src/search/index-write", () => ({
	indexWrite: vi.fn(async () => ({ success: true, tags: [], links: [] })),
}));

vi.mock("../../../src/storage/r2", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../../src/storage/r2")>();
	return {
		...original,
		createR2Storage: () => mocks.storage,
	};
});

import { REFLECTION_MODELS } from "../../../src/llm/workers-ai";
import { runReflection } from "../../../src/reflection";

describe("legacy reflection model", () => {
	let run: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mocks.storage = createMockStorage();
		run = vi.fn().mockResolvedValue({ response: "## Summary\nNothing to do." });
	});

	const env = (extra: Record<string, unknown> = {}) =>
		({
			MEMORY_BUCKET: {},
			MEMORY_INDEX: {},
			AI: { run },
			MEMORY_AUTH_TOKEN: "t",
			USE_AGENTIC_REFLECTION: "false",
			...extra,
		}) as never;

	it("uses REFLECTION_MODEL when set", async () => {
		await runReflection(env({ REFLECTION_MODEL: "@cf/test/legacy-model" }));
		expect(run).toHaveBeenCalledWith("@cf/test/legacy-model", expect.anything());
	});

	it("falls back to REFLECTION_MODELS.primary, not a removed model", async () => {
		await runReflection(env());
		expect(run).toHaveBeenCalledWith(REFLECTION_MODELS.primary, expect.anything());
		expect(REFLECTION_MODELS.primary).toBe("@cf/deepseek-ai/deepseek-v4.1-flash-1017");
	});
});
