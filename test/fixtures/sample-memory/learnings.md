# Learnings

## 2026-01-31

### Git Operations
- Never use `git clean -fd` without checking what will be deleted first
- Always use `git clean -n` (dry run) before actual clean
- Lost files can sometimes be recovered from IDE local history

### TypeScript
- Use `satisfies` for type checking without widening
- Prefer `unknown` over `any` for better type safety
- Template literal types are powerful for string manipulation

### Cloudflare Workers
- Durable Objects have 128MB memory limit
- SQLite in DO is great for persistence
- Use R2 versioning for file history
