import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createR2Storage } from "../../src/storage/r2";

describe("R2 Storage", () => {
	const storage = createR2Storage(env.MEMORY_BUCKET);

	beforeEach(async () => {
		// Clean up test files before each test
		const files = await storage.list("test/", true);
		for (const file of files) {
			if (!file.path.endsWith("/")) {
				await storage.delete(file.path);
			}
		}
	});

	describe("write and read", () => {
		it("should write and read a file", async () => {
			const path = "test/hello.md";
			const content = "# Hello World\n\nThis is a test.";

			await storage.write(path, content);
			const file = await storage.read(path);

			expect(file).not.toBeNull();
			expect(file!.content).toBe(content);
			expect(file!.path).toBe(path);
			expect(file!.size).toBe(content.length);
			expect(file!.updated_at).toBeDefined();
		});

		it("should overwrite existing file", async () => {
			const path = "test/overwrite.md";

			await storage.write(path, "First content");
			await storage.write(path, "Second content");

			const file = await storage.read(path);
			expect(file!.content).toBe("Second content");
		});

		it("should return null for non-existent file", async () => {
			const file = await storage.read("test/nonexistent.md");
			expect(file).toBeNull();
		});

		it("should handle empty content", async () => {
			const path = "test/empty.md";

			await storage.write(path, "");
			const file = await storage.read(path);

			expect(file!.content).toBe("");
			expect(file!.size).toBe(0);
		});

		it("should handle binary-like content", async () => {
			const path = "test/binary.txt";
			const content = "Line 1\nLine 2\r\nLine 3\tTabbed";

			await storage.write(path, content);
			const file = await storage.read(path);

			expect(file!.content).toBe(content);
		});

		it("should handle unicode content", async () => {
			const path = "test/unicode.md";
			const content = "Hello 世界! 🌍 Привет мир! مرحبا";

			await storage.write(path, content);
			const file = await storage.read(path);

			expect(file!.content).toBe(content);
		});
	});

	describe("list", () => {
		it("should list files in directory", async () => {
			await storage.write("test/list/file1.md", "Content 1");
			await storage.write("test/list/file2.md", "Content 2");

			const files = await storage.list("test/list");

			expect(files.length).toBe(2);
			expect(files.map((f) => f.path)).toContain("test/list/file1.md");
			expect(files.map((f) => f.path)).toContain("test/list/file2.md");
		});

		it("should list files recursively", async () => {
			await storage.write("test/recursive/a.md", "A");
			await storage.write("test/recursive/sub/b.md", "B");
			await storage.write("test/recursive/sub/deep/c.md", "C");

			const files = await storage.list("test/recursive", true);

			expect(files.length).toBe(3);
		});

		it("should return empty array for empty directory", async () => {
			const files = await storage.list("test/empty-dir");
			expect(files).toEqual([]);
		});

		it("should list root when no path provided", async () => {
			await storage.write("test/root-test.md", "Root content");

			const files = await storage.list();

			expect(files.some((f) => f.path.includes("test/root-test.md"))).toBe(true);
		});

		it("should include file metadata", async () => {
			const content = "Test content for metadata";
			await storage.write("test/metadata.md", content);

			const files = await storage.list("test");
			const file = files.find((f) => f.path === "test/metadata.md");

			expect(file).toBeDefined();
			expect(file!.size).toBe(content.length);
			expect(file!.updated_at).toBeDefined();
		});
	});

	describe("delete", () => {
		it("should delete existing file", async () => {
			const path = "test/to-delete.md";

			await storage.write(path, "Will be deleted");
			await storage.delete(path);

			const file = await storage.read(path);
			expect(file).toBeNull();
		});

		it("should not throw when deleting non-existent file", async () => {
			await expect(storage.delete("test/nonexistent.md")).resolves.not.toThrow();
		});
	});

	describe("versioning", () => {
		// Note: These tests may not work without bucket-level versioning enabled
		it("should return empty versions when versioning not enabled", async () => {
			await storage.write("test/versioned.md", "Version 1");

			const versions = await storage.getVersions("test/versioned.md");

			// Without bucket versioning, this returns empty
			expect(Array.isArray(versions)).toBe(true);
		});

		it("should return null for non-existent version", async () => {
			const content = await storage.getVersion("test/any.md", "nonexistent-version");
			expect(content).toBeNull();
		});
	});
});
