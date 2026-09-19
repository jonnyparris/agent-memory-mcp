/**
 * Jev (`typesafe/jev`) integrations — calibrated evaluation on Workers AI.
 *
 * Three call sites, each one typed question:
 *  - rerankSearchResults: which of the top-K search results actually answers
 *    the query (choice). Cosine similarity measures lexical-semantic
 *    closeness; Jev measures "answers the question".
 *  - classifyOverlap: relationship between a freshly-written file and an
 *    existing similar one (choice: duplicate/supersedes/related/distinct).
 *  - checkForSecrets: does this content contain credentials? (noul). Used as
 *    a write-time gate — matching files are stored but not indexed.
 *
 * All helpers fail open/soft: a Jev outage degrades to the pre-Jev behaviour
 * (original ordering, plain overlap warnings, index as usual) and surfaces
 * the error — it must never block a write or empty a search result set.
 *
 * Response envelope: the AI binding returns `{ state, result: { answers } }`
 * — not the flat `{ answers }` shape shown in the model docs (verified live
 * 2026-09-19). `jevAnswers` handles both.
 */

/** Minimal AI surface for Jev. The generated worker types only type
 * `run` for catalog models (`keyof AiModelList`); typesafe/jev is a
 * third-party model the runtime accepts but the type can't express, so
 * call sites pass env.AI through this narrow interface. */
export interface JevAi {
	run(
		model: "typesafe/jev",
		inputs: { state: unknown; questions: Record<string, unknown> },
	): Promise<Record<string, unknown>>;
}

export interface JevChoiceAnswer {
	type: "choice";
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
}

export interface JevNoulAnswer {
	type: "noul";
	noul: number;
}

export function isJevChoice(value: unknown): value is JevChoiceAnswer {
	return (
		typeof value === "object" &&
		value !== null &&
		"choice" in value &&
		typeof value.choice === "string" &&
		"probabilities" in value &&
		typeof value.probabilities === "object" &&
		value.probabilities !== null
	);
}

export function isJevNoul(value: unknown): value is JevNoulAnswer {
	return (
		typeof value === "object" && value !== null && "noul" in value && typeof value.noul === "number"
	);
}

/** Extract the answers map from a Jev response, both envelope shapes. */
export function jevAnswers(
	response: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
	if (!response || typeof response !== "object") return {};
	const direct = response.answers;
	if (typeof direct === "object" && direct !== null) {
		return direct as Record<string, unknown>;
	}
	const result = response.result;
	if (typeof result === "object" && result !== null) {
		const answers = (result as Record<string, unknown>).answers;
		if (typeof answers === "object" && answers !== null) {
			return answers as Record<string, unknown>;
		}
	}
	return {};
}

// ---------------------------------------------------------------------------
// Search re-rank
// ---------------------------------------------------------------------------

export interface RerankCandidate {
	path: string;
	snippet: string;
	score: number;
}

export interface RerankOutcome {
	/** Candidate indices sorted best-first by Jev probability. */
	order: number[];
	/** Jev probability per candidate index (key = position in the input). */
	probabilities: Record<string, number>;
}

const SNIPPET_RERANK_CHARS = 400;

/**
 * Re-rank search results by "which one actually answers the query".
 * Single Jev choice call for the whole candidate set — one round-trip
 * regardless of K. Returns null on any failure (caller keeps its own order).
 */
export async function rerankSearchResults(
	ai: JevAi,
	query: string,
	candidates: RerankCandidate[],
): Promise<RerankOutcome | null> {
	if (candidates.length < 2) return null;

	const criteria: Record<string, string> = {};
	candidates.forEach((c, i) => {
		const snippet = c.snippet.replace(/\s+/g, " ").slice(0, SNIPPET_RERANK_CHARS);
		criteria[String(i)] = `${c.path} — ${snippet}`;
	});

	try {
		const response = await ai.run("typesafe/jev", {
			state: { query, candidates: candidates.map((c) => ({ path: c.path, score: c.score })) },
			questions: {
				best_answer: {
					type: "choice",
					instructions:
						"Which result's content actually answers the query? Judge the content snippet, not the filename alone. If several look equally relevant, prefer the one whose snippet directly addresses the question over one that merely shares vocabulary.",
					criteria,
				},
			},
		});

		const answer = jevAnswers(response).best_answer;
		if (!isJevChoice(answer)) return null;

		const order = candidates
			.map((_, i) => i)
			.sort(
				(a, b) => (answer.probabilities[String(b)] ?? 0) - (answer.probabilities[String(a)] ?? 0),
			);
		return { order, probabilities: answer.probabilities };
	} catch (error) {
		console.error(
			"Jev search rerank failed:",
			error instanceof Error ? error.message : String(error),
		);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Overlap classification
// ---------------------------------------------------------------------------

export type OverlapVerdict = "duplicate" | "supersedes" | "related" | "distinct";

export interface OverlapAnalysis {
	path: string;
	verdict: OverlapVerdict;
	confidence: number;
	action: string;
}

const OVERLAP_ACTIONS: Record<OverlapVerdict, string> = {
	duplicate: "Merge this content into the existing file instead of keeping both.",
	supersedes:
		"The existing file looks outdated — update it in place, or move it to an archive path so it stops competing for recall.",
	related: "Keep both — they look similar but cover different aspects.",
	distinct: "No action needed.",
};

/**
 * Classify the relationship between a new write and one existing similar
 * file. Returns null on failure (caller falls back to the plain overlap
 * warning).
 */
export async function classifyOverlap(
	ai: JevAi,
	newPath: string,
	newSnippet: string,
	existing: { path: string; snippet: string; score: number },
): Promise<OverlapAnalysis | null> {
	try {
		const response = await ai.run("typesafe/jev", {
			state: {
				new_file: { path: newPath, content: newSnippet.slice(0, 3000) },
				existing_file: { path: existing.path, content: existing.snippet.slice(0, 3000) },
				similarity: existing.score,
			},
			questions: {
				relationship: {
					type: "choice",
					instructions:
						"How does the new file relate to the existing file, judged by their content?",
					criteria: {
						duplicate:
							"Substantially the same information — keeping both creates a redundant memory",
						supersedes:
							"Both hold similar information but the existing file is stale or outdated relative to the new one",
						related: "Similar topic but genuinely different information worth keeping in both",
						distinct: "Only superficially similar — different topics in practice",
					},
				},
			},
		});

		const answer = jevAnswers(response).relationship;
		if (!isJevChoice(answer)) return null;
		const verdict =
			answer.choice === "duplicate" ||
			answer.choice === "supersedes" ||
			answer.choice === "related" ||
			answer.choice === "distinct"
				? answer.choice
				: null;
		if (!verdict) return null;
		return {
			path: existing.path,
			verdict,
			confidence: answer.probabilities[verdict] ?? answer.confidence,
			action: OVERLAP_ACTIONS[verdict],
		};
	} catch (error) {
		console.error(
			`Jev overlap classification failed for ${existing.path}:`,
			error instanceof Error ? error.message : String(error),
		);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Secret gate
// ---------------------------------------------------------------------------

const SECRET_SCAN_CHARS = 8000;

/** Probability above which a write is treated as containing credentials. */
export const SECRET_GATE_THRESHOLD = 0.8;

/**
 * Calibrated credential check on write content. Untrusting regexes here
 * misses base64 tokens, key-shaped strings with unusual prefixes, and
 * future credential formats — Jev judges the content as a whole.
 * Returns null on failure (caller indexes as usual and notes the error).
 */
export async function checkForSecrets(ai: JevAi, content: string): Promise<boolean | null> {
	try {
		const response = await ai.run("typesafe/jev", {
			state: { content: content.slice(0, SECRET_SCAN_CHARS) },
			questions: {
				contains_secret: {
					type: "noul",
					instructions:
						"Does `content` contain live credentials — API keys, bearer tokens, passwords, private keys, connection strings with embedded credentials, or refresh tokens? Placeholder examples, redacted values, and docs describing credential *formats* do not count.",
					criteria: {
						true: "At least one value in the content looks like a real, usable credential",
						false:
							"No usable credentials — examples, placeholders, or no credential-shaped values at all",
					},
				},
			},
		});

		const answer = jevAnswers(response).contains_secret;
		return isJevNoul(answer) ? answer.noul >= SECRET_GATE_THRESHOLD : null;
	} catch (error) {
		console.error(
			"Jev secret check failed:",
			error instanceof Error ? error.message : String(error),
		);
		return null;
	}
}
