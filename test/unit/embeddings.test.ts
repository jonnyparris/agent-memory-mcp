import { describe, expect, it } from "vitest";
import {
	EMBEDDING_DIMENSIONS,
	generateEmbedding,
	generateEmbeddings,
} from "../../src/search/embeddings";
import { createMockAI, mockEmbedding } from "../mocks/workers-ai";

describe("generateEmbedding", () => {
	it("should return vector with correct dimensions", async () => {
		const ai = createMockAI() as unknown as Ai;
		const result = await generateEmbedding(ai, "test input");

		expect(result.vector).toHaveLength(EMBEDDING_DIMENSIONS);
		expect(result.dimensions).toBe(EMBEDDING_DIMENSIONS);
	});

	it("should return normalized vectors (unit length)", async () => {
		const ai = createMockAI() as unknown as Ai;
		const result = await generateEmbedding(ai, "test input");

		// Calculate magnitude - should be ~1 for normalized vector
		const magnitude = Math.sqrt(result.vector.reduce((sum, val) => sum + val * val, 0));
		expect(magnitude).toBeCloseTo(1, 5);
	});

	it("should return deterministic embeddings for same input", async () => {
		const ai = createMockAI() as unknown as Ai;
		const result1 = await generateEmbedding(ai, "same text");
		const result2 = await generateEmbedding(ai, "same text");

		expect(result1.vector).toEqual(result2.vector);
	});

	it("should return different embeddings for different inputs", async () => {
		const ai = createMockAI() as unknown as Ai;
		const result1 = await generateEmbedding(ai, "first text");
		const result2 = await generateEmbedding(ai, "second text");

		expect(result1.vector).not.toEqual(result2.vector);
	});

	it("should handle empty text", async () => {
		const ai = createMockAI() as unknown as Ai;
		const result = await generateEmbedding(ai, "");

		expect(result.vector).toHaveLength(EMBEDDING_DIMENSIONS);
		expect(result.dimensions).toBe(EMBEDDING_DIMENSIONS);
		// Empty string should still produce valid vector values
		expect(result.vector.every((v) => typeof v === "number" && !Number.isNaN(v))).toBe(true);
	});

	it("should handle whitespace-only text", async () => {
		const ai = createMockAI() as unknown as Ai;
		const result = await generateEmbedding(ai, "   \n\t  ");

		expect(result.vector).toHaveLength(EMBEDDING_DIMENSIONS);
		expect(result.vector.every((v) => typeof v === "number" && !Number.isNaN(v))).toBe(true);
	});

	it("should truncate very long text to the 8000-character query budget", async () => {
		let capturedText = "";
		const mockAI = {
			run: async (_model: string, inputs: { text: string }) => {
				capturedText = inputs.text;
				return { data: [{ embedding: mockEmbedding(inputs.text) }] };
			},
		};

		const longText = "a".repeat(50000);
		await generateEmbedding(mockAI as unknown as Ai, longText);

		expect(capturedText.length).toBe(8000);
	});

	it("should not truncate text under the embed budget", async () => {
		let capturedText = "";
		const mockAI = {
			run: async (_model: string, inputs: { text: string }) => {
				capturedText = inputs.text;
				return { data: [{ embedding: mockEmbedding(inputs.text) }] };
			},
		};

		const shortText = "a".repeat(1000);
		await generateEmbedding(mockAI as unknown as Ai, shortText);

		expect(capturedText.length).toBe(1000);
	});

	// A character budget only approximates the tokeniser. brag-sheet.md fit
	// the old 32000-character cap and still tokenised to 8908 against a
	// 8192-token model limit, so the write reported success while the file
	// kept a stale vector.
	it("should back off and retry when the model rejects the input as too long", async () => {
		const attempts: number[] = [];
		const mockAI = {
			run: async (_model: string, inputs: { text: string }) => {
				attempts.push(inputs.text.length);
				if (attempts.length === 1) {
					throw new Error("3030: Sequence too long: 8908 > 8192");
				}
				return { data: [{ embedding: mockEmbedding(inputs.text) }] };
			},
		};

		const result = await generateEmbedding(mockAI as unknown as Ai, "a".repeat(40000));

		expect(attempts).toEqual([8000, 4000]);
		expect(result.vector.length).toBeGreaterThan(0);
	});

	it("should give up after repeated length rejections", async () => {
		let calls = 0;
		const mockAI = {
			run: async () => {
				calls++;
				throw new Error("3030: Sequence too long: 9000 > 8192");
			},
		};

		await expect(generateEmbedding(mockAI as unknown as Ai, "a".repeat(40000))).rejects.toThrow(
			/Sequence too long/,
		);
		expect(calls).toBe(3);
	});

	it("should not retry errors unrelated to input length", async () => {
		let calls = 0;
		const mockAI = {
			run: async () => {
				calls++;
				throw new Error("5000: Internal error");
			},
		};

		await expect(generateEmbedding(mockAI as unknown as Ai, "hello")).rejects.toThrow(
			/Internal error/,
		);
		expect(calls).toBe(1);
	});

	it("should handle text exactly at truncation limit", async () => {
		let capturedText = "";
		const mockAI = {
			run: async (_model: string, inputs: { text: string }) => {
				capturedText = inputs.text;
				return { data: [{ embedding: mockEmbedding(inputs.text) }] };
			},
		};

		const exactText = "a".repeat(8000);
		await generateEmbedding(mockAI as unknown as Ai, exactText);

		expect(capturedText.length).toBe(8000);
	});
});

describe("generateEmbeddings", () => {
	it("should generate embeddings for multiple texts", async () => {
		const ai = createMockAI() as unknown as Ai;
		const texts = ["first", "second", "third"];
		const results = await generateEmbeddings(ai, texts);

		expect(results).toHaveLength(3);
		for (const result of results) {
			expect(result.vector).toHaveLength(EMBEDDING_DIMENSIONS);
			expect(result.dimensions).toBe(EMBEDDING_DIMENSIONS);
		}
	});

	it("should handle empty array", async () => {
		const ai = createMockAI() as unknown as Ai;
		const results = await generateEmbeddings(ai, []);

		expect(results).toHaveLength(0);
	});

	it("should handle single item array", async () => {
		const ai = createMockAI() as unknown as Ai;
		const results = await generateEmbeddings(ai, ["only one"]);

		expect(results).toHaveLength(1);
		expect(results[0].vector).toHaveLength(EMBEDDING_DIMENSIONS);
	});

	it("should send texts to the model in batches of 20", async () => {
		const batchSizes: number[] = [];
		const mockAI = {
			run: async (_model: string, inputs: { text: string | string[] }) => {
				const texts = Array.isArray(inputs.text) ? inputs.text : [inputs.text];
				batchSizes.push(texts.length);
				return { data: texts.map((t) => mockEmbedding(t)) };
			},
		};

		const texts = Array.from({ length: 45 }, (_, i) => `text ${i}`);
		const results = await generateEmbeddings(mockAI as unknown as Ai, texts);

		expect(batchSizes).toEqual([20, 20, 5]);
		expect(results).toHaveLength(45);
	});

	it("should fall back to one text at a time when a batch is too long", async () => {
		const calls: Array<string | string[]> = [];
		const mockAI = {
			run: async (_model: string, inputs: { text: string | string[] }) => {
				calls.push(inputs.text);
				if (Array.isArray(inputs.text)) throw new Error("3030: Sequence too long");
				return { data: [mockEmbedding(inputs.text)] };
			},
		};

		const results = await generateEmbeddings(mockAI as unknown as Ai, ["a", "b"]);

		expect(results).toHaveLength(2);
		expect(calls).toEqual([["a", "b"], "a", "b"]);
	});

	it("should throw non-length errors instead of storing a partial set", async () => {
		const mockAI = {
			run: async () => {
				throw new Error("5000: Internal error");
			},
		};
		await expect(generateEmbeddings(mockAI as unknown as Ai, ["a"])).rejects.toThrow(/Internal/);
	});

	it("should maintain order of results", async () => {
		const ai = createMockAI() as unknown as Ai;
		const texts = ["alpha", "beta", "gamma"];
		const results = await generateEmbeddings(ai, texts);

		// Each result should match the single embedding for that text
		for (let i = 0; i < texts.length; i++) {
			const singleResult = await generateEmbedding(ai, texts[i]);
			expect(results[i].vector).toEqual(singleResult.vector);
		}
	});

	it("should handle large batch correctly", async () => {
		const ai = createMockAI() as unknown as Ai;
		const texts = Array.from({ length: 50 }, (_, i) => `item ${i}`);
		const results = await generateEmbeddings(ai, texts);

		expect(results).toHaveLength(50);
		results.forEach((result, i) => {
			expect(result.vector).toHaveLength(EMBEDDING_DIMENSIONS);
			// Verify each embedding is unique
			if (i > 0) {
				expect(result.vector).not.toEqual(results[i - 1].vector);
			}
		});
	});
});

describe("EMBEDDING_DIMENSIONS", () => {
	it("should be 1024", () => {
		expect(EMBEDDING_DIMENSIONS).toBe(1024);
	});
});
