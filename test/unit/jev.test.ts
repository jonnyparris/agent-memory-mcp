import { describe, expect, it } from "vitest";
import {
	type JevAi,
	type RerankCandidate,
	checkForSecrets,
	classifyOverlap,
	jevAnswers,
	overlapNewContent,
	rerankSearchResults,
} from "../../src/jev";

function aiWithResponse(answers: Record<string, unknown>): JevAi {
	return {
		run: async () => ({ state: "Completed", result: { answers } }),
	} as unknown as JevAi;
}

function aiThatThrows(message = "jev down"): JevAi {
	return {
		run: async () => {
			throw new Error(message);
		},
	} as unknown as JevAi;
}

describe("jevAnswers", () => {
	it("reads the { state, result: { answers } } envelope (binding shape)", () => {
		const response = { state: "Completed", result: { answers: { x: 1 } } };
		expect(jevAnswers(response)).toEqual({ x: 1 });
	});

	it("reads the flat { answers } shape (docs shape)", () => {
		expect(jevAnswers({ answers: { x: 1 } })).toEqual({ x: 1 });
	});

	it("returns {} for malformed responses", () => {
		expect(jevAnswers({})).toEqual({});
		expect(jevAnswers({ result: "Completed" })).toEqual({});
		expect(jevAnswers(null as unknown as Record<string, unknown>)).toEqual({});
	});
});

describe("rerankSearchResults", () => {
	const candidates: RerankCandidate[] = [
		{ path: "a.md", snippet: "alpha", score: 0.9 },
		{ path: "b.md", snippet: "beta", score: 0.85 },
		{ path: "c.md", snippet: "gamma", score: 0.8 },
	];

	it("reorders by descending Jev probability", async () => {
		const ai = aiWithResponse({
			best_answer: {
				type: "choice",
				choice: "2",
				confidence: 0.9,
				probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 },
			},
		});
		const outcome = await rerankSearchResults(ai, "query", candidates);
		expect(outcome?.order).toEqual([2, 1, 0]);
		expect(outcome?.probabilities["2"]).toBe(0.7);
	});

	it("returns null when Jev throws (caller keeps its own order)", async () => {
		expect(await rerankSearchResults(aiThatThrows(), "query", candidates)).toBeNull();
	});

	it("returns null on an unexpected answer shape", async () => {
		const ai = aiWithResponse({ best_answer: { choice: "0" } });
		expect(await rerankSearchResults(ai, "query", candidates)).toBeNull();
	});

	it("short-circuits single-result searches", async () => {
		const outcome = await rerankSearchResults(aiWithResponse({}), "query", [candidates[0]]);
		expect(outcome).toBeNull();
	});
});

describe("classifyOverlap", () => {
	const existing = { path: "memory/old.md", snippet: "old content", score: 0.8 };

	it("maps the choice verdict + action", async () => {
		const ai = aiWithResponse({
			relationship: {
				type: "choice",
				choice: "supersedes",
				confidence: 0.8,
				probabilities: { duplicate: 0.05, supersedes: 0.9, related: 0.05, distinct: 0 },
			},
		});
		const analysis = await classifyOverlap(ai, "memory/new.md", "new content", existing);
		expect(analysis?.verdict).toBe("supersedes");
		expect(analysis?.confidence).toBe(0.9);
		expect(analysis?.action).toContain("archive");
	});

	it("sends Jev the whole new file, not the first 3,000 characters", async () => {
		let sent = "";
		const ai = {
			run: async (_m: string, inputs: { state: { new_file: { content: string } } }) => {
				sent = inputs.state.new_file.content;
				return {
					result: {
						answers: {
							relationship: {
								type: "choice",
								choice: "duplicate",
								confidence: 1,
								probabilities: { duplicate: 1 },
							},
						},
					},
				};
			},
		} as unknown as JevAi;
		const content = `${"u".repeat(6000)}${"dup".repeat(1000)}`;
		await classifyOverlap(ai, "memory/new.md", content, existing);
		expect(sent).toBe(content);
	});

	it("returns null when Jev fails", async () => {
		expect(await classifyOverlap(aiThatThrows(), "memory/new.md", "new", existing)).toBeNull();
	});

	it("returns null for an unknown verdict string", async () => {
		const ai = aiWithResponse({
			relationship: {
				type: "choice",
				choice: "something-else",
				confidence: 1,
				probabilities: { "something-else": 1 },
			},
		});
		expect(await classifyOverlap(ai, "memory/new.md", "new", existing)).toBeNull();
	});
});

describe("overlapNewContent", () => {
	it("returns content at or under the cap unchanged", () => {
		expect(overlapNewContent("abc", 5000, 10)).toBe("abc");
		expect(overlapNewContent("x".repeat(10), undefined, 10)).toBe("x".repeat(10));
	});

	it("keeps the opening and the matching part above the cap", () => {
		const content = `${"o".repeat(1500)}${"u".repeat(60_000)}${"M".repeat(5000)}${"z".repeat(10_000)}`;
		const out = overlapNewContent(content, 61_500, 40_000);
		expect(out.length).toBe(40_000);
		expect(out.startsWith("o".repeat(1500))).toBe(true);
		expect(out).toContain("M".repeat(5000));
	});

	it("shifts the window back when the match is near the end", () => {
		const content = `${"o".repeat(1500)}${"u".repeat(60_000)}TAIL`;
		const out = overlapNewContent(content, content.length - 4, 40_000);
		expect(out.length).toBe(40_000);
		expect(out.endsWith("TAIL")).toBe(true);
	});

	it("falls back to the first cap characters with no match offset, or one inside the opening", () => {
		const content = "x".repeat(50_000);
		expect(overlapNewContent(content, undefined, 40_000)).toBe("x".repeat(40_000));
		expect(overlapNewContent(content, 0, 40_000)).toBe("x".repeat(40_000));
	});
});

describe("checkForSecrets", () => {
	it("returns true when noul clears the threshold", async () => {
		const ai = aiWithResponse({
			contains_secret: { type: "noul", noul: 0.9 },
		});
		expect(await checkForSecrets(ai, "token: ghp_abc123")).toBe(true);
	});

	it("returns false below the threshold", async () => {
		const ai = aiWithResponse({
			contains_secret: { type: "noul", noul: 0.3 },
		});
		expect(await checkForSecrets(ai, "docs about token formats")).toBe(false);
	});

	it("returns null on failure (caller indexes as usual)", async () => {
		expect(await checkForSecrets(aiThatThrows(), "anything")).toBeNull();
	});
});
