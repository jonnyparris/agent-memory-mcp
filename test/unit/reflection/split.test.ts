import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	indexWrite: vi.fn(),
}));

vi.mock("../../../src/search/index-write", () => ({
	indexWrite: mocks.indexWrite,
}));

import {
	MAX_SPLITS_PER_RUN,
	MAX_SPLIT_HEADINGS,
	SPLIT_MIN_CHARS,
	SplitError,
	applySplit,
	computeSplit,
	headingOutline,
	pathProblem,
	scanHeadings,
	splitPathProblem,
	targetHasSection,
} from "../../../src/reflection/split";
import {
	createExecutionContext,
	executeReflectionTool,
} from "../../../src/reflection/tool-executor";
import { createMockStorage } from "../../mocks/storage";

const pad = (n: number, ch = "x") => `${ch.repeat(n)}\n`;

/** A newest-first log over the split threshold. */
function bigLog(eol = "\n"): string {
	const sec = (name: string, n: number) => `## ${name}${eol}${eol}- ${"y".repeat(n)}${eol}${eol}`;
	return `---${eol}tags: [projects, refresh-log]${eol}---${eol}${eol}# Refresh log${eol}${eol}Intro line.${eol}${eol}${sec("November 2", 12000)}${sec("November 1", 12000)}${sec("October 31", 12000)}${sec("October 30", 12000)}`;
}

const base = {
	sourcePath: "memory/projects/refresh-log.md",
	targetPath: "memory/projects/refresh-log-2026-10.md",
	date: "2026-11-20",
};

describe("computeSplit", () => {
	it("moves the named sections verbatim and leaves one pointer per run", () => {
		const source = bigLog();
		const r = computeSplit({
			...base,
			source,
			target: null,
			headings: ["## October 31", "## October 30"],
		});

		expect(r.source).toContain("## November 1");
		expect(r.source).not.toContain("## October 31");
		expect(r.source).toContain(
			"Moved to [[memory/projects/refresh-log-2026-10]] on 2026-11-20: October 31; October 30.",
		);
		expect(r.source.match(/Moved to/g)).toHaveLength(1);
		// Every moved byte is in the target, in order, and the target copies the tags.
		const oct31 = source.slice(source.indexOf("## October 31"), source.indexOf("## October 30"));
		const oct30 = source.slice(source.indexOf("## October 30"));
		expect(r.target).toContain(oct31.trimEnd());
		expect(r.target).toContain(oct30.trimEnd());
		expect(r.target.indexOf("## October 31")).toBeLessThan(r.target.indexOf("## October 30"));
		expect(
			r.target.startsWith("---\ntags: [projects, refresh-log]\n---\n\n# Refresh log — split"),
		).toBe(true);
		expect(r.target).toContain("Sections moved verbatim out of [[memory/projects/refresh-log]]");
		// Nothing else changed in the source.
		expect(r.source.startsWith(source.slice(0, source.indexOf("## October 31")))).toBe(true);
	});

	it("puts a pointer at each separate run", () => {
		const r = computeSplit({
			...base,
			source: bigLog(),
			target: null,
			headings: ["## November 1", "## October 30"],
		});
		expect(r.source.match(/Moved to/g)).toHaveLength(2);
	});

	it("appends to an existing target", () => {
		const target = "# Old\n\n## October 29\n\n- z\n";
		const r = computeSplit({ ...base, source: bigLog(), target, headings: ["## October 30"] });
		expect(r.target.startsWith("# Old\n\n## October 29\n\n- z\n\n## October 30")).toBe(true);
	});

	it("skips sections the target already holds, so a retry converges", () => {
		const first = computeSplit({
			...base,
			source: bigLog(),
			target: null,
			headings: ["## October 30"],
		});
		// Target write landed, source write failed: run again from the old source.
		const retry = computeSplit({
			...base,
			source: bigLog(),
			target: first.target,
			headings: ["## October 30"],
		});
		expect(retry.moved).toHaveLength(0);
		expect(retry.alreadyInTarget).toHaveLength(1);
		expect(retry.target).toBe(first.target);
		expect(retry.source).toBe(first.source);
	});

	it("ends a section at the next heading of the same or higher level", () => {
		const source = `# T\n\n## A\n\n### A1\n\n${pad(SPLIT_MIN_CHARS)}\n## B\n\nkeep\n`;
		const r = computeSplit({ ...base, source, target: null, headings: ["## A"] });
		expect(r.target).toContain("### A1");
		expect(r.source).toContain("## B\n\nkeep");
		expect(r.source).not.toContain("### A1");
	});

	it("ignores heading-like lines in fences and frontmatter", () => {
		const source = `---\n# not a heading\n---\n\n# T\n\n## A\n\n\`\`\`\n## fake\n\`\`\`\n\n~~~~\n## fake2\n~~~\n~~~~\n\n${pad(SPLIT_MIN_CHARS)}\n## B\n\nkeep\n`;
		expect(scanHeadings(source).map((h) => h.text)).toEqual(["# T", "## A", "## B"]);
		const r = computeSplit({ ...base, source, target: null, headings: ["## A"] });
		expect(r.target).toContain("## fake2");
		expect(() => computeSplit({ ...base, source, target: null, headings: ["## fake"] })).toThrow(
			/not in the file/,
		);
	});

	it("refuses an unclosed fence", () => {
		const source = `# T\n\n## A\n\n\`\`\`\n${pad(SPLIT_MIN_CHARS)}## B\n`;
		expect(() => computeSplit({ ...base, source, target: null, headings: ["## A"] })).toThrow(
			/unclosed code fence/,
		);
	});

	it("keeps CRLF bytes intact", () => {
		const source = bigLog("\r\n");
		const r = computeSplit({ ...base, source, target: null, headings: ["## October 30"] });
		const moved = source.slice(source.indexOf("## October 30")).replace(/\s+$/, "");
		expect(r.target).toContain(moved);
		expect(r.source).toContain("on 2026-11-20: October 30.\r\n");
		expect(r.source).not.toMatch(/[^\r]\n/);
	});

	it("refuses missing, duplicate, nested and all-section picks, and small files", () => {
		const source = bigLog();
		expect(() => computeSplit({ ...base, source, target: null, headings: ["## Nope"] })).toThrow(
			/not in the file\. Headings in the file:\n# Refresh log/,
		);
		expect(() =>
			computeSplit({
				...base,
				source: `${source}\n## October 30\n\nx\n`,
				target: null,
				headings: ["## October 30"],
			}),
		).toThrow(/appears 2 times/);
		const nested = `# T\n\n## A\n\n### A1\n\n${pad(SPLIT_MIN_CHARS)}\n## B\n\nkeep\n`;
		expect(() =>
			computeSplit({ ...base, source: nested, target: null, headings: ["## A", "### A1"] }),
		).toThrow(/inside/);
		expect(() =>
			computeSplit({
				...base,
				source,
				target: null,
				headings: ["## November 2", "## November 1", "## October 31", "## October 30"],
			}),
		).toThrow(/moves every section/);
		expect(() =>
			computeSplit({ ...base, source: "# T\n\n## A\n\nx\n", target: null, headings: ["## A"] }),
		).toThrow(/splits start at/);
		expect(() => computeSplit({ ...base, source, target: null, headings: [] })).toThrow(
			/non-empty/,
		);
	});

	it("validates paths", () => {
		const source = bigLog();
		const bad = (targetPath: string) => () =>
			computeSplit({ ...base, targetPath, source, target: null, headings: ["## October 30"] });
		expect(bad("memory/../AGENTS.md")).toThrow(/'\.\.'/);
		expect(bad("memory/projects/x.txt")).toThrow(/\.md/);
		expect(bad("memory/workload/refresh-log-2026-10.md")).toThrow(/named after the source/);
		// An unrelated note next to the source is not a target.
		expect(bad("memory/projects/browser-run.md")).toThrow(/named after the source/);
		expect(bad("memory/projects/refresh-log-#2.md")).toThrow(/may not contain/);
		expect(bad("memory/projects/refresh-log.md")).toThrow(/differ/);
		expect(bad("memory/reflections/x.md")).toThrow();
		expect(pathProblem("memory/projects/sub/ok.md")).toBeNull();
		expect(pathProblem("memory\\x.md")).toMatch(/backslash/);
	});

	it("refuses Work HQ's current month archive, allows a closed month", () => {
		const day = (d: string) => `## ${d}\n\n- ${"j".repeat(12000)}\n\n`;
		const source = `---\ntags: [journal]\n---\n\n# Work HQ Journal — archive\n\n${day("2026-11-01")}${day("2026-11-02")}${day("2026-11-03")}${day("2026-11-04")}`;
		const p = {
			sourcePath: "memory/workload/work-hq-journal-archive-2026-11.md",
			targetPath: "memory/workload/work-hq-journal-archive-2026-11-part1.md",
			source,
			target: null,
			headings: ["## 2026-11-01"],
		};
		expect(() => computeSplit({ ...p, date: "2026-11-20" })).toThrow(/Work HQ rewrites this month/);
		expect(computeSplit({ ...p, date: "2026-12-01" }).moved).toHaveLength(1);
		// Nothing may be split into this month's file either.
		expect(
			splitPathProblem(
				"memory/workload/work-hq-journal-archive.md",
				"memory/workload/work-hq-journal-archive-2026-11.md",
				"2026-11-20",
			),
		).toMatch(/Work HQ rewrites/);
	});

	it("does not treat a quote of the section in the target as already moved", () => {
		const source = bigLog();
		const sec = source.slice(source.indexOf("## October 30")).replace(/\s+$/, "");
		// The target holds the text mid-line and inside a fence, never as its own section.
		const target = `# Old\n\nquote: ${sec}\n\n\`\`\`\n${sec}\n\`\`\`\n`;
		const r = computeSplit({ ...base, source, target, headings: ["## October 30"] });
		expect(r.alreadyInTarget).toHaveLength(0);
		expect(r.moved).toHaveLength(1);
		expect(r.target.endsWith(`\n\n${sec}\n`)).toBe(true);
		expect(targetHasSection(r.target, sec)).toBe(true);
	});

	it("caps headings per split and refuses an unscannable target", () => {
		const many = Array.from({ length: MAX_SPLIT_HEADINGS + 1 }, (_, i) => `## H${i}`);
		expect(() => computeSplit({ ...base, source: bigLog(), target: null, headings: many })).toThrow(
			/at most 200 headings/,
		);
		expect(() =>
			computeSplit({
				...base,
				source: bigLog(),
				target: "# Old\n\n```\nopen",
				headings: ["## October 30"],
			}),
		).toThrow(/has an unclosed code fence; flag it/);
		expect(() =>
			computeSplit({
				...base,
				source: bigLog(),
				target: null,
				headings: [`## ${"z".repeat(600)}`],
			}),
		).toThrow(/over 500 characters/);
	});

	it("bounds the outline it returns", () => {
		const heads = Array.from(
			{ length: 250 },
			(_, i) => `## Heading ${i} ${"w".repeat(i === 3 ? 400 : 10)}`,
		);
		const text = `# T\n\n${heads.map((h) => `${h}\n\nx\n`).join("\n")}`;
		const out = headingOutline(text);
		expect(out).toContain(`## Heading 3 ${"w".repeat(400)} (`);
		expect(out.split("\n").length).toBeLessThanOrEqual(MAX_SPLIT_HEADINGS + 1);
		expect(out).toMatch(/… \d+ more headings not shown; read the file/);
		const huge = `# T\n\n${Array.from({ length: 150 }, (_, i) => `## H${i} ${"q".repeat(400)}\n\nx\n`).join("\n")}`;
		expect(headingOutline(huge).length).toBeLessThan(21_000);
	});

	it("copies block-list tags into a new target", () => {
		const source = bigLog().replace(
			"tags: [projects, refresh-log]",
			"tags:\n  - projects\n  - refresh-log",
		);
		const r = computeSplit({ ...base, source, target: null, headings: ["## October 30"] });
		expect(r.target.startsWith("---\ntags:\n  - projects\n  - refresh-log\n---\n")).toBe(true);
	});
});

describe("applySplit", () => {
	let storage: ReturnType<typeof createMockStorage>;
	const env = {} as never;
	const edit = { path: base.sourcePath, to: base.targetPath, headings: ["## October 30"] };

	beforeEach(() => {
		vi.clearAllMocks();
		storage = createMockStorage();
		mocks.indexWrite.mockImplementation(async (_e, s, path, content) => {
			await s.write(path, content);
			return { success: true, tags: [], links: [] };
		});
	});

	it("writes the target, then the source", async () => {
		await storage.write(base.sourcePath, bigLog());
		await applySplit(env, storage, edit, "2026-11-20");
		expect(mocks.indexWrite.mock.calls.map((c) => c[2])).toEqual([
			base.targetPath,
			base.sourcePath,
		]);
		expect((await storage.read(base.sourcePath))?.content).not.toContain("## October 30");
		expect((await storage.read(base.targetPath))?.content).toContain("## October 30");
	});

	it("leaves the source alone when the target write fails, and a retry does not duplicate", async () => {
		await storage.write(base.sourcePath, bigLog());
		mocks.indexWrite.mockRejectedValueOnce(new Error("R2 down"));
		await expect(applySplit(env, storage, edit, "2026-11-20")).rejects.toThrow(/R2 down/);
		expect((await storage.read(base.sourcePath))?.content).toBe(bigLog());

		await applySplit(env, storage, edit, "2026-11-20");
		const target = (await storage.read(base.targetPath))?.content ?? "";
		expect(target.match(/## October 30/g)).toHaveLength(1);
		expect((await storage.read(base.sourcePath))?.content).not.toContain("## October 30");
	});

	it("retries cleanly after the target landed but the source write failed", async () => {
		await storage.write(base.sourcePath, bigLog());
		mocks.indexWrite
			.mockImplementationOnce(async (_e, s, path, content) => {
				await s.write(path, content);
				return { success: true, tags: [], links: [] };
			})
			.mockRejectedValueOnce(new Error("R2 down"));
		await expect(applySplit(env, storage, edit, "2026-11-20")).rejects.toThrow(/R2 down/);
		expect((await storage.read(base.sourcePath))?.content).toBe(bigLog());

		await applySplit(env, storage, edit, "2026-11-20");
		const target = (await storage.read(base.targetPath))?.content ?? "";
		expect(target.match(/## October 30/g)).toHaveLength(1);
		expect((await storage.read(base.sourcePath))?.content).not.toContain("## October 30");
	});

	it("finishes the split when the index is down, then reports it", async () => {
		await storage.write(base.sourcePath, bigLog());
		mocks.indexWrite.mockImplementation(async (_e, s, path, content) => {
			await s.write(path, content);
			return { success: true, tags: [], links: [], embedding_error: "down" };
		});
		const r = await applySplit(env, storage, edit, "2026-11-20");
		expect(r.indexError).toMatch(
			/split done and both files saved, but the search index update failed/,
		);
		expect((await storage.read(base.sourcePath))?.content).not.toContain("## October 30");
		expect((await storage.read(base.targetPath))?.content).toContain("## October 30");
	});

	it("treats a re-run of an applied split as a no-op", async () => {
		await storage.write(base.sourcePath, bigLog());
		await applySplit(env, storage, edit, "2026-11-20");
		const src = (await storage.read(base.sourcePath))?.content;
		const tgt = (await storage.read(base.targetPath))?.content;
		mocks.indexWrite.mockClear();
		expect(await applySplit(env, storage, edit, "2026-11-20")).toEqual({ wrote: false });
		expect(mocks.indexWrite).not.toHaveBeenCalled();
		expect((await storage.read(base.sourcePath))?.content).toBe(src);
		expect((await storage.read(base.targetPath))?.content).toBe(tgt);
	});

	it("refuses to write the source when it changed underneath", async () => {
		await storage.write(base.sourcePath, bigLog());
		mocks.indexWrite.mockImplementationOnce(async (_e, s, path, content) => {
			await s.write(path, content);
			await s.write(base.sourcePath, `${bigLog()}\nlate line\n`);
			return { success: true, tags: [], links: [] };
		});
		await expect(applySplit(env, storage, edit, "2026-11-20")).rejects.toBeInstanceOf(SplitError);
		expect((await storage.read(base.sourcePath))?.content).toContain("late line");
		expect((await storage.read(base.sourcePath))?.content).toContain("## October 30");
	});
});

describe("proposeSplit tool", () => {
	let storage: ReturnType<typeof createMockStorage>;
	let ctx: ReturnType<typeof createExecutionContext>;
	const call = (name: string, args: Record<string, unknown>) =>
		executeReflectionTool({ id: "c", name, arguments: args }, ctx);

	beforeEach(async () => {
		storage = createMockStorage();
		ctx = createExecutionContext(storage, {} as never);
		await storage.write(base.sourcePath, bigLog());
	});

	it("stages a split without writing anything", async () => {
		const r = await call("proposeSplit", {
			path: base.sourcePath,
			to: base.targetPath,
			headings: ["## October 30"],
			reason: "84K",
		});
		expect(r.success).toBe(true);
		expect(ctx.proposedEdits).toEqual([
			{
				path: base.sourcePath,
				action: "split",
				to: base.targetPath,
				headings: ["## October 30"],
				reason: "84K",
			},
		]);
		expect(await storage.read(base.targetPath)).toBeNull();
		expect((await storage.read(base.sourcePath))?.content).toBe(bigLog());
	});

	it("returns the outline for a wrong heading", async () => {
		const r = await call("proposeSplit", {
			path: base.sourcePath,
			to: base.targetPath,
			headings: ["## Oct 30"],
			reason: "x",
		});
		expect(r.success).toBe(false);
		expect(r.error).toContain("## October 30 (");
		expect(ctx.proposedEdits).toHaveLength(0);
	});

	it("refuses a split next to a staged replace or create, in either order", async () => {
		await call("proposeEdit", {
			path: base.targetPath,
			action: "create",
			content: "x",
			reason: "r",
		});
		const r = await call("proposeSplit", {
			path: base.sourcePath,
			to: base.targetPath,
			headings: ["## October 30"],
			reason: "x",
		});
		expect(r.success).toBe(false);

		ctx = createExecutionContext(storage, {} as never);
		await call("proposeSplit", {
			path: base.sourcePath,
			to: base.targetPath,
			headings: ["## October 30"],
			reason: "x",
		});
		const rep = await call("proposeEdit", {
			path: base.sourcePath,
			action: "replace",
			content: bigLog(),
			reason: "r",
		});
		expect(rep.success).toBe(false);
		const app = await call("proposeEdit", {
			path: base.sourcePath,
			action: "append",
			content: "see also",
			reason: "r",
		});
		expect(app.success).toBe(true);
	});

	it("refuses a read-wrapper source", async () => {
		await storage.write(
			base.sourcePath,
			`Read ${base.sourcePath} (100 bytes)\n\n{"path":"x","content":"${"a".repeat(SPLIT_MIN_CHARS)}"}`,
		);
		const r = await call("proposeSplit", {
			path: base.sourcePath,
			to: base.targetPath,
			headings: ["## October 30"],
			reason: "x",
		});
		expect(r.success).toBe(false);
	});

	it("refuses chains, two sources into one target, and more than the per-run cap", async () => {
		const ok = await call("proposeSplit", {
			path: base.sourcePath,
			to: base.targetPath,
			headings: ["## October 30"],
			reason: "x",
		});
		expect(ok.success).toBe(true);
		// Chain: the target becomes a source.
		await storage.write(base.targetPath, bigLog());
		const chain = await call("proposeSplit", {
			path: base.targetPath,
			to: "memory/projects/refresh-log-2026-10-part2.md",
			headings: ["## October 30"],
			reason: "x",
		});
		expect(chain.success).toBe(false);

		// Cap: fill up with unrelated splits.
		ctx = createExecutionContext(storage, {} as never);
		for (let i = 0; i < MAX_SPLITS_PER_RUN; i++) {
			const p = `memory/projects/log${i}.md`;
			await storage.write(p, bigLog());
			const r = await call("proposeSplit", {
				path: p,
				to: `memory/projects/log${i}-old.md`,
				headings: ["## October 30"],
				reason: "x",
			});
			expect(r.success).toBe(true);
		}
		const over = await call("proposeSplit", {
			path: base.sourcePath,
			to: base.targetPath,
			headings: ["## October 30"],
			reason: "x",
		});
		expect(over.success).toBe(false);
		expect(over.error).toMatch(/splits are staged already/);
	});

	it("checks paths before reading anything", async () => {
		const read = vi.spyOn(storage, "read");
		const r = await call("proposeSplit", {
			path: base.sourcePath,
			to: "memory/../AGENTS.md",
			headings: ["## October 30"],
			reason: "x",
		});
		expect(r.success).toBe(false);
		expect(read).not.toHaveBeenCalled();
	});

	it("proposeEdit does not accept the split action", async () => {
		const r = await call("proposeEdit", {
			path: base.sourcePath,
			action: "split",
			content: "x",
			reason: "r",
		});
		expect(r.success).toBe(false);
		expect(ctx.proposedEdits).toHaveLength(0);
	});
});
