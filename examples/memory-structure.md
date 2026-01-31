# Recommended Memory Structure

Organize your memory files for optimal retrieval and semantic search.

## Directory Layout

```
memory/
├── learnings.md        # Corrections, lessons learned, mistakes to avoid
├── preferences.md      # Your preferences, working style, tool choices
├── people.md           # People you work with, their roles & communication styles
├── projects.md         # Active projects, goals, context
│
├── patterns/           # Reusable patterns and workflows
│   ├── git.md          # Git workflows, branching strategies
│   ├── code-review.md  # Code review guidelines, common feedback
│   ├── debugging.md    # Debugging techniques, common issues
│   └── deployment.md   # Deployment checklists, rollback procedures
│
├── domains/            # Domain-specific knowledge
│   ├── typescript.md   # TypeScript tips, gotchas, patterns
│   ├── cloudflare.md   # Workers, R2, D1, Durable Objects notes
│   └── your-stack.md   # Your tech stack specifics
│
├── workload/           # Current work tracking
│   ├── active.md       # What you're working on right now
│   ├── backlog.md      # Upcoming work, priorities
│   ├── weekly/         # Weekly plans and reviews
│   │   └── 2026-w05.md
│   └── archive/        # Completed work for reference
│
└── conversations/      # Notable conversation summaries (optional)
    └── 2026-01-31-feature-discussion.md
```

## File Guidelines

### Keep Files Focused

Each file should cover one topic. Smaller, focused files:
- Search better (semantic search returns relevant snippets)
- Are easier to update
- Avoid context pollution

**Good**: `patterns/git.md` with just git patterns
**Bad**: `everything.md` with all your notes jumbled together

### Use Descriptive Headers

Headers become search anchors. Make them descriptive:

```markdown
# Git Patterns

## Squash Merge Strategy for Feature Branches

When merging feature branches to main...

## Recovering Lost Commits with Reflog

If you accidentally reset or rebase...
```

### Date Your Learnings

Add dates to time-sensitive content so you know when you learned something:

```markdown
# Learnings

## 2026-01-31

### TypeScript 5.4 Features
- The `NoInfer<T>` utility type prevents inference...

## 2026-01-28

### R2 Versioning Gotcha
- Versioning must be enabled per-bucket, not retroactive...
```

### Link Related Content

Reference other memory files when relevant:

```markdown
# Projects

## agent-memory-mcp

Building an MCP server for AI memory.

Related:
- See `domains/cloudflare.md` for Workers patterns
- See `patterns/deployment.md` for release checklist
```

## Example Files

### learnings.md

Track corrections and mistakes to avoid repeating them:

```markdown
# Learnings

## 2026-01-31

### Git Operations
- NEVER use `git clean -fd` without `git clean -n` first (dry run)
- Lost files can sometimes be recovered from IDE local history
- Check `.gitignore` patterns before cleaning

### TypeScript
- Use `satisfies` for type checking without widening
- Prefer `unknown` over `any` for better type safety
- `as const` makes objects deeply readonly

## 2026-01-28

### Cloudflare Workers
- Durable Objects have 128MB memory limit
- SQLite in DO is persisted to disk, survives restarts
- R2 versioning must be enabled before it tracks versions
```

### preferences.md

Help the AI assistant understand how you work:

```markdown
# Preferences

## Communication Style
- Be direct - no need for pleasantries or hedging
- Push back if my reasoning seems weak
- Prefer async communication over meetings

## Code Style
- TypeScript strict mode always
- Prefer composition over inheritance
- Small, focused functions over large classes
- Tests should read like documentation

## Tools
- Editor: VS Code with Vim keybindings
- Terminal: iTerm2 with zsh
- AI: OpenCode for coding, Claude for research

## Working Hours
- Most productive: 9am - 12pm
- Deep work blocks: Wednesday afternoons
- No meetings before 10am please
```

### people.md

Remember who you work with:

```markdown
# People

## Direct Team

### Alice Chen (Senior Engineer)
- Focus: Backend systems, distributed computing
- Communication: Prefers Slack DMs, code reviews over meetings
- Note: Very detail-oriented, appreciates thorough PRs

### Bob Smith (Product Manager)
- Focus: User experience, roadmap
- Communication: Prefers written specs, async updates
- Note: Likes bullet points, dislikes long paragraphs

## Key Stakeholders

### Carol Davis (Engineering Director)
- Cares about: Reliability, team velocity, technical debt
- Meeting style: Prepared agendas, time-boxed discussions
```

### projects.md

Track active project context:

```markdown
# Projects

## agent-memory-mcp (Active)

MCP server for AI agent memory with semantic search.

**Status**: Alpha - core features working
**Goals**: 
- Semantic search across memory files
- File versioning via R2
- Codemode for complex queries

**Key Decisions**:
- Using Durable Objects for vector index (HNSW)
- SQLite for persistence within DO
- Workers AI for embeddings (@cf/baai/bge-base-en-v1.5)

## other-project (Backlog)

...
```

## Search Tips

The semantic search works best when you:

1. **Use natural language in queries**: "how to recover deleted git commits" works better than "git reflog"

2. **Keep related content together**: A section about git recovery will match better than scattered mentions

3. **Be specific in your notes**: "Use `git reflog` to find lost commits after accidental reset" is more searchable than "reflog is useful"

## Maintenance

### Weekly Review
- Archive completed work to `workload/archive/`
- Update `active.md` with current priorities
- Add any learnings from the week

### Monthly Cleanup
- Review `learnings.md` - consolidate or move to `patterns/`
- Update `people.md` with new team members
- Archive old conversations

### Keep It Lightweight
Don't over-organize. Start simple and add structure as needed. A few well-maintained files beat a complex hierarchy you never update.
