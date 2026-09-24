/**
 * Scheduled Reflection
 *
 * Runs daily via cron trigger. Supports two modes:
 * - Agentic (default): Uses tool-calling LLMs for intelligent memory analysis
 * - Legacy: Falls back to single-shot LLM for prose suggestions
 *
 * The agentic mode runs in two phases:
 * 1. Quick Scan (GLM Flash): Auto-applies low-risk fixes
 * 2. Deep Analysis (Kimi K2.6): Proposes substantive changes for human review
 */

import { WorkersAIProvider } from "../llm/workers-ai";
import {
	type FlaggedIssueSummary,
	type ReflectionChange,
	buildReflectionCard,
	sendChatNotification,
} from "../notification";
import { type IndexWriteResult, indexWrite } from "../search/index-write";
import type { R2Storage } from "../storage/r2";
import { createR2Storage } from "../storage/r2";
import type { Env, MemoryFileMetadata } from "../types";
import { type AgenticReflectionResult, runAgenticReflection } from "./agentic";
import { type StagedReflection, archiveReflection, writeStagedReflection } from "./staging";
import { replaceShrinkError } from "./tool-executor";

// Meta file paths
const LAST_REFLECTION_PATH = "memory/meta/last-reflection.json";
const PENDING_DIR = "memory/reflections/pending";

// Core memory files to always include in reflection (legacy mode)
const CORE_MEMORY_PATHS = ["memory/learnings.md", "memory/preferences.md", "memory/projects.md"];

// Pattern paths to include (legacy mode)
const PATTERNS_DIR = "memory/patterns";

interface LastReflection {
	timestamp: number;
	date: string;
}

interface ReflectionContext {
	date: string;
	lastReflection: LastReflection | null;
	recentFiles: MemoryFileMetadata[];
	coreMemory: Record<string, string>;
	patterns: Record<string, string>;
}

export interface ReflectionResult {
	success: boolean;
	date: string;
	pendingPath?: string;
	summary?: string;
	error?: string;
	mode?: "agentic" | "legacy";
	autoApplied?: number;
	proposed?: number;
	/** Detailed list of quick fixes applied in Phase A */
	quickFixes?: ReflectionChange[];
	/** Detailed list of edits applied in Phase B */
	edits?: ReflectionChange[];
	/** List of edits that failed to apply */
	failedEdits?: string[];
	/** Issues the model flagged but didn't propose an edit for. Surfaced in
	 * the gchat card so the human can act on them. */
	flaggedIssues?: FlaggedIssueSummary[];
	/** True if a phase ran out of turns. An empty result then proves nothing. */
	incomplete?: boolean;
}

/**
 * Run the daily reflection
 */
export async function runReflection(
	env: Env,
	options?: { dryRun?: boolean },
): Promise<ReflectionResult> {
	const dryRun = options?.dryRun ?? false;
	const date = new Date().toISOString().split("T")[0];
	const storage = createR2Storage(env.MEMORY_BUCKET);

	// Check if agentic mode is enabled (default: true)
	const useAgentic = env.USE_AGENTIC_REFLECTION !== "false";

	try {
		let result: ReflectionResult;

		if (dryRun) {
			// Nothing is written and nobody is notified: the run is for looking
			// at what reflection would do.
			return await runAgenticDryRun(env, storage, date);
		}

		if (useAgentic) {
			result = await runAgenticReflectionFlow(env, storage, date);
		} else {
			result = await runLegacyReflection(env, storage, date);
		}

		// Log result for monitoring
		console.log(
			JSON.stringify({
				event: "reflection_complete",
				date,
				mode: result.mode,
				success: result.success,
				autoApplied: result.autoApplied ?? 0,
				proposed: result.proposed ?? 0,
				incomplete: result.incomplete ?? false,
				error: result.error,
			}),
		);

		// Always send a DM summary (if webhook configured)
		if (env.CHAT_WEBHOOK_AUTH_KEY && env.CHAT_WEBHOOK_URL && env.CHAT_WEBHOOK_SPACE_ID) {
			const card = buildReflectionCard(
				date,
				result.summary ?? "Reflection complete — no issues found.",
				{
					quickFixes: result.quickFixes,
					edits: result.edits,
					failedEdits: result.failedEdits,
					flaggedIssues: result.flaggedIssues,
					incomplete: result.incomplete,
				},
			);
			await sendChatNotification(env.CHAT_WEBHOOK_AUTH_KEY, result.summary ?? "", {
				webhookUrl: env.CHAT_WEBHOOK_URL,
				spaceId: env.CHAT_WEBHOOK_SPACE_ID,
				card,
			});
		}

		return result;
	} catch (e) {
		const error = e instanceof Error ? e.message : String(e);

		console.error(
			JSON.stringify({
				event: "reflection_failed",
				date,
				error,
			}),
		);

		// Try to notify about failure (if webhook configured)
		if (env.CHAT_WEBHOOK_AUTH_KEY && env.CHAT_WEBHOOK_URL && env.CHAT_WEBHOOK_SPACE_ID) {
			await sendChatNotification(
				env.CHAT_WEBHOOK_AUTH_KEY,
				`Reflection failed for ${date}: ${error}`,
				{
					webhookUrl: env.CHAT_WEBHOOK_URL,
					spaceId: env.CHAT_WEBHOOK_SPACE_ID,
				},
			);
		}

		return {
			success: false,
			date,
			error,
		};
	}
}

function requireIndexedWrite(path: string, result: IndexWriteResult): void {
	if (!result.embedding_error) return;

	throw new Error(
		`Partial write failure for ${path}: content was saved, but the search index update failed ` +
			`(${result.embedding_error}). Reindex this file before relying on search.`,
	);
}

/**
 * Run the agentic phases without writing anything, and report what would
 * have happened. Proposed edits are listed, not applied.
 */
async function runAgenticDryRun(
	env: Env,
	storage: R2Storage,
	date: string,
): Promise<ReflectionResult> {
	const r = await runAgenticReflection(env, storage, { dryRun: true });
	const incomplete = r.deepAnalysisFinished === false || r.quickScanFinished === false;
	return {
		success: r.success,
		date,
		mode: "agentic",
		incomplete,
		summary: `[dry run] quick scan ${r.quickScanIterations} turns${r.quickScanFinished ? "" : " (unfinished)"}, deep analysis ${r.deepAnalysisIterations} turns${r.deepAnalysisFinished ? "" : " (unfinished)"}. Would apply ${r.autoAppliedFixes.length} quick fixes and ${r.proposedEdits.length} edits; flagged ${r.flaggedIssues.length}.\n\n${r.summary}`,
		autoApplied: 0,
		proposed: r.proposedEdits.length,
		quickFixes: r.autoAppliedFixes.map((f) => ({
			path: f.path,
			action: f.fixType,
			reason: f.reason,
		})),
		edits: r.proposedEdits.map((e) => ({
			path: e.path,
			action: e.action,
			reason: `${e.reason} [content: ${e.content?.length ?? 0} chars]`,
		})),
		flaggedIssues: r.flaggedIssues.map((f) => ({ path: f.path, issue: f.issue })),
		error: r.error,
	};
}

/**
 * Run agentic reflection with tool calling
 */
async function runAgenticReflectionFlow(
	env: Env,
	storage: R2Storage,
	date: string,
): Promise<ReflectionResult> {
	const agenticResult: AgenticReflectionResult = await runAgenticReflection(env, storage);

	const hasChanges =
		agenticResult.proposedEdits.length > 0 || agenticResult.autoAppliedFixes.length > 0;
	const hasFlagged = agenticResult.flaggedIssues.length > 0;

	// Auto-apply proposed edits, except whole-file deletions.
	//
	// Two things were wrong here. First, every branch wrote through
	// `storage.write`, which leaves the search index describing the previous
	// content — with per-section vectors the stored chunk offsets then point at
	// the wrong bytes and every snippet after the edit is shifted. Second,
	// `delete` removed an entire memory file unattended on the 06:00 cron, with
	// R2 versioning off and therefore no undo, on nothing but a model's
	// judgement. Deleting a whole file is never a cosmetic call, so it is now
	// recorded for review instead of executed.
	const appliedEdits: ReflectionChange[] = [];
	const failedEdits: string[] = [...agenticResult.writeFailures];
	const refusedEdits: ReflectionChange[] = [];

	for (const edit of agenticResult.proposedEdits) {
		try {
			switch (edit.action) {
				case "replace":
				case "create": {
					// Defence in depth: the propose step already refuses a replace
					// that drops most of a file, but proposals can also arrive from
					// persisted records. Re-check against the file as it is now.
					if (edit.action === "replace") {
						const current = await storage.read(edit.path);
						const shrink = replaceShrinkError(edit, current?.content);
						if (shrink) {
							refusedEdits.push({
								path: edit.path,
								action: edit.action,
								reason: `REFUSED (${shrink}): ${edit.reason}`,
							});
							continue;
						}
					}
					if (edit.content) {
						const result = await indexWrite(env, storage, edit.path, edit.content, {
							detectOverlaps: false,
						});
						requireIndexedWrite(edit.path, result);
					}
					break;
				}
				case "append":
					if (edit.content) {
						const existing = await storage.read(edit.path);
						const newContent = existing ? `${existing.content}\n${edit.content}` : edit.content;
						const result = await indexWrite(env, storage, edit.path, newContent, {
							detectOverlaps: false,
						});
						requireIndexedWrite(edit.path, result);
					}
					break;
				case "delete":
					refusedEdits.push({
						path: edit.path,
						action: edit.action,
						reason: `REFUSED (needs human review): ${edit.reason}`,
					});
					console.log(
						JSON.stringify({
							event: "auto_apply_edit_refused",
							path: edit.path,
							action: edit.action,
							reason: edit.reason,
						}),
					);
					continue;
			}
			appliedEdits.push({ path: edit.path, action: edit.action, reason: edit.reason });
			console.log(
				JSON.stringify({ event: "auto_applied_edit", path: edit.path, action: edit.action }),
			);
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			failedEdits.push(`${edit.action}: ${edit.path} — ${error}`);
			console.error(
				JSON.stringify({
					event: "auto_apply_edit_failed",
					path: edit.path,
					action: edit.action,
					error,
				}),
			);
		}
	}

	// Write reflection record to archive (audit trail of what was changed and why)
	const stagedReflection: StagedReflection = {
		date,
		summary: agenticResult.summary || "No summary provided.",
		proposedEdits: agenticResult.proposedEdits,
		autoAppliedFixes: agenticResult.autoAppliedFixes,
		failedEdits,
		// A refused deletion is surfaced as a flagged issue so it lands in the
		// archived record and the caller's response instead of vanishing. The
		// whole point of refusing is that a human decides.
		flaggedIssues: [
			...agenticResult.flaggedIssues,
			...refusedEdits.map((e) => ({
				path: e.path,
				issue:
					e.action === "delete"
						? `Reflection proposed deleting this file and was refused: ${e.reason}`
						: `Reflection proposed a rewrite of this file and was refused: ${e.reason}`,
			})),
		],
		quickScanIterations: agenticResult.quickScanIterations,
		deepAnalysisIterations: agenticResult.deepAnalysisIterations,
		quickScanFinished: agenticResult.quickScanFinished,
		deepAnalysisFinished: agenticResult.deepAnalysisFinished,
	};
	// Write to pending first, then archive (reuses existing staging logic)
	const pendingPath = await writeStagedReflection(storage, stagedReflection);
	const archivePath = await archiveReflection(storage, pendingPath);
	console.log(
		JSON.stringify({
			event: "reflection_archived",
			date,
			archivePath,
			autoApplied: agenticResult.autoAppliedFixes.length,
			edits: appliedEdits.length,
			failedEdits: failedEdits.length,
			refusedEdits: refusedEdits.length,
		}),
	);

	// Update last reflection timestamp
	await storage.write(
		LAST_REFLECTION_PATH,
		JSON.stringify({
			timestamp: Date.now(),
			date,
		}),
	);

	// Build quick fixes list from Phase A auto-applied fixes
	const quickFixes: ReflectionChange[] = agenticResult.autoAppliedFixes.map((f) => ({
		path: f.path,
		action: f.fixType,
		reason: f.reason,
	}));

	// Build a detailed summary.
	//
	// "Looks good" is only honest if deep analysis actually finished. For
	// months every run hit its turn cap with nothing recorded and this branch
	// reported a clean bill of health; running out of turns is now said out
	// loud.
	const incomplete =
		agenticResult.deepAnalysisFinished === false || agenticResult.quickScanFinished === false;
	let summary: string;
	if (!hasChanges && !hasFlagged && incomplete) {
		const phases: string[] = [];
		if (agenticResult.quickScanFinished === false) {
			phases.push(`quick scan stopped after ${agenticResult.quickScanIterations} turns`);
		}
		if (agenticResult.deepAnalysisFinished === false) {
			phases.push(`deep analysis stopped after ${agenticResult.deepAnalysisIterations} turns`);
		}
		summary = `Reflection did not finish: ${phases.join(" and ")} without reaching a conclusion. Nothing was changed or flagged. This is not a sign that memory is fine.`;
	} else if (!hasChanges && !hasFlagged) {
		summary = "Memory looks good — no issues found.";
		if (agenticResult.summary) {
			summary += `\n\n${agenticResult.summary}`;
		}
	} else if (!hasChanges && hasFlagged) {
		// Findings exist but the model didn't propose any structural edits.
		// Surface the count so the human knows to look at the card.
		summary = `Flagged ${agenticResult.flaggedIssues.length} issue${agenticResult.flaggedIssues.length === 1 ? "" : "s"} for review (no auto-edits applied).`;
		if (agenticResult.summary) {
			summary += `\n\n${agenticResult.summary}`;
		}
	} else {
		const parts: string[] = [];
		if (quickFixes.length > 0) {
			parts.push(`${quickFixes.length} quick fixes`);
		}
		if (appliedEdits.length > 0) {
			parts.push(`${appliedEdits.length} edits`);
		}
		if (failedEdits.length > 0) {
			parts.push(`${failedEdits.length} failed`);
		}
		summary = `Auto-applied ${parts.join(", ")}.`;
		if (hasFlagged) {
			summary += ` Plus ${agenticResult.flaggedIssues.length} flagged for review.`;
		}
		if (agenticResult.summary) {
			summary += `\n\n${agenticResult.summary}`;
		}
	}

	return {
		// A storage write with a failed index update is not a successful
		// reflection: the content changed, but search is known to be stale.
		success: agenticResult.success && failedEdits.length === 0,
		date,
		summary,
		incomplete,
		mode: "agentic",
		autoApplied: quickFixes.length + appliedEdits.length,
		proposed: 0, // Nothing left pending — all auto-applied
		quickFixes,
		edits: appliedEdits,
		failedEdits: failedEdits.length > 0 ? failedEdits : undefined,
		flaggedIssues: [
			...agenticResult.flaggedIssues.map((f) => ({ path: f.path, issue: f.issue })),
			...refusedEdits.map((e) => ({
				path: e.path,
				issue:
					e.action === "delete"
						? `Reflection proposed deleting this file and was refused: ${e.reason}`
						: `Reflection proposed a rewrite of this file and was refused: ${e.reason}`,
			})),
		],
		error:
			agenticResult.error ??
			(failedEdits.length > 0
				? `Reflection completed with partial failures: ${failedEdits.join("; ")}`
				: undefined),
	};
}

/**
 * Run legacy single-shot reflection (fallback)
 */
async function runLegacyReflection(
	env: Env,
	storage: R2Storage,
	date: string,
): Promise<ReflectionResult> {
	const llm = new WorkersAIProvider(env.AI);

	// 1. Gather context
	const context = await gatherContext(storage, date);

	// 2. Build prompt and call LLM
	const prompt = buildReflectionPrompt(context);
	const llmResult = await llm.complete(prompt, {
		systemPrompt: LEGACY_SYSTEM_PROMPT,
		maxTokens: 4096,
		temperature: 0.7,
	});

	// 3. Parse and validate response
	const reflection = parseReflectionResponse(llmResult.response, date);

	// 4. Write staged changes
	const pendingPath = `${PENDING_DIR}/${date}.md`;
	await storage.write(pendingPath, reflection.content);

	// 5. Update last reflection timestamp
	await storage.write(
		LAST_REFLECTION_PATH,
		JSON.stringify({
			timestamp: Date.now(),
			date,
		}),
	);

	return {
		success: true,
		date,
		pendingPath,
		summary: reflection.summary,
		mode: "legacy",
	};
}

/**
 * Gather all context needed for legacy reflection
 */
async function gatherContext(storage: R2Storage, date: string): Promise<ReflectionContext> {
	// Get last reflection time
	let lastReflection: LastReflection | null = null;
	try {
		const lastReflectionFile = await storage.read(LAST_REFLECTION_PATH);
		if (lastReflectionFile) {
			lastReflection = JSON.parse(lastReflectionFile.content);
		}
	} catch {
		// First reflection, no previous timestamp
	}

	// List recent files (since last reflection, or all if first time)
	const allFiles = await storage.list("memory", true);
	const recentFiles = filterRecentFiles(allFiles, lastReflection?.timestamp);

	// Read core memory files
	const coreMemory: Record<string, string> = {};
	for (const path of CORE_MEMORY_PATHS) {
		const file = await storage.read(path);
		if (file) {
			coreMemory[path] = file.content;
		}
	}

	// Read pattern files
	const patterns: Record<string, string> = {};
	const patternFiles = await storage.list(PATTERNS_DIR, true);
	for (const pf of patternFiles) {
		if (pf.path.endsWith(".md")) {
			const file = await storage.read(pf.path);
			if (file) {
				patterns[pf.path] = file.content;
			}
		}
	}

	return {
		date,
		lastReflection,
		recentFiles,
		coreMemory,
		patterns,
	};
}

/**
 * Filter files modified since a timestamp
 */
function filterRecentFiles(files: MemoryFileMetadata[], since?: number): MemoryFileMetadata[] {
	if (!since) {
		// First reflection - include all files
		return files;
	}

	return files.filter((f) => {
		const fileTime = new Date(f.updated_at).getTime();
		return fileTime > since;
	});
}

/**
 * Build the reflection prompt (legacy mode)
 */
function buildReflectionPrompt(context: ReflectionContext): string {
	const lastReflectionInfo = context.lastReflection
		? `Last reflection: ${context.lastReflection.date}`
		: "This is the first reflection";

	const recentFilesInfo =
		context.recentFiles.length > 0
			? context.recentFiles
					.map((f) => `- ${f.path} (${f.size} bytes, updated ${f.updated_at})`)
					.join("\n")
			: "No files modified since last reflection";

	const coreMemoryInfo = Object.entries(context.coreMemory)
		.map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
		.join("\n\n");

	const patternsInfo =
		Object.keys(context.patterns).length > 0
			? Object.entries(context.patterns)
					.map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
					.join("\n\n")
			: "No patterns documented yet";

	return `# Daily Reflection - ${context.date}

## Context
${lastReflectionInfo}

## Recent Activity
${recentFilesInfo}

## Current Knowledge Base

### Core Memory
${coreMemoryInfo}

### Patterns
${patternsInfo}

## Tasks

Analyze the memory system and provide:

1. **Summary** (2-3 sentences): What's the overall state of the memory?

2. **Consolidation**: Are there duplicate learnings or redundant information that should be merged?

3. **Gaps**: What knowledge is missing? What should be documented but isn't?

4. **Errors**: Any contradictions, outdated information, or mistakes?

5. **Suggestions for Human**: Workflow improvements, productivity ideas, tools to explore

6. **Suggestions for Agent**: How could the agent operate more effectively?

7. **New Ideas**: Future projects, experiments, things to build

## Output Format

Respond in this exact markdown format:

\`\`\`markdown
# Reflection - ${context.date}

## Summary
[2-3 sentence summary]

## Consolidation Suggestions
- [suggestion 1]
- [suggestion 2]

## Knowledge Gaps
- [gap 1]
- [gap 2]

## Errors Found
- [error 1] (or "None found")

## Suggestions for Human
- [suggestion 1]
- [suggestion 2]

## Suggestions for Agent
- [suggestion 1]
- [suggestion 2]

## New Ideas
- [idea 1]
- [idea 2]
\`\`\``;
}

const LEGACY_SYSTEM_PROMPT = `You are an AI agent reflecting on your memory system to improve over time.

Your memory contains:
- learnings.md: Technical lessons and gotchas
- preferences.md: Communication and code style preferences
- projects.md: Active and past projects
- patterns/: Reusable code patterns and knowledge

Your goal is to:
1. Keep the memory clean and well-organized
2. Identify what's missing that would be useful
3. Spot mistakes or outdated information
4. Suggest improvements for both the human and the agent

Be specific and actionable. Don't be vague.
If something is working well, say so briefly and move on.
Focus on what could be improved.`;

interface ParsedReflection {
	summary: string;
	content: string;
}

/**
 * Parse the LLM response and extract structured content (legacy mode)
 */
function parseReflectionResponse(response: string, date: string): ParsedReflection {
	// Try to extract markdown block
	const markdownMatch = response.match(/```markdown\n([\s\S]*?)\n```/);
	const content = markdownMatch ? markdownMatch[1].trim() : response.trim();

	// Extract summary section
	const summaryMatch = content.match(/## Summary\n([\s\S]*?)(?=\n##|$)/);
	const summary = summaryMatch
		? summaryMatch[1].trim().slice(0, 200)
		: `Reflection completed for ${date}`;

	return {
		summary,
		content,
	};
}

/**
 * Expose for testing
 */
export const _internal = {
	gatherContext,
	filterRecentFiles,
	buildReflectionPrompt,
	parseReflectionResponse,
};
