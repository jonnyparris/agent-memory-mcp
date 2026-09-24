/**
 * Nightly reflection focus.
 *
 * "Review all of memory" in 25 turns is too broad for any model we can afford
 * to run nightly: it reads a handful of files at random and runs out of turns.
 * Each night instead gets one narrow job and the files that job needs, so the
 * whole budget goes on one question. Over a week every area gets a pass.
 */

export interface ReflectionFocus {
	id: string;
	title: string;
	/** What to look for. Appended to the deep-analysis prompt. */
	instructions: string;
	/** Path prefixes (or exact paths) this focus looks at. Empty = everything. */
	paths: string[];
}

export const FOCUSES: ReflectionFocus[] = [
	{
		id: "orphans",
		title: "Links and orphans",
		instructions: `Find files that should link to each other and don't.
- Use getBacklinks on the core hub files and on files that look important.
- A file with no backlinks that is not a leaf (a plan, a dated note) is probably orphaned: add a "See also" link to it from the most relevant hub with proposeEdit (append).
- Where two files clearly cover the same topic, append a short "See also: [[other]]" to each.
Prefer many small appends over rewrites.`,
		paths: [],
	},
	{
		id: "plans",
		title: "Stale plans and workload",
		instructions: `Review plans and workload files.
- Flag plans that are finished, abandoned or superseded (look for "done", "shipped", "merged", old dates, or a newer plan on the same topic). Say which file supersedes it.
- Flag todo items in active-todos that are clearly done or long stale.
- Flag two plans that cover the same work.
Do not edit plans. Use flagIssue with a specific recommendation (archive / merge into X / mark done).`,
		paths: ["memory/workload/", "memory/plans/"],
	},
	{
		id: "learnings",
		title: "Contradictions and duplicates in learnings",
		instructions: `Review the learnings files for:
- Two entries that give contradictory advice. Quote both and say which is current.
- The same lesson written twice in different places. Say which copy to keep.
- Lessons that name tools, versions or workflows that other memory says were replaced.
Use flagIssue with quotes. Only use proposeEdit for small appends (a cross-reference or a "superseded by" note).`,
		paths: ["memory/learnings", "memory/patterns/", "memory/reference/"],
	},
	{
		id: "projects",
		title: "Project freshness",
		instructions: `Review project notes.
- Flag projects whose status line looks stale (last update months ago, "in progress" with no recent activity).
- Flag facts in projects.md that contradict a dedicated file under projects/ (the dedicated file is usually newer).
- Flag projects mentioned in workload or sessions that have no project note.
Use flagIssue with the specific stale line quoted.`,
		paths: ["memory/projects", "memory/workload/active-todos.md", "memory/sessions"],
	},
	{
		id: "people",
		title: "People and preferences",
		instructions: `Review people and preference notes.
- Flag people entries whose role or team contradicts another file.
- Flag preferences that contradict each other or AGENTS-style rules elsewhere in memory.
- Flag duplicate entries for the same person.
Use flagIssue. Don't rewrite people files.`,
		paths: ["memory/people", "memory/preferences.md", "memory/soul.md", "memory/context/"],
	},
	{
		id: "structure",
		title: "Structure and misplaced files",
		instructions: `Review how memory is organised.
- Flag files in the wrong folder (a project note at the top level, a plan outside plans/).
- Flag folders that duplicate each other.
- Flag files over ~40KB that should be split, and suggest the split (by topic or by month).
Use flagIssue with the exact move or split you recommend.`,
		paths: [],
	},
	{
		id: "patterns",
		title: "Patterns and reference accuracy",
		instructions: `Review patterns and reference files.
- Flag patterns that contradict current learnings (learnings are usually newer).
- Flag reference docs with obviously outdated facts (dates, versions, URLs to things that were renamed).
- Suggest links between a pattern and the learnings that motivated it (proposeEdit append).`,
		paths: ["memory/patterns/", "memory/reference/", "memory/learnings"],
	},
];

/** Pick the focus for a date: one per weekday, so a week covers everything. */
export function focusForDate(date: Date, override?: string): ReflectionFocus {
	if (override) {
		const found = FOCUSES.find((f) => f.id === override);
		if (found) return found;
	}
	return FOCUSES[date.getUTCDay() % FOCUSES.length];
}

/** True if a path is in scope for a focus. */
export function inFocus(focus: ReflectionFocus, path: string): boolean {
	if (focus.paths.length === 0) return true;
	return focus.paths.some((p) => path === p || path.startsWith(p));
}
