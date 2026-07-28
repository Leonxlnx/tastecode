# Architecture

Decisions and why, including what we rejected — that part matters, or we re-argue the same
thing in three months. Detail gets added as we build. To change a decision: edit here and
add a change-log row.

---

## Shape

**A local server owns all state and orchestration. Every client is a thin renderer over a
typed WebSocket protocol.**

```
desktop renderer · web · mobile          thin clients
        │  WebSocket, typed contracts
        │  req/res { id, method, params } · push { channel, sequence, data }
   core server (Node, local, long-lived)
        │  orchestration · adapters · SQLite event log · checkpoints · worktrees · PTY
   codex app-server · ACP agents · CLI adapters · direct API
```

Why not just do it in Electron's main process:

- **Agents survive the UI.** Close the window, the turn keeps running.
- **Mobile becomes a client, not a rewrite.**
- The web client is nearly free.
- The server is headless, so orchestration is testable without booting Electron.

T3 Code and OpenCode independently landed on the same shape.

**Protocol rules:** every payload schema-validated at the boundary, both directions. Push
envelopes carry a monotonic `sequence` per connection so clients detect gaps and resync.
Client transport is an explicit state machine (`connecting → open → reconnecting → closed`)
that queues outbound requests while disconnected.

_Rejected:_ everything in Electron main (forecloses mobile/web). tRPC on the wire (ties us
to a TypeScript client).

---

## Desktop shell: Electron, not Tauri

Tauri wins on size — ~10MB vs ~150MB, and much lower idle memory. We choose Electron anyway.

**The reason is rendering.** Tauri uses the OS webview: Chromium on Windows, WebKit on
macOS, WebKitGTK on Linux. CSS and font rendering diverge. For most apps that's an
annoyance; for an app whose entire pitch is visual craft it's fatal. Two developers cannot
hold pixel and motion parity across three engines — the Windows dev would ship something
beautiful that the macOS dev sees rendered subtly wrong, every time. The 150MB is what buys
never having that conversation.

Supporting reasons: the whole product is process orchestration and every vendor SDK here is
JS/TS first · `node-pty` (ConPTY) is the only real PTY option and its Electron friction is
solved and documented · `electron-builder` gives us NSIS, differential updates and a working
Azure Trusted Signing path · T3 Code is Electron, and Conductor is native macOS which is
exactly why it will never run on Windows.

**What we accept:** ~150MB installs, and a weaker security default than Tauri. The second
one is non-negotiable to fix, in the scaffold from day one — `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`, strict CSP, a narrow typed `contextBridge`,
deny-by-default external navigation. The renderer never spawns a process, touches the
filesystem, or reads a credential.

_Rejected:_ Tauri v2 (above) · native per-platform (two codebases for two developers means
Windows is permanently the worse one) · web-only as primary (no PTY, no filesystem, no
credential store — but we'll ship it as a secondary surface since it's nearly free) ·
Wails/Neutralino (same webview divergence, smaller ecosystem).

---

## Stack

|                    |                                             |                                                                                                                                     |
| ------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Language / runtime | TypeScript strict, Node 24 LTS              | Not Bun — native modules and Windows maturity still lag                                                                             |
| Monorepo           | pnpm workspaces + Turborepo + Vite          | pnpm's store makes worktree-heavy work cheap                                                                                        |
| UI                 | React 19                                    | The two load-bearing libraries below are React                                                                                      |
| Chat list          | TanStack Virtual, `anchorTo: 'end'`         | Purpose-built for streaming AI chat                                                                                                 |
| Markdown           | Streamdown + Shiki in a worker              | Handles unterminated markdown mid-stream                                                                                            |
| Styling            | Tailwind v4 + our own token layer           | Tokens generated from the design system                                                                                             |
| Components         | Radix / Base UI primitives, our own visuals | **No component kit adopted wholesale** — shadcn-default styling is the most recognizable AI-app look and would undercut the premise |
| Motion             | Motion                                      | Spring physics, used sparingly                                                                                                      |
| State              | Zustand + event-derived store               | Selector discipline matters more than the library                                                                                   |
| DB                 | SQLite (`better-sqlite3`), WAL, FTS5        | Native module — needs prebuilds on both OSes in CI                                                                                  |
| PTY                | `node-pty` (ConPTY)                         | Windows 10 1809+ required                                                                                                           |
| Tests              | Vitest; Playwright for Electron             | Adapter contract tests run the real binaries                                                                                        |

**On Effect-TS:** T3 Code uses it throughout and it genuinely fits this problem. We don't
adopt it for v1 — the learning curve colors every signature and with two developers the
fluency cost outweighs the benefit before we've shipped. We take the patterns (explicit
layers, typed errors, drainable workers) in plain TypeScript. Revisit if orchestrator
concurrency bugs become a recurring pain.

---

## Agent adapters

**One internal model: Thread → Turn → Item.** Borrowed from Codex because it's the best
designed and maps straight onto the UI. Items are `message`, `reasoning`, `command`,
`file_change`, `tool_call`, `plan`, `error`, each with a `started → deltas → completed`
lifecycle. Adapters translate _into_ this. Nothing engine-specific leaks past them.

| Tier       | Mechanism                        | Engines                                             | Fidelity                                 |
| ---------- | -------------------------------- | --------------------------------------------------- | ---------------------------------------- |
| 1 — Native | Vendor's own protocol            | Codex (`app-server` JSON-RPC), OpenCode (JS/TS SDK) | Full — approvals, fork, steer, fs events |
| 2 — ACP    | Agent Client Protocol over stdio | Gemini CLI + ~25 others                             | Good. One adapter, long tail for free    |
| 3 — CLI    | Headless NDJSON                  | Claude Code, Cursor, Grok                           | Adequate. Version-pinned, fragile        |

Engines can appear in more than one tier. We default to the highest fidelity available, with
a user override — so if Claude Code's ACP surface proves more stable than its CLI surface,
we switch tiers without touching the UI. That's the point of the layer.

**`capabilities()` is what makes it honest.** Not every engine can fork, steer, or emit
reasoning. The UI reads capabilities and hides what's unavailable rather than showing a
button that fails.

**Tier 3 will break** — it's coupled to someone else's output shape. Each Tier 3 adapter
needs a declared version range, a CI contract test that runs the real binary, graceful
degradation to an `unknown` item (never a crash, never silent loss), and a visible
"untested version" banner.

Checkpoints, worktrees, cost accounting and search live **above** the adapters, implemented
once. Git checkpoints work identically regardless of which engine made the change.

_Rejected:_ ACP-only (gives up Codex's richest-in-class surface) · native-only (caps us at
4 engines) · our own agent loop for everything (competing with Anthropic's and OpenAI's
harness teams while also building a UI) · a `switch` on provider in the orchestrator.

---

## Storage

**SQLite in the server. Append-only event log is the source of truth; UI state is a derived
read model. FTS5 for search.**

- Crash mid-turn → replay the log, lose nothing.
- Undo and checkpoints fall out naturally.
- Read-model migrations are cheap because they can always be rebuilt.
- **Rule: state changes by appending an event.** No direct writes to read-model tables. This
  is the rule most likely to erode; enforce it in review.

**Checkpoints are git**, captured on turn start and completion. Correct, inspectable with
tools users already trust, identical across every engine. Non-git directories fall back to a
content-addressed snapshot of touched files only.

**Search is FTS5** over message and tool-output text. Instant search across every session
ever, for almost no implementation cost — and "what was that command three weeks ago in the
other project?" is a real question nobody in this category answers well.

|             | Windows                           | macOS                                            |
| ----------- | --------------------------------- | ------------------------------------------------ |
| DB + logs   | `%APPDATA%\PersonalHarness\`      | `~/Library/Application Support/PersonalHarness/` |
| User config | `%USERPROFILE%\.personalharness\` | `~/.personalharness/`                            |
| Credentials | Credential Manager                | Keychain                                         |

Config is human-readable and hand-editable on purpose. It is never where secrets go.

Needs deciding before v1: a retention policy. Unbounded event logs grow forever, and
silently deleting a user's history is unacceptable.

_Rejected:_ JSONL files (we'll _read_ Claude Code's, but no indexing/transactions/search) ·
libsql/Turso (sync story we don't need yet) · SQLite in the renderer (source of truth in the
most disposable process) · whole-DB encryption (the DB holds no credentials by policy).

---

## Long threads must feel instant

Threads exceed 200 messages of streamed markdown, code, diffs and tool output. This is the
hardest problem in the client and it decides whether the app feels premium or cheap.

Agent chat is harder than normal chat because **rows resize hundreds of times per turn while
streaming** — naive virtualization re-measures on every delta and the viewport walks upward.
That's the classic AI-chat scroll bug. Plus: rows are huge and heterogeneous, highlighting is
expensive, markdown arrives incomplete, and history is prepended.

The rules that solve it:

1. **End-anchored virtualization.** TanStack Virtual with `anchorTo: 'end'`, stable item
   keys (never index), cached size estimates. Follow-on-append **switches off the moment the
   user scrolls away**, with a "jump to latest" affordance.
2. **A completed message is immutable and renders exactly once.** Streaming deltas append to
   a separate live-tail component — the only thing re-rendering during a turn. No context, no
   store subscription, no inline lambdas inside the message subtree.
3. **Two-phase code blocks.** Cheap CSS treatment instantly, Shiki from a worker swapped in
   after, identical layout box so nothing reflows. Only the languages we load; cache by
   content hash.
4. **Batch deltas on rAF** (~16ms). Imperceptible, an order of magnitude fewer renders.
5. **Collapse huge blocks by default** — better UX and better performance.
6. **Never mount full history on open.** Last N turns, fetch older on demand.

### Budgets — CI gates, not aspirations

|                                         |                          |
| --------------------------------------- | ------------------------ |
| Open a 500-message thread → first paint | < 150 ms                 |
| Scroll a 500-message thread             | 60 fps, no frame > 32 ms |
| Main-thread work per delta batch        | < 4 ms                   |
| Cold start → interactive                | < 1.5 s                  |
| Switch sessions                         | < 100 ms                 |
| Idle memory, 5 sessions                 | < 500 MB                 |

Build a 1,000-message fixture thread early, keep it in the repo, run every UI PR against it.
**A PR that regresses a budget doesn't merge.**

---

## Layout

```
apps/      desktop (Electron shell) · web (the UI) · server (core) · marketing
packages/  contracts · domain · adapters-* · ui · design-agent · shared
tools/     scripts (Node, never .sh)
```

`packages/contracts` is the most carefully reviewed package in the repo — a change there is
a breaking change for three clients. Adding an engine is a new `adapters-*` package plus a
registry entry, which is deliberately a good first outside contribution.

---

## Change log

| Date       | Change             |
| ---------- | ------------------ |
| 2026-07-28 | Initial decisions. |
