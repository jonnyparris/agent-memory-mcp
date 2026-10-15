/**
 * Throwaway spike Worker for docs/proposals/ai-search-backend.md.
 *
 * Not part of the product. Reads the real memory corpus from R2 (read-only),
 * copies the files the current index would embed into one AI Search instance
 * with built-in storage, and exposes a few bearer-protected routes the spike
 * harness (spike/ai-search/run.ts) calls to measure recall, write latency and
 * `$in` filter limits.
 *
 * Delete the Worker and the instance when the spike is over:
 *   npx wrangler delete --config spike/ai-search/wrangler.jsonc
 *   POST /teardown
 */
import { type JevAi, checkForSecrets } from "../../src/jev";
import { generateEmbedding } from "../../src/search/embeddings";
import { indexSkipReason } from "../../src/search/indexable";
import { parseTags } from "../../src/tags";

interface Env {
	MEMORY_BUCKET: R2Bucket;
	// biome-ignore lint/suspicious/noExplicitAny: AI Search binding types are not in workers-types yet; throwaway spike
	AI_SEARCH: any;
	AI: Ai;
	SPIKE_TOKEN: string;
}

const INSTANCE = "agent-memory-spike";

// Prefixes the memory-scope DO never sees: conversations live in a separate
// DO instance, history snapshots are excluded from `list`.
const OUT_OF_SCOPE = [/^conversations\//, /^_history\//];

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function instance(env: Env) {
	return env.AI_SEARCH.get(INSTANCE);
}

type Mode = "vector" | "keyword" | "hybrid" | "hybrid_rerank" | "hybrid_or" | "hybrid_or_rerank";

async function runSearch(
	env: Env,
	query: string,
	mode: Mode,
	limit: number,
	filters?: Record<string, unknown>,
) {
	const retrieval: Record<string, unknown> = {
		retrieval_type: mode.startsWith("hybrid") ? "hybrid" : mode,
		max_num_results: 50,
		match_threshold: 0,
	};
	if (mode.includes("_or")) retrieval.keyword_match_mode = "or";
	if (filters) retrieval.filters = filters;
	const opts: Record<string, unknown> = { retrieval, cache: { enabled: false } };
	if (mode.endsWith("rerank")) {
		opts.reranking = { enabled: true, model: "@cf/baai/bge-reranker-base", match_threshold: 0 };
	}
	const t0 = Date.now();
	const res = await instance(env).search({ query, ai_search_options: opts });
	const ms = Date.now() - t0;
	// Chunks -> files: best chunk wins (score of the file = max chunk score),
	// order preserved from the service's ranking.
	const files: Array<{ path: string; score: number; chunks: number }> = [];
	const seen = new Map<string, { path: string; score: number; chunks: number }>();
	for (const c of res.chunks ?? []) {
		const key = c.item?.key as string;
		const hit = seen.get(key);
		if (hit) {
			hit.chunks++;
			continue;
		}
		const entry = { path: key, score: c.score, chunks: 1 };
		seen.set(key, entry);
		files.push(entry);
	}
	return {
		ms,
		chunk_count: (res.chunks ?? []).length,
		files: files.slice(0, limit),
		// biome-ignore lint/suspicious/noExplicitAny: AI Search binding types are not in workers-types yet; throwaway spike
		raw: res.chunks?.slice(0, 3).map((c: any) => ({
			key: c.item?.key,
			score: c.score,
			details: c.scoring_details,
			metadata: c.item?.metadata,
		})),
	};
}

async function listAll(env: Env) {
	const keys: Array<{ key: string; size: number; uploaded: number }> = [];
	let cursor: string | undefined;
	do {
		const page = await env.MEMORY_BUCKET.list({ cursor, limit: 1000 });
		for (const o of page.objects) {
			keys.push({ key: o.key, size: o.size, uploaded: o.uploaded.getTime() });
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return keys;
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		if (req.headers.get("authorization") !== `Bearer ${env.SPIKE_TOKEN}`) {
			return json({ error: "unauthorized" }, 401);
		}
		const url = new URL(req.url);
		// biome-ignore lint/suspicious/noExplicitAny: AI Search binding types are not in workers-types yet; throwaway spike
		const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as any) : {};

		try {
			switch (url.pathname) {
				case "/setup": {
					const existing = await env.AI_SEARCH.list().catch(() => null);
					const created = await env.AI_SEARCH.create({
						id: INSTANCE,
						embedding_model: body.embedding_model ?? "@cf/baai/bge-m3",
						custom_metadata: [
							{ field_name: "path", data_type: "text" },
							{ field_name: "mtime", data_type: "number" },
						],
					});
					const info = await env.AI_SEARCH.get(INSTANCE)
						.info?.()
						.catch((e: Error) => e.message);
					return json({ existing, created: !!created, info });
				}

				case "/info": {
					const inst = instance(env);
					const [info, stats] = await Promise.all([
						inst.info?.().catch((e: Error) => e.message),
						inst.stats?.().catch((e: Error) => e.message),
					]);
					return json({ info, stats });
				}

				case "/corpus": {
					// What the memory-scope index would hold today.
					const all = await listAll(env);
					const inScope = all.filter((o) => !OUT_OF_SCOPE.some((r) => r.test(o.key)));
					const eligible = inScope.filter((o) => indexSkipReason(o.key) === null);
					return json({
						total: all.length,
						in_scope: inScope.length,
						eligible: eligible.length,
						eligible_bytes: eligible.reduce((s, o) => s + o.size, 0),
						over_64_bytes: eligible.filter((o) => new TextEncoder().encode(o.key).length > 64)
							.length,
						over_128_chars: eligible.filter((o) => o.key.length > 128).map((o) => o.key),
						keys: body.with_keys ? eligible.map((o) => o.key) : undefined,
					});
				}

				case "/backfill": {
					// Body: { keys: string[] } — the harness pages through /corpus.
					const keys: string[] = body.keys ?? [];
					const ai = env.AI as unknown as JevAi;
					const out = await Promise.all(
						keys.map(async (key) => {
							if (indexSkipReason(key)) return { key, skipped: "denylist" };
							const obj = await env.MEMORY_BUCKET.get(key);
							if (!obj) return { key, skipped: "missing" };
							const content = await obj.text();
							if (!content.trim()) return { key, skipped: "empty" };
							const secret = await checkForSecrets(ai, content);
							// biome-ignore lint/suspicious/noExplicitAny: AI Search binding types are not in workers-types yet; throwaway spike
							// Fail closed for the spike: anything the gate can't
							// clear stays out of a second store.
							if (secret !== false) return { key, skipped: `credential-gate:${secret}` };
							try {
								const item = await instance(env).items.upload(key, content, {
									metadata: { path: key, mtime: String(obj.uploaded.getTime()) },
								});
								return { key, id: item.id, tags: parseTags(content) };
							} catch (e) {
								return { key, error: (e as Error).message };
							}
						}),
					);
					return json(out);
				}

				case "/items": {
					const page = await instance(env).items.list({
						page: body.page ?? 1,
						per_page: 50,
						status: body.status,
					});
					return json(page);
				}

				case "/search": {
					const r = await runSearch(
						env,
						body.query,
						body.mode ?? "hybrid",
						body.limit ?? 10,
						body.filters,
					);
					return json(r);
				}

				case "/latency": {
					// uploadAndPoll on a throwaway key, then search for it.
					const size: number = body.size ?? 2300 * 4;
					const marker = `spike-marker-${crypto.randomUUID().slice(0, 8)}`;
					const base = `# Latency probe\n\n${marker} is a unique token for this probe.\n\n${"Memory files hold notes, learnings and plans. ".repeat(Math.ceil(size / 45))}`;
					const content = base.slice(0, size);
					const key = `memory/_spike/latency-${marker}.md`;
					const t0 = Date.now();
					const item = await instance(env).items.uploadAndPoll(key, content, {
						pollIntervalMs: body.poll ?? 250,
						timeoutMs: 120000,
					});
					const tUpload = Date.now() - t0;
					const t1 = Date.now();
					const found = await runSearch(env, marker, "keyword", 3);
					const tSearch = Date.now() - t1;
					const visible = found.files.some((f) => f.path === key);
					await instance(env)
						.items.delete(item.id)
						.catch(() => null);
					return json({
						size,
						status: item.status,
						chunks: item.chunks_count,
						upload_and_poll_ms: tUpload,
						search_ms: tSearch,
						visible,
					});
				}

				case "/embed": {
					// Offline baselines: the same bge-m3 call the DO makes, for
					// exact-cosine and chunked-cosine comparisons run in the harness.
					// Body: { texts: string[] } or { keys: string[], chunk?: number, overlap?: number }.
					const round = (v: number[]) => v.map((x) => Math.round(x * 1e5) / 1e5);
					if (body.texts) {
						const vecs = await Promise.all(
							(body.texts as string[]).map(async (t) =>
								round((await generateEmbedding(env.AI, t)).vector),
							),
						);
						return json(vecs);
					}
					const chunk: number = body.chunk ?? 0;
					const overlap: number = body.overlap ?? 0;
					const out = await Promise.all(
						(body.keys as string[]).map(async (key) => {
							const obj = await env.MEMORY_BUCKET.get(key);
							if (!obj) return { key, error: "missing" };
							const content = await obj.text();
							const pieces: string[] = [];
							if (!chunk) pieces.push(content);
							else
								for (let i = 0; i < content.length; i += chunk - overlap) {
									pieces.push(content.slice(i, i + chunk));
									if (i + chunk >= content.length) break;
								}
							const vecs: number[][] = [];
							for (const p of pieces) vecs.push(round((await generateEmbedding(env.AI, p)).vector));
							return { key, content: body.with_content ? content : undefined, vecs };
						}),
					);
					return json(out);
				}

				case "/visible": {
					// upload(), then poll search until the doc is returned. Measures
					// write-to-searchable, which is what overlap detection needs,
					// independently of the item status flag.
					const size: number = body.size ?? 9200;
					const marker = `spikemarker${crypto.randomUUID().slice(0, 8)}`;
					const content =
						`# Latency probe ${marker}\n\n${marker} is a unique token for this probe.\n\n${`Memory files hold notes, learnings and plans. ${marker} `.repeat(Math.ceil(size / 60))}`.slice(
							0,
							size,
						);
					const key = `memory/_spike/visible-${marker}.md`;
					const t0 = Date.now();
					const item = await instance(env).items.upload(key, content);
					const tUpload = Date.now() - t0;
					let keywordAt: number | null = null;
					let vectorAt: number | null = null;
					let polls = 0;
					while (
						Date.now() - t0 < (body.timeout ?? 100000) &&
						(keywordAt === null || vectorAt === null)
					) {
						polls++;
						const [k, v] = await Promise.all([
							keywordAt === null ? runSearch(env, marker, "keyword", 3) : null,
							vectorAt === null ? runSearch(env, `Latency probe ${marker}`, "vector", 50) : null,
						]);
						if (k?.files.some((f) => f.path === key)) keywordAt = Date.now() - t0;
						if (v?.files.some((f) => f.path === key)) vectorAt = Date.now() - t0;
						if (keywordAt === null || vectorAt === null)
							await new Promise((r) => setTimeout(r, body.poll ?? 500));
					}
					const info = await instance(env)
						.items.get(item.id)
						.info()
						.catch((e: Error) => ({ status: e.message }));
					await instance(env)
						.items.delete(item.id)
						.catch(() => null);
					return json({
						size,
						upload_ms: tUpload,
						keyword_visible_ms: keywordAt,
						vector_visible_ms: vectorAt,
						polls,
						status_at_end: info.status,
						chunks: info.chunks_count,
					});
				}

				case "/in-test": {
					// filename/path $in with N candidates; real targets padded with fakes.
					const real: string[] = body.real ?? [];
					const n: number = body.n ?? 50;
					const field: string = body.field ?? "filename";
					const candidates = [...real];
					for (let i = candidates.length; i < n; i++) candidates.push(`memory/_fake/nope-${i}.md`);
					const t0 = Date.now();
					try {
						const r = await runSearch(env, body.query, body.mode ?? "hybrid", 10, {
							[field]: { $in: candidates },
						});
						return json({ n, field, ok: true, ms: Date.now() - t0, files: r.files, raw: r.raw });
					} catch (e) {
						return json({ n, field, ok: false, ms: Date.now() - t0, error: (e as Error).message });
					}
				}

				case "/teardown": {
					await env.AI_SEARCH.delete(INSTANCE);
					return json({ deleted: INSTANCE });
				}
			}
			return json({ error: "not found" }, 404);
		} catch (e) {
			return json({ error: (e as Error).message, stack: (e as Error).stack }, 500);
		}
	},
};
