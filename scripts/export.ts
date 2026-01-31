#!/usr/bin/env npx tsx
/**
 * Export script: Download all memory files from the deployed MCP server to local disk
 *
 * Usage:
 *   MEMORY_MCP_URL=https://your-worker.workers.dev \
 *   MEMORY_AUTH_TOKEN=your-token \
 *   npx tsx scripts/export.ts [output-dir]
 *
 * Arguments:
 *   output-dir  Path to export files to (default: ./export)
 *
 * The script will:
 *   1. List all files from R2 via the MCP server's list tool
 *   2. Download each file's content via the read tool
 *   3. Write files to local disk, maintaining directory structure
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MCP_URL = process.env.MEMORY_MCP_URL;
const AUTH_TOKEN = process.env.MEMORY_AUTH_TOKEN;

if (!MCP_URL || !AUTH_TOKEN) {
	console.error("Error: MEMORY_MCP_URL and MEMORY_AUTH_TOKEN environment variables are required");
	console.error("\nUsage:");
	console.error("  MEMORY_MCP_URL=https://your-worker.workers.dev \\");
	console.error("  MEMORY_AUTH_TOKEN=your-token \\");
	console.error("  npx tsx scripts/export.ts [output-dir]");
	process.exit(1);
}

const outputDir = process.argv[2] || "./export";

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

interface FileMetadata {
	path: string;
	size: number;
	updated_at: string;
}

interface ListResult {
	files: FileMetadata[];
}

interface ReadResult {
	content: string;
	updated_at: string;
	size: number;
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

function parseToolResult<T>(response: McpResponse): T {
	if (response.error) {
		throw new Error(`MCP error: ${response.error.message}`);
	}

	if (response.result?.isError) {
		const text = response.result.content[0]?.text || "Unknown error";
		throw new Error(`Tool error: ${text}`);
	}

	const text = response.result?.content[0]?.text;
	if (!text) {
		throw new Error("Empty response from MCP server");
	}

	return JSON.parse(text) as T;
}

async function exportMemory(): Promise<void> {
	console.log(`\nExporting files from: ${MCP_URL}`);
	console.log(`To local directory: ${outputDir}\n`);

	// List all files recursively
	console.log("Fetching file list...");
	const listResponse = await callTool("list", { path: "", recursive: true });
	const listResult = parseToolResult<ListResult>(listResponse);

	// Filter out directories (they end with / or have size 0 and look like dirs)
	const files = listResult.files.filter((f) => !f.path.endsWith("/") && f.size > 0);

	if (files.length === 0) {
		console.log("No files found in memory storage");
		return;
	}

	console.log(`Found ${files.length} file(s) to export\n`);

	let successCount = 0;
	let errorCount = 0;

	for (const file of files) {
		process.stdout.write(`Downloading: ${file.path} ... `);

		try {
			// Read file content from MCP server
			const readResponse = await callTool("read", { path: file.path });
			const readResult = parseToolResult<ReadResult>(readResponse);

			if (readResult.error) {
				console.log(`ERROR: ${readResult.error}`);
				errorCount++;
				continue;
			}

			// Determine local file path
			const localPath = join(outputDir, file.path);

			// Create directory structure
			await mkdir(dirname(localPath), { recursive: true });

			// Write file to disk
			await writeFile(localPath, readResult.content, "utf-8");

			console.log(`OK (${readResult.size} bytes)`);
			successCount++;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.log(`ERROR: ${message}`);
			errorCount++;
		}
	}

	console.log("\n--- Export Summary ---");
	console.log(`Total files:  ${files.length}`);
	console.log(`Successful:   ${successCount}`);
	console.log(`Failed:       ${errorCount}`);
	console.log(`\nFiles exported to: ${outputDir}`);

	if (errorCount > 0) {
		process.exit(1);
	}
}

exportMemory().catch((err) => {
	console.error("Export failed:", err);
	process.exit(1);
});
