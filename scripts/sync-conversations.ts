#!/usr/bin/env npx tsx
/**
 * Sync OpenCode Conversations to agent-memory-mcp
 *
 * Parses local OpenCode session files and pushes them to the MCP server
 * for indexing. Supports incremental updates (only syncs changed files).
 *
 * Usage:
 *   MEMORY_MCP_URL=https://your-worker.workers.dev/mcp \
 *   MEMORY_AUTH_TOKEN=your-token \
 *   npx tsx scripts/sync-conversations.ts
 *
 * Environment:
 *   MEMORY_MCP_URL - URL of your agent-memory-mcp server
 *   MEMORY_AUTH_TOKEN - Auth token for the server
 *   OPENCODE_STORAGE - Override OpenCode storage path (default: ~/.local/share/opencode/storage)
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// Configuration
const MCP_URL = process.env.MEMORY_MCP_URL;
const AUTH_TOKEN = process.env.MEMORY_AUTH_TOKEN;
const OPENCODE_STORAGE =
	process.env.OPENCODE_STORAGE || join(homedir(), ".local/share/opencode/storage");
const STATE_FILE = join(OPENCODE_STORAGE, ".sync-state.json");

interface SyncState {
	lastSync: string;
	syncedSessions: Record<string, number>; // sessionId -> mtime
}

function loadSyncState(): SyncState {
	if (existsSync(STATE_FILE)) {
		try {
			return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
		} catch {
			// Corrupted, start fresh
		}
	}
	return { lastSync: "", syncedSessions: {} };
}

function saveSyncState(state: SyncState): void {
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function callMcpTool(name: string, args: Record<string, unknown>): Promise<unknown> {
	if (!MCP_URL || !AUTH_TOKEN) {
		throw new Error("MEMORY_MCP_URL and MEMORY_AUTH_TOKEN environment variables are required");
	}

	const response = await fetch(MCP_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${AUTH_TOKEN}`,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: Date.now(),
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});

	if (!response.ok) {
		throw new Error(`MCP request failed: ${response.status} ${await response.text()}`);
	}

	const result = (await response.json()) as {
		result?: { content?: Array<{ text?: string }> };
		error?: { message: string };
	};
	if (result.error) {
		throw new Error(`MCP error: ${result.error.message}`);
	}

	// Parse the tool result
	const text = result.result?.content?.[0]?.text;
	return text ? JSON.parse(text) : null;
}

interface OpenCodeSession {
	id?: string;
	messages?: Array<{
		role: string;
		content: unknown;
		timestamp?: string;
	}>;
	createdAt?: string;
}

function* scanSessions(): Generator<{
	sessionId: string;
	project: string;
	filePath: string;
	mtime: number;
}> {
	const sessionDir = join(OPENCODE_STORAGE, "session");
	if (!existsSync(sessionDir)) {
		console.log(`No session directory found at ${sessionDir}`);
		return;
	}

	// OpenCode stores sessions in: storage/session/{projectHash}/{sessionId}.json
	const projectDirs = readdirSync(sessionDir);

	for (const projectDir of projectDirs) {
		if (projectDir.startsWith(".")) continue;

		const projectPath = join(sessionDir, projectDir);
		if (!statSync(projectPath).isDirectory()) continue;

		const sessionFiles = readdirSync(projectPath).filter((f) => f.endsWith(".json"));

		for (const sessionFile of sessionFiles) {
			const filePath = join(projectPath, sessionFile);
			const mtime = statSync(filePath).mtimeMs;
			const sessionId = basename(sessionFile, ".json");

			yield {
				sessionId,
				project: projectDir, // Project hash
				filePath,
				mtime,
			};
		}
	}
}

async function main() {
	console.log("Syncing OpenCode conversations to agent-memory-mcp...\n");

	if (!MCP_URL || !AUTH_TOKEN) {
		console.error("Error: MEMORY_MCP_URL and MEMORY_AUTH_TOKEN environment variables are required");
		console.error("\nUsage:");
		console.error(
			"  MEMORY_MCP_URL=https://your-worker.workers.dev/mcp MEMORY_AUTH_TOKEN=xxx npx tsx scripts/sync-conversations.ts",
		);
		process.exit(1);
	}

	const state = loadSyncState();
	const sessionsToSync: Array<{ sessionId: string; project: string; data: OpenCodeSession }> = [];
	let skipped = 0;

	// Scan for changed sessions
	for (const { sessionId, project, filePath, mtime } of scanSessions()) {
		const lastMtime = state.syncedSessions[sessionId];

		if (lastMtime && lastMtime >= mtime) {
			skipped++;
			continue;
		}

		try {
			const content = readFileSync(filePath, "utf-8");
			const data = JSON.parse(content) as OpenCodeSession;

			// Only sync sessions with actual messages
			if (data.messages && data.messages.length > 0) {
				sessionsToSync.push({ sessionId, project, data });
				state.syncedSessions[sessionId] = mtime;
			}
		} catch (e) {
			console.warn(`  Skipping ${sessionId}: ${e}`);
		}
	}

	console.log(`Found ${sessionsToSync.length} sessions to sync (${skipped} unchanged)\n`);

	if (sessionsToSync.length === 0) {
		console.log("Nothing to sync.");
		return;
	}

	// Batch sync to MCP server
	const BATCH_SIZE = 10;
	let totalAdded = 0;
	let totalUpdated = 0;

	for (let i = 0; i < sessionsToSync.length; i += BATCH_SIZE) {
		const batch = sessionsToSync.slice(i, i + BATCH_SIZE);
		console.log(`Syncing batch ${Math.floor(i / BATCH_SIZE) + 1}...`);

		try {
			const result = (await callMcpTool("index_conversations", { sessions: batch })) as {
				added?: number;
				updated?: number;
				totalIndexed?: number;
			};
			totalAdded += result.added || 0;
			totalUpdated += result.updated || 0;
			console.log(`  Added: ${result.added}, Updated: ${result.updated}`);
		} catch (e) {
			console.error(`  Batch failed: ${e}`);
			// Remove failed sessions from state so they retry next time
			for (const s of batch) {
				delete state.syncedSessions[s.sessionId];
			}
		}
	}

	// Save state
	state.lastSync = new Date().toISOString();
	saveSyncState(state);

	console.log("\nSync complete!");
	console.log(`  Added: ${totalAdded}`);
	console.log(`  Updated: ${totalUpdated}`);
	console.log(`  Total sessions tracked: ${Object.keys(state.syncedSessions).length}`);
}

main().catch((e) => {
	console.error("Fatal error:", e);
	process.exit(1);
});
