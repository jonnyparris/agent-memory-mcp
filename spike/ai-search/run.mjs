#!/usr/bin/env node
// Spike harness: recall@5 / MRR@10 for the live HNSW index vs AI Search modes.
//
//   SPIKE_URL=https://agent-memory-aisearch-spike.<sub>.workers.dev \
//   SPIKE_TOKEN=... MEMORY_URL=https://agent-memory-mcp.<sub>.workers.dev/mcp \
//   MEMORY_TOKEN=... SPIKE_DATA=/path/to/private/dir node spike/ai-search/run.mjs > $SPIKE_DATA/results.json
//
// Gold sets live in $SPIKE_DATA/queries.json. A query counts as a hit@k when any gold
// file is in the top k (this is the "did the agent get pointed at the right
// file" question, not graded relevance).
import { readFileSync } from "node:fs";

const { SPIKE_URL, SPIKE_TOKEN, MEMORY_URL, MEMORY_TOKEN } = process.env;
const DATA = process.env.SPIKE_DATA ?? "/tmp/agent-memory-spike";
// Real queries and gold sets name people and tickets, so they stay out of
// this public repo. queries.example.json shows the shape.
const queries = JSON.parse(readFileSync(`${DATA}/queries.json`, "utf8"));
// MODES="" runs only the live index (no spike Worker needed), which is how
// the post-spike index was checked.
const MODES = (process.env.MODES ?? "vector,hybrid,hybrid_or,hybrid_rerank,hybrid_or_rerank")
	.split(",")
	.filter(Boolean);

async function spike(path, body) {
	const r = await fetch(`${SPIKE_URL}${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${SPIKE_TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return r.json();
}

let rpcId = 0;
async function hnsw(query) {
	const t0 = Date.now();
	const r = await fetch(MEMORY_URL, {
		method: "POST",
		headers: {
			authorization: `Bearer ${MEMORY_TOKEN}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: ++rpcId,
			method: "tools/call",
			params: { name: "search", arguments: { query, limit: 10 } },
		}),
	});
	let text = await r.text();
	// Streamable HTTP may answer as SSE.
	if (text.startsWith("event:") || text.startsWith("data:")) {
		text = text
			.split("\n")
			.filter((l) => l.startsWith("data:"))
			.map((l) => l.slice(5))
			.join("");
	}
	const msg = JSON.parse(text);
	const out =
		msg.result?.structuredContent ?? JSON.parse(msg.result.content[0].text.replace(/^[^{]*/, ""));
	return { ms: Date.now() - t0, files: out.results.map((x) => ({ path: x.path, score: x.score })) };
}

function score(files, gold) {
	// Latency probes live under memory/_spike/ and may exist mid-run.
	const paths = files.map((f) => f.path).filter((p) => !p.startsWith("memory/_spike/"));
	const rank = paths.findIndex((p) => gold.includes(p));
	return {
		hit1: rank === 0,
		hit5: rank >= 0 && rank < 5,
		rr: rank >= 0 && rank < 10 ? 1 / (rank + 1) : 0,
		rank,
	};
}

const rows = [];
for (const q of queries) {
	const row = { q: q.q, kind: q.kind, gold: q.gold, systems: {} };
	const base = await hnsw(q.q);
	row.systems.hnsw = {
		ms: base.ms,
		top: base.files.map((f) => f.path).slice(0, 5),
		...score(base.files, q.gold),
	};
	for (const mode of MODES) {
		const r = await spike("/search", { query: q.q, mode, limit: 12 });
		if (r.error) {
			row.systems[mode] = { error: r.error };
			continue;
		}
		row.systems[mode] = {
			ms: r.ms,
			top: r.files
				.map((f) => f.path)
				.filter((p) => !p.startsWith("memory/_spike/"))
				.slice(0, 5),
			...score(r.files, q.gold),
		};
	}
	rows.push(row);
	process.stderr.write(".");
}
process.stderr.write("\n");

const systems = ["hnsw", ...MODES];
const summary = {};
const slices = {
	all: () => true,
	exact: (r) => r.kind.includes("exact"),
	long: (r) => r.kind.includes("long"),
	real: (r) => r.kind.includes("real"),
};
for (const [slice, pred] of Object.entries(slices)) {
	const sel = rows.filter(pred);
	summary[slice] = { n: sel.length };
	for (const s of systems) {
		const ok = sel.filter((r) => !r.systems[s]?.error);
		const ms = ok.map((r) => r.systems[s].ms).sort((a, b) => a - b);
		summary[slice][s] = {
			recall_at_1: +(ok.filter((r) => r.systems[s].hit1).length / ok.length).toFixed(3),
			recall_at_5: +(ok.filter((r) => r.systems[s].hit5).length / ok.length).toFixed(3),
			mrr_at_10: +(ok.reduce((a, r) => a + r.systems[s].rr, 0) / ok.length).toFixed(3),
			p50_ms: ms[Math.floor(ms.length / 2)],
			errors: sel.length - ok.length,
		};
	}
}
console.log(JSON.stringify({ summary, rows }, null, 2));
