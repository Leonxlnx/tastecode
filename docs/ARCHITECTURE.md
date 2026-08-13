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

## Desktop client: Rust and GPUI

**The primary desktop client is a single Rust + GPUI application on macOS and Windows.** GPUI
draws the same retained element tree through Metal and DirectX, so both platforms share one
layout, text and motion implementation without shipping Chromium or accepting two operating
system webviews. Exact colors, geometry, typography and timings are Rust design tokens rather
than a second design system invented during the port.

The server/client boundary above remains load-bearing. The native client first speaks the
existing protocol v2 to the Node server; persistence, orchestration, PTY support and adapters
then move to Rust behind that stable boundary. The Electron/React app remains the visual and
behavioral oracle during migration and is removed only after native parity. This order keeps
every screen testable against working product behavior instead of coupling a renderer rewrite
to an adapter rewrite.

GPUI is pre-1.0, so the workspace pins an exact release and wraps framework-facing primitives
inside `harness-ui`. A GPUI update is an intentional compatibility change, not a floating
dependency update. macOS and Windows builds and screenshots are separate release gates;
source-level platform support is not evidence that font rasterization, title bars or input
behavior match on both systems.

_Superseded:_ Electron bought one Chromium renderer across platforms, but its install size,
idle footprint and per-frame JavaScript/DOM work conflict with the native performance goal.
_Rejected:_ Tauri/Wails/Neutralino retain divergent OS webviews · separate AppKit and WinUI
clients create two permanent UI implementations · a web-only primary cannot own the native
terminal, filesystem and credential-store surface.

### Embedded browser during the Electron reference phase

**Page previews use a renderer-owned Electron `<webview>` guest, never an iframe or an
operating-system webview.** Before attachment, the main process strips preload access, assigns a
dedicated persistent partition, disables Node integration, and requires sandboxing, context
isolation, and web security. The guest accepts only HTTP(S) navigation, denies permissions, keeps
attempted new windows in the same preview, and exposes an explicit validated system-browser
handoff.

The guest remains a normal DOM element, so it follows the animated workspace without a native
overlay or bounds IPC. A renderer `ResizeObserver` fits fluid, desktop, tablet, and mobile modes;
fixed modes retain their requested CSS viewport and scale the complete guest to fit instead of
stretching it. All modes therefore share Electron's Chromium path across macOS, Windows, and
Linux.

---

## Target stack

The TypeScript workspace remains beside this target during migration. It is reference code,
not a second implementation to maintain after native parity.

|                    |                                              |                                                                                                                        |
| ------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Language / runtime | Rust stable, pinned by the workspace         | One native runtime for the client, server and adapters                                                                 |
| Monorepo           | Cargo workspace                              | Crates keep protocol, UI, orchestration and adapters independently testable                                            |
| UI                 | GPUI 0.2.2, exact pin                        | One GPU-rendered element tree through Metal and DirectX                                                                |
| Chat list          | Custom end-anchored virtual GPUI element     | Variable-height streaming rows need stable keys, cached measurement and explicit anchor control                        |
| Markdown           | Incremental parser + native highlighter      | Incomplete streamed blocks stay cheap; completed blocks become immutable                                               |
| Styling            | Typed Harness tokens                         | The current CSS values are migrated exactly, including every theme and density state                                   |
| Components         | Harness-owned GPUI primitives                | Focus, menus, sheets and inputs preserve current behavior without importing another visual language                    |
| Motion             | GPUI frame animations                        | Existing easing and durations are the contract; reduced motion remains first-class                                     |
| State              | GPUI entities + event-derived read models    | Deltas update the live tail without invalidating the whole application tree                                            |
| DB                 | SQLite, WAL, FTS5                            | Append-only events and rebuildable read models remain unchanged                                                        |
| PTY                | Rust ConPTY / Unix PTY abstraction           | Process-tree termination and intentional-exit semantics remain cross-platform requirements                             |
| Terminal state     | `alacritty_terminal` 0.26.0                  | ANSI parsing mutates a bounded cell grid incrementally, while Harness retains ownership of PTY lifecycle and transport |
| Tests              | Rust unit, protocol fixture and render tests | Real provider captures and platform screenshots remain the final contract                                              |

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

| Tier       | Mechanism                        | Engines                                                        | Fidelity                              |
| ---------- | -------------------------------- | -------------------------------------------------------------- | ------------------------------------- |
| 1 — Native | Vendor's own protocol            | Codex (`app-server` JSON-RPC), OpenCode (HTTP), Pi (RPC JSONL) | Full where the protocol exposes it    |
| 2 — ACP    | Agent Client Protocol over stdio | Gemini CLI + ~25 others                                        | Good. One adapter, long tail for free |
| 3 — CLI    | Headless NDJSON                  | Claude Code, Cursor, Grok                                      | Adequate. Version-pinned, fragile     |

Engines can appear in more than one tier. We default to the highest fidelity available, with
a user override — so if Claude Code's ACP surface proves more stable than its CLI surface,
we switch tiers without touching the UI. That's the point of the layer.

**Users may register protocol-compatible executables as separate harness sources.** Each
entry names an existing adapter protocol and stores an executable, fixed argv, optional launch
directory, and non-secret environment overrides in
`~/.personalharness/custom-harnesses.json`; arguments never pass through a shell, and secrets
never belong in this file. Custom commands resolve against a desktop-safe PATH that includes
conventional user locations such as `~/.local/bin`. When a mod boots from its own directory,
`HARNESS_WORKSPACE_PATH` retains the active project for its wrapper and native protocols still
receive that project normally. The source gets its own model catalog and persisted identity, so
a fork can coexist with the stock CLI without replacing it.

Settings can run a bounded compatibility check before the first prompt. Codex, Pi, OpenCode,
and ACP complete their actual initialize handshake; one-shot CLI adapters run only their free
help/model-discovery command. Missing executables, inaccessible directories, protocol failures,
and timeouts are reported separately, and timed-out protocol children are disposed. A successful
check proves the advertised handshake, not arbitrary behavior in a modified implementation, so
version drift and custom-server instability remain disclosed. Parked built-ins stay hidden unless
the user explicitly registers one of these sources.

**`capabilities()` is what makes it honest.** Not every engine can fork, steer, or emit
reasoning. The UI reads capabilities and hides what's unavailable rather than showing a
button that fails.

**Tier 3 will break** — it's coupled to someone else's output shape. Each Tier 3 adapter
needs a declared version range, a CI contract test that runs the real binary, graceful
degradation to an `unknown` item (never a crash, never silent loss), and a visible
"untested version" banner.

Checkpoints, worktrees, cost accounting and search live **above** the adapters, implemented
once. Git checkpoints work identically regardless of which engine made the change.

**The product must work with only a direct API provider configured.** Harness owns the
shared session model, persistence, orchestration, queueing, review, worktrees, terminal and
UI. Provider integrations supply inference and declare optional capabilities; they do not
own shared product behavior. New features are designed against the internal contracts
first, then mapped through every adapter. A missing provider capability hides or degrades
only that capability, never the surrounding workflow. Behavioral provider-name branches
belong inside adapters, not the server or renderer.

**Side chat is a provider-neutral ephemeral session, not a native-fork dependency.** At the
fork boundary the orchestrator folds a bounded, reasoning-free snapshot of the parent event
log into session instructions and starts a normal session through the selected adapter.
The side event channel and transcript are independent, the row stays out of project history
and search, and closing the panel disposes and deletes it. A provider may expose native fork,
but shared Side chat semantics cannot depend on that optional capability.

**Direct model APIs use one small Harness-owned agent runtime.** OpenAI, Anthropic and
OpenAI-compatible endpoints provide inference and tool calls, not a complete coding-agent
session. The API runtime drives the same server-owned tools, approvals, persistence and
checkpoints as every other adapter; only request and stream translation varies by API
transport. This is the fallback that keeps Harness functional with only an API key. It is
not used when a richer vendor agent surface is available. The concrete transport matrix and
delivery order live in [PROVIDERS.md](./PROVIDERS.md).

_Rejected:_ ACP-only (gives up Codex's richest-in-class surface) · native-only (caps us at
4 engines) · a Harness agent loop as the only integration path (throws away richer vendor
agent features) · a `switch` on provider in the orchestrator.

### Voice dictation uses the active Codex ChatGPT session

Voice dictation is the explicit exception to provider independence because it reuses the
user's existing ChatGPT entitlement instead of making transcription a shared agent feature.

The shared renderer records mono 24 kHz PCM WAV, then sends the bounded clip through the
local server. The Codex adapter asks app-server for the current ChatGPT session token and
uses it only for a bounded multipart upload to ChatGPT's transcription endpoint. The token
never crosses the server protocol, renderer bridge, logs, database, or filesystem. A 401 or
403 refreshes the session through Codex once before failing.

The mic is capability-gated to ChatGPT-authenticated Codex sessions. API-key auth, older
Codex versions without `getAuthStatus`, and other providers hide it rather than falling back
to browser `SpeechRecognition`, which is unreliable in packaged Electron and inconsistent
across web clients.

_Rejected:_ Codex realtime websocket transcription (currently requires API-key auth) · Web
Speech API (unreliable in packaged Electron and inconsistent across web clients).

---

## Project-scoped MCP configuration

**Harness owns project-scoped MCP configuration; vendor-global configuration is an
inherited input, not our storage layer.** Definitions and per-project enablement live in
the server-owned, human-readable user-config location documented under Storage, keyed by
the canonical project path and a stable server id. They do not live in the repository or
the SQLite event log.

Secrets live only in the OS credential store. The config may contain an opaque credential
reference, never a token or secret environment value. Provider-owned OAuth credentials
remain with the provider binary; Harness starts the provider's login flow and observes its
reported status without reading the credential.

For each provider, effective MCP configuration resolves in this order:

1. An explicitly disabled project entry hides the vendor-global server with the same id.
2. A project definition replaces the vendor-global definition with the same id for that
   project only.
3. Vendor-global servers without a project override remain inherited and read-only.

Project-scoped operations never rewrite or delete unrelated vendor-global configuration.
An adapter that cannot perform an operation reports it as unsupported through capabilities
and returns an actionable error; Harness does not pretend success or fall back to mutating
global state. Read-only inventory may still be exposed when the provider supports it.

_Rejected:_ repository-local MCP config (opening an untrusted checkout must not authorize
command execution; revisit only with an explicit trust gate) · SQLite config (not
human-readable or hand-editable) · writing project state into each vendor's global config
(provider-specific, lossy, and too easy to overwrite unrelated user settings).

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

| Date       | Change                                                                  |
| ---------- | ----------------------------------------------------------------------- |
| 2026-07-28 | Initial decisions.                                                      |
| 2026-08-01 | Defined ownership and precedence for project-scoped MCP configuration.  |
| 2026-08-02 | Added Codex-backed voice dictation.                                     |
| 2026-08-03 | Added the provider-neutral direct API runtime decision.                 |
| 2026-08-06 | Replaced the Electron target with a staged Rust + GPUI migration.       |
| 2026-08-12 | Added user-owned, protocol-compatible harness commands and Pi RPC.      |
| 2026-08-12 | Defined provider-neutral ephemeral Side chat sessions.                  |
| 2026-08-12 | Standardized Electron browser previews on sandboxed `<webview>` guests. |
