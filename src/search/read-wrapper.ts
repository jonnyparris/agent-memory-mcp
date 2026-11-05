/**
 * Detect content that is the `read` tool's display text rather than a file.
 *
 * `read` answers with a one-line summary, a blank line, then JSON
 * (`okResult` in `../helpers`):
 *
 *   Read memory/x.md (31560 bytes)
 *
 *   {"content":"...","updated_at":"...","size":31560}
 *
 * A client that sees only the text block (codemode, some MCP adapters)
 * gets that whole string back. An agent that edits it and writes it back
 * stores the envelope as the file, and anything that parses the file
 * afterwards sees garbage. Notes telling agents not to do this did not
 * stop repeats, so the write path refuses it. `allow_wrapped` opts out.
 */

// Every summary line `read` emits: `Read <path> (N bytes)`,
// `Read <path> (chars a-b of N)`, either with `· truncated, ...`, and
// `Read k/n files[ · ...]` for a multi-path read. The JSON that follows
// starts with `{"content":` (single file) or `{"files":` (several).
// The suffix alternatives must not overlap (both matching spaces): a long
// space run with no newline then backtracks quadratically on every write.
const DISPLAY_TEXT =
	/^\s*Read (?:.+ \((?:\d+ bytes|chars \d+-\d+ of \d+)\)|\d+\/\d+ files)(?: · [^\r\n]*|[ \t]*)\r?\n\s*\{\s*"(?:content|files)"\s*:/;

// The same envelope one level further out: the raw MCP result object
// serialised whole (`JSON.stringify(await tools.…read(...))`). Parsed, not
// pattern-matched, so the text block gets exactly the DISPLAY_TEXT test
// (escaped quotes in paths, reformatted inner JSON). The cheap prefix check
// keeps ordinary writes from paying for a parse.
const MCP_PREFIX = /^\s*\{\s*"content"\s*:\s*\[/;

function mcpText(content: string): string | null {
	if (!MCP_PREFIX.test(content)) return null;
	try {
		const block = (JSON.parse(content) as { content?: Array<{ type?: unknown; text?: unknown }> })
			.content?.[0];
		return block?.type === "text" && typeof block.text === "string" ? block.text : null;
	} catch {
		return null;
	}
}

export function isReadWrapper(content: string): boolean {
	if (DISPLAY_TEXT.test(content)) return true;
	const text = mcpText(content);
	return text !== null && DISPLAY_TEXT.test(text);
}

/**
 * Thrown by `indexWrite` when the content is a `read` response envelope
 * and the caller did not set `allowWrapped: true`.
 */
export class WrappedContentError extends Error {
	constructor(path: string) {
		super(
			[
				`Refusing to write ${path}: this content is the read tool's display text ("Read <path> (...)" followed by JSON), not the file.`,
				`Write the file's content instead. Parse the JSON after the "Read ..." line (if you have the whole MCP result, take .content[0].text first).`,
				"Single-file read: use .content. Multi-file read: use .files[<path>].content.",
				"If that object has truncated: true or an offset other than 0, it holds only part of the file: read that one path again with offset: 0, then offset: next_offset, until next_offset is absent, and join the pieces.",
				"On write or write_many, pass allow_wrapped: true only if you really mean to store this text.",
			].join(" "),
		);
		this.name = "WrappedContentError";
	}
}
