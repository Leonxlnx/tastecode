# ADR-0004 — Storage, checkpoints, and search

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

We store months of agent history: threads, turns, items, tool output, diffs, costs. It must
survive crashes, be searchable, support undo, and never lose a user's work.

## Decision

**SQLite, WAL mode, in the server process. An append-only event log is the source of truth;
UI state is a derived read model. FTS5 provides search.**

### Event log as source of truth

```
events(id INTEGER PK, thread_id, seq, type, payload JSON, created_at)
```

Every domain event is appended, never mutated. Read-model tables (`threads`, `turns`,
`items`, `file_changes`, `usage`) are projections rebuilt from the log.

Why this shape:
- **Crash safety.** The app dies mid-turn; on restart we replay and lose nothing.
- **Undo and checkpoints** become natural rather than bolted on.
- **Adapters emit events** already — the log is the same stream, persisted.
- **Schema migration on the read model is cheap** because it can always be rebuilt.

Cost: more write volume and a projection layer to maintain. Worth it. This is the same
pattern T3 Code's `OrchestrationEngine` uses (persist events → update read model → expose
domain events).

### Checkpoints: git, not our own diff format

On turn start and turn completion we capture a git checkpoint of the workspace. Rollback is
a git operation. Reasons: it is correct, it is inspectable with tools users already trust,
and it works identically across every engine including ones with no checkpoint feature.

For non-git directories, fall back to a content-addressed snapshot of touched files only —
never a full-directory copy.

### Search: FTS5

An `items_fts` virtual table over message and tool-output text, kept in sync by trigger.
Gives us instant full-text search across every session ever, with snippets and ranking, for
almost no implementation cost.

**This is a genuine differentiator.** "What was that command I ran three weeks ago in the
other project?" is a real, frequent, currently unanswerable question. Nobody in the category
does it well.

### Driver: `better-sqlite3`

Synchronous, fastest in-process option, well-supported on Windows. It is a native module, so
CI must produce prebuilds for `windows-latest` and `macos-latest` (both arm64 and x64) and
`electron-rebuild` must run against our exact Electron ABI. Budget real time for this; native
modules are where Electron builds usually break first.

### Where things live on disk

| | Windows | macOS |
| --- | --- | --- |
| Database + logs | `%APPDATA%\PersonalHarness\` | `~/Library/Application Support/PersonalHarness/` |
| User config (editable, versionable) | `%USERPROFILE%\.personalharness\` | `~/.personalharness/` |
| Credentials | Windows Credential Manager | Keychain |
| Worktrees | user-chosen, default sibling of the repo | same |

Config is human-readable and hand-editable on purpose — this audience expects to be able to
diff and version their setup. It is never where secrets go.

## Rejected alternatives

- **JSONL files** (what Claude Code itself does at `~/.claude/projects/`). Simple, greppable,
  and we *will read* those files to import existing sessions. Rejected as our own store: no
  indexing, no transactions, no search, poor at 500-message threads.
- **libsql / Turso.** Adds a sync story we do not need yet. Revisit for multi-device.
- **Postgres / anything requiring a server.** Absurd install friction for a desktop app.
- **SQLite in the renderer via WASM.** Puts the source of truth in the least trusted, most
  disposable process. No.
- **Encrypting the whole database (SQLCipher).** Defensible, but the DB holds no credentials
  by policy, and encryption complicates backup, debugging and support. Revisit if users ask
  for it — the prompts and code in there are sensitive even if the secrets are not.

## Consequences

- Anything that mutates state does so by appending an event. No direct writes to read-model
  tables. This must be enforced in review; it is the rule most likely to erode.
- Projection code needs a rebuild path and a test that asserts log-replay produces an
  identical read model.
- Retention needs a policy before v1: unbounded event logs on a long-lived install will grow
  without limit. Ship with configurable pruning (default: keep everything, warn past a size
  threshold) — deleting a user's history silently is unacceptable.
