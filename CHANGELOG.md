# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

From v0.2.0 onward, entries are generated from [Conventional Commits](https://www.conventionalcommits.org/)
via `npm run release` (commit-and-tag-version). The 0.1.0 entry was
backfilled by hand from history.

## [0.2.0] - 2026-07-01

### Added
- `list` now returns each file's R2 `etag`, so a sync client can diff it
  against a local content hash and skip re-downloading unchanged files.
- `write_many` — write up to 50 files in a single MCP call, with parallel
  R2 writes and concurrent search-index updates.
- `write` gained `wait_for_index` and `detect_overlaps` flags for
  sub-second writes when the caller doesn't need the search index to be
  consistent the moment the call returns.
- Scheduled reflection surfaces flagged issues in its Google Chat card.

### Changed
- Reflection primary model swapped to Gemma 4 26B.

### Fixed
- `write` refuses empty content by default to prevent silent overwrites
  (pass `allow_empty: true` to truncate deliberately).
- LLM provider falls back to `reasoning_content` when `content` is null,
  so a reasoning model that exhausts its token budget mid-deliberation
  still returns a usable answer.

## [0.1.0] - 2026-02-04

Initial release.

### Added
- Self-hostable MCP server for AI agent memory on Cloudflare Workers,
  backed by R2 storage and a Durable Object semantic index.
- Core memory tools: `read` (single file or up to 50 in one call),
  `write`, `list`, `search`, `history`, `rollback`, and `execute`.
- Tag support: YAML frontmatter extraction, `list_tags`, and tag-filtered
  `list`/`search`.
- Obsidian-style `[[wikilink]]` indexing with `get_backlinks`.
- Conversation indexing with time-weighted semantic search.
- Reminders (recurring cron and one-shot).
- Agentic reflection via Workers AI, with list/apply/archive tools and
  archived reflection records.

[0.2.0]: https://github.com/jonnyparris/agent-memory-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jonnyparris/agent-memory-mcp/releases/tag/v0.1.0
