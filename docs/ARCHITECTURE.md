# Architecture

Decisions and why, including what we rejected — that part matters, or we re-argue the same
thing in three months. Detail gets added as we build. To change a decision: edit here and
add a change-log row.

---

## Shape

**A local server owns all state and orchestration. Every client is a thin renderer over a
typed WebSocket protocol.**

```
desktop renderer · web                   thin clients
        │  WebSocket, typed contracts
        │  req/res { id, method, params } · push { channel, sequence, data }
   core server (Node, local, long-lived)
        │  orchestration · adapters · SQLite event log · checkpoints · worktrees · PTY
   codex app-server · ACP agents · CLI adapters · direct API
```

Why not just do it in Electron's main process:

- **Agents survive the UI.** Close the window, the turn keeps running.
- The web client is nearly free.
- The server is headless, so orchestration is testable without booting Electron.

T3 Code and OpenCode independently landed on the same shape.

**Protocol rules:** every payload schema-validated at the boundary, both directions. Push
envelopes carry a monotonic `sequence` per connection so clients detect gaps and resync.
Client transport is an explicit state machine (`connecting → open → reconnecting → closed`)
that queues outbound requests while disconnected.

PR descriptions, comments, and reviews load private repository images through the existing
authenticated `gh` process and typed protocol, not a new HTTP proxy or renderer-held credential.
Repository-file URLs reach fixed Contents/Blob API endpoints; private uploads use a validated
GitHub attachment ID through the same CLI, including renewal of expired private-CDN links.
Responses are bounded to 10 MiB and checked PNG, JPEG, GIF, WebP, AVIF, SVG, BMP, or ICO bytes.
SVG stays in Chromium's isolated image mode, never inline markup, so scripts and external
resources cannot execute. Animated image bytes are preserved. Four concurrent reads share a
bounded queue, and byte-bounded LRU caches in the server and renderer avoid repeat fetches.
Previews start near the visible scroll area and decode asynchronously; relative paths resolve
against the PR head. Public GitHub origins remain image-only in CSP. GitHub permissions still
apply, and neither browser cookies nor signed redirect URLs are copied into renderer responses.

_Rejected:_ everything in Electron main (forecloses the web client). tRPC on the wire (ties us
to a TypeScript client).

---

## Desktop shell: Electron

**The primary desktop client is Electron on macOS and Windows.** One Chromium renderer gives
both platforms the same layout, text and motion implementation. Tauri and other system-webview
shells are smaller, but their Chromium/WebKit split would make visual parity a permanent
cross-platform problem.

The local Node server remains a separate long-lived process behind the typed WebSocket
protocol. Closing or restarting the Electron window does not stop active agents. The renderer
stays a thin client and never owns orchestration, persistence, provider processes, the PTY, or
credentials.

Electron's weaker security defaults are fixed in the shell: `contextIsolation: true`,
`nodeIntegration: false`, sandboxing, a strict CSP, a narrow typed `contextBridge`, and
deny-by-default external navigation. The renderer never spawns a process, touches the
filesystem, or reads a credential.

_Rejected:_ Tauri/Wails/Neutralino use divergent operating-system webviews · separate AppKit
and WinUI clients create two permanent UI implementations · a web-only primary cannot own the
native terminal, filesystem and credential-store surface. The Rust + GPUI rewrite is preserved
on `archive/rust-rewrite-2026-08-15`; it is not part of `main`.

### Embedded browser previews

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

## Stack

|                    |                                            |                                                                         |
| ------------------ | ------------------------------------------ | ----------------------------------------------------------------------- |
| Language / runtime | TypeScript 5.9.3, Node 24 LTS              | One language across the server, adapters, web client, and desktop shell |
| Monorepo           | pnpm workspaces + Vite                     | pnpm's store keeps worktree-heavy development cheap                     |
| Desktop            | Electron 43                                | One Chromium renderer across macOS and Windows                          |
| UI                 | React 19                                   | Shared renderer behavior and app-owned controls                         |
| Chat list          | TanStack Virtual, end-anchored             | Variable-height streamed rows keep stable keys and cached measurement   |
| Markdown           | Streamdown + Shiki's JavaScript engine     | Incomplete streamed blocks stay cheap without weakening the CSP         |
| Styling            | CSS token layer                            | Themes, geometry, density, and motion remain app-owned                  |
| State              | React external store + event-derived views | Deltas update the live tail without rebuilding completed history        |
| DB                 | Node SQLite, WAL, FTS5                     | Append-only events and rebuildable read models remain unchanged         |
| PTY                | `node-pty`                                 | The shared process layer handles Unix PTYs and Windows ConPTY           |
| Tests              | Vitest + live Electron checks              | Captured provider frames and platform runs remain the final contract    |

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

| Tier       | Mechanism                        | Engines                                                                                 | Fidelity                              |
| ---------- | -------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------- |
| 1 — Native | Vendor protocol or supported SDK | Codex (`app-server` JSON-RPC), Claude Code (Agent SDK), OpenCode (HTTP), Pi (RPC JSONL) | Full where the protocol exposes it    |
| 2 — ACP    | Agent Client Protocol over stdio | Gemini CLI + ~25 others                                                                 | Good. One adapter, long tail for free |
| 3 — CLI    | Headless NDJSON                  | Cursor, Grok                                                                            | Adequate. Version-pinned, fragile     |

Engines can appear in more than one tier. We default to the highest fidelity available, with
a user override. Claude Code now runs through Anthropic's Agent SDK while keeping the user's
installed `claude` executable and account, so the adapter gets a persistent prompt stream,
interactive permissions and questions, and live control calls without making shared behavior
depend on that vendor. A different Claude surface can still replace it without touching the UI.
Because the adapter always names that executable, the SDK's optional per-platform CLI packages
(about 290 MB each) are removed from the dependency graph in `pnpm-workspace.yaml` and excluded
from the desktop package; the app ships no Claude binary of its own.

**Users may register protocol-compatible executables as separate harness sources.** Each
entry names an existing adapter protocol and stores an executable, fixed argv, optional launch
directory, and non-secret environment overrides in
`~/.tastecode/custom-harnesses.json`; arguments never pass through a shell, and secrets
never belong in this file. Provider CLIs, terminals, and custom commands resolve against a
desktop-safe PATH. GUI-launched Electron apps do not inherit a login shell, so the server
adds conventional user locations such as `~/.local/bin` and Homebrew's prefix rather than
sourcing `.zshrc`. When a mod boots from its own directory,
`HARNESS_WORKSPACE_PATH` retains the active project for its wrapper and native protocols still
receive that project normally. The source gets its own model catalog and persisted identity, so
a fork can coexist with the stock CLI without replacing it.

Settings can run a bounded compatibility check before the first prompt. Codex, Claude Code, Pi,
OpenCode, and ACP complete their actual initialize handshake; one-shot CLI adapters run only their
free help/model-discovery command. Claude's SDK probe uses a never-yielding prompt stream, so it can
read models and account metadata without starting an Anthropic API request. Its synthetic `default`
row is discarded, live aliases are presented with their resolved version numbers, and the live list
is merged with Claude Code's complete versioned catalog. Missing executables,
inaccessible directories, protocol failures, and timeouts are reported separately, and timed-out
protocol children are disposed. A successful check proves the advertised handshake, not arbitrary
behavior in a modified implementation, so version drift and custom-server instability remain
disclosed. Parked built-ins stay hidden unless the user explicitly registers one of these sources.

**`capabilities()` is what makes it honest.** Not every engine can fork, steer, or emit
reasoning. The UI reads capabilities and hides what's unavailable rather than showing a
button that fails.

**TasteCode thread ids and provider resume ids are separate identities.** The stable TasteCode
id owns the event log, queue, worktree, and UI route. When a provider reports a different opaque
session id, the adapter emits it as recovery metadata and the server persists it separately.
Restarted runtimes receive both ids and must return the original TasteCode id; the provider id is
used only at that adapter's resume boundary. A provider that never reported one fails with a
recoverable new-chat instruction rather than passing a synthetic TasteCode id to the provider.

**Completed resumable runtimes are a hardware-scaled warm LRU.** Each attached adapter can own a
child process, so keeping every completed thread attached makes idle memory grow without a bound.
TasteCode keeps one warm idle runtime per 2 GiB of RAM, with a floor of four and a ceiling of 16.
Viewing a thread refreshes its recency; an evicted thread resumes on its next submission. Running,
queued, Side chat, provider-operation, and non-resumable runtimes are never evicted.

**Large optional feature engines load only when their feature starts.** The server keeps Design
mode's tiny attachment marker on the normal turn path, but defers its full prompts, parsers, and
validators until a design run starts or resumes. An unused optional feature must not add to every
startup or idle process merely because its routes exist.

**Startup readiness uses the lightest provider-owned check.** Codex sign-in readiness comes from
its short `login status` command, so opening TasteCode does not start a full `app-server` merely to
enable the composer. Provider Settings still asks the native protocol for rich account details.
The selected source may also reuse a model catalog that the provider validated within the last five
minutes; opening the model picker always requests live discovery. Cached models never replace the
per-launch sign-in check.

**Tier 3 will break** — it's coupled to someone else's output shape. Each Tier 3 adapter
needs a declared version range, a CI contract test that runs the real binary, graceful
degradation to an `unknown` item (never a crash, never silent loss), and a visible
"untested version" banner.

Checkpoints, worktrees, cost accounting and search live **above** the adapters, implemented
once. Git checkpoints work identically regardless of which engine made the change.

**The product must work with only a direct API provider configured.** TasteCode owns the
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

**Direct model APIs use one small TasteCode-owned agent runtime.** OpenAI, Anthropic and
OpenAI-compatible endpoints provide inference and tool calls, not a complete coding-agent
session. The API runtime drives the same server-owned tools, approvals, persistence and
checkpoints as every other adapter; only request and stream translation varies by API
transport. This is the fallback that keeps TasteCode functional with only an API key. It is
not used when a richer vendor agent surface is available. The concrete transport matrix and
delivery order live in [PROVIDERS.md](./PROVIDERS.md).

_Rejected:_ ACP-only (gives up Codex's richest-in-class surface) · native-only (caps us at
4 engines) · a TasteCode agent loop as the only integration path (throws away richer vendor
agent features) · a `switch` on provider in the orchestrator.

### Voice dictation uses the signed-in Codex account

Desktop Codex chats offer dictation immediately to the left of Send. The renderer records
bounded mono 24 kHz PCM WAV and sends audio through the existing local voice protocol.
The Codex adapter obtains account authorization through app-server `getAuthStatus` and
uploads the clip to the fixed ChatGPT transcription endpoint. It refreshes authorization
once after a 401/403. Credentials remain in adapter memory, never in the renderer,
configuration, database, logs, or protocol responses. No separate API key is required.

Recording shows live audio levels, a timer, cancel, transcribe, and transcribe-and-send.
Escape cancels; cancellation closes the microphone and aborts uploads. The transport and
response sizes are bounded. This account endpoint is not a public API contract, so failures
must remain visible and must not silently switch to a billed API connection.

_Rejected:_ browser SpeechRecognition (unreliable in packaged Electron) and requiring an
extra OpenAI API key for account-backed dictation.

---

## Project-scoped MCP configuration

**TasteCode owns project-scoped MCP configuration; vendor-global configuration is an
inherited input, not our storage layer.** Definitions and per-project enablement live in
the server-owned, human-readable user-config location documented under Storage, keyed by
the canonical project path and a stable server id. They do not live in the repository or
the SQLite event log.

Secrets live only in the OS credential store. The config may contain an opaque credential
reference, never a token or secret environment value. Provider-owned OAuth credentials
remain with the provider binary; TasteCode starts the provider's login flow and observes its
reported status without reading the credential.

For each provider, effective MCP configuration resolves in this order:

1. An explicitly disabled project entry hides the vendor-global server with the same id.
2. A project definition replaces the vendor-global definition with the same id for that
   project only.
3. Vendor-global servers without a project override remain inherited and read-only.

Project-scoped operations never rewrite or delete unrelated vendor-global configuration.
An adapter that cannot perform an operation reports it as unsupported through capabilities
and returns an actionable error; TasteCode does not pretend success or fall back to mutating
global state. Read-only inventory may still be exposed when the provider supports it.

Grok's one-shot print mode has no session-scoped MCP input, so a Grok session with enabled
project servers starts through the same installed binary's ACP stdio mode and passes those
servers in `session/new`. Sessions without a project server keep the captured streaming-JSON
path. This preserves Grok's inherited user configuration without writing `~/.grok/config.toml`
or a repository `.grok/config.toml` on the user's behalf.

Claude Code receives enabled project definitions on both start and resume through the Agent
SDK. Initial same-id loopback definitions suppress overridden inherited servers without exposing
credentials. Before the session becomes ready, the SDK control channel replaces these definitions
with the configured transports. Each server receives only its own credentials; secrets do not
enter command arguments or the shared Claude process environment. Diagnostics are redacted.
Other inherited servers remain available. The captured SDK cannot safely hide an inherited
server without writing vendor settings. Claude's adapter therefore rejects disabled entries
and unsupported per-server working directories before persistence or process startup. It
does not advertise live inventory, reload, or OAuth controls. Removing a project definition
still restores the inherited configuration on the next start or resume.

_Rejected:_ repository-local MCP config (opening an untrusted checkout must not authorize
command execution; revisit only with an explicit trust gate) · SQLite config (not
human-readable or hand-editable) · writing project state into each vendor's global config
(provider-specific, lossy, and too easy to overwrite unrelated user settings).

---

## Storage

**SQLite in the server. The append-only event log is the source of truth for thread
transcripts and orchestration history; UI state is a derived read model. FTS5 for search.**

- Crash mid-turn → replay the log, lose nothing.
- Undo and checkpoints fall out naturally.
- Read-model migrations are cheap because they can always be rebuilt.
- **Rule: transcript and orchestration history changes by appending an event.** Project,
  lifecycle, settings, and catalog metadata remain ordinary transactional records. Never write
  directly to read models derived from the event log.

**Local provider history is discovered without starting a model turn.** Codex, Claude Code,
and Grok own their saved-file readers; shared import code only reads their declared history
interface. A background metadata scan adds native chats only to projects already added in
TasteCode and loads transcripts on demand. History readers never add projects. Adding a project
starts a fresh scan; removing it stops further imports until it is added again. Stable provider
identities prevent duplicate chats. Imported messages use the same
typed items and renderer as local turns. New versions append events; source membership hides
replaced native branches without moving local event positions or checkpoints. Replay orders
imported turns by their original time and replaces stale partial client histories when needed.
Provider files stay read-only. Local names, pins, archives, project removal, and deletion remain
local choices. Cloud-only chats and missing native transcript files are outside this local reader.

**Checkpoints are git**, captured on turn start and completion. Correct, inspectable with
tools users already trust, identical across every engine. Non-git directories fall back to a
content-addressed snapshot of touched files only.

**Search is FTS5** over message and tool-output text. Instant search across every session
ever, for almost no implementation cost — and "what was that command three weeks ago in the
other project?" is a real question nobody in this category answers well.

**Many-thread sidebar state stays sparse and incremental.** The SQLite inbox index materializes
only current failures and pending requests; successful historic turns do not add startup work.
Index migrations and transcript rewrites rebuild it from the append-only event log. In memory,
Inbox projections allocate approval and input sets only while requests are pending. Live status
changes enter a bounded thread-id journal, so `projects.list` updates the exact changed rows while
its project, thread, and queue snapshots are unchanged. An expired journal falls back to a
complete projection. Visible inbox clocks also stay narrow: second, minute, and day values use
separate stable context lanes, so one working thread updates its own status without rebuilding
idle rows, menus, or shelf details. Repeated closed menus mount only their trigger; the full
positioning and keyboard controller activates on first use and stays warm. Context-menu targets
share one delegated listener set instead of installing listeners on every visible row.

**Long-thread replay snapshots extend from their durable tail.** An exact snapshot is returned
without parsing the event log. When a few newer events exist, the server reads only those events,
folds them over the prior compact replay, and replaces the snapshot. History rewrites delete the
snapshot first, so a stale branch can never survive a restore.

|             | Windows                     | macOS                                      |
| ----------- | --------------------------- | ------------------------------------------ |
| DB + logs   | `%APPDATA%\TasteCode\`      | `~/Library/Application Support/TasteCode/` |
| User config | `%USERPROFILE%\.tastecode\` | `~/.tastecode/`                            |
| Credentials | Credential Manager          | Keychain                                   |

On first use, TasteCode moves legacy Personal Harness files into these locations without
overwriting an existing TasteCode file.

Config is human-readable and hand-editable on purpose. It is never where secrets go.

History retention is user controlled. The local `history` command reports storage size,
exports records, previews eligible closed tasks, and archives them before explicit cleanup.
Cleanup retains active tasks and private checkouts, then reclaims unused database pages.
There is no automatic history expiry. See [History maintenance](./HISTORY.md).

Checkpoint and undo commits have database-scoped Git refs. Worktree cleanup combines all
retained commits by Git common directory before removing unused refs. Restore and branch
switch guards instead use the canonical checkout directory: separate worktrees can work
independently, while tasks sharing a checkout cannot restore files during another turn or
while its process is still stopping. An isolated start receives its base ref directly.

`ProviderControls` owns provider-specific account, login, usage, MCP and skill behavior.
Shared orchestration reads declared capabilities and merges shared local configuration.
Settings views renew 60-second notification leases; one read cannot hold a control process
for the whole app lifetime. `ThreadController` owns web transcript, replay, queue, submission
and draft state, while the frame store still batches streamed deltas for React.

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
5. **Closed activity owns no detail DOM.** Command and tool details mount when their
   disclosure opens, stay mounted for the closing animation, then unmount. Collapsed output
   must not consume layout, DOM, or image-preview work.
6. **Collapse huge blocks by default** — better UX and better performance.
7. **Never mount full history on open.** Last N turns, fetch older on demand.
8. **Partial background caches do not grow a second transcript.** At most eight inactive
   workers keep a hot transcript, with 256 items or 256 KiB per worker and 512 items or 512 KiB
   in total. Older or larger workers retain only lifecycle and attention state. Their transcript
   reloads from the local event log when selected.
9. **Completed inactive histories have a shared text budget.** The three-entry / 3,000-item LRU
   also caps retained strings at 8 Mi characters (at most 16 MiB of UTF-16 payload). An oversized
   completed transcript leaves the cache and reloads from the local event log when selected, so
   one huge reply cannot consume idle memory.

### Budgets — local release gates

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

The [local Electron gate](./PERFORMANCE-CHECKS.md) measures real visible rows, repeated
startup and stable idle memory. Reports also keep transient memory peaks. Hosted CI stays
manual.

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

| Date       | Change                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-07-28 | Initial decisions.                                                                                                                                                             |
| 2026-08-01 | Defined ownership and precedence for project-scoped MCP configuration.                                                                                                         |
| 2026-08-02 | Added Codex-backed voice dictation.                                                                                                                                            |
| 2026-08-03 | Added the provider-neutral direct API runtime decision.                                                                                                                        |
| 2026-08-06 | Replaced the Electron target with a staged Rust + GPUI migration.                                                                                                              |
| 2026-08-12 | Added user-owned, protocol-compatible harness commands and Pi RPC.                                                                                                             |
| 2026-08-12 | Defined provider-neutral ephemeral Side chat sessions.                                                                                                                         |
| 2026-08-12 | Standardized Electron browser previews on sandboxed `<webview>` guests.                                                                                                        |
| 2026-08-14 | Removed phone and remote-client support from active product scope.                                                                                                             |
| 2026-08-14 | Routed project-enabled Grok MCP sessions through ACP stdio.                                                                                                                    |
| 2026-08-15 | Archived the Rust + GPUI rewrite and restored Electron on `main`.                                                                                                              |
| 2026-08-18 | Moved voice transcription from ChatGPT session reuse to explicit OpenAI API auth.                                                                                              |
| 2026-08-18 | Separated stable TasteCode ids from provider-native resume identities.                                                                                                         |
| 2026-08-21 | Bounded completed resumable adapter runtimes with a hardware-scaled warm LRU.                                                                                                  |
| 2026-08-21 | Made many-thread Inbox state sparse and status projection incremental.                                                                                                         |
| 2026-08-21 | Materialized only current Inbox state instead of replaying every historic turn.                                                                                                |
| 2026-08-21 | Extended stale long-thread replay snapshots from only their new event tail.                                                                                                    |
| 2026-08-21 | Added shared item, byte, and worker limits for background transcript caches.                                                                                                   |
| 2026-08-21 | Bounded completed inactive transcript caches by retained string size.                                                                                                          |
| 2026-08-21 | Deferred closed menu controllers and shared row context-menu listeners.                                                                                                        |
| 2026-08-21 | Released one-shot Codex control processes after a short idle window.                                                                                                           |
| 2026-08-21 | Expired resumable thread processes after a bounded warm idle window.                                                                                                           |
| 2026-08-21 | Limited runtime-retention sweeps to safe resumable idle processes.                                                                                                             |
| 2026-08-21 | Removed full provider-control startup from cached, signed-in launches.                                                                                                         |
| 2026-08-21 | Indexed workspace review folders to bound large changed-file tree construction.                                                                                                |
| 2026-08-22 | Applied the desktop-safe PATH to provider detection, CLI spawns, and the PTY.                                                                                                  |
| 2026-09-08 | Added checkpoint reachability and checkout guards, explicit history maintenance, provider controls, task-state ownership, bounded leases and local Electron performance gates. |
| 2026-09-15 | Added authenticated repository and upload image previews, isolated SVG rendering, lazy loading, and byte-bounded caches for pull-request Markdown.                             |
| 2026-09-15 | Dropped the Claude Agent SDK's bundled per-platform CLI from the dependency graph and the desktop package; the adapter always spawns the user's `claude`.                      |
