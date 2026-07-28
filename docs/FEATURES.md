# Features

What we are building for v1, the principles that decide the hundred small calls, and the bar
a release has to clear.

- [1. Shape of the app](#1-shape-of-the-app)
- [2. v1 scope](#2-v1-scope)
- [3. Out of scope for v1](#3-out-of-scope-for-v1)
- [4. UX principles](#4-ux-principles)
- [5. Quality bar](#5-quality-bar)
- [6. Ideas parked for later](#6-ideas-parked-for-later)

---

## 1. Shape of the app

Three columns, resizable, all collapsible. Deliberately close to what T3 Code and Conductor
converged on, because it is correct and users already understand it. We compete on what
happens *inside* the columns.

```
┌──────────┬────────────────┬───────────────────────────────────────┐
│ Projects │ Sessions       │ Thread                                │
│          │                │                                       │
│ repo A ● │ ▸ add auth   ⣿ │  ┌─ turn ────────────────────────────┐ │
│ repo B   │ ▸ fix build  ✓ │  │ user: …                           │ │
│ repo C   │ ▸ redesign   ◐ │  │ ▸ thinking (collapsed)            │ │
│          │                │  │ ▸ ran: pnpm test         12 lines │ │
│ + add    │ + new session  │  │ ▸ edited 3 files    +42 −8  ▸review│ │
│          │                │  │ assistant: …                      │ │
│          │                │  └───────────────────────────────────┘ │
│          │                │  ┌─ composer ────────────────────────┐ │
│          │                │  │ ▸ Claude Sonnet · plan mode · ⌘↵  │ │
└──────────┴────────────────┴───────────────────────────────────────┘
```

Plus a **right drawer** that slides over the thread for diff review, terminal, files, plan,
and cost. Never a modal for anything the user needs to read while typing.

---

## 2. v1 scope

### Projects and sessions
- Add a project by folder or by cloning a repo. Auto-detects git, package manager, and which
  agent CLIs are available.
- Many sessions per project, many projects open, all running concurrently.
- Sessions persist across app restarts and reattach to running agents.
- **One-click worktree isolation** per session, branch named after the task. Cleanup on
  archive, with an explicit warning if the worktree has uncommitted work.
- Import existing terminal sessions from `~/.claude/projects/*.jsonl`.

### The thread
- Streaming output with **first-class item types**: message, reasoning, plan, command +
  output, file change, tool call, error. Each renders as itself, not as a wall of text.
- Reasoning and long tool output collapse by default with a one-line summary; expand in place.
- Turn-level navigation: jump to previous/next turn, fold a whole turn, and a turn-index rail
  for long threads.
- **Steer mid-turn** where the engine supports it — type while it works.
- Interrupt is always one keystroke and always works.
- Edit-and-resend a previous message, forking the thread.
- Search within a thread, and across all sessions.

### Review
- Inline diff review per file, per hunk, accept/reject.
- Checkpoint on every turn; restore to any checkpoint.
- A "what changed this session" summary, separate from the message-by-message trail.
- Syntax-highlighted, word-level diffs. **This screen must be genuinely nicer than `git diff`
  in a terminal or we have failed at the one thing we claim.**

### Approvals and safety
- Approval requests render as a distinct, unmissable card: the exact command, the working
  directory, and allow-once / allow-for-session / always-allow-this-pattern / deny.
- A visible mode indicator — read-only, ask, or autonomous. Never ambiguous which is on.
- Global panic stop: halt every running agent everywhere.

### Providers
- Setup wizard detects installed CLIs and their auth state, and guides installation of what
  is missing. This is a real UI surface, not an error message — see
  [PROVIDERS.md §1](./PROVIDERS.md#1-the-rule) for why it is load-bearing.
- Provider cards: Claude, Codex, Cursor, OpenCode, Kimi Code, GLM Coding Plan, Grok,
  OpenRouter, custom OpenAI-compatible, local.
- Per-session model and provider selection, changeable mid-session where the engine allows.
- Cost and token accounting per turn, session, and provider.

### Extensions
- MCP server management: add, enable/disable, per-project scoping, tool inspection.
- **Agent Skills** (`SKILL.md`): browse, enable per project, install from a folder.
- Custom instruction files (`CLAUDE.md` / `AGENTS.md`), editable from the app.
- Slash commands.

### Terminal
A real PTY pane per session (ConPTY on Windows), in the working directory or worktree. The
escape hatch. Its existence is what lets us say no to a hundred small feature requests.

### The design agent
Ships in v1 as a distinct mode. Full spec in [DESIGN-AGENT.md](./DESIGN-AGENT.md).

### Personalization
- Light and dark, plus density (comfortable / compact) and a font choice with real options,
  not just "system."
- Fully remappable keybindings, with Vim-style and VS Code-style presets.
- Layout persistence per project.

---

## 3. Out of scope for v1

Kanban / task board · mobile app · cloud execution · team features · multi-agent
orchestration (agents dispatching agents) · a built-in code editor · voice input.

Each is defensible later. None is what makes v1 good.

---

## 4. UX principles

The premise is that the client is better than the alternatives. That is not achieved by a
feature list; it is achieved by a hundred decisions that each look small. These are the
rules we hold ourselves to when making them.

**1. Speed is the first feature.** Nothing else registers if the app is slow. Perceived
speed beats measured speed: optimistic UI, skeletons matching final layout exactly, never a
spinner where content could appear progressively. Over 200ms, show what is happening, not
that something is happening. Budgets are in
[ARCHITECTURE.md §6](./ARCHITECTURE.md#6-making-long-threads-instant) and enforced in CI.

**2. Never move something the user is reading.** The cardinal sin of chat UIs. Streaming
must not push content, history loading must not jump scroll, and the view must never yank
back to the bottom because new tokens arrived. Non-negotiable.

**3. The agent's state is always legible.** At any moment: which agent, which model, which
mode, which directory or worktree, whether it is running, roughly what it costs. Ambiguity
about what an autonomous process may do is the fastest way to lose trust, and once lost it
does not come back.

**4. Everything is reversible, and reversal is obvious.** Checkpoint before every turn.
Restore is one click. Destructive actions name exactly what will be lost. **No confirmation
dialog that users learn to dismiss without reading** — if it can be undone, do it and offer
undo; if it truly cannot, make the consequence concrete rather than adding a checkbox.

**5. Progressive disclosure, aggressively.** Agent threads contain enormous volumes of
low-value output. Default to collapsed summaries: `▸ ran 4 commands`, `▸ edited 3 files
+42 −8`, `▸ thought for 12s`. The default view should read like a summary of what happened;
detail is there when you go looking.

**6. Density is a user preference, not our opinion.** Ship comfortable and compact, honor
both properly, remember the choice per project.

**7. Motion is physical, short, and load-bearing.** Motion explains what happened — where a
panel came from, what became what. Spring-based, 150–250ms. Nothing decorative, nothing that
delays input. `prefers-reduced-motion` disables all of it and the app stays perfectly
legible without a single animation.

**8. Keyboard first, mouse fully supported.** Every action has a shortcut; a command palette
(`Ctrl/Cmd+K`) reaches everything; focus rings are visible and correct. But this is a
graphical app for people who chose a graphical app — nothing may be keyboard-only, and no
shortcut is required to discover a feature.

**9. Windows is not a port.** Native window chrome and snap behavior. Correct DPI on
mixed-DPI multi-monitor setups. Windows-native font fallbacks. Correct path display
(`D:\repo`, not `/d/repo`). An installer, updater and file associations that behave like a
Windows app. Two rules follow: the Windows build is *never* the one that lags, and every
marketing screenshot is taken on Windows.

**10. Beautiful, but not fashionable.** Nothing should look like a component library's
default theme. Deliberate type scale with real weight contrast; a palette with a defined
light source; no gradient without a reason; shadows that agree about where the light is;
whitespace as hierarchy rather than uniform padding. The design agent enforces this for
*user* output — we hold ourselves to the same ban list. It would be absurd to ship a
taste-driven design agent inside a generic-looking app.

**11. Errors are honest and actionable.** Agent failure, missing CLI, expired token, rate
limit: say what happened in plain language and offer the next step. Never a raw stack trace,
never a toast that vanishes before it can be read, never "something went wrong." When we do
not know why something failed, say that too and provide the log. This audience can debug —
they need to be told the truth.

**12. First run is a product surface.** The setup wizard is the first thing every user sees
and the moment most of them decide. Target: clean Windows machine to first agent response in
under five minutes.

**13. Quiet by default.** No badges, no notification dots, no "New!" ribbons, no upsell, no
telemetry consent modal on launch. A workspace for concentration — calm when idle,
purposeful when working.

---

## 5. Quality bar

A release does not ship unless:

1. Every performance budget in
   [ARCHITECTURE.md §6](./ARCHITECTURE.md#6-making-long-threads-instant) is met against the
   1,000-message fixture thread.
2. It has been used for real work on Windows and macOS by both developers for a week.
3. Cold install on a clean Windows VM: download → first agent response in under five
   minutes, including installing whatever CLI is missing.
4. No unsigned binaries. No SmartScreen warning.
5. Interrupt works, every time, on every engine. **An agent you cannot stop is not a tool.**

---

## 6. Ideas parked for later

Kept so they are not lost. Explicitly not v1.

- **Thread outline / table of contents** auto-generated from turns. Nobody does this and
  long threads desperately need it.
- **Diff-first review mode** — read the change, not the conversation, with the conversation
  available as annotation.
- **Session templates** — start preloaded with these skills, this model, this instruction file.
- **Compare two agents on the same task** side by side in two worktrees, then keep one.
  Cheap for us, genuinely novel, and a great demo.
- **Cost guardrails** — warn or require confirmation before a turn that exceeds a threshold.
- **A quiet, gorgeous "agent is working" state.** Most tools show a spinner. This is the
  screen users stare at most; it should be the best-looking thing in the app.
