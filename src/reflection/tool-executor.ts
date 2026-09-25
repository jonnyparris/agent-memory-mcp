/**
 * Tool Executor for Agentic Reflection
 *
 * Executes tool calls from the LLM and manages side effects.
 * Proposed edits are staged for review; auto-apply fixes are immediate.
 */

import type { LLMToolCall } from "../llm/types";
import { getMemoryIndex } from "../search/client";
import { indexWrite } from "../search/index-write";
import type { R2Storage } from "../storage/r2";
import type { Env } from "../types";

/**
 * Largest deletion an auto-applied "quick fix" may make, in characters.
 *
 * The quick-fix types are all nominally cosmetic — typo, whitespace, newline,
 * duplicate, formatting — but the mechanism is
 * `content.replace(oldText, newText ?? "")` with `oldText` chosen freely by
 * the model, so nothing structural stops a "duplicate" fix from deleting an
 * entire section. These writes happen unattended on the 06:00 cron, and R2
 * versioning is off, so there is no undo.
 *
 * 400 characters comfortably covers a stray tag line, a repeated heading or a
 * duplicated sentence, and stops well short of a paragraph. Anything larger
 * is a judgement call and belongs in `proposedEdits` for review, which is
 * what the deep-analysis phase is for.
 */
const MAX_AUTO_FIX_DELETION = 400;

/**
 * Smallest a `replace` may leave a file, as a fraction of its current size.
 *
 * `replace` overwrites the whole file and is auto-applied after the run. The
 * model reads large files in 15,000-character pages and writes at most a few
 * thousand tokens, so a replace of a large file is far more likely to be "the
 * part I saw" than a considered rewrite. Anything that drops more than
 * 30% of the file is treated as a content decision and flagged for a human.
 */
export const MIN_REPLACE_RATIO = 0.7;

/** Characters returned per readFile call. */
const READ_PAGE_SIZE = 15000;

/**
 * A proposed edit that requires human review
 */
export interface ProposedEdit {
	path: string;
	action: "replace" | "append" | "delete" | "create";
	content?: string;
	reason: string;
}

/**
 * An auto-applied fix (already done)
 */
export interface AutoAppliedFix {
	path: string;
	fixType: "typo" | "whitespace" | "newline" | "duplicate" | "formatting";
	oldText?: string;
	newText?: string;
	reason: string;
}

/**
 * An issue flagged for deep analysis
 */
export interface FlaggedIssue {
	path: string;
	issue: string;
}

/**
 * Context for tool execution
 */
export interface ToolExecutionContext {
	storage: R2Storage;
	env: Env;
	proposedEdits: ProposedEdit[];
	autoAppliedFixes: AutoAppliedFix[];
	flaggedIssues: FlaggedIssue[];
	/** Writes whose storage step succeeded but index update failed. */
	writeFailures: string[];
	/** Record fixes without writing anything. Used by POST /reflect?dry_run=1. */
	dryRun?: boolean;
}

/**
 * Result of a tool execution
 */
export interface ToolResult {
	success: boolean;
	result?: unknown;
	error?: string;
}

/**
 * Execute a reflection tool call
 */
export async function executeReflectionTool(
	toolCall: LLMToolCall,
	context: ToolExecutionContext,
): Promise<ToolResult> {
	const { name, arguments: args } = toolCall;

	try {
		switch (name) {
			case "searchMemory":
				return executeSearch(args as { query: string; limit?: number }, context);

			case "readFile":
				return executeRead(args as { path: string; offset?: number }, context);

			case "listFiles":
				return executeList(args as { path: string; recursive?: boolean }, context);

			case "getBacklinks":
				return executeGetBacklinks(args as { target: string }, context);

			case "proposeEdit":
				return executePropose(args as unknown as ProposedEdit, context);

			case "autoApply":
				return executeAutoApply(
					args as {
						path: string;
						fixType: AutoAppliedFix["fixType"];
						oldText?: string;
						newText?: string;
						reason: string;
					},
					context,
				);

			case "flagIssue":
				return executeFlagIssue(args as unknown as FlaggedIssue, context);

			case "finishReflection":
				return {
					success: true,
					result: {
						finished: true,
						...args,
					},
				};

			default:
				return { success: false, error: `Unknown tool: ${name}` };
		}
	} catch (e) {
		return {
			success: false,
			error: `Tool execution failed: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}

/**
 * Search memory using semantic search via the Durable Object index
 */
async function executeSearch(
	args: { query: string; limit?: number },
	context: ToolExecutionContext,
): Promise<ToolResult> {
	const limit = Math.min(args.limit ?? 5, 20);

	try {
		const results = await getMemoryIndex(context.env).search({ query: args.query, limit });
		return {
			success: true,
			result: {
				query: args.query,
				matches: results,
				count: results.length,
			},
		};
	} catch (e) {
		return { success: false, error: `Search error: ${String(e)}` };
	}
}

/**
 * Read a file from memory
 */
async function executeRead(
	args: { path: string; offset?: number },
	context: ToolExecutionContext,
): Promise<ToolResult> {
	const file = await context.storage.read(args.path);

	if (!file) {
		return { success: false, error: `File not found: ${args.path}` };
	}

	// Page large files rather than silently dropping the tail. Before paging,
	// anything past the first 15,000 characters was invisible to reflection,
	// which is most of learnings.md, projects.md and the brag sheet.
	const total = file.content.length;
	const offset = Math.max(0, Math.min(Math.floor(args.offset ?? 0), total));
	const end = Math.min(offset + READ_PAGE_SIZE, total);
	const truncated = end < total;
	const content = file.content.slice(offset, end);

	return {
		success: true,
		result: {
			path: args.path,
			content,
			size: file.size,
			totalChars: total,
			offset,
			updated_at: file.updated_at,
			truncated,
			...(truncated ? { nextOffset: end, remainingChars: total - end } : {}),
		},
	};
}

/**
 * List files in a directory
 */
async function executeList(
	args: { path: string; recursive?: boolean },
	context: ToolExecutionContext,
): Promise<ToolResult> {
	const files = await context.storage.list(args.path, args.recursive ?? false);

	return {
		success: true,
		result: {
			path: args.path,
			files: files.map((f) => ({
				path: f.path,
				size: f.size,
				updated_at: f.updated_at,
			})),
			count: files.length,
		},
	};
}

/**
 * Look up which files reference a given wikilink target.
 *
 * Calls the DO's /backlinks endpoint — the same surface the public
 * get_backlinks MCP tool uses. Returning both the list and count lets
 * the model reason about hubs vs orphans without another round trip.
 */
async function executeGetBacklinks(
	args: { target: string },
	context: ToolExecutionContext,
): Promise<ToolResult> {
	if (!args.target) {
		return { success: false, error: "target is required" };
	}

	try {
		const { backlinks } = await getMemoryIndex(context.env).backlinks(args.target);
		return {
			success: true,
			result: {
				target: args.target,
				backlinks,
				count: backlinks.length,
			},
		};
	} catch (e) {
		return { success: false, error: `Backlinks error: ${String(e)}` };
	}
}

/**
 * Stage a proposed edit for human review
 */
async function executePropose(
	args: ProposedEdit,
	context: ToolExecutionContext,
): Promise<ToolResult> {
	// A whole-file deletion is a content decision, not an edit to apply from an
	// unattended reflection run. Surface it for a human without staging it for
	// the auto-apply phase. The apply phase refuses it independently as
	// defense-in-depth for persisted or externally-constructed proposals.
	if (args.action === "delete") {
		context.flaggedIssues.push({
			path: args.path,
			issue: `Reflection proposed deleting this file: ${args.reason}`,
		});
		return {
			success: true,
			result: {
				message: `Delete refused and flagged for human review: ${args.path}`,
				totalProposed: context.proposedEdits.length,
			},
		};
	}

	// Validate the edit
	let existing: { content: string } | null = null;
	if (args.action !== "create") {
		existing = await context.storage.read(args.path);
		if (!existing) {
			return { success: false, error: `File not found: ${args.path}` };
		}
	}

	// Check for required content on create/replace/append
	if (["create", "replace", "append"].includes(args.action) && !args.content) {
		return {
			success: false,
			error: `Content required for ${args.action} action`,
		};
	}

	// A replace that throws away a large part of the file is almost always the
	// model rewriting only the page it read. Refuse it here so the model can
	// switch to append or flagIssue, and record the finding so it survives
	// even if the model moves on.
	const shrinkError = replaceShrinkError(args, existing?.content);
	if (shrinkError) {
		context.flaggedIssues.push({
			path: args.path,
			issue: `Reflection wanted to rewrite this file but the rewrite was refused (${shrinkError}). Its reason: ${args.reason}`,
		});
		return {
			success: false,
			error: `Refused: ${shrinkError}. replace must contain the whole file. Use append to add text, or flagIssue to hand the fix to a human. The issue has been flagged.`,
		};
	}

	// Models sometimes send the same edit twice. Applying an append twice
	// would duplicate the text, so a repeat is acknowledged but not staged.
	const duplicate = context.proposedEdits.some(
		(e) => e.path === args.path && e.action === args.action && e.content === args.content,
	);
	if (duplicate) {
		return {
			success: true,
			result: {
				message: `Already staged: ${args.action} ${args.path}`,
				totalProposed: context.proposedEdits.length,
			},
		};
	}

	// Stage the edit
	context.proposedEdits.push({
		path: args.path,
		action: args.action,
		content: args.content,
		reason: args.reason,
	});

	return {
		success: true,
		result: {
			message: `Edit staged: ${args.action} ${args.path}`,
			totalProposed: context.proposedEdits.length,
		},
	};
}

/**
 * Return why a `replace` would shrink a file too far, or null if it is fine.
 * Shared by the propose step and the apply step (defence in depth).
 */
export function replaceShrinkError(
	edit: { action: string; content?: string },
	existingContent: string | undefined,
): string | null {
	if (edit.action !== "replace" || existingContent === undefined) return null;
	const before = existingContent.length;
	const after = edit.content?.length ?? 0;
	if (before === 0 || after >= before * MIN_REPLACE_RATIO) return null;
	const dropped = Math.round((1 - after / before) * 100);
	return `it would cut the file from ${before} to ${after} characters (${dropped}% removed)`;
}

/**
 * Auto-apply a low-risk fix immediately
 */
async function executeAutoApply(
	args: {
		path: string;
		fixType: AutoAppliedFix["fixType"];
		oldText?: string;
		newText?: string;
		reason: string;
	},
	context: ToolExecutionContext,
): Promise<ToolResult> {
	// Read current file
	const file = await context.storage.read(args.path);
	if (!file) {
		return { success: false, error: `File not found: ${args.path}` };
	}

	let newContent = file.content;

	// Apply fix based on type
	switch (args.fixType) {
		case "typo":
		case "whitespace":
			if (!args.oldText || !args.newText) {
				return {
					success: false,
					error: `oldText and newText required for ${args.fixType} fix`,
				};
			}
			if (!file.content.includes(args.oldText)) {
				return {
					success: false,
					error: `oldText not found in file: "${args.oldText.slice(0, 50)}..."`,
				};
			}
			newContent = file.content.replace(args.oldText, args.newText);
			break;

		case "newline":
			// Ensure file ends with exactly one newline
			newContent = `${file.content.trimEnd()}\n`;
			break;

		case "duplicate":
			// For duplicates, the caller should provide oldText (the duplicate) and newText (empty or merged)
			if (!args.oldText) {
				return { success: false, error: "oldText required for duplicate fix" };
			}
			newContent = file.content.replace(args.oldText, args.newText ?? "");
			break;

		case "formatting":
			// For formatting, we apply the provided replacement
			if (args.oldText && args.newText !== undefined) {
				newContent = file.content.replace(args.oldText, args.newText);
			}
			break;
	}

	if (newContent.trim().length === 0) {
		return {
			success: false,
			error: `Refusing to auto-apply a ${args.fixType} fix that would leave ${args.path} blank.`,
		};
	}

	// Refuse a deletion large enough to be a content decision rather than a
	// cosmetic tidy. Measured on net shrinkage, so a replacement that swaps
	// text of similar length is unaffected.
	const removed = file.content.length - newContent.length;
	if (removed > MAX_AUTO_FIX_DELETION) {
		return {
			success: false,
			error: `Refusing to auto-apply a ${args.fixType} fix that removes ${removed} characters from ${args.path} (limit ${MAX_AUTO_FIX_DELETION}). Deletions this large are content decisions, not cosmetic fixes — use proposeEdit so a human reviews it.`,
		};
	}

	// Only write if content changed
	if (newContent !== file.content && !context.dryRun) {
		// Must go through indexWrite, not storage.write.
		//
		// A raw R2 write leaves search metadata describing the previous
		// content. Any retrieval data derived from the file is then stale.
		//
		// indexWrite also brings the empty-content guard, which a direct write
		// bypasses entirely — a `duplicate` fix whose oldText happened to match
		// the whole file would have truncated it to zero bytes, unrecoverably.
		const result = await indexWrite(context.env, context.storage, args.path, newContent, {
			detectOverlaps: false,
		});
		if (result.embedding_error) {
			const error =
				`Partial write failure for ${args.path}: content was saved, but the search index ` +
				`update failed (${result.embedding_error}). Reindex this file before relying on search.`;
			context.flaggedIssues.push({ path: args.path, issue: error });
			context.writeFailures.push(error);
			console.error(error);
			return { success: false, error };
		}
	}

	// Record only a fully successful fix. On an index failure the R2 write has
	// landed, but reporting the operation as applied would hide stale search.
	context.autoAppliedFixes.push({
		path: args.path,
		fixType: args.fixType,
		oldText: args.oldText,
		newText: args.newText,
		reason: args.reason,
	});

	return {
		success: true,
		result: {
			message: `Auto-applied ${args.fixType} fix to ${args.path}`,
			totalAutoApplied: context.autoAppliedFixes.length,
		},
	};
}

/**
 * Flag an issue for deep analysis
 */
async function executeFlagIssue(
	args: FlaggedIssue,
	context: ToolExecutionContext,
): Promise<ToolResult> {
	// Models sometimes call this with no arguments. An empty flag reaches the
	// chat card as a blank bullet and tells the human nothing.
	if (typeof args?.path !== "string" || !args.path.trim()) {
		return { success: false, error: "path is required" };
	}
	if (typeof args?.issue !== "string" || !args.issue.trim()) {
		return { success: false, error: "issue is required: say what is wrong and what to do" };
	}
	if (!context.flaggedIssues.some((f) => f.path === args.path && f.issue === args.issue)) {
		context.flaggedIssues.push({ path: args.path, issue: args.issue });
	}

	return {
		success: true,
		result: {
			message: `Flagged for deep analysis: ${args.path}`,
			totalFlagged: context.flaggedIssues.length,
		},
	};
}

/**
 * Create a fresh execution context
 */
export function createExecutionContext(
	storage: R2Storage,
	env: Env,
	options?: { dryRun?: boolean },
): ToolExecutionContext {
	return {
		storage,
		env,
		dryRun: options?.dryRun ?? false,
		proposedEdits: [],
		autoAppliedFixes: [],
		flaggedIssues: [],
		writeFailures: [],
	};
}
