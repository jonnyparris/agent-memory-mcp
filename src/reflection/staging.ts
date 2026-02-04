/**
 * Staged Changes Writer
 *
 * Writes reflection results to pending/ directory for human review.
 * Includes proposed edits, auto-applied fixes summary, and analysis details.
 */

import type { R2Storage } from "../storage/r2";
import type { AutoAppliedFix, FlaggedIssue, ProposedEdit } from "./tool-executor";

const PENDING_DIR = "memory/reflections/pending";

/**
 * Full reflection data to be staged
 */
export interface StagedReflection {
	date: string;
	summary: string;
	proposedEdits: ProposedEdit[];
	autoAppliedFixes: AutoAppliedFix[];
	flaggedIssues: FlaggedIssue[];
	quickScanIterations: number;
	deepAnalysisIterations: number;
}

/**
 * Write a staged reflection file for human review
 * @returns The path to the staged file
 */
export async function writeStagedReflection(
	storage: R2Storage,
	reflection: StagedReflection,
): Promise<string> {
	const content = buildStagedContent(reflection);
	const path = `${PENDING_DIR}/${reflection.date}.md`;

	await storage.write(path, content);
	return path;
}

/**
 * Build the markdown content for a staged reflection
 */
function buildStagedContent(reflection: StagedReflection): string {
	const {
		date,
		summary,
		proposedEdits,
		autoAppliedFixes,
		flaggedIssues,
		quickScanIterations,
		deepAnalysisIterations,
	} = reflection;

	const sections: string[] = [];

	// Header
	sections.push(`# Reflection - ${date}

## Summary

${summary}

## Statistics

| Metric | Value |
|--------|-------|
| Quick Scan Iterations | ${quickScanIterations} |
| Deep Analysis Iterations | ${deepAnalysisIterations} |
| Auto-Applied Fixes | ${autoAppliedFixes.length} |
| Proposed Changes | ${proposedEdits.length} |
| Issues Flagged | ${flaggedIssues.length} |
`);

	// Auto-applied fixes section
	if (autoAppliedFixes.length > 0) {
		sections.push(`## Auto-Applied Fixes (Already Done)

These low-risk fixes were applied automatically:

${autoAppliedFixes
	.map(
		(fix, i) => `### ${i + 1}. ${fix.fixType.toUpperCase()} - ${fix.path}

**Reason:** ${fix.reason}
${fix.oldText ? `\n**Changed:** \`${escapeForMarkdown(fix.oldText.slice(0, 100))}\` → \`${escapeForMarkdown(fix.newText?.slice(0, 100) ?? "")}\`` : ""}
`,
	)
	.join("\n")}
`);
	} else {
		sections.push(`## Auto-Applied Fixes

_No auto-fixes were applied._
`);
	}

	// Proposed edits section
	if (proposedEdits.length > 0) {
		sections.push(`## Proposed Changes (Require Review)

Review each proposed change below. To apply:

1. **replace**: Copy the content to replace the target file
2. **append**: Add the content to the end of the target file
3. **create**: Create a new file with the content
4. **delete**: Remove the target file

${proposedEdits
	.map(
		(edit, i) => `### ${i + 1}. ${edit.action.toUpperCase()}: ${edit.path}

**Reason:** ${edit.reason}

${
	edit.content
		? `**Content:**
\`\`\`
${edit.content}
\`\`\`
`
		: ""
}`,
	)
	.join("\n")}
`);
	} else {
		sections.push(`## Proposed Changes

_No changes proposed for review._
`);
	}

	// Flagged issues that weren't fully resolved
	if (flaggedIssues.length > 0) {
		const unresolvedFlags = flaggedIssues.filter(
			(flag) => !proposedEdits.some((edit) => edit.path === flag.path),
		);

		if (unresolvedFlags.length > 0) {
			sections.push(`## Unresolved Issues

These issues were flagged but no specific fix was proposed:

${unresolvedFlags.map((flag) => `- **${flag.path}**: ${flag.issue}`).join("\n")}

Consider reviewing these manually.
`);
		}
	}

	// Instructions
	sections.push(`## After Review

Once you've reviewed and applied any desired changes:

1. Delete this file, OR
2. Move to \`memory/reflections/archive/${date}.md\`

This ensures the next reflection starts fresh.
`);

	return sections.join("\n");
}

/**
 * Escape special characters for markdown inline code
 */
function escapeForMarkdown(text: string): string {
	return text.replace(/`/g, "\\`").replace(/\n/g, "\\n");
}

/**
 * List all pending reflections
 */
export async function listPendingReflections(
	storage: R2Storage,
): Promise<{ path: string; date: string }[]> {
	const files = await storage.list(PENDING_DIR, false);

	return files
		.filter((f) => f.path.endsWith(".md"))
		.map((f) => {
			// Extract date from filename: memory/reflections/pending/2026-02-04.md
			const match = f.path.match(/(\d{4}-\d{2}-\d{2})\.md$/);
			return {
				path: f.path,
				date: match ? match[1] : "unknown",
			};
		})
		.sort((a, b) => b.date.localeCompare(a.date)); // Most recent first
}

/**
 * Archive a pending reflection (move from pending to archive)
 */
export async function archiveReflection(
	storage: R2Storage,
	pendingPath: string,
): Promise<string | null> {
	const file = await storage.read(pendingPath);
	if (!file) {
		return null;
	}

	// Extract date from path
	const match = pendingPath.match(/(\d{4}-\d{2}-\d{2})\.md$/);
	if (!match) {
		return null;
	}

	const archivePath = `memory/reflections/archive/${match[1]}.md`;
	await storage.write(archivePath, file.content);
	await storage.delete(pendingPath);

	return archivePath;
}
