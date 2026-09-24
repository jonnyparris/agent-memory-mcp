import { describe, expect, it } from "vitest";
import { isHygieneTarget, tidyMarkdown } from "../../../src/reflection/hygiene";

describe("tidyMarkdown", () => {
	it("strips trailing whitespace but keeps a two-space hard break", () => {
		expect(tidyMarkdown("a   \nb\t\nc  \nd\n")).toBe("a\nb\nc  \nd\n");
	});

	it("collapses runs of blank lines to two", () => {
		expect(tidyMarkdown("a\n\n\n\n\nb\n")).toBe("a\n\n\nb\n");
	});

	it("ends with exactly one newline", () => {
		expect(tidyMarkdown("a")).toBe("a\n");
		expect(tidyMarkdown("a\n\n\n")).toBe("a\n");
	});

	it("leaves fenced code alone", () => {
		const src = "```\nx   \n\n\n\n\ny\n```\n";
		expect(tidyMarkdown(src)).toBe(src);
	});

	it("returns malformed content (unclosed fence) unchanged", () => {
		const src = "```\nx   \n";
		expect(tidyMarkdown(src)).toBe(src);
	});

	it("is idempotent", () => {
		const once = tidyMarkdown("# T  \n\n\n\n- a \n");
		expect(tidyMarkdown(once)).toBe(once);
	});
});

describe("isHygieneTarget", () => {
	it("targets memory markdown only, skipping machine output", () => {
		expect(isHygieneTarget("memory/learnings.md")).toBe(true);
		expect(isHygieneTarget("memory/reflections/archive/2026-01-01.md")).toBe(false);
		expect(isHygieneTarget("memory/meta/x.md")).toBe(false);
		expect(isHygieneTarget("memory/foo.json")).toBe(false);
		expect(isHygieneTarget("conversations/x.md")).toBe(false);
	});
});
