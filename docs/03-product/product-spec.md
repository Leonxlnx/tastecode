# Product specification — v1

Scope for the first public Windows release. Anything not listed here is v2 or later.

---

## Shape of the app

Three columns, resizable, all collapsible. Deliberately close to the layout T3 Code and
Conductor converged on, because it is correct and users already understand it. We compete on
what happens *inside* the columns.

```
┌──────────┬────────────────┬───────────────────────────────────────┐
│ Projects │ Sessions       │ Thread                                │
│          │                │                                       │
│ repo A ● │ ▸ add auth   ⣿ │  ┌─ turn ────────────────────────────┐ │
│ repo B   │ ▸ fix build  ✓ │  │ user: …                           │ │
│ repo C   │ ▸ redesign   ◐ │  │ ▸ thinking (collapsed)            │ │
│          │                │  │ ▸ ran: pnpm test         12 lines │ │
│ + add    │ + new session  │  │ ▸ edited 3 files      +42 −8  ▸review│
│          │                │  │ assistant: …                      │ │
│          │                │  └───────────────────────────────────┘ │
│          │                │  ┌─ composer ────────────────────────┐ │
│          │                │  │ ▸ Claude Sonnet · plan mode · ⌘↵  │ │
└──────────┴────────────────┴───────────────────────────────────────┘
```

Plus a **right drawer** that slides over the thread for: diff review, terminal, files,
plan, and cost. Never a modal for anything the user needs to read while typing.

---

## v1 feature set

### Projects and sessions
- Add a project by folder or by cloning a repo. Auto-detects git, package manager, and which
  agent CLIs are available.
- Many sessions per project, many projects open, all running concurrently.
- Sessions persist across app restarts and reattach to running agents.
- **One-click worktree isolation** per session, with the branch named after the task.
  Cleanup on session archive, with an explicit warning if the worktree has uncommitted work.
- Import existing terminal sessions from `~/.claude/projects/*.jsonl` — "you already have 40
  sessions, here they are" is a great first-run moment.

### The thread
- Streaming output with **first-class item types**: message, reasoning, plan, command +
  output, file change, tool call, error. Each renders as itself, not as a wall of text.
- Reasoning and long tool output collapse by default with a one-line summary; expand in place.
- Turn-level navigation: jump to previous/next turn, fold a whole turn, and a minimap or
  turn-index rail for long threads.
- **Steer mid-turn** where the engine supports it (Codex `turn/steer`) — type while it works.
- Interrupt is always one keystroke and always works.
- Edit-and-resend a previous message, forking the thread (Codex `thread/fork`).
- Full-text search within a thread, and across all sessions (FTS5).

### Review
- Inline diff review per file, per hunk, accept/reject.
- Checkpoint on every turn; restore to any checkpoint.
- A "what changed this session" summary view separate from the message-by-message trail.
- Syntax-highlighted, word-level diffs. This screen must be genuinely nicer than `git diff`
  in a terminal or we have failed at the one thing we claim.

### Approvals and safety
- Approval requests render as a distinct, unmissable card: the exact command, the working
  directory, and allow-once / allow-for-session / always-allow-this-pattern / deny.
- A visible mode indicator: read-only, ask, or autonomous. Never ambiguous which one is on.
- Global panic stop: halt every running agent everywhere.

### Providers
- Setup wizard detects installed CLIs and their auth state; guides installation of what is
  missing (this is a real UI surface, not an error message — see ADR-0005).
- Provider cards: Claude, Codex, Cursor, OpenCode, Kimi Code, GLM Coding Plan, Grok,
  OpenRouter, custom OpenAI-compatible, local.
- Per-session model/provider selection, changeable mid-session where the engine allows.
- Cost and token accounting per turn, session, and provider.

### Extensions
- MCP server management: add, enable/disable, per-project scoping, inspect available tools.
- **Agent Skills** (`SKILL.md`): browse installed skills, enable per project, and install
  from a folder. Built on the open standard so skills work inside and outside the harness.
- Custom instruction files (`CLAUDE.md` / `AGENTS.md`) — edit from the app, honored by the
  engines that read them.
- Slash commands.

### Terminal
- A real PTY pane per session (ConPTY on Windows), in the working directory or the worktree.
  The escape hatch. Its existence is what lets us say no to a hundred small feature requests.

### The design agent
Ships in v1 as a distinct mode. Full spec:
[`design-agent-spec.md`](./design-agent-spec.md).

### Personalization
- Light and dark, plus density (comfortable / compact) and a font choice that includes real
  options, not just "system."
- Fully remappable keybindings, with Vim-style and VS Code-style presets.
- Layout persistence per project.

---

## Explicitly out of scope for v1

Kanban/task board · mobile app · cloud execution · team features · multi-agent orchestration
(agents dispatching agents) · a built-in code editor · voice input.

Each is defensible later. None is what makes v1 good.

---

## Quality bar (the actual acceptance criteria)

A release does not ship unless:

1. Every performance budget in [`ui-performance.md`](../01-research/ui-performance.md) is met
   against the 1,000-message fixture thread.
2. It has been used for real work on Windows and macOS by both developers for a week.
3. Cold install on a clean Windows VM: download → first agent response in under five minutes,
   including installing whatever CLI is missing.
4. No unsigned binaries. No SmartScreen warning.
5. Interrupt works, every time, on every engine. An agent you cannot stop is not a tool.

---

## Ideas worth stealing or inventing later

Kept here so they are not lost, explicitly not v1:

- **Thread outline / table of contents** auto-generated from turns — nobody does this and
  long threads desperately need it.
- **Diff-first review mode**: read the change, not the conversation, with the conversation
  available as annotation.
- **Session templates**: "start a session preloaded with these skills, this model, this
  instruction file."
- **Compare two agents on the same task** side by side in two worktrees, then keep one.
  Cheap for us, genuinely novel, and a great demo.
- **Cost guardrails**: warn or require confirmation before a turn that exceeds a threshold.
- **A quiet, gorgeous "agent is working" state.** Most tools show a spinner. This is the
  screen users stare at most; it should be the best-looking thing in the app.
