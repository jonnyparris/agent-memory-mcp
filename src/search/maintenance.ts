import {
	type ConversationExchange,
	exchangeEmbeddingText,
	exchangeIndexPath,
	loadConversationIndex,
} from "../conversations";
import type { R2Storage } from "../storage/r2";
import { parseTags } from "../tags";
import type { Env } from "../types";
import { parseWikilinks } from "../wikilinks";
import { getConversationIndex, getMemoryIndex } from "./client";
import type { MemoryIndexRpc, PruneResult } from "./durable-object";

/**
 * Index upkeep that needs to look outside the Durable Object.
 *
 * The DO holds vectors but not the content they came from. Content lives in
 * R2 (memory scope) or in the conversation index JSON (conversations scope).
 * So finding stale vectors, and re-embedding old ones, is driven from the
 * Worker, which can read both.
 */

export type IndexScope = "memory" | "conversations";

/**
 * Refuse to prune "missing" paths when more than this share of the index looks
 * missing. A wrong bucket binding (this happened on 2026-09-19, see
 * wrangler.duvland.jsonc) or a listing failure makes every path look gone, and
 * pruning on that would wipe the index. Real churn is a handful of files.
 */
const MAX_MISSING_SHARE = 0.2;

/** What the live store holds for a scope, keyed by index path. */
interface Source {
	/** Every path the scope's content source currently has. */
	present: Set<string>;
	/** Load the text to embed for an indexed path, or null if it is gone. */
	load(path: string): Promise<{ content: string; tags?: string[]; links?: string[] } | null>;
}

async function memorySource(storage: R2Storage): Promise<Source> {
	const listed = await storage.list("", true);
	return {
		present: new Set(listed.map((f) => f.path)),
		async load(path) {
			const file = await storage.read(path);
			if (!file) return null;
			return {
				content: file.content,
				tags: parseTags(file.content),
				links: parseWikilinks(file.content),
			};
		},
	};
}

async function conversationSource(storage: R2Storage): Promise<Source> {
	const { exchanges } = await loadConversationIndex(storage);
	const byPath = new Map<string, ConversationExchange>(
		exchanges.map((e) => [exchangeIndexPath(e.id), e]),
	);
	return {
		present: new Set(byPath.keys()),
		async load(path) {
			const exchange = byPath.get(path);
			return exchange ? { content: exchangeEmbeddingText(exchange) } : null;
		},
	};
}

function scopeIndex(env: Env, scope: IndexScope): MemoryIndexRpc {
	return scope === "memory" ? getMemoryIndex(env) : getConversationIndex(env);
}

function scopeSource(storage: R2Storage, scope: IndexScope): Promise<Source> {
	return scope === "memory" ? memorySource(storage) : conversationSource(storage);
}

export interface PruneIndexResult extends PruneResult {
	scope: IndexScope;
	/** Indexed paths the content source no longer has. */
	missing: string[];
	/** Set when the missing-path check was skipped, with the reason. */
	missing_check_skipped?: string;
}

/**
 * Prune one scope: denylisted paths, plus paths gone from the content source.
 *
 * The missing-path half is skipped (denylist pruning still runs) when the
 * source looks empty or when too large a share of the index looks missing.
 * Both point at a misconfiguration, not at deleted files.
 */
export async function pruneIndex(
	env: Env,
	storage: R2Storage,
	options: { scope?: IndexScope; dryRun?: boolean } = {},
): Promise<PruneIndexResult> {
	const scope = options.scope ?? "memory";
	const index = scopeIndex(env, scope);
	const [{ paths }, source] = await Promise.all([
		index.indexedPaths(),
		scopeSource(storage, scope),
	]);

	let missing = paths.map((p) => p.path).filter((p) => !source.present.has(p));
	let skipped: string | undefined;
	if (paths.length > 0 && source.present.size === 0) {
		skipped = "content source is empty; refusing to treat every indexed path as missing";
	} else if (paths.length > 0 && missing.length / paths.length > MAX_MISSING_SHARE) {
		skipped = `${missing.length} of ${paths.length} indexed paths look missing (over ${MAX_MISSING_SHARE * 100}%); check the bucket binding`;
	}
	if (skipped) {
		console.error(`Prune (${scope}): ${skipped}`);
		missing = [];
	}

	const result = await index.prune({ dryRun: options.dryRun ?? false, missing });
	return {
		...result,
		scope,
		missing,
		...(skipped ? { missing_check_skipped: skipped } : {}),
	};
}

export interface ReindexResult {
	scope: IndexScope;
	/** Legacy (whole-file vector) paths before this run. */
	legacy_before: number;
	/** Paths re-embedded as chunks. */
	reindexed: string[];
	/** Legacy paths whose content is gone. Left for `prune` to remove. */
	missing: string[];
	failed: Array<{ path: string; error: string }>;
	/** Legacy paths still waiting after this run. */
	remaining: number;
	dryRun: boolean;
}

/**
 * Re-embed up to `limit` legacy files as chunks, from their stored content.
 *
 * Legacy files are the whole-file vectors carried over when the index moved
 * to chunks. They still answer vector queries but have no keyword entry and
 * are embedded only on their opening section. Batched so a call fits inside
 * one request; run it until `remaining` is 0. The daily cron runs it too.
 *
 * Only paths already in the index are touched. A file that was never indexed
 * (denylisted, or held back by the credential gate) stays that way.
 */
export async function reindexLegacy(
	env: Env,
	storage: R2Storage,
	options: { scope?: IndexScope; limit?: number; dryRun?: boolean } = {},
): Promise<ReindexResult> {
	const scope = options.scope ?? "memory";
	const limit = Math.max(1, options.limit ?? 25);
	const index = scopeIndex(env, scope);
	const { paths } = await index.indexedPaths();
	const legacy = paths.filter((p) => p.legacy).map((p) => p.path);

	const result: ReindexResult = {
		scope,
		legacy_before: legacy.length,
		reindexed: [],
		missing: [],
		failed: [],
		remaining: legacy.length,
		dryRun: options.dryRun ?? false,
	};
	if (legacy.length === 0 || result.dryRun) return result;

	const source = await scopeSource(storage, scope);
	for (const path of legacy) {
		if (result.reindexed.length + result.failed.length >= limit) break;
		const item = await source.load(path);
		if (!item) {
			result.missing.push(path);
			continue;
		}
		try {
			await index.update({ path, ...item });
			result.reindexed.push(path);
		} catch (e) {
			result.failed.push({ path, error: e instanceof Error ? e.message : String(e) });
		}
	}
	result.remaining = legacy.length - result.reindexed.length;
	return result;
}
