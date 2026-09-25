import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { HISTORY_PREFIX, createR2Storage } from "../../src/storage/r2";

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
		// Snapshots are deliberately invisible to `storage.list`, so the raw
		// binding is the only way to sweep them. Without this, the retention
		// and "first write" tests inherit versions from earlier tests.
		const snapshots = await env.MEMORY_BUCKET.list({ prefix: `${HISTORY_PREFIX}test/` });
		for (const object of snapshots.objects) {
			await env.MEMORY_BUCKET.delete(object.key);
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

			// Non-recursive root list returns top-level entries — files at
			// depth > 0 appear as delimited prefixes (e.g. "test/") rather
			// than the full file path. Use recursive=true to walk the tree.
			const files = await storage.list();
			expect(files.some((f) => f.path === "test/")).toBe(true);

			const recursive = await storage.list("", true);
			expect(recursive.some((f) => f.path === "test/root-test.md")).toBe(true);
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

	describe("version history", () => {
		it("takes no snapshot when history is not requested", async () => {
			const path = "test/no-history.md";
			await storage.write(path, "one");
			await storage.write(path, "two");

			expect(await storage.getVersions(path)).toEqual([]);
		});

		it("takes no snapshot on the first write of a path", async () => {
			// Nothing was superseded. A version here would offer to restore a
			// file into existence from nothing.
			const result = await storage.write("test/first.md", "one", { history: true });

			expect(result.previous_version_id).toBeUndefined();
			expect(await storage.getVersions("test/first.md")).toEqual([]);
		});

		it("snapshots the superseded content and returns its version id", async () => {
			const path = "test/versioned.md";
			await storage.write(path, "Version 1", { history: true });
			const result = await storage.write(path, "Version 2", { history: true });

			expect(result.previous_version_id).toBeDefined();

			const versions = await storage.getVersions(path);
			expect(versions).toHaveLength(1);
			expect(versions[0]!.version_id).toBe(result.previous_version_id);
			expect(versions[0]!.size).toBe("Version 1".length);

			// The snapshot holds what was replaced, not what replaced it.
			expect(await storage.getVersion(path, result.previous_version_id!)).toBe("Version 1");
			expect((await storage.read(path))!.content).toBe("Version 2");
		});

		it("orders versions newest first", async () => {
			const path = "test/ordered.md";
			await storage.write(path, "v1", { history: true });
			await storage.write(path, "v2", { history: true });
			await storage.write(path, "v3", { history: true });

			const versions = await storage.getVersions(path);
			expect(versions).toHaveLength(2);
			// v2 was superseded most recently, so it comes first.
			expect(await storage.getVersion(path, versions[0]!.version_id)).toBe("v2");
			expect(await storage.getVersion(path, versions[1]!.version_id)).toBe("v1");
		});

		it("honours the limit", async () => {
			const path = "test/limited.md";
			for (let i = 0; i < 5; i++) {
				await storage.write(path, `v${i}`, { history: true });
			}
			expect(await storage.getVersions(path, 2)).toHaveLength(2);
		});

		it("trims the oldest snapshots beyond the retention limit", async () => {
			const path = "test/retained.md";
			const retain = 3;
			for (let i = 0; i < retain + 3; i++) {
				await storage.write(path, `v${i}`, { history: true, retain });
			}

			const versions = await storage.getVersions(path, 100);
			expect(versions).toHaveLength(retain);
			// The survivors are the newest: v2..v4 were superseded last.
			const contents = await Promise.all(
				versions.map((v) => storage.getVersion(path, v.version_id)),
			);
			expect(contents).toEqual(["v4", "v3", "v2"]);
		});

		it("keeps snapshots out of list output", async () => {
			const path = "test/hidden.md";
			await storage.write(path, "one", { history: true });
			await storage.write(path, "two", { history: true });
			expect(await storage.getVersions(path)).toHaveLength(1);

			// Neither the objects nor a synthetic `_history/` directory entry
			// may appear, at any depth, or the client sync mirrors them to
			// disk and the reflection scanner reads them.
			const everything = await storage.list("", true);
			expect(everything.some((f) => f.path.startsWith(HISTORY_PREFIX))).toBe(false);

			const root = await storage.list("", false);
			expect(root.some((f) => f.path.startsWith(HISTORY_PREFIX))).toBe(false);
		});

		it("never snapshots a snapshot", async () => {
			// Guards against unbounded `_history/_history/...` nesting if a
			// caller ever writes straight to a history path.
			const key = `${HISTORY_PREFIX}test/direct.md/whatever.snap`;
			await storage.write(key, "one", { history: true });
			await storage.write(key, "two", { history: true });

			expect(await storage.getVersions(key)).toEqual([]);
		});

		it("returns null for a version that does not exist", async () => {
			expect(await storage.getVersion("test/any.md", "nonexistent-version")).toBeNull();
		});
	});
});
