/**
 * Tool Executor for Agentic Reflection
 *
 * Executes tool calls from the LLM and manages side effects.
 * Proposed edits are staged for review; auto-apply fixes are immediate.
 */

import type { LLMToolCall } from "../llm/types";
import type { R2Storage } from "../storage/r2";
import type { Env } from "../types";

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
				return executeRead(args as { path: string }, context);

			case "listFiles":
				return executeList(args as { path: string; recursive?: boolean }, context);

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

			case "flagForDeepAnalysis":
				return executeFlagForDeepAnalysis(args as unknown as FlaggedIssue, context);

			case "finishReflection":
				return {
					success: true,
					result: {
						finished: true,
						...args,
					},
				};

			case "finishQuickScan":
				return {
					success: true,
					result: {
						finished: true,
						phase: "quick_scan",
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
		const indexId = context.env.MEMORY_INDEX.idFromName("default");
		const index = context.env.MEMORY_INDEX.get(indexId);

		const response = await index.fetch(
			new Request("http://internal/search", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ query: args.query, limit }),
			}),
		);

		if (!response.ok) {
			const errorText = await response.text();
			return { success: false, error: `Search failed: ${errorText}` };
		}

		const results = await response.json();
		return {
			success: true,
			result: {
				query: args.query,
				matches: results,
				count: Array.isArray(results) ? results.length : 0,
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
	args: { path: string },
	context: ToolExecutionContext,
): Promise<ToolResult> {
	const file = await context.storage.read(args.path);

	if (!file) {
		return { success: false, error: `File not found: ${args.path}` };
	}

	// Truncate large files to avoid context overflow
	const maxLength = 15000;
	const truncated = file.content.length > maxLength;
	const content = truncated
		? `${file.content.slice(0, maxLength)}\n...[truncated, ${file.content.length - maxLength} bytes omitted]...`
		: file.content;

	return {
		success: true,
		result: {
			path: args.path,
			content,
			size: file.size,
			updated_at: file.updated_at,
			truncated,
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
 * Stage a proposed edit for human review
 */
async function executePropose(
	args: ProposedEdit,
	context: ToolExecutionContext,
): Promise<ToolResult> {
	// Validate the edit
	if (args.action !== "create") {
		const exists = await context.storage.read(args.path);
		if (!exists && args.action !== "delete") {
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

	// Only write if content changed
	if (newContent !== file.content) {
		await context.storage.write(args.path, newContent);
	}

	// Record the fix
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
async function executeFlagForDeepAnalysis(
	args: FlaggedIssue,
	context: ToolExecutionContext,
): Promise<ToolResult> {
	context.flaggedIssues.push({
		path: args.path,
		issue: args.issue,
	});

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
export function createExecutionContext(storage: R2Storage, env: Env): ToolExecutionContext {
	return {
		storage,
		env,
		proposedEdits: [],
		autoAppliedFixes: [],
		flaggedIssues: [],
	};
}
