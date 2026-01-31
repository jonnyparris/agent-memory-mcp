#!/usr/bin/env npx tsx
/**
 * Migration script: Upload local memory files to the deployed MCP server
 *
 * Usage:
 *   MEMORY_MCP_URL=https://your-worker.workers.dev \
 *   MEMORY_AUTH_TOKEN=your-token \
 *   npx tsx scripts/migrate.ts [source-dir]
 *
 * Arguments:
 *   source-dir  Path to local memory directory (default: ./memory)
 *
 * The script will:
 *   1. Recursively read all files from the source directory
 *   2. Upload each file to R2 via the MCP server's write tool
 *   3. The MCP server automatically updates embeddings on write
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const MCP_URL = process.env.MEMORY_MCP_URL;
const AUTH_TOKEN = process.env.MEMORY_AUTH_TOKEN;

if (!MCP_URL || !AUTH_TOKEN) {
	console.error("Error: MEMORY_MCP_URL and MEMORY_AUTH_TOKEN environment variables are required");
	console.error("\nUsage:");
	console.error("  MEMORY_MCP_URL=https://your-worker.workers.dev \\");
	console.error("  MEMORY_AUTH_TOKEN=your-token \\");
	console.error("  npx tsx scripts/migrate.ts [source-dir]");
	process.exit(1);
}

const sourceDir = process.argv[2] || "./memory";

interface McpResponse {
	jsonrpc: string;
	id: number;
	result?: {
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
	};
	error?: {
		code: number;
		message: string;
	};
}

interface WriteResult {
	success?: boolean;
	version_id?: string;
	error?: string;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<McpResponse> {
	const response = await fetch(`${MCP_URL}/mcp`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${AUTH_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: Date.now(),
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${await response.text()}`);
	}

	return response.json() as Promise<McpResponse>;
}

async function getAllFiles(dir: string): Promise<string[]> {
	const files: string[] = [];

	async function walk(currentDir: string): Promise<void> {
		const entries = await readdir(currentDir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);

			// Skip hidden files and directories
			if (entry.name.startsWith(".")) {
				continue;
			}

			if (entry.isDirectory()) {
				await walk(fullPath);
			} else {
				files.push(fullPath);
			}
		}
	}

	await walk(dir);
	return files;
}

async function migrate(): Promise<void> {
	console.log(`\nMigrating files from: ${sourceDir}`);
	console.log(`To MCP server: ${MCP_URL}\n`);

	// Check if source directory exists
	try {
		const dirStat = await stat(sourceDir);
		if (!dirStat.isDirectory()) {
			console.error(`Error: ${sourceDir} is not a directory`);
			process.exit(1);
		}
	} catch {
		console.error(`Error: Source directory ${sourceDir} does not exist`);
		process.exit(1);
	}

	// Get all files
	const files = await getAllFiles(sourceDir);

	if (files.length === 0) {
		console.log("No files found in source directory");
		return;
	}

	console.log(`Found ${files.length} file(s) to migrate\n`);

	let successCount = 0;
	let errorCount = 0;

	for (const filePath of files) {
		const relativePath = relative(sourceDir, filePath);
		// Use the relative path as the R2 key, preserving directory structure
		// Prefix with "memory/" to match expected MCP storage layout
		const r2Path = `memory/${relativePath}`;

		process.stdout.write(`Uploading: ${relativePath} ... `);

		try {
			const content = await readFile(filePath, "utf-8");
			const response = await callTool("write", { path: r2Path, content });

			if (response.error) {
				console.log(`ERROR: ${response.error.message}`);
				errorCount++;
				continue;
			}

			if (response.result?.isError) {
				const text = response.result.content[0]?.text || "Unknown error";
				const parsed = JSON.parse(text) as { error?: string };
				console.log(`ERROR: ${parsed.error || text}`);
				errorCount++;
				continue;
			}

			const resultText = response.result?.content[0]?.text;
			if (resultText) {
				const result = JSON.parse(resultText) as WriteResult;
				if (result.success) {
					console.log("OK");
					successCount++;
				} else {
					console.log(`ERROR: ${result.error || "Unknown error"}`);
					errorCount++;
				}
			} else {
				console.log("OK (no response body)");
				successCount++;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.log(`ERROR: ${message}`);
			errorCount++;
		}
	}

	console.log("\n--- Migration Summary ---");
	console.log(`Total files:  ${files.length}`);
	console.log(`Successful:   ${successCount}`);
	console.log(`Failed:       ${errorCount}`);

	if (errorCount > 0) {
		process.exit(1);
	}
}

migrate().catch((err) => {
	console.error("Migration failed:", err);
	process.exit(1);
});
