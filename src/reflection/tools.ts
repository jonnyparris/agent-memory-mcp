/**
 * Reflection Tools
 *
 * Defines the tools available to the agentic reflection system.
 * These enable the LLM to explore memory, identify issues, and propose fixes.
 */

import type { LLMTool } from "../llm/types";

/**
 * Tools available during reflection
 *
 * The reflection agent can:
 * 1. Search memory semantically to find relevant files
 * 2. Read full file contents
 * 3. List directory contents
 * 4. Propose edits (auto-applied after the run, with guards)
 * 5. Flag issues for a human
 * 6. Auto-apply low-risk fixes (typos, formatting)
 * 7. Finish reflection with a summary
 */
export const REFLECTION_TOOLS: LLMTool[] = [
	{
		name: "searchMemory",
		description:
			"Search memory semantically to find relevant files. Use when you need to find information about a topic or discover related content.",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Natural language query describing what you're looking for",
				},
				limit: {
					type: "number",
					description: "Max results to return (default 5, max 20)",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "readFile",
		description:
			"Read a memory file. Returns up to 15,000 characters per call. If the result says truncated, call again with offset set to nextOffset to read the rest.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path relative to memory root, e.g., 'memory/learnings.md'",
				},
				offset: {
					type: "number",
					description:
						"Character offset to start reading from (default 0). Use nextOffset from a truncated read.",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "listFiles",
		description: "List files in a directory. Use to explore memory structure and discover files.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Directory path, e.g., 'memory/patterns' or 'memory/workload'",
				},
				recursive: {
					type: "boolean",
					description: "Whether to list recursively (default false)",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "getBacklinks",
		description:
			"List files that link to the given target via Obsidian-style [[wikilinks]]. Use before proposing to delete or merge a file to understand what references it. Also useful for identifying hubs (many backlinks) and orphans (none).",
		parameters: {
			type: "object",
			properties: {
				target: {
					type: "string",
					description:
						"The file to look up, e.g. 'memory/foo.md'. Links written as [[memory/foo]], [[foo]] or [[foo.md]] all count.",
				},
			},
			required: ["target"],
		},
	},
	{
		name: "proposeEdit",
		description:
			"Edit a memory file. Edits are applied automatically after the run, with no human in the loop. 'append' adds text to the end of the file (safest). 'replace' overwrites the WHOLE file with content, so content must be the complete new file; a replace that drops a large part of an existing file is refused and flagged instead. 'create' makes a new file. 'delete' is never applied; it is flagged for a human. If you cannot write the complete fix, use flagIssue instead.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path to edit",
				},
				action: {
					type: "string",
					description: "Type of edit to perform",
					enum: ["replace", "append", "delete", "create"],
				},
				content: {
					type: "string",
					description:
						"New content for the file (required for replace/append/create, ignored for delete)",
				},
				reason: {
					type: "string",
					description:
						"Explain why this change is needed - be specific about the issue being fixed",
				},
			},
			required: ["path", "action", "reason"],
		},
	},
	{
		name: "autoApply",
		description:
			"Apply a low-risk fix immediately without human review. Only use for: typo fixes in prose (not code), trailing newlines, extra whitespace, duplicate removal. The change will be applied immediately.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path to fix",
				},
				fixType: {
					type: "string",
					description: "Type of fix being applied",
					enum: ["typo", "whitespace", "newline", "duplicate", "formatting"],
				},
				oldText: {
					type: "string",
					description: "The exact text to replace (for typo/whitespace fixes)",
				},
				newText: {
					type: "string",
					description: "The corrected text",
				},
				reason: {
					type: "string",
					description: "Brief explanation of the fix",
				},
			},
			required: ["path", "fixType", "reason"],
		},
	},
	{
		name: "flagIssue",
		description:
			"Record a problem for a human to fix, without editing anything. Use when the fix is too big or too risky to write as an edit (for example a large file that needs restructuring, or a contradiction you can't resolve).",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path with the issue",
				},
				issue: {
					type: "string",
					description: "What is wrong and what the fix should be. Be specific.",
				},
			},
			required: ["path", "issue"],
		},
	},
	{
		name: "finishReflection",
		description:
			"Complete the reflection with a summary. Call this when you have finished analyzing memory and proposing changes.",
		parameters: {
			type: "object",
			properties: {
				summary: {
					type: "string",
					description:
						"2-3 sentence summary of findings and actions taken. Include counts of issues found and changes proposed.",
				},
				proposedChanges: {
					type: "number",
					description: "Total number of edits proposed with proposeEdit",
				},
				autoApplied: {
					type: "number",
					description: "Total number of low-risk fixes auto-applied",
				},
			},
			required: ["summary", "proposedChanges", "autoApplied"],
		},
	},
];
