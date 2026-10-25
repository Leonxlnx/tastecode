# Architecture

Decisions and why, including what we rejected — that part matters, or we re-argue the same
thing in three months. Detail gets added as we build. To change a decision: edit here and
add a change-log row.

---

## Shape

**A local server owns all state and orchestration. Every client is a thin renderer over a
typed WebSocket protocol.**

```
desktop renderer · web     phone (Expo + SwiftUI)     thin clients
        │  WebSocket, typed contracts   │ same protocol, end-to-end encrypted link
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

**Closing a terminal ends its foreground job, not everything it ever started.** node-pty's
`kill()` only sends the shell SIGHUP; bash and zsh forward it to their jobs, and when the shell
exits the kernel sends it to the terminal's foreground process group. Before that hangup the
server reads the foreground group from a shell it forked as a session leader. A shell still
running after a grace period is SIGKILLed, and the close is done once the shell is gone. The
manager then stops the foreground job in the background, so a chat can open a new terminal at
once: the job gets a grace period to exit on its own, then SIGTERM, then SIGKILL, and a job that
still cannot be stopped is logged rather than failing anything. On a pane or chat close the
shell's grace, the job's grace and the wait after SIGTERM are three seconds each, and the wait
after SIGKILL is one second. Server shutdown waits for every job, under one deadline counted from
the start of the close: a shell still running is SIGKILLed and jobs get SIGTERM from 0.2 s, jobs
get SIGKILL at 2 s, and the close gives up at 2.3 s. That keeps the last SIGKILL inside the
desktop's three-second force stop, and leaves most of the time to SIGTERM, on which servers that
reload on SIGHUP (gunicorn, nginx, postgres) shut down cleanly. Closing or deleting a chat,
removing a project's chats and discarding a worktree wait only for the shells; a project's own
terminal is closed without waiting.

Before each signal the group is listed again. On Linux the job is only signalled while every live
member is still in the closed shell's session, which keeps a recycled group id from being
signalled. macOS `ps` prints 0 as every process's session, so there that re-check guards nothing
and only the shell's session-leader check holds.

Only processes outside the foreground group survive. A job put in the background from the
interactive prompt gets its own group through job control and stays the shell's business, as in
a terminal emulator: `nohup … &` and `disown` keep working, and so does a background job that
ignores SIGHUP, which the OS cannot tell apart from `nohup`. `setsid` leaves the group from
anywhere. Everything else in the foreground group is ended whatever it does with SIGHUP: a
foreground `nohup` command, and the `&` or `nohup … &` children of a foreground script or of a
one-shot `run()` command, which run without job control and stay in the group. On Windows
node-pty already terminates every process attached to the closed ConPTY (read from its source,
not yet tried on Windows).

_Rejected:_ sweeping the whole PTY session (#1162): it also kills `nohup` and disowned jobs that
a terminal emulator leaves running. SIGTERM straight after the hangup: it cut off jobs that need
more than a moment to shut down cleanly. Waiting for the job in the close itself: closing a chat
took up to nine seconds and its terminal could not be reopened meanwhile.

### User feedback goes through the server

**Outbound feedback goes through the local server; the inbox key lives only in the server
process.** The renderer's CSP allows only the local server, so the feedback dialog calls
`feedback.status`, `feedback.preview` and `feedback.submit`, and the server builds, redacts and
sends the Trecko request. Preview and submit share one builder, so the preview is exactly what
is sent, and only `feedback.submit` (the dialog's Send) sends anything. The key is injected at
build time: `apps/desktop/scripts/feedback-endpoint.js` writes the gitignored
`dist/feedback/feedback.env`, which ships as an extra resource outside `app.asar`. Desktop main
passes the server only that file's path; the server reads it once at startup and deletes every
feedback variable from `process.env`, so agent CLIs, terminals and git never inherit the key.
`pnpm dev` reads `~/.tastecode/trecko-feedback.env` instead. Builds without a key answer
`not_configured`, and every entry point stays hidden. The local limits (one send at a time,
waits after each attempt, daily caps, duplicate refusal) only stop the app itself from spamming
the inbox. The key can be extracted from any packaged build, so real abuse protection belongs
in Trecko.

_Rejected:_ a renderer `fetch` to Trecko (widens the CSP and puts the key in the renderer).
Leaving the key in the server's environment (every child process would inherit it). Compiling
the key into desktop main (main never needs it).

### Phones connect over an end-to-end encrypted link

**A paired phone is one more client of the same protocol, reached directly over the local
network or a tailnet, with every frame encrypted end to end.** Phone access is off until the
user turns it on in Settings › Phone. Then a second listener (`HARNESS_PHONE_PORT`, default 4317) accepts WebSockets on `/link` from private, link-local, loopback and tailnet
(100.64.0.0/10) addresses only, refuses any request carrying an `Origin` header (no page can
reach it), and speaks nothing but a **Noise IK** handshake (`Noise_IK_25519_ChaChaPoly_SHA256`,
prologue `tastecode-link/1`) until the phone has proved its key. The pairing code is a
`tastecode://pair` link holding the computer's static X25519 key, its port, its addresses (local
name, Wi-Fi, Tailscale) and a one-time secret that expires after ten minutes; the first phone to
present it is registered by its public key, and the code closes. The phone pins the computer's
key, so no address in the code has to be trusted and nothing can stand in the middle. After the
handshake each WebSocket message is one ChaCha20-Poly1305 frame, larger than Noise's own 64 KiB
limit when a history page needs it; a frame that fails authentication closes the link. Both
implementations (Node's crypto in `apps/server/src/phone-noise.ts`, CryptoKit in
`apps/mobile/modules/tastecode-link`) reproduce the published cacophony vector byte for byte.

The server's private key lives in the OS credential store, one per data folder; paired phones
are stored as public keys in `app_settings`. A phone may call only `PHONE_METHODS`: reading and
driving chats, choosing models and access levels, browsing folders to add a project, attaching
images. Terminals, installs, credentials, MCP and further pairing stay on the desktop, and
phone links never receive `phone.*` or preview pushes. A paired phone sees every push the
desktop sees, so a turn started on either streams on both; `projects.changed` tells every client
when another one started, renamed or moved a chat. A chat's setup (model, reasoning effort,
service tier, access level) is kept by the server, not by each client: `thread.settings` reads
it, `thread.setSettings` and `thread.setApproval` change it, and the `thread.settings` push
carries every change, so a pick on one device shows on the other at once. The desktop publishes
the choice keys its picker hides (`models.hidden`) and the phone offers only the rest, because
the desktop never runs a chat on a hidden model.

The phone app is Expo with its interface written in Swift: one SwiftUI view hierarchy (iOS 26,
Liquid Glass) inside an `@expo/ui` host, in the local `tastecode-ui` module, beside the
`tastecode-link` module (Network.framework and CryptoKit, keys in the Keychain). Protocol logic,
reconnects and state are TypeScript and import the shared contracts' types. TypeScript also
words what the screens show (`src/view`: chat rows, step summaries, approval subjects) and sends
it to Swift as JSON; an open chat sends only the rows that changed, so a streaming reply carries
its own text and nothing else; Swift reads that JSON off the main thread. Swift draws and asks
back through one action event. The chat transcript is UIKit, not SwiftUI: a collection view whose
layout knows every row's exact height, rows laid out on a background queue from Markdown blocks
measured once and cached, and in a long reply only the blocks near the screen built. Text is
drawn off the main thread into IOSurfaces (also a screen and a half ahead of a scroll), which the
main thread hands to Core Animation as they are; a streaming row moves only itself and the rows
below it. An Android build replaces the two native modules with Kotlin and Compose and keeps
everything else. The phone app has its own npm install, outside the pnpm workspace.

_Rejected:_ the earlier phone design's bearer tokens in a plaintext WebSocket URL (safe only on
Tailscale, readable by anyone on a café Wi-Fi). TLS with a pinned self-signed certificate
(React Native's WebSocket cannot pin, and Node needs a certificate generator). A relay server
(traffic and metadata would leave the user's machines; a relay can come later, carrying the same
encrypted frames). A fully native Swift app (Android would share nothing). Screens composed in
React from `@expo/ui`'s SwiftUI components (the first version): menus, toolbars, the composer's
glass and scrolling could not be shaped as iOS draws them, and every streamed delta re-rendered
React. The transcript in SwiftUI (a lazy stack of `Text`): every streamed delta parsed and laid out
the whole reply again on the main thread: streaming the same reply in a simulator, it used about
three times the main thread's time the UIKit transcript does. Transcript text drawn in
`draw(_:)`, even with `drawsAsynchronously`: the main thread typeset every changed block and then
waited at each commit for Core Animation's drawing queue, about 60% of its busy time while
streaming. Text as plain `CGImage` contents: it cost the main thread 5–10% more CPU while
scrolling than IOSurfaces, which Core Animation shares with the render server rather than
sending over.

---

## Desktop shell: Electron

**The primary desktop client is Electron on macOS and Windows.** One Chromium renderer gives
both platforms the same layout, text and motion implementation. Tauri and other system-webview
shells are smaller, but their Chromium/WebKit split would make visual parity a permanent
cross-platform problem.

The local Node server remains a separate long-lived process behind the typed WebSocket
protocol. Closing or restarting the Electron window does not stop active agents. The renderer
stays a thin client and never owns orchestration, persistence, provider processes, the PTY, or
credentials. Quitting asks the server to shut down over IPC (`{ type: 'harness:shutdown' }`),
so it flushes streamed text and closes the store; the desktop force-stops it only after three
seconds. A crashed renderer reloads once on its own and then offers a Reload dialog instead of
looping. The packaged server takes its port from the renderer's compiled CSP, so a stray
`HARNESS_PORT` cannot split the two.

Durable user data never lives in the OS temp folder, which the system may clean at any time.
Pasted attachments are written under the app's data folder, because chat history keeps their
paths; files pasted by older builds into `<temp>/TasteCode/pasted-files` stay readable. They
are never pruned by age: only chat history knows whether a file is still referenced. New
isolated chat checkouts live in `trees` beside the database for the same reason
(`HARNESS_WORKTREE_DIR` overrides it); existing checkouts keep their stored paths.

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
isolation, and web security. Top-level navigation accepts HTTPS anywhere and HTTP only on
loopback, where dev previews bind 127.0.0.1. Programmatic navigation is checked through the
session request API; stopping inside `did-start-navigation` can crash Chromium. This policy
is not a general subresource or network firewall. The guest denies permissions, keeps
attempted new windows in the same preview, and exposes an explicit validated system-browser
handoff. Guests keep Chromium's background throttling, so a hidden or minimized window does not
run a page's timers and animation frames at full rate. Hidden full-page captures use their own
unthrottled offscreen window instead.

The guest remains a normal DOM element, so it follows the animated workspace without a native
overlay or bounds IPC. A renderer `ResizeObserver` fits fluid, desktop, tablet, and mobile modes;
fixed modes retain their requested CSS viewport and scale the complete guest to fit instead of
stretching it. All modes therefore share Electron's Chromium path across macOS, Windows, and
Linux.

### Desktop update assets

The desktop updater finds releases in `Leonxlnx/tastecode` through the public release Atom
feed on github.com. The API's anonymous limit is 60 requests an hour per IP address, shared
by everything behind one office, school or VPN address, and an anonymous 304 still counts.
The feed is outside that limit. A check that finds no newer version tag in the feed spends
no API request. The newest newer tag costs one request to `/releases/tags/<tag>`, which
confirms the release is published and supplies the asset digests. When that tag has no
published release (drafts and bare tags answer 404), when none of the feed's ten newest
tags is the installed version or older, when a feed entry has no readable tag, or when a
full feed has nothing newer but no longer lists the installed release (later-published
older versions can push a newer release out of the window), the release list is read
instead. The feed is ordered by publication, so while it still lists the installed release
everything published after it is in view. A check therefore spends at most two API
requests while the project has fewer than 100 releases. Either way the highest semantic
version wins regardless of publication order, and downgrades stay disabled.

GitHub's pre-release flag does not matter: during the alpha every release is published as
a pre-release, and every published release reaches every install. Drafts stay invisible.
Beta 7 through 0.1.1 select by publication date; those installed clients still require the
newest public release to contain both desktop installers. The client requires the matching EXE or DMG and verifies
its size and SHA-256 against GitHub's asset metadata.

Downloads survive failures and restarts. The installer is stored in the machine's cache
directory (`~/Library/Caches/TasteCode/update-downloads` on macOS, local AppData on Windows)
under its SHA-256, and the next attempt asks for the remaining bytes with a Range request.
A minute without data ends an attempt and keeps the bytes so far. The bytes are verified
before use, removed once the native updater holds its own copy, and discarded when a check
finds nothing newer. A verified download also survives a failed preparation (`ditto`,
`hdiutil`, `codesign`, a timeout or a Squirrel error); only proof that the package itself
is bad (wrong signature, invalid or corrupt image) discards it, so a local failure never
costs a silent 500 MB re-download. Removal retries and never fails an update, because
Windows virus scanners briefly lock fresh installers.

Background attempts never surface their failures. An offline launch, a GitHub outage or a
dropped download falls back to the last verdict, is recorded in opt-in local diagnostics,
and retries after 5, 15 and 30 minutes, then hourly. A rate-limited answer waits for
GitHub's reset. A check the user starts, and a failed install of a ready update, show the
error. After the machine wakes, an overdue check runs within 15 seconds.

Installation remains owned by electron-updater's NSIS and Squirrel.Mac paths. On macOS,
the client mounts the DMG read-only, validates its app ID, version and signature, and
creates Squirrel's ZIP locally. A private loopback endpoint supplies the verified file
with locally computed SHA-512 metadata. It closes after the native updater consumes the
file. Quit waits for active download cleanup so a mounted DMG is detached.

Beta 7 retains the public YAML/ZIP assets needed by beta 6. Starting at beta 8, only the
EXE and DMG are uploaded; the complete checksums and packaging proof remain local.
The cutoff and remaining beta 6 users are covered in [RELEASING.md](./RELEASING.md).

_Rejected:_ replacing app bundles with a custom shell/helper installer would duplicate
native signing checks and replacement logic; a second release repository would split
the release process. Removing compatibility files in beta 7 would strand beta 6 users.
Sorting by publication date allows an older, later-published platform proof to hide the
current version and fail asset validation before the downgrade check runs.
Conditional API requests with ETags do not save the anonymous limit. electron-updater's
YAML feeds and blockmaps would add files to every release and give up the two-asset
release that installed clients rely on, so differential downloads are not offered either.
Stable and beta channels keyed on the pre-release flag were built and removed the same day:
with every alpha release published as a pre-release, a stable default would have blocked all
updates. Channels need a real stable line first, at v1 at the earliest.

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
The user can instead run it through `claude -p` with stream-json on both pipes, where the adapter
speaks the same control protocol itself (`cli-runtime.ts`); an engine declares such choices as
`capabilities.runtimes`, and the server stores the choice and applies it at every launch.
Because the adapter always names that executable, the SDK's optional per-platform CLI packages
(about 290 MB each) are removed from the dependency graph in `pnpm-workspace.yaml` and excluded
from the desktop package; the app ships no Claude binary of its own.

**Users may register protocol-compatible executables as separate harness sources.** Each
entry names an existing adapter protocol and stores an executable, fixed argv, optional launch
directory, and non-secret environment overrides in
`~/.tastecode/custom-harnesses.json`; arguments never pass through a shell, and secrets
never belong in this file. Provider CLIs, terminals, and custom commands resolve against a
desktop-safe PATH. GUI-launched Electron apps do not inherit a login shell, so the server
adds conventional user locations such as `~/.local/bin`, Homebrew's prefix, and
`%LOCALAPPDATA%/Programs/OpenAI/Codex/bin` rather than sourcing `.zshrc`. Codex's adapter
owns its official standalone install command, so fresh desktops do not need npm to install
their first provider. The server allowlists that same command for guided setup. When a mod boots
from its own directory,
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

**Branch scope (2026-10-03).** `main` ships only the Codex, Claude Code and Grok adapters.
Every other adapter in this document, the ACP agent roster and the direct API runtime exist
only on `nightly`; on `main`, `packages/adapter-acp` remains solely as the protocol client
behind project-enabled Grok MCP sessions. The decisions below still bind both branches.

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

**Direct model API connections were removed (2026-10-20).** TasteCode no longer stores API
keys or runs chats on them itself. Its own small agent loop (four workspace tools, a 64 KiB
request budget) made a key-backed chat a far weaker agent than any CLI, and the OpenCode-backed
replacement tried the same day was dropped before it shipped. To use their own key, users sign
in to OpenCode with it and chat through the OpenCode provider. The `api` provider id and the
`connections.*` methods remain in `packages/contracts` until a contracts change removes them;
the server answers those methods as unknown, and a saved API chat stays readable but cannot
start again. The principle above, and the matching hard rule in `AGENTS.md`, named the direct
API provider as the one every shared feature is checked against; which provider takes that
place is Leon's decision.

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
Provider files stay read-only. Local names, pins, project removal, and deletion remain local
choices; a deleted chat or closed Side chat keeps an import marker, so a rescan does not bring
it back. Cloud-only chats and missing native transcript files are outside this local reader.
Background rescans stay cheap: Codex reuses indexed transcript file stats for up to 60 seconds
while its state index is unchanged, and Grok keeps a parsed session summary until the file's
size or modification time changes.

**Checkpoints are git**, captured on turn start and completion. Correct, inspectable with
tools users already trust, identical across every engine. Non-git directories fall back to a
content-addressed snapshot of touched files only.

A snapshot stages the working tree into a temporary index seeded from a copy of the
checkout's own index, reset to HEAD with `read-tree --reset -i`, so `add -A` re-reads only
files whose stat data changed. The copy keeps the source index's timestamp, so git still
re-checks racily clean entries. An index that marks any entry assume-unchanged or
skip-worktree falls back to a plain `read-tree`, because `add -A` would trust the mark and
record HEAD instead of the working file. _Rejected:_ a plain `read-tree` for every snapshot
(no stat data, so every tracked file was hashed before each turn: `add -A` took 404 ms of a
451 ms snapshot of a 2,487-file checkout) · listing changes with `git status` against the
real index (it hides the same marked files and may lock the index the agent is using).

**Search is FTS5** over message and tool-output text. Instant search across every session
ever, for almost no implementation cost — and "what was that command three weeks ago in the
other project?" is a real question nobody in this category answers well. Messages are indexed in
full. Command and tool output indexes its first 12K and last 4K characters, which keeps long logs from
being duplicated into the index. A search-index version change drops and recreates the table
before the rebuild; deleting every row first would tokenize the old index again.

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
snapshot first, so a stale branch can never survive a restore. Snapshots duplicate the log, so
disk keeps only the 64 most recently written ones, and closing a thread deletes its snapshot. An
older or closed thread rebuilds its replay from the log when it is opened again.

**Thread history is paged by whole turns.** A `thread.history` request with `page` cuts the
cached compact replay: the newest page holds the last turns plus the latest usage and the
approvals and questions older turns left open (a thread error closes them, as in the renderer),
and `olderCursor` walks back. A page ends only where every turn inside it has emitted its last
event, so a prompt recorded before its provider's turn start or a late tool completion never
straddles a cursor; one oversized block may exceed the requested size. Cursors are opaque,
thread-scoped and name the boundary turn and the replay's sequence. An older page is answered
from the replay saved at that sequence while it still exists, so a streaming turn never makes a
page re-compact or rewrite the snapshot; any rewrite of older history deletes that replay. The
answer is `reset` with the newest page when the boundary turn is gone (a restore removed it), when
the replay now ends before the cursor's sequence (a truncation with nothing written since), or
when provider history gained events after that sequence. A truncation that keeps the boundary turn
and has newer events after it does not reset: the older turns are unchanged. A provider rewrite
that only retires events is detected only through the re-recorded thread start: the merge records
`thread.started` again whenever it retires rows. Requests without `page` keep
the full and `afterSeq` responses.

**A cold open reads only the end of the event log.** When no current replay is parsed in memory,
the newest page is read newest first from the log itself, bounded before compaction (#1363's
plan). The page must equal the one cut from the compacted whole log, so the reader grows its
tail until no turn or item in it also occurs in an older row; compacting such a tail alone gives
the same events, and its blocks after the first are the whole log's blocks. A derived index makes
that check cheap: `history_keys` stores, per thread, the first row naming each turn and item, and
`history_state_events` lists the usage, request, answer, turn-end and error rows that decide what
older rows leave open. Both are written in the event's own transaction; a run of deltas writes
its keys once, so the per-delta path stays one insert. A thread is trusted only with a complete
mark: new threads get it at creation, older ones when a full read indexes them, and a start
that finds rows newer than the recorded watermark (written by a build without the index, or
just before a crash) drops the mark of those threads. Removed or retired rows leave entries that
only make the reader read further back. A tail that compaction would leave unchanged says
nothing about the rows before it, so the reader keeps reading. It falls back to the full read for
imported provider turns, which display in time order rather than log order, and when it would
read the whole log anyway; that read also saves the replay older pages are cut from. The
reader saves no replay itself: the first older page compacts the whole log once.
On the 10,375-event benchmark a cold newest page takes about 9 ms instead of about 40 ms.

**Streamed turn diffs are stored only when they change.** Providers can resend the same
working-tree diff many times during one turn. The orchestrator skips an identical repeat for the
running turn; the latest stored diff is unchanged.

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
There is no automatic history expiry. Explicit compaction also removes streamed text fragments
that a later completed event of the same item already holds in full; replay reads the completed
text, so transcripts stay identical. This maintenance command is the only path that removes
event rows without removing their task. See [History maintenance](./HISTORY.md).

Checkpoint and undo commits have database-scoped Git refs. Worktree cleanup combines all
retained commits by Git common directory before removing unused refs. Its identity is the
filesystem-native canonical path, so Windows long paths and 8.3 aliases share one retained-commit
set. Resolution errors propagate and separate repositories remain distinct. Restore and branch
switch guards instead use the canonical checkout directory: separate worktrees can work
independently, while tasks sharing a checkout cannot restore files during another turn or
while its process is still stopping. An isolated start receives its base ref directly.

`ProviderControls` owns provider-specific account, login, usage, MCP and skill behavior.
Shared orchestration reads declared capabilities and merges shared local configuration.
Settings views renew 60-second notification leases; one read cannot hold a control process
for the whole app lifetime. Usage-limit reads are cached per provider for 60 seconds and shared
by concurrent callers. A turn's usage update, a sign-in change or a reset marks them stale; so
does an account read that reports a different account, which is how a sign-in or switch made in
the provider's own CLI reaches the app. An account without plan limits keeps its "unavailable"
answer for 30 minutes instead, through usage updates: spending usage cannot give it limits, and
Claude scans its local transcripts for up to a minute to say so. Only an account change or a
reset discards that answer early. Failed reads are never cached.
Change notifications to clients are coalesced to one leading and one trailing notice per
provider every 30 seconds. Repeated reads, such as switching threads, reuse the cached result
until something changes instead of starting a limit-reading process each time.
Background writing (chat titles, commit messages) reads only the sources its model choice
needs: a manual target alone, otherwise Claude Code, then Codex, then Grok, and every source
only for the cheapest-model fallback. Automatic writing prefers Claude Code's newest Haiku at
medium effort, then a Codex subscription's newest Luna at medium, then Grok 4.6 at low. Each source's account and model read is cached for 60 seconds and
shared with the Settings listing; a sign-in change or harness edit drops them. Reading every
source per task was rejected: it started six vendor processes per new chat.
`ThreadController` owns web transcript, replay, queue, submission
and draft state, while the frame store still batches streamed deltas for React.

_Rejected:_ JSONL files (we'll _read_ Claude Code's, but no indexing/transactions/search) ·
libsql/Turso (sync story we don't need yet) · SQLite in the renderer (source of truth in the
most disposable process) · whole-DB encryption (the DB holds no credentials by policy).

---

### Direct API request retention

Removed with API connections on 2026-10-20.

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
   content hash. Grammar regexes scan one-byte copies of Latin-1 lines: a line cut from a
   reply or patch with one em dash anywhere is stored two bytes wide, and V8 tokenized it
   about half as fast in Electron 43. Copying whole blocks was rejected because one wide
   character inside the block defeats it.
   Completed fences above 32 KiB keep all source lines mounted while decorative token DOM
   is applied in 12-line animation-frame batches. Repeated foreground colors inherit from
   their line; tokens with attributes or other styles retain their elements. Simple complete
   fences skip Markdown/HTML AST construction; complex fences retain Streamdown parsing.
   Plain chunks reserve their full line height in one layout box, and adjacent inherited
   text shares a text node to avoid unnecessary initial layout and removal work.
   Large code containers override Streamdown's block-level content visibility so
   offscreen token batches also lay out incrementally rather than all at first scroll.
   Whole-block token commits exceeded the frame budget. CSS layout containment was rejected
   because it increased theme compositing cost; clipping or dropping source was rejected
   because selection, copy, horizontal scrolling and accessibility must remain intact.
4. **Batch deltas on rAF** (~16ms). Imperceptible, an order of magnitude fewer renders.
5. **Closed activity owns no detail DOM.** Command and tool details mount when their
   disclosure opens, stay mounted for the closing animation, then unmount. Collapsed output
   must not consume layout, DOM, parsing, or image-preview work: a closed row decides that it
   can open from its arguments, or from its output once per item, and builds its detail only
   when it mounts.
6. **Collapse huge blocks by default** — better UX and better performance.
7. **Never mount full history on open.** A cold open asks for the newest ten turns; twenty more
   load when the reader nears the top, and the row being read keeps its position as they are
   prepended. Find in chat and search jumps need every turn, so they fetch the rest in one
   unpaged read instead of searching only what is loaded. A failed read says so and waits for
   Retry. Closing find only drops that read's reply: a transport request cannot be aborted, so
   the server still sends the whole history and the renderer still parses and validates it
   (about 133 ms for a 4.76 MB chat in the browser) before discarding it.
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
| Collapsed 300-call activity, 37.5 MiB   | < 8 MiB, < 200 elements  |
| Same activity, reopened and closed      | < 2 MiB retained         |

Build a 1,000-message fixture thread early, keep it in the repo, run every UI PR against it.
**A PR that regresses a budget doesn't merge.**

The [local Electron gate](./PERFORMANCE-CHECKS.md) measures real visible rows, repeated
startup and stable idle memory. Reports also keep transient memory peaks. Hosted CI stays
manual.

---

## Dashboard design references (nightly)

**Parked since 2026-10-16 (owner decision).** The dashboard asset set is not good enough to ship,
so Design mode builds websites only until better assets arrive. One switch,
`DASHBOARD_REFERENCES_ENABLED` in `packages/design-agent/src/dashboard-references.ts`, turns the
whole surface off: no dashboard catalog is loaded from any library, no dashboard deck is sampled,
`isDashboardBrief` and a saved `operate_monitor` page route nothing into dashboard prompts, and
the Page protocol stops offering that mode and family. A dashboard or app-screen request becomes a
normal website run built from website references, with the limitation recorded in the brief's
assumptions; it never fails and never claims a dashboard library. The 400 dashboard WebPs, their
catalog and provenance left the packaged library (about 42 MB) and stay in git history. The
history below describes the parked path.

Nightly dashboard support is integrated through
[PR #1393](https://github.com/Leonxlnx/tastecode/pull/1393), following
[PR #1392](https://github.com/Leonxlnx/tastecode/pull/1392) merged at `17aa22a3`.
The integrated source includes main through `3e67df35`, retaining the complete nightly provider
roster and usage history. Windows cleanup
[PR #1394](https://github.com/Leonxlnx/tastecode/pull/1394), task authorization
[PR #1403](https://github.com/Leonxlnx/tastecode/pull/1403), and checkpoint identity
[PR #1404](https://github.com/Leonxlnx/tastecode/pull/1404) are merged on main; the API connection
contract in [PR #1395](https://github.com/Leonxlnx/tastecode/pull/1395) is merged on nightly.
This feature is not a public-beta release.
The asset import is complete: a separate dashboard catalog and provenance record contain
200 reviewed generated desktop/mobile pairs, stored as 400 WebPs. The existing 172 website
references and 316 WebPs are unchanged. The combined bundle has 372 references and 716 WebPs:
344 paired references and 28 desktop-only references.
Sampling chooses a layout group uniformly, then one variant within that group, so retries do
not give a composition extra votes. Since 2026-10-12 the dashboard draw is uniform only among the
screens whose domain, tags, product name, cue or motifs best match the request's domain words,
and over all screens when nothing matches. One complete app-shell reference preserves navigation,
content density and responsive hierarchy. The compiled default-bundle checks passed for all
200 selectable dashboard groups, saved-deck roundtrips and both image attachments. All 400
dashboard WebPs have unique matching hashes and valid viewport metadata. The catalog differs
from the private import only in formatting and is deeply JSON-equal; the other 401 imported
files are byte-identical. Website selection still yields 14 website-only references, and
marketing-page classification checks pass.

Briefing distinguishes an operating interface from a marketing page about a dashboard product.
The former plans `operate_monitor` views with functional filters, sorting, tabs, navigation,
drawers and charts. Motion follows those state changes, with keyboard access, focus restoration
and reduced-motion equivalents. Native inline chart SVG in reference-bound dashboard views and
visibly identified demo values avoid website-only validation blockers; asserted product claims
still require evidence. Website hero entrances and scroll reveals keep their existing behavior.

Since 2026-10-12, every phase keeps one design language per page: references set each
section's composition, and one anchor reference sets the type, palette, radius, spacing and
component language. See [One design language per page](./DESIGN-REFERENCES.md#one-design-language-per-page).
Dashboards use one family plus optional monospace data, taken from the anchor screen's own
type, and never add a display face. They are reviewed for shell
consistency, data density, table and chart readability, visible control states and focus.
A site, one-pager or Webseite about an app classifies as a website.

Reference-driven Design requires the session's declared image input capability. Unsupported
sessions reject before inference or persisted Design state; ordinary coding remains available.
The workflow never substitutes an unannounced text-only build for the requested image copying.

Fresh [Windows verification](https://github.com/Leonxlnx/tastecode/actions/runs/37228489532)
passed lint, typecheck, the full test command and build at exact feature source
`edc92ea9c82c40b1c7e0b6f12aa329b2fa05f79e`: 4,445 passed, 18 existing skips, zero failures.
Desktop tests ran: 368 passed and 10 existing skips, included in that total. No deadlines were
overridden. Follow-up integration changes only documentation and recorded screenshots.
Historical local verification at `0ccdb67d` passed all four gates with 4,432 passed and 18 skips.
Thirty-six focused cases cover nine provider IDs: 18 synthetic-vision website/dashboard flows
and 18 capability-rejection/ordinary-follow-up cases.

The isolated browser smoke passed at `a02c6ab3490e55003aa2a95f977b8ccca690bea9`, exercising the
former direct-API runtime (removed 2026-10-20) against a synthetic endpoint. Two unsupported Design attempts made no
additional inference requests and persisted no Design runs. Ordinary follow-ups retained both
API identities, models, messages and tool context across an owned server restart. Four completed
synthetic turns used six fake API requests and 72 synthetic tokens. All 14 source/build
fingerprints stayed stable during the run; the queue was empty, no browser exceptions occurred,
and owned processes were stopped. This proves capability rejection and ordinary API recovery.
Live image-capable dashboard generation, packaged Electron, macOS and real-keyring acceptance
remain unverified. Synthetic flows and a separate external demo do not replace these checks.

_Rejected:_ composing dashboards from marketing sections, treating generation retries as new
layout votes, or requiring static screenshots in place of working native charts and controls.

---

## One design language per generated page (nightly)

Owner decision, 2026-10-12: a generated website must not switch design language between sections.
Randomness stays, but one page keeps one type system (at most two families), one palette, one
radius and spacing scale, and one button, card and label language. This supersedes the uniform,
site-agnostic website sampling from
[PR #1176](https://github.com/Leonxlnx/tastecode/pull/1176), which drew every layout family
independently and put about eleven source sites into one 14-reference deck.

The first drawn section, normally the hero, is still chosen uniformly by group and becomes the
anchor; its source host defines the page's language. Each later section takes the requested
family from the anchor site, then from the three most similar close sites in the optional per-site
`style-profiles.json` (style score at least 10 of 14). Only a sparse family, one with fewer than
ten composition groups, may then borrow a compatible family from those sites; otherwise the
section comes from the uniform pool the family always used. The requested family always beats
borrowed geometry, and the minimum score stops a few broadly similar sites from supplying a rare
section to most pages. Profile outliers never anchor a page or count as their site's language. A
missing or malformed profile file degrades to same-site and uniform sampling rather than failing a
run. Saved deck entries record `site` and `role`; the anchor also carries a one-line `style`
summary. Older decks parse unchanged. Details are in [DESIGN-REFERENCES.md](./DESIGN-REFERENCES.md).

Brand derives the language from the anchor and at most two same-site references instead of the
whole deck, and every phase is told that the anchor sets type, palette, radii, spacing, controls
and surfaces while other references give composition only. Review then audits the generated source
and adds bounded, non-fatal findings for fonts outside the brand and radius drift
([DESIGN-AGENT.md](./DESIGN-AGENT.md)). The audit is a Review finding rather than a hard source
gate because Build and Repair get one correction each, so a false positive must never fail a run.

_Rejected:_ narrowing by style tags (the catalogs carry almost none), drawing every section from
the anchor site only (most sites lack some families, which would shrink the deck), a uniform
draw per family (the source of the mixed-language pages), the anchor site's compatible family
before a close site's own family (it put other section types into a third of FAQ slots), and
similar sites with no minimum score or only half the maximum (a few broadly similar sites then
supplied a rare section, such as the library's only stats section, to a third or more of pages).

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
| 2026-10-20 | Removed direct API connections; a user's own key runs through OpenCode's sign-in.                                                                                              |
| 2026-10-16 | Sent user-initiated feedback to the team's Trecko inbox through the local server; the inbox key stays in the server process and out of git.                                    |
| 2026-10-16 | Parked dashboard references behind `DASHBOARD_REFERENCES_ENABLED`; dashboard requests build as websites and the 42 MB dashboard set left the package.                          |
| 2026-10-14 | Read cold newest history pages from the end of the event log, checked against a derived per-thread index of first turn and item rows (#957).                                   |
| 2026-10-14 | Seeded checkpoint snapshots from the checkout's own index so a turn start re-reads only changed files instead of hashing every tracked file.                                   |
| 2026-10-14 | Kept a provider's "unavailable" limits answer for 30 minutes through usage updates, so Claude's minute-long transcript scan no longer reruns after every turn.                 |
| 2026-10-12 | Sample website references from one anchor site, then similar profiled sites, to keep one design language per page; prefer dashboards matching the requested domain.            |
| 2026-10-11 | Paged thread history by whole turns over the cached compact replay instead of sending the full replay on every open; a store-level reader for cold opens remains (#957).       |
| 2026-10-04 | Added nightly dashboard references and image-capability preflight; Windows gates passed. Live-vision and packaged acceptance remain separate.                                  |
| 2026-10-04 | Canonicalized checkpoint Git storage with native filesystem paths so Windows long/8.3 aliases retain the combined refs of linked worktrees (#1404).                            |
| 2026-10-03 | Trust exact WebSocket origins only; keep isolated checkouts and pasted files out of the OS temp folder; bind pull-request reviews and merges to the inspected head commit.     |
| 2026-10-03 | Removed every provider except Codex, Claude Code and Grok from `main`; the rest, including the direct API runtime, live only on `nightly`.                                     |
| 2026-10-03 | Find desktop updates through the release feed, resume interrupted downloads, keep background failures quiet, and check again after the machine wakes.                          |
| 2026-09-30 | Batch large completed-code token rendering and inherit repeated foregrounds without reducing the source workload; enforce the frame budget against native renderer traces.     |
| 2026-09-22 | Select desktop releases by semantic version, preventing a later-published older platform proof from hiding the current release.                                                |
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
| 2026-09-18 | Added the beta 7 updater bridge and verified EXE/DMG transport, with two public assets from beta 8 and native installers retained.                                             |
| 2026-09-26 | Scanned one-byte copies of Latin-1 lines in every Shiki grammar pass, including the main-thread diff views.                                                                    |
| 2026-09-26 | Kept inline tool images out of Codex tool text and imported tool calls; the transcript never shows tool attachments.                                                           |
| 2026-09-26 | Let provider history reads skip turns already stored locally; the server drops their echoes anyway.                                                                            |
| 2026-09-26 | Cached usage-limit reads, skipped repeated turn diffs, bounded search-indexed tool output and disk replay snapshots, and folded completed deltas during compaction.            |
| 2026-09-26 | Loaded the desktop release updater as a lazy chunk and kept background throttling for browser guests.                                                                          |
| 2026-10-11 | Kept closed activity rows from building their detail and gated a collapsed 300-call activity's heap locally.                                                                   |
| 2026-10-11 | Ended a closed terminal's foreground job after a grace period, and a shell ignoring SIGHUP; background jobs stay.                                                              |
| 2026-10-14 | Background writing reads only the model sources its choice needs, caches each source separately, and reuses Grok's sign-in `grok models` output for its model list.            |
| 2026-10-19 | Made Claude Code's newest Haiku at medium the automatic background model, ahead of Codex Luna, which moved from low to medium effort.                                          |
| 2026-10-22 | Added phone access: a Noise IK link on the LAN or a tailnet, one-time pairing codes, a phone method allowlist, `projects.changed`, and the Expo + SwiftUI phone app.           |
| 2026-10-22 | Phone app screens moved from React-composed Expo UI to one SwiftUI hierarchy in Swift; TypeScript words the content and sends changed rows only.                               |
| 2026-10-23 | Each chat's setup moved from every client's own storage to the server (`thread.settings`); the desktop shares its hidden models.                                               |
| 2026-10-25 | Claude Code can also run through `claude -p` (stream-json, same protocol); engines declare `capabilities.runtimes`, the server keeps the choice.                               |
