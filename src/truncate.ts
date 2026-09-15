/**
 * Maximum characters returned by a single read. This exists to bound the MCP
 * response (and the caller's context window), not to describe the file — a
 * file larger than this is still fully retrievable by paging with `offset`.
 */
export const MAX_READ_LENGTH = 50000;

const DEFAULT_MAX_LENGTH = MAX_READ_LENGTH;
/** In-band warning appended to an accidentally-shortened read. */
export const TRUNCATION_MARKER = "\n\n[Content truncated...]";

export interface TruncateOptions {
	maxLength?: number;
	suffix?: string;
}

export interface TruncateResult {
	content: string;
	truncated: boolean;
	original_size: number;
}

/**
 * Truncate content to a maximum length with an optional suffix.
 *
 * Returns the string directly for convenience at call sites that don't
 * care about truncation status. Use `truncateWithMeta` if you need to
 * surface "this was cut" to the caller.
 */
export function truncate(content: string, options: TruncateOptions = {}): string {
	return truncateWithMeta(content, options).content;
}

/**
 * Truncate and report whether truncation happened. Tools that return file
 * contents to clients should use this so the client knows if it got the
 * full file or a partial view.
 */
export function truncateWithMeta(content: string, options: TruncateOptions = {}): TruncateResult {
	const { maxLength = DEFAULT_MAX_LENGTH, suffix = "\n\n[Content truncated...]" } = options;

	if (content.length <= maxLength) {
		return { content, truncated: false, original_size: content.length };
	}

	// Prefer newlines near the end as cut points so we don't split a line
	// mid-sentence. 80% of the budget is a pragmatic threshold — closer to
	// the limit and we'd refuse good cut points; further away and we'd
	// waste too much budget searching for prettier breaks.
	const truncateAt = maxLength - suffix.length;
	const lastNewline = content.lastIndexOf("\n", truncateAt);
	const cutPoint = lastNewline > truncateAt * 0.8 ? lastNewline : truncateAt;

	return {
		content: content.slice(0, cutPoint) + suffix,
		truncated: true,
		original_size: content.length,
	};
}

export interface ReadWindowOptions {
	/** Character offset to start from. Clamped to [0, content.length]. */
	offset?: number;
	/** Max characters to return. Clamped to [1, MAX_READ_LENGTH]. */
	limit?: number;
	/**
	 * Append the in-band `[Content truncated...]` marker when the window
	 * stops short of the end. Default true.
	 */
	marker?: boolean;
}

export interface ReadWindow {
	/** The slice, plus the marker when one was appended. */
	content: string;
	/** Where this window starts. */
	offset: number;
	/** Characters in the slice, excluding any marker. */
	returned: number;
	/** Characters in the whole file. */
	total_length: number;
	/** True when the window stops short of the end. */
	truncated: boolean;
	/** Offset to pass next to continue reading. Absent at end of file. */
	next_offset?: number;
}

/**
 * Take a resumable window of a file's content.
 *
 * Replaces bare truncation for reads. Truncation alone loses data silently:
 * an agent reads a 78K-character file, gets 50K, appends a line and writes it
 * back — and 28K is gone. `next_offset` makes the remainder reachable, which
 * is the difference between a capped read and a lossy one.
 *
 * The `marker` distinction is deliberate. A caller that passed no paging
 * arguments and got cut short is in the accident case, so the warning goes
 * *inside* the content where even code that ignores metadata will trip over
 * it. A caller that passed `offset`/`limit` has demonstrated awareness and is
 * reassembling chunks, so it gets the exact slice — a marker spliced into the
 * middle of a reassembled file would be corruption.
 */
export function readWindow(content: string, options: ReadWindowOptions = {}): ReadWindow {
	const total = content.length;
	const marker = options.marker !== false;

	// Clamp rather than reject. A caller paging to the end of a file that
	// shrank between calls should get an empty tail, not an error.
	const offset = Math.min(Math.max(Math.trunc(options.offset ?? 0), 0), total);
	const limit = Math.min(
		Math.max(Math.trunc(options.limit ?? MAX_READ_LENGTH), 1),
		MAX_READ_LENGTH,
	);

	let end = Math.min(offset + limit, total);

	// Prefer a newline as the cut point so a window does not split a line.
	// The 80%-of-budget floor keeps the slice non-empty, which is what
	// guarantees `next_offset` always advances and paging terminates.
	if (end < total) {
		const lastNewline = content.lastIndexOf("\n", end);
		if (lastNewline > offset + limit * 0.8) {
			end = lastNewline;
		}
	}

	const slice = content.slice(offset, end);
	const truncated = end < total;

	return {
		content: truncated && marker ? slice + TRUNCATION_MARKER : slice,
		offset,
		returned: slice.length,
		total_length: total,
		truncated,
		...(truncated ? { next_offset: end } : {}),
	};
}

/**
 * Extract a snippet around a match position
 */
export function extractSnippet(
	content: string,
	options: { maxLength?: number; position?: number } = {},
): string {
	const { maxLength = 500, position = 0 } = options;

	if (content.length <= maxLength) {
		return content;
	}

	// Center the snippet around the position
	const halfLength = Math.floor(maxLength / 2);
	let start = Math.max(0, position - halfLength);
	let end = Math.min(content.length, position + halfLength);

	// Adjust if we're near the edges
	if (start === 0) {
		end = Math.min(content.length, maxLength);
	} else if (end === content.length) {
		start = Math.max(0, content.length - maxLength);
	}

	let snippet = content.slice(start, end);

	// Try to start/end at word boundaries
	if (start > 0) {
		const firstSpace = snippet.indexOf(" ");
		if (firstSpace > 0 && firstSpace < 50) {
			snippet = `...${snippet.slice(firstSpace + 1)}`;
		} else {
			snippet = `...${snippet}`;
		}
	}

	if (end < content.length) {
		const lastSpace = snippet.lastIndexOf(" ");
		if (lastSpace > snippet.length - 50) {
			snippet = `${snippet.slice(0, lastSpace)}...`;
		} else {
			snippet = `${snippet}...`;
		}
	}

	return snippet;
}
