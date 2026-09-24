/**
 * Agentic Reflection Runner
 *
 * Implements the two-tier reflection architecture:
 * - Phase A: Quick Scan (GLM Flash) - auto-applies low-risk fixes
 * - Phase B: Deep Analysis (Gemma 4 by default) - proposes substantive changes
 */

import type { LLMCompletionResult, LLMMessage, LLMTool, LLMToolCall } from "../llm/types";
import { REFLECTION_MODELS, WorkersAIProvider } from "../llm/workers-ai";
import type { R2Storage } from "../storage/r2";
import type { Env } from "../types";
import {
	type AutoAppliedFix,
	type FlaggedIssue,
	type ProposedEdit,
	type ToolExecutionContext,
	type ToolResult,
	createExecutionContext,
	executeReflectionTool,
} from "./tool-executor";
import { QUICK_SCAN_TOOLS, REFLECTION_TOOLS } from "./tools";

/**
 * Turn budget for each phase.
 *
 * The old caps (5 and 10) were never reached with work done: a real run spent
 * all five quick-scan turns reading 15 of 33 files, and all ten deep-analysis
 * turns reading files and checking backlinks one call at a time. Neither phase
 * ever called its finish tool, nothing was proposed, and the run was reported
 * as "Memory looks good". A full run at these caps is still only a few minutes
 * of wall time, well inside the 15-minute limit for a cron-triggered Worker.
 */
export const MAX_QUICK_SCAN_ITERATIONS = 12;
export const MAX_DEEP_ANALYSIS_ITERATIONS = 25;

/** When this many turns are left, tell the model to stop exploring and report. */
const WRAP_UP_TURNS = 3;

/**
 * Rough ceiling on accumulated message characters per phase (~4 chars per
 * token). Past this, the oldest tool results are shortened so the history
 * stays inside the model's context window. GLM 4.7 Flash has 131k tokens,
 * Gemma 4 has 256k.
 */
const QUICK_SCAN_CONTEXT_CHARS = 240_000;
const DEEP_ANALYSIS_CONTEXT_CHARS = 480_000;

/** Empty responses (no text, no tool call) tolerated before the phase gives up. */
const MAX_EMPTY_STOPS = 2;

/** Tools the model may still use on its final turn. */
const QUICK_SCAN_FINAL_TOOLS = new Set(["autoApply", "flagForDeepAnalysis", "finishQuickScan"]);
const DEEP_ANALYSIS_FINAL_TOOLS = new Set(["proposeEdit", "flagIssue", "finishReflection"]);

/** System prompts for each phase */
const QUICK_SCAN_SYSTEM_PROMPT = `You are a quick-scan agent checking memory files for simple issues.

Your task is to:
1. List files in the memory directory
2. Read files and check for: typos, formatting issues, trailing whitespace, missing newlines, exact duplicates
3. Auto-apply safe fixes immediately using the autoApply tool
4. Flag complex issues (contradictions, outdated info, semantic duplicates) for deep analysis

Rules:
- ONLY auto-apply fixes you are 100% certain about
- Never auto-apply changes to code blocks
- Never auto-apply changes that alter meaning
- When in doubt, flag for deep analysis instead
- Be efficient - scan systematically, don't re-read files
- You have a limited number of turns. Read several files per turn
- Large files come back in pages. You don't need to page through everything;
  flag a large file for deep analysis if it looks disorganised

Call finishQuickScan when done.`;

const DEEP_ANALYSIS_SYSTEM_PROMPT = `You are an AI agent performing deep reflection on your memory system.

Your memory contains:
- memory/learnings.md: Technical lessons and gotchas
- memory/preferences.md: Communication and code style preferences
- memory/projects.md: Active and past projects
- memory/patterns/: Reusable code patterns and knowledge
- memory/workload/: Work tracking, todos, and plans

Memory files can reference each other using Obsidian-style wikilinks:
[[path/to/other-file]] or [[path|display text]]. These are indexed as
backlinks — use the getBacklinks tool to see which files reference a
target. High backlink count means the file is a hub; zero backlinks
on a non-leaf file often means it's orphaned.

Your task is to:
1. Search memory to understand what's there
2. Identify issues: contradictions, outdated info, gaps, semantic
   duplicates, orphaned files, and missing cross-references
3. Fix what you can with proposeEdit, and record the rest with flagIssue
4. Be specific - if you find an issue, write the exact fix or the exact problem

Rules:
- proposeEdit changes are applied automatically after the run. Be careful:
  prefer append for additions, and only use replace when you have read the
  whole file and your content is the complete new file
- Use flagIssue for anything too large or risky to write as an edit. A
  flagged issue is shown to the human; an unrecorded finding is lost
- You have a limited number of turns. Make several tool calls per turn
  (for example, read 3-5 files at once) instead of one at a time
- Do not spend the whole budget reading. Record findings as you go
- Report only what the files show now. Memory often describes past
  incidents and how they were fixed; a note like "restored after a bad
  write" is history, not a current problem. If you suspect damage, say
  what you saw in the file (quote it), not what you infer
- One flag per problem. If several files share a problem, flag it once
  and list the files in the issue text
- Focus on substantive improvements, not formatting (quick scan handles that)
- If issues were flagged from quick scan, analyze them first
- Use searchMemory to find related content before proposing merges
- Use getBacklinks before proposing deletion or merge of a referenced file
- When two files clearly relate but don't link, propose a proposeEdit that
  adds a [[wikilink]] in the natural spot. Favour a short "See also"
  section over inline links unless the flow reads naturally.
- Be specific in your reasons - explain what's wrong and why

Call finishReflection when done.`;

/**
 * Result of the agentic reflection process
 */
export interface AgenticReflectionResult {
	success: boolean;
	summary: string;
	proposedEdits: ProposedEdit[];
	autoAppliedFixes: AutoAppliedFix[];
	quickScanIterations: number;
	deepAnalysisIterations: number;
	flaggedIssues: FlaggedIssue[];
	/** Storage writes that landed but failed to update the search index. */
	writeFailures: string[];
	/** True if the quick scan called finishQuickScan (or stopped on its own). */
	quickScanFinished: boolean;
	/** True if deep analysis called finishReflection (or stopped on its own).
	 *  False means it ran out of turns, so an empty result proves nothing. */
	deepAnalysisFinished: boolean;
	error?: string;
}

/**
 * Run the full agentic reflection (both phases)
 */
export async function runAgenticReflection(
	env: Env,
	storage: R2Storage,
	options?: { dryRun?: boolean },
): Promise<AgenticReflectionResult> {
	const context = createExecutionContext(storage, env, options);
	const inventory = await buildInventory(storage);

	// Phase A: Quick Scan
	const quickScanResult = await runQuickScan(env, context, inventory);
	if (!quickScanResult.success) {
		return {
			success: false,
			summary: `Quick scan failed: ${quickScanResult.error}`,
			proposedEdits: [],
			autoAppliedFixes: context.autoAppliedFixes,
			quickScanIterations: quickScanResult.iterations,
			deepAnalysisIterations: 0,
			flaggedIssues: context.flaggedIssues,
			writeFailures: context.writeFailures,
			quickScanFinished: false,
			deepAnalysisFinished: false,
			error: quickScanResult.error,
		};
	}

	// Phase B: Deep Analysis
	const deepAnalysisResult = await runDeepAnalysis(env, context, inventory);

	return {
		success: deepAnalysisResult.success,
		summary: deepAnalysisResult.summary,
		proposedEdits: context.proposedEdits,
		autoAppliedFixes: context.autoAppliedFixes,
		quickScanIterations: quickScanResult.iterations,
		deepAnalysisIterations: deepAnalysisResult.iterations,
		flaggedIssues: context.flaggedIssues,
		writeFailures: context.writeFailures,
		quickScanFinished: quickScanResult.finished,
		deepAnalysisFinished: deepAnalysisResult.finished,
		error: deepAnalysisResult.error,
	};
}

/** Max files listed in the inventory handed to the model. */
const INVENTORY_MAX_FILES = 200;

/**
 * List every memory file up front, with size and last-updated date.
 *
 * Both phases used to start by calling listFiles, costing a turn each, and the
 * quick scan only listed the top level. Handing the model the inventory lets
 * it spend its turns reading and deciding, and the sizes tell it which files
 * will need paging.
 */
export async function buildInventory(storage: R2Storage): Promise<string> {
	let files: Awaited<ReturnType<R2Storage["list"]>>;
	try {
		files = await storage.list("memory", true);
	} catch {
		return "";
	}
	const relevant = files
		.filter((f) => !f.path.endsWith("/") && !f.path.startsWith("memory/reflections/"))
		.sort((a, b) => a.path.localeCompare(b.path));
	if (relevant.length === 0) return "";

	const lines = relevant
		.slice(0, INVENTORY_MAX_FILES)
		.map((f) => `- ${f.path} (${f.size} bytes, updated ${String(f.updated_at).slice(0, 10)})`);
	if (relevant.length > INVENTORY_MAX_FILES) {
		lines.push(`- ...and ${relevant.length - INVENTORY_MAX_FILES} more (use listFiles)`);
	}
	return `Memory files (${relevant.length}):\n${lines.join("\n")}`;
}

/** Preserve the call/result pairing in accumulated conversation history. */
function pushAssistantTurn(messages: LLMMessage[], result: LLMCompletionResult): void {
	if (!result.response && !result.toolCalls?.length) return;

	messages.push({
		role: "assistant",
		content: result.response,
		...(result.toolCalls?.length ? { tool_calls: result.toolCalls } : {}),
	});
}

function pushToolResult(
	messages: LLMMessage[],
	toolCall: LLMToolCall,
	toolResult: ToolResult,
): void {
	messages.push({
		role: "tool",
		content: JSON.stringify(toolResult),
		tool_call_id: toolCall.id,
	});
}

/** Characters kept from a tool result once it has been shortened. */
const ELIDED_PREVIEW_CHARS = 300;

/**
 * Keep the history inside the context window by shortening the oldest tool
 * results first. The call/result pairing is left intact; only the content of
 * a result is cut. Findings already live in the execution context, so all the
 * model loses is the raw text of files it read many turns ago.
 */
export function compactHistory(messages: LLMMessage[], maxChars: number): void {
	let total = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
	if (total <= maxChars) return;

	for (const m of messages) {
		if (total <= maxChars) break;
		if (m.role !== "tool" || m.content.length <= ELIDED_PREVIEW_CHARS * 2) continue;
		const before = m.content.length;
		m.content = `${m.content.slice(0, ELIDED_PREVIEW_CHARS)}...[older result shortened to save context; re-read if you need it]`;
		total -= before - m.content.length;
	}
}

/** Tell the model how much budget is left, and to wrap up near the end. */
function budgetNudge(remaining: number, finishTool: string, recordTools: string): string | null {
	if (remaining > WRAP_UP_TURNS) return null;
	if (remaining <= 1) {
		return `This is your final turn. Record any remaining findings with ${recordTools}, then call ${finishTool}. No more reading.`;
	}
	return `You have ${remaining} turns left. Stop exploring. Record what you found with ${recordTools}, then call ${finishTool}.`;
}

interface PhaseConfig {
	phase: "quick_scan" | "deep_analysis";
	model: string;
	systemPrompt: string;
	initialPrompt: string;
	tools: LLMTool[];
	finalTools: Set<string>;
	finishTool: string;
	recordTools: string;
	maxIterations: number;
	maxContextChars: number;
	maxTokens: number;
	temperature: number;
}

interface PhaseResult {
	success: boolean;
	iterations: number;
	/** True if the model finished on its own rather than running out of turns. */
	finished: boolean;
	/** Arguments of the finish tool call, or the final prose if it stopped without one. */
	finishArgs?: Record<string, unknown>;
	finalText?: string;
	error?: string;
}

/**
 * The shared tool-calling loop for both phases.
 */
async function runPhase(
	env: Env,
	context: ToolExecutionContext,
	config: PhaseConfig,
): Promise<PhaseResult> {
	const llm = new WorkersAIProvider(env.AI, config.model);
	const messages: LLMMessage[] = [{ role: "user", content: config.initialPrompt }];

	let iterations = 0;
	let emptyStops = 0;
	let checkpointSent = false;
	const recordedAtStart = context.proposedEdits.length + context.flaggedIssues.length;

	while (iterations < config.maxIterations) {
		iterations++;
		const remaining = config.maxIterations - iterations + 1;
		const isFinalTurn = remaining === 1;
		const tools = isFinalTurn
			? config.tools.filter((t) => config.finalTools.has(t.name))
			: config.tools;

		compactHistory(messages, config.maxContextChars);

		let result: LLMCompletionResult;
		try {
			result = await llm.complete(messages, {
				systemPrompt: config.systemPrompt,
				maxTokens: config.maxTokens,
				temperature: config.temperature,
				tools,
			});
		} catch (e) {
			return {
				success: false,
				iterations,
				finished: false,
				error: `${config.phase === "quick_scan" ? "Quick scan" : "Deep analysis"} error: ${e instanceof Error ? e.message : String(e)}`,
			};
		}

		console.log(
			JSON.stringify({
				phase: config.phase,
				iteration: iterations,
				remaining,
				model: config.model,
				response: result.response?.slice(0, 200),
				toolCalls: result.toolCalls?.map((t) => t.name),
				proposed: context.proposedEdits.length,
				flagged: context.flaggedIssues.length,
			}),
		);

		pushAssistantTurn(messages, result);

		if (!result.toolCalls || result.toolCalls.length === 0) {
			const text = result.response?.trim() ?? "";
			// An empty stop is not a conclusion. Gemma 4 does this after a long
			// run of reads: finish_reason "stop", no text, no tool call. Counting
			// it as "finished" turned a model that gave up into "memory looks
			// good". Ask once more for a real answer before giving up.
			if (!text && emptyStops < MAX_EMPTY_STOPS && iterations < config.maxIterations) {
				emptyStops++;
				console.log(JSON.stringify({ phase: config.phase, event: "empty_stop", emptyStops }));
				messages.push({
					role: "user",
					content: `You stopped without an answer. Record what you found with ${config.recordTools}, then call ${config.finishTool} with a summary. If you found nothing wrong, call ${config.finishTool} and say what you checked.`,
				});
				continue;
			}
			console.log(
				JSON.stringify({ phase: config.phase, event: "no_tool_calls", finishing: !!text }),
			);
			return { success: true, iterations, finished: !!text, finalText: text };
		}

		let finishArgs: Record<string, unknown> | undefined;
		for (const toolCall of result.toolCalls) {
			const toolResult = await executeReflectionTool(toolCall, context);
			pushToolResult(messages, toolCall, toolResult);
			if (toolCall.name === config.finishTool && toolResult.success) {
				finishArgs = toolCall.arguments;
			}
		}
		// Execute every call in the turn before stopping: a model will often
		// send its last proposeEdit alongside finishReflection, and breaking out
		// early dropped those.
		if (finishArgs) {
			return { success: true, iterations, finished: true, finishArgs };
		}

		const left = remaining - 1;
		const nudge = budgetNudge(left, config.finishTool, config.recordTools);
		if (nudge) {
			messages.push({ role: "user", content: nudge });
		} else if (
			!checkpointSent &&
			iterations >= Math.floor(config.maxIterations / 2) &&
			context.proposedEdits.length + context.flaggedIssues.length === recordedAtStart
		) {
			// Halfway with nothing recorded is the pattern that produced months of
			// empty reports: the model reads and reads and never commits.
			checkpointSent = true;
			messages.push({
				role: "user",
				content: `Checkpoint: ${iterations} of ${config.maxIterations} turns used and nothing recorded yet. Record the problems you have already seen with ${config.recordTools} now, then keep going. If memory really is clean, call ${config.finishTool} and explain what you checked.`,
			});
		}
	}

	console.log(
		JSON.stringify({
			phase: config.phase,
			event: "iteration_limit_reached",
			iterations,
			proposed: context.proposedEdits.length,
			flagged: context.flaggedIssues.length,
		}),
	);
	return { success: true, iterations, finished: false };
}

/**
 * Phase A: Quick Scan with GLM Flash
 */
async function runQuickScan(
	env: Env,
	context: ToolExecutionContext,
	inventory: string,
): Promise<{ success: boolean; iterations: number; finished: boolean; error?: string }> {
	let initialPrompt = `Begin quick scan. Read memory files and auto-apply any safe fixes you find. Flag complex issues for deep analysis. You have ${MAX_QUICK_SCAN_ITERATIONS} turns; read several files per turn.`;
	if (inventory) initialPrompt += `\n\n${inventory}`;

	const result = await runPhase(env, context, {
		phase: "quick_scan",
		model: env.REFLECTION_MODEL_FAST ?? REFLECTION_MODELS.fast,
		systemPrompt: QUICK_SCAN_SYSTEM_PROMPT,
		initialPrompt,
		tools: QUICK_SCAN_TOOLS,
		finalTools: QUICK_SCAN_FINAL_TOOLS,
		finishTool: "finishQuickScan",
		recordTools: "autoApply or flagForDeepAnalysis",
		maxIterations: MAX_QUICK_SCAN_ITERATIONS,
		maxContextChars: QUICK_SCAN_CONTEXT_CHARS,
		maxTokens: 2048,
		temperature: 0.3, // Lower temperature for more consistent quick fixes
	});

	return {
		success: result.success,
		iterations: result.iterations,
		finished: result.finished,
		error: result.error,
	};
}

/**
 * Phase B: Deep Analysis
 */
async function runDeepAnalysis(
	env: Env,
	context: ToolExecutionContext,
	inventory: string,
): Promise<{
	success: boolean;
	iterations: number;
	finished: boolean;
	summary: string;
	error?: string;
}> {
	// Build initial prompt including any flagged issues from quick scan
	let initialPrompt = `Begin deep analysis of memory. Identify problems, fix what you can with proposeEdit, and record the rest with flagIssue. You have ${MAX_DEEP_ANALYSIS_ITERATIONS} turns; make several tool calls per turn and record findings as you go.`;

	if (inventory) initialPrompt += `\n\n${inventory}`;

	if (context.flaggedIssues.length > 0) {
		const flaggedList = context.flaggedIssues.map((f) => `- ${f.path}: ${f.issue}`).join("\n");
		initialPrompt += `\n\nThe quick scan flagged these issues for deeper analysis:\n${flaggedList}\n\nPlease analyze these first. They are already shown to the human, so only flag them again if you have something to add.`;
	}

	if (context.autoAppliedFixes.length > 0) {
		initialPrompt += `\n\nNote: Quick scan already auto-applied ${context.autoAppliedFixes.length} low-risk fixes.`;
	}

	const result = await runPhase(env, context, {
		phase: "deep_analysis",
		model: env.REFLECTION_MODEL ?? REFLECTION_MODELS.primary,
		systemPrompt: DEEP_ANALYSIS_SYSTEM_PROMPT,
		initialPrompt,
		tools: REFLECTION_TOOLS,
		finalTools: DEEP_ANALYSIS_FINAL_TOOLS,
		finishTool: "finishReflection",
		recordTools: "proposeEdit or flagIssue",
		maxIterations: MAX_DEEP_ANALYSIS_ITERATIONS,
		maxContextChars: DEEP_ANALYSIS_CONTEXT_CHARS,
		maxTokens: 4096,
		temperature: 0.7,
	});

	let summary = "";
	if (typeof result.finishArgs?.summary === "string") {
		summary = result.finishArgs.summary;
	} else if (result.finalText) {
		summary = result.finalText.slice(0, 500);
	}
	if (!summary && result.finished) {
		summary = "Deep analysis completed";
	}
	if (!result.finished && result.success) {
		const why =
			result.iterations >= MAX_DEEP_ANALYSIS_ITERATIONS
				? `ran out of turns (${result.iterations}/${MAX_DEEP_ANALYSIS_ITERATIONS})`
				: `stopped responding after ${result.iterations} of ${MAX_DEEP_ANALYSIS_ITERATIONS} turns`;
		summary = `Deep analysis ${why} before finishing. Proposed ${context.proposedEdits.length} edits and flagged ${context.flaggedIssues.length} issues before it stopped.`;
	}

	return {
		success: result.success,
		iterations: result.iterations,
		finished: result.finished,
		summary,
		error: result.error,
	};
}

/**
 * Run only deep analysis (skip quick scan)
 * Useful for testing or when quick scan isn't needed
 */
export async function runDeepAnalysisOnly(
	env: Env,
	storage: R2Storage,
): Promise<AgenticReflectionResult> {
	const context = createExecutionContext(storage, env);
	const inventory = await buildInventory(storage);
	const result = await runDeepAnalysis(env, context, inventory);

	return {
		success: result.success,
		summary: result.summary,
		proposedEdits: context.proposedEdits,
		autoAppliedFixes: context.autoAppliedFixes,
		quickScanIterations: 0,
		deepAnalysisIterations: result.iterations,
		flaggedIssues: context.flaggedIssues,
		writeFailures: context.writeFailures,
		quickScanFinished: true,
		deepAnalysisFinished: result.finished,
		error: result.error,
	};
}
