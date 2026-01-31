# agent-memory-mcp

A self-hostable MCP server for AI agent memory, built on Cloudflare Workers + R2 + Durable Objects.

Provides semantic search, file versioning, and codemode queries for personal AI agent memory systems.

## Features

- **Semantic Search**: Find memories by meaning, not just keywords
- **File Versioning**: Git-like history for all memory files (via R2 versioning)
- **Codemode Execution**: Run JavaScript against your memories for complex queries
- **Self-Hosted**: Your data stays on your Cloudflare account
- **Free Tier Friendly**: Runs entirely within Cloudflare's free tier for personal use

## Quick Start

### 1. Clone and Deploy

```bash
git clone https://github.com/jonnyparris/agent-memory-mcp.git
cd agent-memory-mcp
npm install

# Create your R2 bucket
npx wrangler r2 bucket create agent-memory

# Set your auth token
npx wrangler secret put MEMORY_AUTH_TOKEN
# Enter a secure random token when prompted

# Deploy
npm run deploy
```

### 2. Configure Your AI Assistant

#### OpenCode

Add to `.opencode/opencode.json`:

```json
{
  "mcp": {
    "agent-memory": {
      "type": "remote",
      "url": "https://agent-memory-mcp.YOUR_SUBDOMAIN.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer {env:MEMORY_AUTH_TOKEN}"
      }
    }
  }
}
```

#### Claude Code

```bash
export MEMORY_AUTH_TOKEN="your-secret-token"
claude mcp add --transport http agent-memory \
  https://agent-memory-mcp.YOUR_SUBDOMAIN.workers.dev/mcp \
  --header "Authorization: Bearer $MEMORY_AUTH_TOKEN"
```

#### Cursor

Settings > MCP Servers > Add:
- URL: `https://agent-memory-mcp.YOUR_SUBDOMAIN.workers.dev/mcp`
- Headers: `Authorization: Bearer YOUR_TOKEN`

## Available Tools

### `read`
Read a file from memory storage.

```typescript
read({ path: "memory/learnings.md" })
// Returns: { content, updated_at, size }
```

### `write`
Write content to a file. Automatically updates search index.

```typescript
write({ path: "memory/learnings.md", content: "# My Learnings\n..." })
// Returns: { success: true, version_id }
```

### `list`
List files in a directory.

```typescript
list({ path: "memory/", recursive: true })
// Returns: { files: [{ path, size, updated_at }] }
```

### `search`
Search memory by meaning. Returns relevant file snippets.

```typescript
search({ query: "how to deploy workers", limit: 5 })
// Returns: { results: [{ path, snippet, score }] }
```

### `history`
List previous versions of a file.

```typescript
history({ path: "memory/learnings.md", limit: 10 })
// Returns: { versions: [{ version_id, timestamp, size }] }
```

### `rollback`
Restore a file to a previous version.

```typescript
rollback({ path: "memory/learnings.md", version_id: "abc123" })
// Returns: { success: true, restored_from }
```

### `execute`
Execute JavaScript code against memory contents.

```typescript
execute({
  code: `
    const files = await memory.list("memory/");
    const contents = await Promise.all(files.map(f => memory.read(f.path)));
    return contents.filter(c => c.includes("TypeScript")).length;
  `
})
// Returns: { result: 5 }
```

## Recommended Memory Structure

```
memory/
├── learnings.md        # Corrections, lessons learned
├── preferences.md      # User preferences, working style
├── people.md           # People you work with
├── projects.md         # Active projects
│
├── patterns/           # Reusable patterns
│   ├── git.md
│   ├── code-review.md
│   └── debugging.md
│
├── workload/           # Current work tracking
│   ├── active.md
│   ├── backlog.md
│   └── archive/
│
└── archive/            # Old context
```

## Development

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Run tests
npm test

# Run specific test suites
npm run test:unit
npm run test:integration

# Deploy
npm run deploy
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    agent-memory-mcp Worker                       │
├─────────────────────────────────────────────────────────────────┤
│  MCP Server                                                      │
│  - Auth validation (Bearer token)                                │
│  - Tool handlers (read, write, list, search, etc.)              │
├─────────────────────┬───────────────────────────────────────────┤
│  R2 Bucket          │  Durable Object (MemoryIndex)             │
│  - File storage     │  - HNSW vector index                      │
│  - Versioning       │  - SQLite persistence                     │
│                     │  - Workers AI embeddings                   │
└─────────────────────┴───────────────────────────────────────────┘
```

## Cost Estimate (Personal Use)

| Service | Free Tier | Typical Usage | Cost |
|---------|-----------|---------------|------|
| R2 Storage | 10 GB/month | ~1 MB | $0 |
| R2 Reads | 10M/month | ~3K | $0 |
| R2 Writes | 1M/month | ~600 | $0 |
| Workers Requests | 10M/month | ~6K | $0 |
| Workers AI | 10K neurons/day | ~60 | $0 |
| Durable Objects | 100K req/day | ~200 | $0 |

**Total: $0/month** (within free tier)

## License

MIT
