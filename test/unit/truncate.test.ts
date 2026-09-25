import { describe, expect, it } from "vitest";
import type { ReadWindow } from "../../src/truncate";
import {
	MAX_READ_LENGTH,
	TRUNCATION_MARKER,
	extractSnippet,
	readWindow,
	truncate,
} from "../../src/truncate";

describe("truncate", () => {
	it("should not truncate short content", () => {
		const content = "Hello, world!";
		const result = truncate(content);
		expect(result).toBe(content);
	});

	it("should truncate long content", () => {
		const content = "a".repeat(60000);
		const result = truncate(content);

		expect(result.length).toBeLessThan(60000);
		expect(result).toContain("[Content truncated...]");
	});

	it("should respect custom maxLength", () => {
		const content = "a".repeat(200);
		const result = truncate(content, { maxLength: 100 });

		expect(result.length).toBeLessThanOrEqual(100 + 25); // maxLength + suffix
	});

	it("should use custom suffix", () => {
		const content = "a".repeat(200);
		const result = truncate(content, { maxLength: 100, suffix: "..." });

		expect(result.endsWith("...")).toBe(true);
	});

	it("should try to truncate at newline", () => {
		const lines = ["Line 1", "Line 2", "Line 3", "Line 4", "Line 5"];
		const content = lines.join("\n").padEnd(200, "x");
		const result = truncate(content, { maxLength: 50 });

		// Should not cut in the middle of a line if possible
		expect(result).toMatch(/Line \d\n/);
	});

	it("should handle content with only newlines", () => {
		const content = "\n".repeat(100);
		const result = truncate(content, { maxLength: 50 });

		expect(result.length).toBeLessThanOrEqual(75);
	});

	it("should handle empty content", () => {
		const result = truncate("");
		expect(result).toBe("");
	});

	it("should handle content exactly at maxLength", () => {
		const content = "a".repeat(50000);
		const result = truncate(content, { maxLength: 50000 });
		expect(result).toBe(content);
	});
});

describe("extractSnippet", () => {
	it("should return full content if under maxLength", () => {
		const content = "Short content here";
		const result = extractSnippet(content);
		expect(result).toBe(content);
	});

	it("should extract snippet from beginning", () => {
		const content = "a".repeat(1000);
		const result = extractSnippet(content, { maxLength: 100, position: 0 });

		expect(result.length).toBeLessThanOrEqual(110); // Allow for ellipsis
		expect(result.startsWith("a")).toBe(true);
	});

	it("should extract snippet from middle", () => {
		const content = `START${"x".repeat(500)}MIDDLE${"y".repeat(500)}END`;
		const result = extractSnippet(content, {
			maxLength: 100,
			position: content.indexOf("MIDDLE"),
		});

		expect(result).toContain("MIDDLE");
	});

	it("should extract snippet from end", () => {
		const content = `${"a".repeat(900)}THE END`;
		const result = extractSnippet(content, {
			maxLength: 100,
			position: content.length - 5,
		});

		expect(result).toContain("THE END");
	});

	it("should add ellipsis for middle snippets", () => {
		const content = "word ".repeat(200);
		const result = extractSnippet(content, { maxLength: 100, position: 500 });

		expect(result.startsWith("...")).toBe(true);
		expect(result.endsWith("...")).toBe(true);
	});

	it("should not add leading ellipsis for start snippets", () => {
		const content = "word ".repeat(200);
		const result = extractSnippet(content, { maxLength: 100, position: 0 });

		expect(result.startsWith("...")).toBe(false);
	});

	it("should not add trailing ellipsis for end snippets", () => {
		const content = "word ".repeat(200);
		const result = extractSnippet(content, {
			maxLength: 100,
			position: content.length - 1,
		});

		expect(result.endsWith("...")).toBe(false);
	});

	it("should handle empty content", () => {
		const result = extractSnippet("");
		expect(result).toBe("");
	});

	it("should use default values", () => {
		const content = "a".repeat(1000);
		const result = extractSnippet(content);

		expect(result.length).toBeLessThanOrEqual(510); // 500 + ellipsis
	});
});

describe("readWindow", () => {
	it("returns the whole file untouched when it fits", () => {
		const content = "# Notes\nshort enough\n";
		const w = readWindow(content);

		expect(w.content).toBe(content);
		expect(w.truncated).toBe(false);
		expect(w.next_offset).toBeUndefined();
		expect(w.offset).toBe(0);
		expect(w.returned).toBe(content.length);
		expect(w.total_length).toBe(content.length);
	});

	it("caps an unpaged read and marks it in-band", () => {
		// The accident case: no paging arguments, file too long. The warning
		// has to be somewhere code that ignores metadata will still hit it.
		const content = "a".repeat(MAX_READ_LENGTH + 5000);
		const w = readWindow(content);

		expect(w.truncated).toBe(true);
		expect(w.content.endsWith(TRUNCATION_MARKER)).toBe(true);
		expect(w.returned).toBe(MAX_READ_LENGTH);
		expect(w.next_offset).toBe(MAX_READ_LENGTH);
		expect(w.total_length).toBe(content.length);
	});

	it("omits the marker when the caller is paging deliberately", () => {
		const content = "a".repeat(MAX_READ_LENGTH + 5000);
		const w = readWindow(content, { offset: 0, marker: false });

		expect(w.truncated).toBe(true);
		expect(w.content).not.toContain("[Content truncated");
		expect(w.content.length).toBe(w.returned);
	});

	it("reassembles a large file losslessly across windows", () => {
		// The whole point of the feature. A 78K-character file is the real
		// case: learnings.md could not be retrieved in full at all before.
		const content = Array.from({ length: 4000 }, (_, i) => `line ${i} of the file`).join("\n");
		expect(content.length).toBeGreaterThan(MAX_READ_LENGTH);

		let offset: number | undefined = 0;
		let assembled = "";
		let windows = 0;
		while (offset !== undefined) {
			const w: ReadWindow = readWindow(content, { offset, marker: false });
			assembled += w.content;
			offset = w.next_offset;
			windows++;
			expect(windows).toBeLessThan(50); // paging must terminate
		}

		expect(windows).toBeGreaterThan(1);
		expect(assembled).toBe(content);
	});

	it("reassembles losslessly with a small limit and no newlines", () => {
		// Degenerate input: one enormous line, so the newline-preferred cut
		// point never applies and every window is a hard cut.
		const content = "x".repeat(1000);
		let offset: number | undefined = 0;
		let assembled = "";
		while (offset !== undefined) {
			const w = readWindow(content, { offset, limit: 7, marker: false });
			expect(w.returned).toBeGreaterThan(0); // else paging never ends
			assembled += w.content;
			offset = w.next_offset;
		}
		expect(assembled).toBe(content);
	});

	it("prefers a newline cut point so windows do not split a line", () => {
		const content = `${"a".repeat(90)}\n${"b".repeat(90)}`;
		const w = readWindow(content, { limit: 100, marker: false });

		expect(w.content).toBe("a".repeat(90));
		expect(w.next_offset).toBe(90);
		// Resuming keeps the newline rather than dropping it.
		const rest = readWindow(content, { offset: w.next_offset, limit: 100, marker: false });
		expect(w.content + rest.content).toBe(content);
	});

	it("ignores a newline cut point that would waste most of the window", () => {
		// Newline at 10% of the budget: honouring it would return a sliver
		// and turn a two-call read into ten.
		const content = `${"a".repeat(10)}\n${"b".repeat(200)}`;
		const w = readWindow(content, { limit: 100, marker: false });

		expect(w.returned).toBe(100);
	});

	it("clamps an offset past the end to an empty tail", () => {
		// A file that shrank between paged calls should not error.
		const content = "abcdef";
		const w = readWindow(content, { offset: 999, marker: false });

		expect(w.content).toBe("");
		expect(w.offset).toBe(content.length);
		expect(w.truncated).toBe(false);
		expect(w.next_offset).toBeUndefined();
	});

	it("clamps hostile offset and limit values", () => {
		const content = "a".repeat(200);

		expect(readWindow(content, { offset: -50, marker: false }).offset).toBe(0);
		expect(readWindow(content, { limit: 0, marker: false }).returned).toBe(1);
		expect(readWindow(content, { limit: -10, marker: false }).returned).toBe(1);
		expect(readWindow(content, { offset: 1.9, limit: 10.9, marker: false }).offset).toBe(1);

		const huge = "a".repeat(MAX_READ_LENGTH + 100);
		// A caller cannot raise the cap and blow up the response.
		expect(readWindow(huge, { limit: 999_999, marker: false }).returned).toBe(MAX_READ_LENGTH);
	});

	it("reports the final window as complete, not truncated", () => {
		const content = "a".repeat(150);
		const w = readWindow(content, { offset: 100, limit: 100, marker: false });

		expect(w.returned).toBe(50);
		expect(w.truncated).toBe(false);
		expect(w.next_offset).toBeUndefined();
	});
});
