/**
 * Scheduled Reflection
 *
 * Runs daily via cron trigger. Supports two modes:
 * - Agentic (default): Uses tool-calling LLMs for intelligent memory analysis
 * - Legacy: Falls back to single-shot LLM for prose suggestions
 *
 * The agentic mode runs in two phases:
 * 1. Quick Scan (GLM Flash): Auto-applies low-risk fixes
 * 2. Deep Analysis (Kimi K2.5): Proposes substantive changes for human review
 */

import { WorkersAIProvider } from "./llm/workers-ai";
import { buildReflectionCard, sendChatNotification } from "./notification";
import { type AgenticReflectionResult, runAgenticReflection } from "./reflection/agentic";
import { writeStagedReflection } from "./reflection/staging";
import type { R2Storage } from "./storage/r2";
import { createR2Storage } from "./storage/r2";
import type { Env, MemoryFileMetadata } from "./types";

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
}

/**
 * Run the daily reflection
 */
export async function runReflection(env: Env): Promise<ReflectionResult> {
	const date = new Date().toISOString().split("T")[0];
	const storage = createR2Storage(env.MEMORY_BUCKET);

	// Check if agentic mode is enabled (default: true)
	const useAgentic = env.USE_AGENTIC_REFLECTION !== "false";

	try {
		let result: ReflectionResult;

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
				error: result.error,
			}),
		);

		// Send notification only if there's something actionable (if webhook configured)
		const hasActionableChanges = (result.proposed ?? 0) > 0 || (result.autoApplied ?? 0) > 0;
		if (
			hasActionableChanges &&
			env.CHAT_WEBHOOK_AUTH_KEY &&
			env.CHAT_WEBHOOK_URL &&
			env.CHAT_WEBHOOK_SPACE_ID
		) {
			const card = buildReflectionCard(
				date,
				result.summary ?? "Reflection complete",
				result.pendingPath ?? "",
				result.proposed,
				result.autoApplied,
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

	// Only write pending file if there are actual changes to review
	let pendingPath: string | undefined;
	if (agenticResult.proposedEdits.length > 0) {
		pendingPath = await writeStagedReflection(storage, {
			date,
			summary: agenticResult.summary,
			proposedEdits: agenticResult.proposedEdits,
			autoAppliedFixes: agenticResult.autoAppliedFixes,
			flaggedIssues: agenticResult.flaggedIssues,
			quickScanIterations: agenticResult.quickScanIterations,
			deepAnalysisIterations: agenticResult.deepAnalysisIterations,
		});
	}

	// Update last reflection timestamp
	await storage.write(
		LAST_REFLECTION_PATH,
		JSON.stringify({
			timestamp: Date.now(),
			date,
		}),
	);

	// Build a helpful summary
	let summary: string;
	if (!hasChanges) {
		summary = "Memory looks good - no issues found.";
	} else {
		const parts: string[] = [];
		if (agenticResult.autoAppliedFixes.length > 0) {
			parts.push(`Auto-applied ${agenticResult.autoAppliedFixes.length} fixes`);
		}
		if (agenticResult.proposedEdits.length > 0) {
			parts.push(`${agenticResult.proposedEdits.length} changes need review`);
		}
		summary = `${parts.join(". ")}.`;
	}

	return {
		success: agenticResult.success,
		date,
		pendingPath,
		summary,
		mode: "agentic",
		autoApplied: agenticResult.autoAppliedFixes.length,
		proposed: agenticResult.proposedEdits.length,
		error: agenticResult.error,
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
