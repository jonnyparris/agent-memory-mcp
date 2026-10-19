import { describe, expect, it } from "vitest";
import { CHUNK_CHARS, chunkText } from "../../src/search/chunking";
import { bestMatchPosition, chunkStart, searchSnippet } from "../../src/search/snippet";

const filler = "General notes about planning and process. ".repeat(800); // ~34k chars

describe("chunkStart", () => {
	it("matches the offsets chunkText uses", () => {
		const text = "abcdefghij".repeat(1000);
		chunkText(text).forEach((piece, i) => {
			expect(text.slice(chunkStart(i), chunkStart(i) + CHUNK_CHARS)).toBe(piece);
		});
	});
});

describe("searchSnippet", () => {
	const content = `# Active todos\n${filler}The incident was tracked as PAY-4821 in the end.\n${filler}`;
	const hitAt = content.indexOf("PAY-4821");
	const hitChunk = chunkText(content).findIndex((c) => c.includes("PAY-4821"));

	it("shows the matching chunk, not the file opening", () => {
		expect(hitAt).toBeGreaterThan(30_000);
		const s = searchSnippet(content, "PAY-4821", hitChunk);
		expect(s).toContain("PAY-4821");
		expect(s).not.toContain("# Active todos");
		expect(s.length).toBeLessThanOrEqual(510);
	});

	it("finds the term across the whole file when no chunk is given", () => {
		expect(searchSnippet(content, "pay 4821")).toContain("PAY-4821");
	});

	it("centres on the chunk middle when no query term is in it", () => {
		// Numbered lines, so every slice of the text is unique and locatable.
		const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} of the log`).join("\n");
		const chunk = 10;
		const s = searchSnippet(lines, "unrelated semantic query", chunk);
		const at = lines.indexOf(s.replace(/^\.\.\./, "").replace(/\.\.\.$/, ""));
		const mid = chunkStart(chunk) + CHUNK_CHARS / 2;
		expect(at).toBeGreaterThan(mid - 300);
		expect(at).toBeLessThan(mid);
	});

	it("falls back to the opening with no chunk and no term", () => {
		expect(searchSnippet(content, "zzzz").startsWith("# Active todos")).toBe(true);
	});

	it("clamps a chunk index past the end of a file that has shrunk", () => {
		expect(searchSnippet("short file", "query", 40)).toBe("short file");
	});
});

describe("bestMatchPosition", () => {
	it("prefers the spot where the most query terms cluster", () => {
		const text = `deploy once here. ${"x ".repeat(400)}deploy rollback failed on canary`;
		const pos = bestMatchPosition(text, "canary deploy rollback");
		expect(text.slice(pos ?? 0)).toMatch(/^deploy rollback/);
	});

	it("ignores stopwords and short words", () => {
		expect(bestMatchPosition("the a of and to", "the a to")).toBeNull();
	});

	it("treats regex characters in the query literally", () => {
		expect(bestMatchPosition("cost is $5 (approx)", "(approx")).toBe(12);
	});
});
