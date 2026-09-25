/**
 * Agentic Reflection Runner
 *
 * Two steps:
 * 1. Hygiene: deterministic whitespace tidy (no model). See hygiene.ts.
 * 2. Deep analysis: one model, one focus per night (see focus.ts), with a
 *    turn budget, checkpoint nudges, and honest reporting when it doesn't
 *    finish.
 *
 * An LLM "quick scan" used to run first. It spent up to 12 turns a night
 * looking for whitespace problems and never applied a fix; hygiene.ts does
 * that job with code.
 */

import type { LLMCompletionResult, LLMMessage, LLMTool, LLMToolCall } from "../llm/types";
import { REFLECTION_MODELS, WorkersAIProvider } from "../llm/workers-ai";
import type { R2Storage } from "../storage/r2";
import type { Env } from "../types";
import { type ReflectionFocus, focusForDate, inFocus } from "./focus";
import { runHygiene } from "./hygiene";
import {
	type AutoAppliedFix,
	type FlaggedIssue,
	type ProposedEdit,
	type ToolExecutionContext,
	type ToolResult,
	createExecutionContext,
	executeReflectionTool,
} from "./tool-executor";
import { REFLECTION_TOOLS } from "./tools";

/**
 * Turn budget for deep analysis.
 *
 * The old cap of 10 was always reached with nothing done: the model read
 * files one call at a time and never called finishReflection. A full run at
 * 25 is a few minutes of wall time, well inside the 15-minute limit for a
 * cron-triggered Worker.
 */
export const MAX_DEEP_ANALYSIS_ITERATIONS = 25;

/** When this many turns are left, tell the model to stop exploring and report. */
const WRAP_UP_TURNS = 3;

/**
 * Rough ceiling on accumulated message characters (~4 chars per token). Past
 * this, the oldest tool results are shortened so the history stays inside the
 * model's context window.
 */
const DEEP_ANALYSIS_CONTEXT_CHARS = 400_000;

/**
 * Wall-clock budget. A cron-triggered Worker gets 15 minutes. The best model
 * in our comparison (DeepSeek V4 Flash) took 13 minutes for 25 turns, so turn
 * count alone can't keep a run safe. After the soft deadline the model is told
 * to wrap up; after the hard deadline its next turn is the final one.
 */
export const SOFT_DEADLINE_MS = 9 * 60_000;
export const HARD_DEADLINE_MS = 11 * 60_000;

/** Empty responses (no text, no tool call) tolerated before giving up. */
const MAX_EMPTY_STOPS = 2;

/** Tools the model may still use on its final turn. */
const DEEP_ANALYSIS_FINAL_TOOLS = new Set(["proposeEdit", "flagIssue", "finishReflection"]);

const DEEP_ANALYSIS_SYSTEM_PROMPT = `You are an AI agent reviewing a personal memory store: markdown notes an engineering manager's coding agents read and write.

Layout (typical):
- memory/learnings*.md, memory/learnings/: technical lessons and gotchas
- memory/preferences.md, memory/soul.md: how the agent should behave
- memory/projects.md, memory/projects/: projects
- memory/people.md, memory/people/: people
- memory/patterns/, memory/reference/: reusable knowledge
- memory/workload/: todos and plans

Files link with Obsidian wikilinks: [[path/to/file]] or [[file|text]].
getBacklinks shows which files link to a file.

Each night has ONE focus, given in the first message. Stay on it.

How to work:
- Make several tool calls per turn (read 3-5 files at once).
- Record findings as you go. An unrecorded finding is lost.
- flagIssue: a problem for the human, with the fix you recommend. Quote the
  lines you mean. This is the default way to report.
- proposeEdit: applied automatically after the run, with no review. Use it
  for small, safe changes, mainly append (a "See also" link, a "superseded
  by" note). replace overwrites the WHOLE file; only use it on a file you
  have read completely. A replace that drops over 30% of a file is refused.
- Report only what the files show now. Notes about past incidents that were
  fixed are history, not current problems.
- One flag per problem. If several files share it, flag once and list them.
- If you find nothing wrong within the focus, call finishReflection and say
  what you checked. That is a fine result.

Call finishReflection with a 2-3 sentence summary when done.`;

/**
 * Result of the agentic reflection process
 */
export interface AgenticReflectionResult {
	success: boolean;
	summary: string;
	proposedEdits: ProposedEdit[];
	/** Hygiene fixes plus any autoApply fixes the model made. */
	autoAppliedFixes: AutoAppliedFix[];
	deepAnalysisIterations: number;
	flaggedIssues: FlaggedIssue[];
	/** Storage writes that landed but failed to update the search index. */
	writeFailures: string[];
	/** True if deep analysis called finishReflection (or stopped with an answer).
	 *  False means it ran out of turns or went silent, so an empty result
	 *  proves nothing. */
	deepAnalysisFinished: boolean;
	/** Tonight's focus. */
	focus: { id: string; title: string };
	/** Model used for deep analysis. */
	model: string;
	error?: string;
}

export interface ReflectionRunOptions {
	dryRun?: boolean;
	/** Force a focus id instead of the weekday rotation. */
	focus?: string;
	/** Override the deep-analysis model (for evaluating models with dry runs). */
	model?: string;
	/** Skip the hygiene step. */
	skipHygiene?: boolean;
	/** Date used to pick the focus. Defaults to now. */
	now?: Date;
	/** Clock for the wall-clock deadline. Tests only. */
	clock?: () => number;
}

/**
 * Run hygiene, then deep analysis on tonight's focus.
 */
export async function runAgenticReflection(
	env: Env,
	storage: R2Storage,
	options: ReflectionRunOptions = {},
): Promise<AgenticReflectionResult> {
	const context = createExecutionContext(storage, env, { dryRun: options.dryRun });
	const focus = focusForDate(options.now ?? new Date(), options.focus ?? env.REFLECTION_FOCUS);
	const model = options.model ?? env.REFLECTION_MODEL ?? REFLECTION_MODELS.primary;

	if (!options.skipHygiene && env.REFLECTION_HYGIENE !== "false") {
		try {
			const hygiene = await runHygiene(env, storage, { dryRun: options.dryRun });
			context.autoAppliedFixes.push(...hygiene.fixes);
			context.writeFailures.push(...hygiene.failures);
		} catch (e) {
			// Hygiene is a nicety. Never let it stop the analysis.
			console.error(JSON.stringify({ event: "hygiene_failed", error: String(e) }));
		}
	}

	const inventory = await buildInventory(storage, focus);
	const deep = await runDeepAnalysis(env, context, inventory, focus, model, options.clock);

	return {
		success: deep.success,
		summary: deep.summary,
		proposedEdits: context.proposedEdits,
		autoAppliedFixes: context.autoAppliedFixes,
		deepAnalysisIterations: deep.iterations,
		flaggedIssues: context.flaggedIssues,
		writeFailures: context.writeFailures,
		deepAnalysisFinished: deep.finished,
		focus: { id: focus.id, title: focus.title },
		model,
		error: deep.error,
	};
}

/** Max files listed in the inventory handed to the model. */
const INVENTORY_MAX_FILES = 200;

/**
 * List every memory file up front, with size and last-updated date.
 *
 * The model used to start by calling listFiles, costing a turn. Handing it
 * the inventory (limited to tonight's focus) lets
 * it spend its turns reading and deciding, and the sizes tell it which files
 * will need paging.
 */
export async function buildInventory(storage: R2Storage, focus?: ReflectionFocus): Promise<string> {
	let files: Awaited<ReturnType<R2Storage["list"]>>;
	try {
		files = await storage.list("memory", true);
	} catch {
		return "";
	}
	const relevant = files
		.filter((f) => !f.path.endsWith("/") && !f.path.startsWith("memory/reflections/"))
		.filter((f) => !focus || inFocus(focus, f.path))
		.sort((a, b) => a.path.localeCompare(b.path));
	if (relevant.length === 0) return "";

	const lines = relevant
		.slice(0, INVENTORY_MAX_FILES)
		.map((f) => `- ${f.path} (${f.size} bytes, updated ${String(f.updated_at).slice(0, 10)})`);
	if (relevant.length > INVENTORY_MAX_FILES) {
		lines.push(`- ...and ${relevant.length - INVENTORY_MAX_FILES} more (use listFiles)`);
	}
	const scope = focus && focus.paths.length > 0 ? " in scope for tonight's focus" : "";
	return `Memory files${scope} (${relevant.length}):\n${lines.join("\n")}`;
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
	phase: "deep_analysis";
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
	/** Clock, injectable for tests. */
	now?: () => number;
	softDeadlineMs?: number;
	hardDeadlineMs?: number;
}

type StopReason = "finished" | "turns" | "deadline" | "silent" | "error";

interface PhaseResult {
	success: boolean;
	iterations: number;
	stopReason: StopReason;
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
	let deadlineWarned = false;
	let stopReason: StopReason = "turns";
	const now = config.now ?? Date.now;
	const started = now();
	const softDeadline = config.softDeadlineMs ?? SOFT_DEADLINE_MS;
	const hardDeadline = config.hardDeadlineMs ?? HARD_DEADLINE_MS;
	const recordedAtStart = context.proposedEdits.length + context.flaggedIssues.length;

	while (iterations < config.maxIterations) {
		iterations++;
		const elapsed = now() - started;
		const pastHard = elapsed >= hardDeadline;
		const remaining = pastHard ? 1 : config.maxIterations - iterations + 1;
		const isFinalTurn = remaining === 1;
		if (pastHard) {
			messages.push({
				role: "user",
				content: `Time is up. This is your final turn. Record any remaining findings with ${config.recordTools}, then call ${config.finishTool}.`,
			});
		}
		const tools = isFinalTurn
			? config.tools.filter((t) => config.finalTools.has(t.name))
			: config.tools;

		compactHistory(messages, config.maxContextChars);

		let result: LLMCompletionResult;
		try {
			const request = {
				systemPrompt: config.systemPrompt,
				maxTokens: config.maxTokens,
				temperature: config.temperature,
				tools,
			};
			result = await llm.complete(messages, request);
			// Reasoning models can spend the whole token budget thinking and
			// return nothing (finish_reason "length", no content, no tool call).
			// DeepSeek V4 did this on a third of its turns with an 8k budget.
			// Retry the same turn once with thinking off so the run keeps moving.
			if (
				result.finishReason === "length" &&
				!result.toolCalls?.length &&
				!result.response?.trim()
			) {
				console.log(JSON.stringify({ phase: config.phase, event: "reasoning_overflow_retry" }));
				result = await llm.complete(messages, { ...request, thinking: false });
			}
		} catch (e) {
			return {
				success: false,
				iterations,
				finished: false,
				stopReason: "error",
				error: `Deep analysis error: ${e instanceof Error ? e.message : String(e)}`,
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
			if (!text && !isFinalTurn && emptyStops < MAX_EMPTY_STOPS) {
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
			return {
				success: true,
				iterations,
				finished: !!text,
				stopReason: text ? "finished" : "silent",
				finalText: text,
			};
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
			return { success: true, iterations, finished: true, stopReason: "finished", finishArgs };
		}

		if (isFinalTurn) {
			stopReason = pastHard ? "deadline" : "turns";
			break;
		}

		const left = remaining - 1;
		const nudge = budgetNudge(left, config.finishTool, config.recordTools);
		if (!nudge && !deadlineWarned && now() - started >= softDeadline) {
			deadlineWarned = true;
			messages.push({
				role: "user",
				content: `Time is nearly up (a couple of turns left). Stop exploring. Record what you found with ${config.recordTools}, then call ${config.finishTool}.`,
			});
		} else if (nudge) {
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
			event: "phase_unfinished",
			stopReason,
			iterations,
			proposed: context.proposedEdits.length,
			flagged: context.flaggedIssues.length,
		}),
	);
	return { success: true, iterations, finished: false, stopReason };
}

/**
 * Deep analysis on one focus.
 */
async function runDeepAnalysis(
	env: Env,
	context: ToolExecutionContext,
	inventory: string,
	focus: ReflectionFocus,
	model: string,
	clock?: () => number,
): Promise<{
	success: boolean;
	iterations: number;
	finished: boolean;
	summary: string;
	error?: string;
}> {
	let initialPrompt = `Tonight's focus: ${focus.title}

${focus.instructions}

You have ${MAX_DEEP_ANALYSIS_ITERATIONS} turns. Make several tool calls per turn and record findings as you go.`;

	if (inventory) initialPrompt += `\n\n${inventory}`;

	const result = await runPhase(env, context, {
		phase: "deep_analysis",
		model,
		systemPrompt: DEEP_ANALYSIS_SYSTEM_PROMPT,
		initialPrompt,
		tools: REFLECTION_TOOLS,
		finalTools: DEEP_ANALYSIS_FINAL_TOOLS,
		finishTool: "finishReflection",
		recordTools: "flagIssue or proposeEdit",
		maxIterations: MAX_DEEP_ANALYSIS_ITERATIONS,
		maxContextChars: DEEP_ANALYSIS_CONTEXT_CHARS,
		maxTokens: 16384,
		temperature: 0.4,
		now: clock,
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
			result.stopReason === "deadline"
				? `hit its time limit after ${result.iterations} turns`
				: result.stopReason === "silent"
					? `stopped responding after ${result.iterations} turns`
					: `ran out of turns (${result.iterations}/${MAX_DEEP_ANALYSIS_ITERATIONS})`;
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
 * Run only deep analysis (skip hygiene). Useful for tests.
 */
export async function runDeepAnalysisOnly(
	env: Env,
	storage: R2Storage,
	options: ReflectionRunOptions = {},
): Promise<AgenticReflectionResult> {
	return runAgenticReflection(env, storage, { ...options, skipHygiene: true });
}
