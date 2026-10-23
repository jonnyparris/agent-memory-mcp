# Changelog

What changed in each version, in plain English. Newest first.

If you run your own copy, the **"Do you need to do anything?"** part of each
version tells you what to do after you update. Most updates need nothing.

Version numbers follow [Semantic Versioning](https://semver.org/): the middle
number goes up for new features, the last number for fixes.

## [0.3.0] - 2026-10-23

### In short

Search finds the right note far more often. You can now undo changes, delete
and move files, and read very long files in full. The nightly clean-up job
actually does its work now, and tells you honestly when it doesn't finish.
An idle connection no longer runs up hundreds of thousands of requests a
month.

### Search is much better

- **It finds the right note about 9 times in 10.** Before, it was about half
  the time. We measured this with 42 real questions.
- **Long files are searched all the way through.** Before, only the start of
  each file was searched. Now every file is split into small pieces, and each
  piece is searched.
- **Exact words count.** Search now also matches exact words, such as ticket
  numbers, names and error messages. Before, it matched only by general
  meaning, so these were often missed.
- **Results show the part that matched.** The preview now shows the part of
  the file that answers your question, not just the first lines.
- **Less clutter in results.** Drafts, machine-written logs and old archives
  are kept out of search. They are still saved, and you can still open them.
- **Filtering by tag works properly.** Before, a tagged file could be missed
  if many other files matched better. Listing files by tag also returned
  nothing. Both are fixed.
- **Optional smarter ranking.** Ask search to `rerank`, and an AI model
  re-orders the top results by which one actually answers your question.

### Your notes are safer

- **Undo works.** Every time a file is changed, moved or deleted, the old
  version is kept (the last 20 versions of each file). `history` shows them
  and `rollback` brings one back. Before, these tools looked like they worked
  but did nothing. History starts from your first change after updating.
- **New: delete and move files.** Both keep a copy first, so you can undo
  them. Moving a file also tells you which other notes link to the old name.
- **Long files can be read in full.** Before, anything past 50,000
  characters was cut off. An AI that read a long file and saved it again
  could lose the end of it. Reads now come in pages, so nothing is lost.
- **Duplicate warnings are more accurate.** When you save a note that repeats
  one you already have, you get a warning. It now also catches repeats deep
  inside long files, and it warns less often about notes that are only
  related.
- **Passwords and keys are not made searchable.** If a note looks like it
  contains a password or secret key, it is saved but left out of search.

### The nightly clean-up works now

Every night the server reviews your notes and tidies them up.

- **It used to do nothing.** For months it said "Memory looks good" every
  night, because it ran out of time before it could record anything. That
  is fixed.
- **It tells the truth.** If a run doesn't finish, it says so. It never says
  "looks good" unless it actually checked.
- **One job per night.** Each weekday it checks one thing, such as old plans,
  conflicting lessons, or notes that should link to each other. Small jobs
  get finished; "check everything" never did.
- **Simple fixes are done by plain code.** Extra spaces and blank lines are
  cleaned up without using AI at all.
- **Safety limits.** It never deletes a whole file, and it won't make an edit
  that removes more than 30% of a file. It flags those for you instead. Every
  change it makes can be undone.
- **Fewer messages.** You hear from it only when there is something to look
  at, plus a short weekly summary on Sundays.
- **New default AI model:** DeepSeek V4 Flash. It found the most real issues
  in testing. Gemma 4 is cheaper if you want to stay closer to free.

### Lower cost

- **An idle AI assistant no longer costs requests.** A bug made connected
  assistants reconnect every second, even when doing nothing. One month
  this came to 765,000 requests. That is fixed.

### Removed

- **The `execute` tool is gone.** It never worked on the live service, and it
  was a security risk. Use `search`, `read` and `list` instead.

### Do you need to do anything?

- **Run `reindex`** after updating, until it reports `remaining: 0`. This
  rebuilds search for your existing notes. If you skip it, the nightly job
  does it slowly for you (100 files a night). Search still works in the
  meantime, just not as well.
- **If you used `execute`,** switch to `search`, `read` and `list`.
- **If you set `REFLECTION_MODEL_FAST`,** you can remove it. It is no
  longer used.
- **Optional:** to keep costs as low as possible, set `REFLECTION_MODEL` to
  `@cf/google/gemma-4-26b-a4b-it` in `wrangler.jsonc`.

## [0.2.0] - 2026-07-01

### In short

Saving many files at once, faster saves, and a sync helper.

### Added

- **Save up to 50 files in one go** with `write_many`.
- **Faster saves.** You can choose not to wait for search to catch up, or to
  skip the duplicate check. Saves then take under a second.
- **Sync helper.** `list` now gives a fingerprint for each file, so a sync
  tool can skip files that haven't changed.
- **Nightly clean-up messages list the issues it found.**

### Changed

- The nightly clean-up uses the Gemma 4 AI model.

### Fixed

- **Saving an empty file is refused by default,** so a mistake can't wipe a
  note. Pass `allow_empty: true` if you really mean it.
- The nightly clean-up no longer fails when the AI model runs out of space
  while thinking.

### Do you need to do anything?

No.

## [0.1.0] - 2026-02-04

First release.

- A memory server for AI assistants that you run on your own Cloudflare
  account.
- Save, read, list and search notes. Search works by meaning, not just exact
  words.
- Tags (in the file header) to group and filter notes.
- `[[wikilinks]]` between notes, and a way to see which notes link to which.
- Search across your past AI conversations.
- Reminders, one-off or repeating.
- A nightly job that suggests improvements to your notes.

[0.3.0]: https://github.com/jonnyparris/agent-memory-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jonnyparris/agent-memory-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jonnyparris/agent-memory-mcp/releases/tag/v0.1.0
