# Architecture

How the app is built, and why. Every decision here includes what we rejected — that part is
the valuable part, because without it we re-litigate the same question in three months.

**To change a decision:** edit this file, and note the change and the date at the bottom.
Do not quietly diverge in code.

- [1. Shape of the system](#1-shape-of-the-system)
- [2. Desktop shell: Electron, not Tauri](#2-desktop-shell-electron-not-tauri)
- [3. Stack](#3-stack)
- [4. Agent adapters](#4-agent-adapters)
- [5. Storage, checkpoints, and search](#5-storage-checkpoints-and-search)
- [6. Making long threads instant](#6-making-long-threads-instant)
- [7. Package layout](#7-package-layout)

---

## 1. Shape of the system

**A local server process owns all state and all agent orchestration. Every client is a thin
renderer connected over a typed WebSocket protocol.**

```
┌───────────────────────────────────────────────┐
│  Clients (presentation only)                  │
│  desktop renderer · web · mobile (later)      │
└────────────────────┬──────────────────────────┘
                     │  WebSocket, typed contracts
                     │  req/res { id, method, params }
                     │  push   { channel, sequence, data }
┌────────────────────▼──────────────────────────┐
│  Core server (Node.js, local, long-lived)     │
│   SessionOrchestrator · AdapterRegistry       │
│   EventLog (SQLite) · ReadModel · Checkpoints │
│   CredentialVault · WorktreeManager · PTY     │
└────────────────────┬──────────────────────────┘
     ┌───────────────┼───────────────┬───────────────┐
     ▼               ▼               ▼               ▼
 codex             ACP            CLI             direct API
 app-server       agents         adapters         (BYOK)
```

### Why a server core instead of doing it in Electron's main process

1. **Agents survive the UI.** Close the window, the turn keeps running. Reopen and reattach.
   OpenCode advertises exactly this property and it is genuinely valuable.
2. **Mobile becomes a client, not a rewrite.** The remote plan is "expose the same
   WebSocket securely," not "build a second backend."
3. **The web client is nearly free.**
4. **Testability.** The server is headless and scriptable, so orchestration logic is
   testable without booting Electron.

T3 Code and OpenCode independently arrived at this same shape. Three teams converging is
evidence.

### The transport contract

Borrowed, with credit, from T3 Code because it is well-considered:

- **Request/response:** `{ id, method, params }` → `{ id, result }` | `{ id, error }`
- **Push:** `{ channel, sequence, data }`, `sequence` monotonic per connection so clients
  detect gaps and resync rather than silently diverging.
- **Every payload is schema-validated at the transport boundary**, both directions, with
  structured decode diagnostics (code, reason, path). This is what stops three client
  surfaces from drifting apart.
- Client transport is an explicit state machine: `connecting → open → reconnecting →
  closed → disposed`. Outbound requests queue while disconnected and flush on reconnect;
  inbound pushes cache per channel with opt-in `replayLatest` on subscribe.

**Rejected:** everything in the Electron main process (simpler at first, forecloses mobile,
web, and agent-survives-UI). tRPC over the wire (great DX, ties us to a TypeScript client —
mobile and any future non-TS client argue for a plain documented JSON protocol).

---

## 2. Desktop shell: Electron, not Tauri

Tauri is the fashionable answer and the numbers are dramatic: ~5–10MB bundles versus 150MB+,
~30–40MB idle memory versus hundreds. We are choosing Electron anyway.

### Why

**One rendering engine, or we pay for pixel divergence forever.** Tauri uses the OS webview:
WebView2 (Chromium) on Windows, WKWebView (WebKit) on macOS, WebKitGTK on Linux. CSS that
works on Windows breaks elsewhere; font rendering differs; prefix support lags. For most
apps that is an annoyance. For *this* app it is fatal to the premise — we are selling craft.
Two developers cannot maintain pixel-perfect and motion-perfect fidelity across three
engines. The Windows dev would ship a beautiful build the macOS dev sees rendered subtly
wrong, every single time. Electron's 150MB is precisely the price of never having that
conversation.

**The Node ecosystem is our integration layer.** The whole product is process orchestration:
spawning agent CLIs, JSON-RPC over stdio, PTY handling, git plumbing, SQLite. Every vendor
SDK here ships JS/TS first. From Rust we would write and maintain our own bindings for all
of it.

**PTY on Windows.** Terminal panes need `node-pty` (ConPTY, Windows 10 1809+). It is a
native module with known Electron packaging friction — all of which are *solved, documented*
problems in Electron. In Tauri we would rebuild the bridge over `portable-pty` ourselves.

**Shipping on Windows is mature.** `electron-builder` gives us NSIS installers, differential
auto-updates, staged rollouts, and a working Azure Trusted Signing path.

**The reference implementation agrees.** T3 Code is Electron with `electron-builder`
producing NSIS/DMG/AppImage. Conductor is native macOS, which is exactly why it will never
run on Windows.

### What we accept

- **~150MB installs, higher idle memory.** Mitigated by main-process discipline, one
  renderer per window not per view, lazy-loading heavy modules, and a memory budget in CI.
  Our users install Docker and Node; 150MB is not what stops them.
- **A weaker security default than Tauri.** Tauri gives the webview zero native access
  unless granted; Electron's hardening is opt-in. Non-negotiable, in the scaffold from day
  one: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP, a
  narrow typed `contextBridge` surface, deny-by-default `window.open` and external
  navigation.
- **The renderer stays thin.** All privileged work — process spawning, filesystem,
  credentials, database — lives behind the IPC contract. Good architecture regardless, and
  it is what makes web and mobile possible later.

### Rejected

- **Tauri v2** — webview divergence (above) plus ecosystem cost for a two-person team.
  Revisit only if bundle size becomes a real adoption blocker, and even then the answer is
  probably a smaller Electron build, not a rewrite.
- **Native per-platform (SwiftUI + WinUI)** — best possible feel; Conductor proves the
  ceiling. Two codebases for two developers means the Windows version is permanently the
  worse one. Directly contradicts Windows-first.
- **Web app only** — falls out of our architecture for free and we will ship it as a
  secondary surface. Not primary: no PTY, no filesystem, no local process spawning, no OS
  credential store.
- **Wails / Neutralino** — same webview divergence, smaller ecosystem.

---

## 3. Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript, strict | One language across server, all clients, build scripts. |
| Runtime | Node 24 LTS | Native TS type-stripping, mature Windows support. Not Bun: native-module and Windows maturity still lag, and we depend on `node-pty` and `better-sqlite3`. |
| Monorepo | pnpm workspaces | Content-addressed store makes worktree-heavy workflows cheap — directly relevant since we create a worktree per session. |
| Build/task | Turborepo + Vite 6 | Boring, fast, documented. T3 Code uses Vite+/`vp`; we avoid pre-1.0 tooling only one team uses. |
| UI | React 19 | TanStack Virtual and Streamdown are both load-bearing and both React. |
| Styling | Tailwind v4 + our own token layer | Tokens generated from the design system, not hand-written. |
| Components | Radix / Base UI primitives, our own visual layer | Accessibility and behavior from primitives, every pixel written by us. **No component kit adopted wholesale** — shadcn-default styling is the most recognizable AI-app look and would undercut the entire premise. |
| Motion | Motion (ex-Framer Motion) | Spring physics, used sparingly. |
| Chat list | TanStack Virtual, `anchorTo: 'end'` | [§6](#6-making-long-threads-instant) |
| Markdown | Streamdown + Shiki in a worker | Handles unterminated markdown mid-stream. |
| State | Zustand + normalized event-derived store | Selector discipline matters more than the library. |
| Validation | Zod (Valibot if bundle size bites) | Powers the transport contracts. |
| DB | SQLite via `better-sqlite3`, WAL, FTS5 | [§5](#5-storage-checkpoints-and-search) |
| PTY | `node-pty` (ConPTY) | Only real option. Windows 10 1809+ required. |
| Tests | Vitest; Playwright for Electron | Adapter contract tests run the real binaries. |
| Lint/format | oxlint + Prettier (or Biome) | Speed matters at monorepo scale. |

### On Effect-TS

T3 Code uses Effect throughout. It is genuinely good for this problem — layered dependency
injection, typed errors, structured concurrency, resource safety around child processes.

**We do not adopt Effect for v1.** The learning curve is real, it colors every signature,
and with two developers the cost of everyone being fluent outweighs the benefit before we
have a shipped product. We adopt the *patterns* it encourages — explicit layers, typed
errors, drainable workers, deterministic test synchronization via completion signals — in
plain TypeScript.

Revisit after v1 if concurrency bugs in the orchestrator become a recurring source of pain.
That would be the honest signal we needed it.

---

## 4. Agent adapters

### One internal domain model: Thread / Turn / Item

We adopt Codex's data model internally, because it is the best-designed available and it
maps directly onto the UI we want:

- **Thread** — a conversation, bound to a project and a workspace (possibly a worktree)
- **Turn** — one user input and everything the agent does in response
- **Item** — a unit inside a turn: `message`, `reasoning`, `command`, `file_change`,
  `tool_call`, `plan`, `error`. Items have lifecycle: `started` → deltas → `completed`.

Adapters translate *into* this model. The UI renders only this model. Nothing
engine-specific leaks past the adapter boundary.

### Three tiers

| Tier | Mechanism | Engines | Fidelity |
| --- | --- | --- | --- |
| **1 — Native** | Vendor's own client protocol | Codex (`codex app-server` JSON-RPC), OpenCode (JS/TS SDK) | Full. Approvals, fork, steer, fs events, MCP calls. |
| **2 — ACP** | Agent Client Protocol over stdio | Gemini CLI + 25 others in the registry | Good. One adapter, long-tail coverage at zero marginal cost. |
| **3 — CLI** | Headless NDJSON | Claude Code, Cursor, Grok Build | Adequate. Version-pinned and fragile by nature. |

An engine may be reachable through more than one tier — Claude Code and Codex both speak
ACP. **Preference is the highest fidelity available, with a user override.** If Claude
Code's ACP surface proves more stable in practice than its CLI surface, we switch that
engine's default tier without touching the UI. That flexibility is the entire point.

Protocol details per engine are in [PROVIDERS.md](./PROVIDERS.md).

### The adapter contract

```ts
interface AgentAdapter {
  readonly id: string
  detect(): Promise<DetectionResult>        // installed? version? authenticated?
  capabilities(): Capabilities              // what this engine can actually do
  startThread(opts): Promise<ThreadHandle>
  resumeThread(id): Promise<ThreadHandle>
  sendTurn(threadId, input): Promise<TurnHandle>
  interrupt(threadId): Promise<void>
  respondToApproval(requestId, decision): Promise<void>
  events: AsyncIterable<DomainEvent>        // normalized, never engine-native
  dispose(): Promise<void>
}
```

**`capabilities()` is what makes this honest.** Not every engine can fork a thread, steer
mid-turn, or emit reasoning items. The UI reads capabilities and hides what is unavailable
rather than showing a button that fails. This is the difference between a wrapper that feels
solid and one that feels like it is lying to you.

### Handling Tier 3 fragility

Tier 3 adapters are coupled to someone else's CLI output shape. That will break. Required
for each one:

1. A declared supported version range, checked at `detect()` time.
2. **A contract test that runs the real binary** in CI against a trivial prompt and asserts
   the event shape. The only way we learn about a breaking upgrade before our users do.
3. Graceful degradation — an unrecognized event becomes an `unknown` item rendered as raw
   text. Never a crash, never silent data loss.
4. A visible "your Claude Code version is newer than we've tested" banner rather than
   mysterious misbehavior.

Automate upstream tracking: a scheduled job that checks published versions and opens an
issue on change.

### Cross-cutting concerns live above the adapters

Checkpoints, worktree management, cost accounting, and search are implemented **once in the
server**, not per engine. Git checkpoints on turn boundaries work identically no matter
which engine made the change, and give us rollback even for engines with no checkpoint
feature of their own.

### Rejected

- **ACP only** — elegant, but gives up Codex's approvals, fork, steer and fs-watch surface,
  the richest integration any vendor offers, to save one adapter.
- **Native adapters only** — best fidelity, caps us at 3–4 engines and leaves the long tail
  unreachable.
- **Our own agent loop against raw APIs for everything** — we would compete with Anthropic's
  and OpenAI's harness teams on their own ground while also building a UI. Stays in the
  architecture for BYOK and local models, nothing more.
- **A `switch` on provider inside the orchestrator** — how this ends is well known.
  Adapters are packages.

---

## 5. Storage, checkpoints, and search

**SQLite, WAL mode, in the server process. An append-only event log is the source of truth;
UI state is a derived read model. FTS5 provides search.**

```
events(id INTEGER PK, thread_id, seq, type, payload JSON, created_at)
```

Every domain event is appended, never mutated. Read-model tables (`threads`, `turns`,
`items`, `file_changes`, `usage`) are projections rebuilt from the log.

Why:
- **Crash safety.** The app dies mid-turn; on restart we replay and lose nothing.
- **Undo and checkpoints** are natural rather than bolted on.
- **Adapters already emit events** — the log is the same stream, persisted.
- **Read-model migration is cheap** because it can always be rebuilt.

Cost: more write volume and a projection layer to maintain. Worth it. Same pattern as T3
Code's `OrchestrationEngine`.

### Checkpoints: git, not our own diff format

On turn start and turn completion we capture a git checkpoint of the workspace. Rollback is
a git operation — correct, inspectable with tools users already trust, and identical across
every engine. For non-git directories, fall back to a content-addressed snapshot of touched
files only, never a full-directory copy.

### Search: FTS5

An `items_fts` virtual table over message and tool-output text, kept in sync by trigger.
Instant full-text search across every session ever, with snippets and ranking, for almost no
implementation cost.

**This is a genuine differentiator.** "What was that command I ran three weeks ago in the
other project?" is a real, frequent, currently unanswerable question.

### Driver

`better-sqlite3` — synchronous, fastest in-process, well-supported on Windows. It is a
native module, so CI must produce prebuilds for `windows-latest` and `macos-latest` (arm64
and x64) and `electron-rebuild` must run against our exact Electron ABI. Budget real time;
native modules are where Electron builds break first.

### Where things live on disk

| | Windows | macOS |
| --- | --- | --- |
| Database + logs | `%APPDATA%\PersonalHarness\` | `~/Library/Application Support/PersonalHarness/` |
| User config (editable, versionable) | `%USERPROFILE%\.personalharness\` | `~/.personalharness/` |
| Credentials | Windows Credential Manager | Keychain |
| Worktrees | user-chosen, default sibling of the repo | same |

Config is human-readable and hand-editable on purpose — this audience expects to diff and
version their setup. It is never where secrets go.

### Rejected

- **JSONL files** (what Claude Code does at `~/.claude/projects/`). Simple and greppable,
  and we *will read* those files to import existing sessions. Not our own store: no
  indexing, no transactions, no search, poor at 500-message threads.
- **libsql / Turso** — adds a sync story we do not need yet. Revisit for multi-device.
- **Postgres** — absurd install friction for a desktop app.
- **SQLite in the renderer via WASM** — puts the source of truth in the least trusted, most
  disposable process.
- **Encrypting the whole database (SQLCipher)** — defensible, but the DB holds no
  credentials by policy, and encryption complicates backup, debugging and support. Revisit
  if users ask; the prompts and code in there are sensitive even if the secrets are not.

### Rules that follow

- Anything that mutates state appends an event. No direct writes to read-model tables. This
  must be enforced in review; it is the rule most likely to erode.
- Projection code needs a rebuild path and a test asserting log-replay produces an identical
  read model.
- Retention policy before v1: unbounded event logs on a long-lived install grow without
  limit. Ship configurable pruning (default: keep everything, warn past a size threshold).
  Silently deleting a user's history is unacceptable.

---

## 6. Making long threads instant

Threads regularly exceed 200 messages of streamed markdown, code, diffs, and tool output.
This is the hardest engineering problem in the client and it determines whether the app
feels premium or cheap.

### Why agent chat is harder than normal chat

1. **Rows resize constantly while streaming.** As tokens arrive the last message grows —
   hundreds of times per turn. Naive virtualization re-measures on every delta and the
   viewport walks upward. This is *the* classic AI-chat scroll bug.
2. **Rows are enormous and heterogeneous.** One "message" may be a 400-line diff, a file
   tree, a terminal transcript, or three sentences.
3. **Syntax highlighting is expensive.** Shiki uses a real TextMate grammar engine.
   Highlighting 50 blocks synchronously on thread open blocks the main thread for hundreds
   of milliseconds.
4. **Markdown arrives incomplete** — unterminated fences, half-written bold, dangling links.
5. **History is prepended.** Loading older messages must not move what the user is reading.

### Virtualization: TanStack Virtual, end-anchored

```ts
useVirtualizer({
  count: messages.length,
  estimateSize,
  getItemKey,                 // stable ID, never index
  anchorTo: 'end',            // end-anchored: prepend-stable history
  followOnAppend: true,       // stay pinned to newest
  scrollEndThreshold: 80,     // px slack for "is the user at the bottom"
  overscan: 6,
})
```

`anchorTo: 'end'` is the key: when the viewport was pinned before the last item grew, the
size delta is applied and the end stays pinned. That single option eliminates the streaming
scroll-walk, and makes prepending history stable for the same reason.

Rules:
- `followOnAppend` is **disabled the moment the user scrolls away from the bottom**, with a
  "jump to latest" affordance. Nothing is more hostile than a chat that yanks you back.
- `getItemKey` returns a stable message ID. Index keys break everything.
- `estimateSize` is cached per message ID so reopening a thread does not re-measure.

### Streaming markdown: Streamdown

Built for token streams. The feature we need is **unterminated block parsing** — it styles
incomplete bold, italic, code, links and headings correctly mid-stream instead of flickering
between raw and rendered. Streaming mode (animated caret) and static mode (completed
messages), Shiki-backed highlighting, tree-shakeable plugins for Mermaid, LaTeX, CJK.

### Syntax highlighting: two-phase, off the main thread

1. **Instant:** render the block with a cheap CSS-only treatment — correct monospace,
   background, padding, line numbers. Appears immediately, does not shift.
2. **Enhanced:** a Web Worker running Shiki returns highlighted HTML; swap it in. Identical
   layout box, so nothing reflows.

Plus: one `Highlighter` instance with **only the languages we load** (loading all grammars
is a multi-megabyte mistake); lazy-load grammars on first use; cache highlighted HTML by
content hash (agent threads repeat code constantly); never highlight a block that has never
been in the viewport.

### The message component contract

The single most important performance rule in the codebase:

> **A completed message is immutable and renders exactly once.**

- Messages are frozen; a completed message's props never change identity.
- `React.memo` with a comparator checking message ID and a `version` counter, nothing else.
- Streaming deltas append to a **separate live-tail component** — the only thing
  re-rendering during a turn. On completion the tail commits into the immutable list: one
  final re-render, then never again.
- No context, no store subscription, no inline lambdas inside the message subtree. A Zustand
  selector returning a new array on every store write will silently re-render every mounted
  row and undo all of the above.

### Other techniques

- `content-visibility: auto` with `contain-intrinsic-size` on message containers.
- **Collapse huge blocks by default** — a 2,000-line diff renders as a summary chip. Better
  UX *and* better performance.
- **Batch streaming deltas** on `requestAnimationFrame` (~16ms). The user cannot perceive
  the difference; it cuts render count by an order of magnitude.
- **Never mount full history at thread open.** Load the last N turns, fetch older on demand,
  rely on end-anchoring to make prepends invisible.

### Budgets — enforced in CI, not aspirations

| Metric | Budget |
| --- | --- |
| Open a 500-message thread → first paint | < 150 ms |
| Scroll a 500-message thread | 60 fps sustained, no frame > 32 ms |
| Streaming turn, main-thread work per delta batch | < 4 ms |
| App cold start → interactive | < 1.5 s |
| Switch between two open sessions | < 100 ms |
| Idle memory, 5 open sessions | < 500 MB |

Build a synthetic 1,000-message fixture thread early and keep it in the repo. Every UI PR
runs against it. **A PR that regresses a budget does not merge.**

---

## 7. Package layout

```
apps/
  desktop        Electron main + preload (thin)
  web            React client — the actual UI, shared by desktop and browser
  server         Core server: orchestration, adapters, storage
  marketing      Landing page
packages/
  contracts      Wire protocol + schemas. Single source of truth for all clients.
  domain         Thread / Turn / Item model, provider-agnostic
  adapters-*     One package per integration tier
  ui             Design system: tokens, primitives, motion
  design-agent   TasteSkill packaging and runtime
  shared         Utilities, logging, platform helpers
tools/
  scripts        Node-based repo scripts (never .sh — see WORKFLOW.md)
```

Consequences worth stating:

- The renderer never spawns a process, touches the filesystem, or reads a credential.
- `packages/contracts` is the most carefully reviewed package in the repo. Changes there are
  breaking changes for three clients.
- `packages/domain` is stable; churn concentrates in `adapters-*`. Adding a new engine is a
  new package plus a registry entry — a good first contribution once we open source, which
  is a deliberate design goal.
- The server must be independently runnable (`pnpm dev:server`) and scriptable, and needs a
  version-negotiation story with clients, since a desktop app and a phone may run different
  versions against the same server.

---

## Sources

- [Codex App Server](https://developers.openai.com/codex/app-server.md) · [Zed ACP](https://zed.dev/acp)
- [pingdotgg/t3code](https://github.com/pingdotgg/t3code) — architecture docs, inspected directly
- [Tauri vs Electron 2026: The Honest Comparison](https://www.buildmvpfast.com/blog/tauri-v2-vs-electron-desktop-apps-2026)
- [Code Signing for Windows | electron-builder](https://www.electron.build/docs/features/code-signing/code-signing-win/)
- [microsoft/node-pty](https://github.com/microsoft/node-pty)
- [Chat UIs Are Lists Until They Aren't](https://tanstack.com/blog/tanstack-virtual-chat) · [TanStack Virtual chat docs](https://tanstack.com/virtual/latest/docs/chat)
- [Streamdown](https://streamdown.ai/)

---

## Change log

| Date | Change |
| --- | --- |
| 2026-07-28 | Initial decisions recorded. |
