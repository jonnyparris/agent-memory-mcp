import { describe, expect, it } from "vitest";
import { WrappedContentError, isReadWrapper } from "../../src/search/read-wrapper";

describe("isReadWrapper", () => {
	// The exact shape that overwrote memory/workload/active-todos.md on
	// 2026-11-04: the single-file read summary, a blank line, then JSON.
	const incident =
		'Read memory/workload/active-todos.md (31560 bytes)\n\n{"content":"# Active Todos\\n\\n**Last Updated**: 2026-11-04","updated_at":"2026-11-04T16:58:00.000Z","size":31560}';

	it("flags the 2026-11-04 active-todos write", () => {
		expect(isReadWrapper(incident)).toBe(true);
	});

	it.each([
		["single file", 'Read memory/learnings/2026-11.md (812 bytes)\n\n{"content":"x"}'],
		["CRLF line endings", 'Read a.md (1 bytes)\r\n\r\n{"content":"x"}'],
		["pretty-printed JSON", 'Read a.md (1 bytes)\n\n{\n  "content": "x"\n}'],
		[
			"whole MCP result serialised with an indent",
			JSON.stringify(
				{ content: [{ type: "text", text: 'Read a.md (1 bytes)\n\n{"content":"x"}' }] },
				null,
				2,
			),
		],
		[
			"whole MCP result with hand-written spacing",
			'{ "content" : [ { "type" : "text" , "text" : "Read a.md (1 bytes)\\n\\n{\\"content\\":\\"x\\"}" } ] }',
		],
		[
			"whole MCP result, quoted path and reformatted inner JSON",
			JSON.stringify({
				content: [{ type: "text", text: 'Read a"b.md (1 bytes)\n\n{\n  "content": "x"\n}' }],
			}),
		],
		["path with spaces", 'Read memory/my notes.md (5 bytes)\n\n{"content":"x"}'],
		[
			"single file, truncated",
			'Read memory/big.md (60000 bytes) · truncated, pass offset=50000 to continue\n\n{"content":"x","truncated":true}',
		],
		["paged", 'Read memory/big.md (chars 0-50000 of 60000)\n\n{"content":"x"}'],
		["multi-file", 'Read 2/2 files\n\n{"files":{"a.md":{"content":"x"}}}'],
		[
			"multi-file, truncated",
			'Read 1/2 files · 1 truncated, pass next_offset to continue\n\n{"files":{}}',
		],
		[
			"leading whitespace (trimmed by the caller, or not)",
			'\n  Read a.md (1 bytes)\n{"content":"x"}',
		],
		[
			"whole MCP result serialised",
			'{"content":[{"type":"text","text":"Read a.md (1 bytes)\\n\\n{\\"content\\":\\"x\\"}"}]}',
		],
	])("flags %s", (_label, content) => {
		expect(isReadWrapper(content)).toBe(true);
	});

	it.each([
		["ordinary markdown", "# Notes\n\nRead the docs first."],
		["a line that starts with Read", "Read memory/x.md (12 bytes) later.\n\nThen fix it."],
		["the envelope quoted mid-file", 'Notes\n\nRead a.md (1 bytes)\n\n{"content":"x"}'],
		["plain JSON file", '{"content":"x","size":1}'],
		["empty", ""],
		[
			"MCP-shaped JSON whose text merely starts with Read",
			'{"content":[{"type":"text","text":"Read me first"}]}',
		],
		[
			"MCP-shaped JSON whose Read line is not a read summary",
			JSON.stringify({ content: [{ type: "text", text: 'Read this config\n\n{"content":1}' }] }),
		],
		[
			"MCP-shaped JSON, non-text block",
			'{"content":[{"type":"image","text":"Read a.md (1 bytes)\\n\\n{\\"content\\":1}"}]}',
		],
		["a Read line that is not a read summary", 'Read this config:\n\n{"content":"x"}'],
		["a Read line whose parenthesised part is not a size", 'Read a.md (draft)\n\n{"content":"x"}'],
	])("leaves %s alone", (_label, content) => {
		expect(isReadWrapper(content)).toBe(false);
	});

	it("stays linear on a long summary line with no newline", () => {
		// A quadratic draft of this regex took ~1.3s here; the linear one
		// takes a few ms. 500ms leaves room for a slow CI runner.
		const start = performance.now();
		expect(isReadWrapper(`Read a.md (1 bytes) · ${" ".repeat(50_000)}`)).toBe(false);
		expect(performance.now() - start).toBeLessThan(500);
	});
});

describe("WrappedContentError", () => {
	it("tells the caller how to recover every shape the detector matches", () => {
		const message = new WrappedContentError("memory/x.md").message;
		expect(message).toContain("memory/x.md");
		expect(message).toContain("display text");
		expect(message).toContain(".content[0].text");
		expect(message).toContain(".files[<path>].content");
		expect(message).toContain("offset: 0");
		expect(message).toContain("offset: next_offset");
		expect(message).toContain("offset other than 0");
		expect(message).toContain("allow_wrapped: true");
	});
});
