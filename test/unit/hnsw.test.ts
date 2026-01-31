import { describe, expect, it } from "vitest";
import { HNSWIndex } from "../../src/search/hnsw";

describe("HNSWIndex", () => {
	describe("basic operations", () => {
		it("should create an empty index", () => {
			const index = new HNSWIndex(4);
			expect(index.size()).toBe(0);
		});

		it("should insert a single vector", () => {
			const index = new HNSWIndex(4);
			index.insert("doc1", [1.0, 0.0, 0.0, 0.0]);
			expect(index.size()).toBe(1);
		});

		it("should throw on dimension mismatch", () => {
			const index = new HNSWIndex(4);
			expect(() => index.insert("doc1", [1.0, 0.0, 0.0])).toThrow("Vector dimension mismatch");
		});
	});

	describe("search", () => {
		it("should handle empty index", () => {
			const index = new HNSWIndex(4);
			const results = index.search([1.0, 0.0, 0.0, 0.0], 5);
			expect(results).toEqual([]);
		});

		it("should find exact match", () => {
			const index = new HNSWIndex(4);
			index.insert("doc1", [1.0, 0.0, 0.0, 0.0]);
			index.insert("doc2", [0.0, 1.0, 0.0, 0.0]);

			const results = index.search([1.0, 0.0, 0.0, 0.0], 1);

			expect(results.length).toBe(1);
			expect(results[0].id).toBe("doc1");
			expect(results[0].score).toBeCloseTo(1.0, 5);
		});

		it("should find nearest neighbor", () => {
			const index = new HNSWIndex(4);

			index.insert("doc1", [1.0, 0.0, 0.0, 0.0]);
			index.insert("doc2", [0.0, 1.0, 0.0, 0.0]);
			index.insert("doc3", [0.9, 0.1, 0.0, 0.0]); // closest to doc1

			const results = index.search([1.0, 0.0, 0.0, 0.0], 2);

			expect(results.length).toBe(2);
			expect(results[0].id).toBe("doc1");
			expect(results[1].id).toBe("doc3");
		});

		it("should respect limit parameter", () => {
			const index = new HNSWIndex(4);

			for (let i = 0; i < 10; i++) {
				const vec = [0, 0, 0, 0];
				vec[i % 4] = 1;
				index.insert(`doc${i}`, vec);
			}

			const results = index.search([1.0, 0.0, 0.0, 0.0], 3);
			expect(results.length).toBe(3);
		});

		it("should return scores in descending order", () => {
			const index = new HNSWIndex(4);

			index.insert("doc1", [1.0, 0.0, 0.0, 0.0]);
			index.insert("doc2", [0.8, 0.2, 0.0, 0.0]);
			index.insert("doc3", [0.5, 0.5, 0.0, 0.0]);
			index.insert("doc4", [0.0, 1.0, 0.0, 0.0]);

			const results = index.search([1.0, 0.0, 0.0, 0.0], 4);

			for (let i = 0; i < results.length - 1; i++) {
				expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
			}
		});
	});

	describe("delete", () => {
		it("should delete existing node", () => {
			const index = new HNSWIndex(4);
			index.insert("doc1", [1.0, 0.0, 0.0, 0.0]);
			index.insert("doc2", [0.0, 1.0, 0.0, 0.0]);

			expect(index.delete("doc1")).toBe(true);
			expect(index.size()).toBe(1);

			const results = index.search([1.0, 0.0, 0.0, 0.0], 5);
			expect(results.every((r) => r.id !== "doc1")).toBe(true);
		});

		it("should return false for non-existent node", () => {
			const index = new HNSWIndex(4);
			expect(index.delete("nonexistent")).toBe(false);
		});

		it("should handle deleting entry point", () => {
			const index = new HNSWIndex(4);
			index.insert("doc1", [1.0, 0.0, 0.0, 0.0]);
			index.insert("doc2", [0.0, 1.0, 0.0, 0.0]);

			// doc1 might be entry point (first inserted)
			index.delete("doc1");

			// Should still be able to search
			const results = index.search([0.0, 1.0, 0.0, 0.0], 1);
			expect(results.length).toBe(1);
			expect(results[0].id).toBe("doc2");
		});
	});

	describe("serialization", () => {
		it("should serialize and deserialize empty index", () => {
			const index = new HNSWIndex(4);
			const serialized = index.serialize();
			const restored = HNSWIndex.deserialize(serialized);

			expect(restored.size()).toBe(0);
		});

		it("should serialize and deserialize with data", () => {
			const index = new HNSWIndex(4);
			index.insert("doc1", [1.0, 0.0, 0.0, 0.0]);
			index.insert("doc2", [0.0, 1.0, 0.0, 0.0]);
			index.insert("doc3", [0.5, 0.5, 0.0, 0.0]);

			const serialized = index.serialize();
			const restored = HNSWIndex.deserialize(serialized);

			expect(restored.size()).toBe(3);

			// Search should work on restored index
			const results = restored.search([1.0, 0.0, 0.0, 0.0], 1);
			expect(results[0].id).toBe("doc1");
		});
	});

	describe("edge cases", () => {
		it("should handle single item index", () => {
			const index = new HNSWIndex(4);
			index.insert("only", [0.5, 0.5, 0.0, 0.0]);

			const results = index.search([1.0, 0.0, 0.0, 0.0], 5);
			expect(results.length).toBe(1);
			expect(results[0].id).toBe("only");
		});

		it("should handle duplicate inserts with same id", () => {
			const index = new HNSWIndex(4);
			index.insert("doc1", [1.0, 0.0, 0.0, 0.0]);
			index.insert("doc1", [0.0, 1.0, 0.0, 0.0]); // Same id, different vector

			// Should have replaced the old entry
			expect(index.size()).toBe(1);
		});

		it("should handle high-dimensional vectors", () => {
			const dims = 1024;
			const index = new HNSWIndex(dims);

			const vec1 = new Array(dims).fill(0);
			vec1[0] = 1;
			const vec2 = new Array(dims).fill(0);
			vec2[1] = 1;

			index.insert("doc1", vec1);
			index.insert("doc2", vec2);

			const results = index.search(vec1, 1);
			expect(results[0].id).toBe("doc1");
		});

		it("should handle many insertions", () => {
			const index = new HNSWIndex(4);

			// Insert 100 vectors
			for (let i = 0; i < 100; i++) {
				const angle = (i / 100) * Math.PI * 2;
				index.insert(`doc${i}`, [Math.cos(angle), Math.sin(angle), 0, 0]);
			}

			expect(index.size()).toBe(100);

			// Search should still work
			const results = index.search([1.0, 0.0, 0.0, 0.0], 5);
			expect(results.length).toBe(5);
		});
	});
});
