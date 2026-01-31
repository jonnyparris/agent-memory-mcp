# Claude Code Setup

Configure Claude Code (Anthropic's official CLI) to use agent-memory-mcp.

## Prerequisites

1. **Deploy the worker** to your Cloudflare account (see main README)
2. **Note your worker URL**: `https://agent-memory-mcp.YOUR_SUBDOMAIN.workers.dev`
3. **Have your auth token** ready (the one you set with `wrangler secret put`)

## Setup Steps

### 1. Set your auth token as an environment variable

```bash
# Add to your shell profile (~/.zshrc, ~/.bashrc, etc.)
export MEMORY_AUTH_TOKEN="your-secret-token-here"

# Reload your shell
source ~/.zshrc  # or ~/.bashrc
```

### 2. Add the MCP server to Claude Code

```bash
# Replace YOUR_SUBDOMAIN with your actual workers.dev subdomain
claude mcp add --transport http agent-memory \
  "https://agent-memory-mcp.YOUR_SUBDOMAIN.workers.dev/mcp" \
  --header "Authorization: Bearer $MEMORY_AUTH_TOKEN"
```

### 3. Verify the connection

```bash
# List configured MCP servers
claude mcp list

# You should see agent-memory in the list
```

## Alternative: Project-Scoped Configuration

To configure for a specific project instead of globally:

```bash
# Run from your project directory
claude mcp add --transport http --scope project agent-memory \
  "https://agent-memory-mcp.YOUR_SUBDOMAIN.workers.dev/mcp" \
  --header "Authorization: Bearer $MEMORY_AUTH_TOKEN"
```

This creates a `.claude/mcp.json` file in your project.

## Testing the Connection

Start Claude Code and try these commands:

```
# Write a test file
> Write "Hello from Claude Code" to memory/test.md

# Read it back
> Read memory/test.md

# Search your memories
> Search my memories for "Claude Code"
```

## Troubleshooting

### "Unauthorized" error
- Verify your `MEMORY_AUTH_TOKEN` env var is set: `echo $MEMORY_AUTH_TOKEN`
- Ensure it matches the token you set with `wrangler secret put MEMORY_AUTH_TOKEN`

### "Connection refused" error
- Check your worker is deployed: `npx wrangler deployments list`
- Verify the URL is correct (no typos in subdomain)

### MCP server not appearing
- Restart Claude Code after adding the server
- Check `claude mcp list` shows the server

## Removing the Server

```bash
# Remove globally
claude mcp remove agent-memory

# Or remove from project scope
claude mcp remove --scope project agent-memory
```

## Configuration File Locations

- **Global config**: `~/.claude/mcp.json`
- **Project config**: `.claude/mcp.json` (in project root)

Example `mcp.json` structure (for reference):

```json
{
  "mcpServers": {
    "agent-memory": {
      "transport": "http",
      "url": "https://agent-memory-mcp.YOUR_SUBDOMAIN.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer your-token-here"
      }
    }
  }
}
```

**Note**: Prefer using the `claude mcp add` command over manually editing this file.
