import { describe, expect, it } from "vitest";
import { parseTags } from "../../src/tags";

describe("parseTags", () => {
	it("returns an empty array when content is empty", () => {
		expect(parseTags("")).toEqual([]);
	});

	it("returns an empty array when there is no frontmatter", () => {
		expect(parseTags("Just a plain note with no frontmatter.")).toEqual([]);
	});

	it("returns an empty array when frontmatter has no tags key", () => {
		const content = "---\ntitle: Foo\ndate: 2026-01-01\n---\n\nBody";
		expect(parseTags(content)).toEqual([]);
	});

	it("parses inline array syntax: tags: [a, b, c]", () => {
		const content = "---\ntags: [alpha, beta, gamma]\n---\n\nBody";
		expect(parseTags(content)).toEqual(["alpha", "beta", "gamma"]);
	});

	it("parses block list syntax", () => {
		const content = ["---", "tags:", "  - alpha", "  - beta", "  - gamma", "---", "", "Body"].join(
			"\n",
		);
		expect(parseTags(content)).toEqual(["alpha", "beta", "gamma"]);
	});

	it("parses a single scalar tag", () => {
		const content = "---\ntags: solo\n---\n\nBody";
		expect(parseTags(content)).toEqual(["solo"]);
	});

	it("lowercases tags for stable indexing", () => {
		const content = "---\ntags: [FooBar, BAZ]\n---\n\nBody";
		expect(parseTags(content)).toEqual(["foobar", "baz"]);
	});

	it("strips leading # from Obsidian-style tags", () => {
		const content = "---\ntags: ['#alpha', '#beta']\n---\n\nBody";
		expect(parseTags(content)).toEqual(["alpha", "beta"]);
	});

	it("strips surrounding quotes around values", () => {
		const content = `---\ntags: ["quoted", 'single']\n---\n\nBody`;
		expect(parseTags(content)).toEqual(["quoted", "single"]);
	});

	it("deduplicates tags, preserving first occurrence order", () => {
		const content = "---\ntags: [alpha, BETA, alpha, Beta, gamma]\n---\n\nBody";
		expect(parseTags(content)).toEqual(["alpha", "beta", "gamma"]);
	});

	it("ignores frontmatter fields after tags: in a block list", () => {
		const content = [
			"---",
			"title: Foo",
			"tags:",
			"  - alpha",
			"  - beta",
			"date: 2026-01-01",
			"---",
			"",
			"Body",
		].join("\n");
		expect(parseTags(content)).toEqual(["alpha", "beta"]);
	});

	it("handles CRLF line endings", () => {
		const content = "---\r\ntags: [alpha, beta]\r\n---\r\n\r\nBody";
		expect(parseTags(content)).toEqual(["alpha", "beta"]);
	});

	it("returns empty for an empty inline array", () => {
		const content = "---\ntags: []\n---\n\nBody";
		expect(parseTags(content)).toEqual([]);
	});

	it("tolerates empty list items by skipping them", () => {
		const content = ["---", "tags:", "  - alpha", "  - ", "  - beta", "---", "", "Body"].join("\n");
		expect(parseTags(content)).toEqual(["alpha", "beta"]);
	});

	it("does not treat frontmatter-like content mid-file as frontmatter", () => {
		const content = ["# Heading", "", "---", "tags: [nope]", "---", "", "Body"].join("\n");
		expect(parseTags(content)).toEqual([]);
	});

	it("handles frontmatter at the very end of the file (no body)", () => {
		const content = "---\ntags: [alpha]\n---";
		expect(parseTags(content)).toEqual(["alpha"]);
	});
});

/**
 * The bare comma-separated scalar is the style every file in our own memory
 * corpus uses (`tags: brapi, projects`). It used to land in the single-scalar
 * branch and be stored verbatim, so `list_tags` reported one 14-element
 * mega-tag and `search({ tags: ["core"] })` matched nothing.
 */
describe("parseTags - comma-separated scalar", () => {
	it("splits a bare comma-separated list", () => {
		expect(parseTags("---\ntags: brapi, projects\n---\n\nbody")).toEqual(["brapi", "projects"]);
	});

	it("splits the long real-world conversations header", () => {
		const content =
			"---\ntags: conversations, core, cdnjs, brapi, zaraz, clopy, workers-cache, cachew, clickhouse, grafana, prometheus, jira, gitlab, mcp\n---\n\nbody";
		const tags = parseTags(content);

		expect(tags).toHaveLength(14);
		expect(tags).toContain("core");
		expect(tags).toContain("conversations");
		expect(tags).toContain("mcp");
		// The whole thing must no longer survive as one tag.
		expect(tags.some((t) => t.includes(","))).toBe(false);
	});

	it("still treats a genuine single tag as one tag", () => {
		expect(parseTags("---\ntags: core-values\n---\n\nbody")).toEqual(["core-values"]);
	});

	it("trims whitespace and drops empty entries from a trailing comma", () => {
		expect(parseTags("---\ntags: one ,  two ,\n---\n\nbody")).toEqual(["one", "two"]);
	});

	it("lowercases and deduplicates across the split", () => {
		expect(parseTags("---\ntags: CDNJS, cdnjs, Projects\n---\n\nbody")).toEqual([
			"cdnjs",
			"projects",
		]);
	});
});
