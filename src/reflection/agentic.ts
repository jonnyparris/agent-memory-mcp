/**
 * Agentic Reflection Runner
 *
 * Implements the two-tier reflection architecture:
 * - Phase A: Quick Scan (GLM Flash) - auto-applies low-risk fixes
 * - Phase B: Deep Analysis (Kimi K2.5) - proposes substantive changes
 */

import type { LLMMessage } from "../llm/types";
import { REFLECTION_MODELS, WorkersAIProvider } from "../llm/workers-ai";
import type { R2Storage } from "../storage/r2";
import type { Env } from "../types";
import {
	type AutoAppliedFix,
	type FlaggedIssue,
	type ProposedEdit,
	type ToolExecutionContext,
	createExecutionContext,
	executeReflectionTool,
} from "./tool-executor";
import { QUICK_SCAN_TOOLS, REFLECTION_TOOLS } from "./tools";

/** Maximum iterations for each phase to prevent infinite loops */
const MAX_QUICK_SCAN_ITERATIONS = 5;
const MAX_DEEP_ANALYSIS_ITERATIONS = 10;

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

Call finishQuickScan when done.`;

const DEEP_ANALYSIS_SYSTEM_PROMPT = `You are an AI agent performing deep reflection on your memory system.

Your memory contains:
- memory/learnings.md: Technical lessons and gotchas
- memory/preferences.md: Communication and code style preferences  
- memory/projects.md: Active and past projects
- memory/patterns/: Reusable code patterns and knowledge
- memory/workload/: Work tracking, todos, and plans

Your task is to:
1. Search memory to understand what's there
2. Identify issues: contradictions, outdated info, gaps, semantic duplicates
3. Propose specific edits to fix issues (staged for human review)
4. Be specific - if you find an issue, propose the exact fix

Rules:
- All proposed changes go through human review - be bold but thoughtful
- Focus on substantive improvements, not formatting (quick scan handles that)
- If issues were flagged from quick scan, analyze them first
- Use searchMemory to find related content before proposing merges
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
	error?: string;
}

/**
 * Run the full agentic reflection (both phases)
 */
export async function runAgenticReflection(
	env: Env,
	storage: R2Storage,
): Promise<AgenticReflectionResult> {
	const context = createExecutionContext(storage, env);

	// Phase A: Quick Scan
	const quickScanResult = await runQuickScan(env, context);
	if (!quickScanResult.success) {
		return {
			success: false,
			summary: `Quick scan failed: ${quickScanResult.error}`,
			proposedEdits: [],
			autoAppliedFixes: context.autoAppliedFixes,
			quickScanIterations: quickScanResult.iterations,
			deepAnalysisIterations: 0,
			flaggedIssues: context.flaggedIssues,
			error: quickScanResult.error,
		};
	}

	// Phase B: Deep Analysis
	const deepAnalysisResult = await runDeepAnalysis(env, context);

	return {
		success: true,
		summary: deepAnalysisResult.summary,
		proposedEdits: context.proposedEdits,
		autoAppliedFixes: context.autoAppliedFixes,
		quickScanIterations: quickScanResult.iterations,
		deepAnalysisIterations: deepAnalysisResult.iterations,
		flaggedIssues: context.flaggedIssues,
	};
}

/**
 * Phase A: Quick Scan with GLM Flash
 */
async function runQuickScan(
	env: Env,
	context: ToolExecutionContext,
): Promise<{ success: boolean; iterations: number; error?: string }> {
	const model = env.REFLECTION_MODEL_FAST ?? REFLECTION_MODELS.fast;
	const llm = new WorkersAIProvider(env.AI, model);

	const messages: LLMMessage[] = [
		{
			role: "user",
			content:
				"Begin quick scan. List memory files, read them, and auto-apply any safe fixes you find. Flag complex issues for deep analysis.",
		},
	];

	let iterations = 0;
	let finished = false;

	while (!finished && iterations < MAX_QUICK_SCAN_ITERATIONS) {
		iterations++;

		try {
			const result = await llm.complete(messages, {
				systemPrompt: QUICK_SCAN_SYSTEM_PROMPT,
				maxTokens: 2048,
				temperature: 0.3, // Lower temperature for more consistent quick fixes
				tools: QUICK_SCAN_TOOLS,
			});

			// Debug logging
			console.log(
				JSON.stringify({
					phase: "quick_scan",
					iteration: iterations,
					model,
					response: result.response?.slice(0, 200),
					toolCalls: result.toolCalls,
				}),
			);

			// Add assistant response to history
			if (result.response) {
				messages.push({ role: "assistant", content: result.response });
			}

			// Check for tool calls
			if (!result.toolCalls || result.toolCalls.length === 0) {
				// No tool calls - consider it finished
				console.log(
					JSON.stringify({ phase: "quick_scan", event: "no_tool_calls", finishing: true }),
				);
				break;
			}

			// Execute each tool call
			for (const toolCall of result.toolCalls) {
				const toolResult = await executeReflectionTool(toolCall, context);

				// Add tool result to messages
				messages.push({
					role: "tool",
					content: JSON.stringify(toolResult),
					tool_call_id: toolCall.name,
				});

				// Check if quick scan is complete
				if (toolCall.name === "finishQuickScan" && toolResult.success) {
					finished = true;
					break;
				}
			}
		} catch (e) {
			return {
				success: false,
				iterations,
				error: `Quick scan error: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
	}

	return { success: true, iterations };
}

/**
 * Phase B: Deep Analysis with Kimi K2.5
 */
async function runDeepAnalysis(
	env: Env,
	context: ToolExecutionContext,
): Promise<{ success: boolean; iterations: number; summary: string; error?: string }> {
	const model = env.REFLECTION_MODEL ?? REFLECTION_MODELS.primary;
	const llm = new WorkersAIProvider(env.AI, model);

	// Build initial prompt including any flagged issues from quick scan
	let initialPrompt =
		"Begin deep analysis of memory. Search for issues, identify problems, and propose specific fixes.";

	if (context.flaggedIssues.length > 0) {
		const flaggedList = context.flaggedIssues.map((f) => `- ${f.path}: ${f.issue}`).join("\n");
		initialPrompt += `\n\nThe quick scan flagged these issues for deeper analysis:\n${flaggedList}\n\nPlease analyze these first.`;
	}

	if (context.autoAppliedFixes.length > 0) {
		initialPrompt += `\n\nNote: Quick scan already auto-applied ${context.autoAppliedFixes.length} low-risk fixes.`;
	}

	const messages: LLMMessage[] = [{ role: "user", content: initialPrompt }];

	let iterations = 0;
	let finished = false;
	let summary = "";

	while (!finished && iterations < MAX_DEEP_ANALYSIS_ITERATIONS) {
		iterations++;

		try {
			const result = await llm.complete(messages, {
				systemPrompt: DEEP_ANALYSIS_SYSTEM_PROMPT,
				maxTokens: 4096,
				temperature: 0.7,
				tools: REFLECTION_TOOLS,
			});

			// Debug logging
			console.log(
				JSON.stringify({
					phase: "deep_analysis",
					iteration: iterations,
					model,
					response: result.response?.slice(0, 200),
					toolCalls: result.toolCalls,
				}),
			);

			// Add assistant response to history
			if (result.response) {
				messages.push({ role: "assistant", content: result.response });
			}

			// Check for tool calls
			if (!result.toolCalls || result.toolCalls.length === 0) {
				// No tool calls - extract summary from response
				console.log(
					JSON.stringify({ phase: "deep_analysis", event: "no_tool_calls", finishing: true }),
				);
				summary = result.response?.slice(0, 500) ?? "Deep analysis completed";
				break;
			}

			// Execute each tool call
			for (const toolCall of result.toolCalls) {
				const toolResult = await executeReflectionTool(toolCall, context);

				// Add tool result to messages
				messages.push({
					role: "tool",
					content: JSON.stringify(toolResult),
					tool_call_id: toolCall.name,
				});

				// Check if reflection is complete
				if (toolCall.name === "finishReflection" && toolResult.success) {
					finished = true;
					const finishArgs = toolCall.arguments as {
						summary: string;
						proposedChanges: number;
						autoApplied: number;
					};
					summary = finishArgs.summary;
					break;
				}
			}
		} catch (e) {
			return {
				success: false,
				iterations,
				summary: "",
				error: `Deep analysis error: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
	}

	// Generate summary if we hit iteration limit
	if (!summary) {
		summary = `Deep analysis completed after ${iterations} iterations. Proposed ${context.proposedEdits.length} changes for review.`;
	}

	return { success: true, iterations, summary };
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
	const result = await runDeepAnalysis(env, context);

	return {
		success: result.success,
		summary: result.summary,
		proposedEdits: context.proposedEdits,
		autoAppliedFixes: context.autoAppliedFixes,
		quickScanIterations: 0,
		deepAnalysisIterations: result.iterations,
		flaggedIssues: context.flaggedIssues,
		error: result.error,
	};
}
