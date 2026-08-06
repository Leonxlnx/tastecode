# UI handoff

State of the chat surface, the invariants that hold it together, and what is still open.
Written after the 2026-08-06 overnight session (PRs #298–#367, 73 merged) so the next
session can pick the work up without re-deriving any of it.

## Scope

**This document covers UI, UX and features.** The design agent and the taste/skill rules
are worked on separately — see `DESIGN-AGENT.md`. Everything in that workflow is
implemented except replacing the explicit judgment prompts with TasteSkill v2.

Fixing a security or lifecycle bug that happens to live in `packages/design-agent` is
still in scope here. The boundary is feature work and judgment rules, not the files.

## What the overnight session changed

Grouped by intent rather than by PR, because the PR numbers only matter when reading
`git log`.

**The asks that started it.** Full versioned model names with no "Automatic" entries
anywhere (#298). Provider structure — Codex, Claude Code, Grok, Cursor, OpenCode as the
main row, Pi, Kimi, Qwen, Gemini below — with per-source model visibility (#304). Six
background palettes and a translucent sidebar with a strength slider (#305). A File /
Edit / View / Help menu bar (#306). A real GitHub update check that also works for a
private repo, falling back to `git ls-remote` with the user's own credentials (#307–#309).
Guided sign-in: the harness runs the provider CLI in a pty, reads the OAuth URL out of
its output and opens it, leaving the terminal as a fallback (#310). Chat export as
Markdown and a shortcuts dialog (#312). Harness-managed MCP servers reaching real
OpenCode sessions (#313).

**How the chat feels.** Word reveal ran with zero stagger, so every word that arrived in
one frame faded in at the same instant — a provider stall followed by a burst read as a
freeze and then a flash (#357). The per-delta reduce scanned the whole transcript to find
its target, which is why long sessions degraded (#357). The app root re-rendered the
sidebar, composer and header on every streamed frame (#358). The working label fell back
to a generic "Working" between tool calls and remounted each time, so a read/search/edit
sequence strobed (#357).

**Things that jumped or flashed.** The find bar and "Jump to latest" were absolutely
positioned inside the scroll container, so Ctrl+F yanked the transcript to the top and
the jump button rendered below the viewport (#347). The copy row appeared only on
completion and was in normal flow, so the transcript jumped 32px the instant a stream
ended (#356). No `scrollbar-gutter` anywhere, so the centred chat column shifted sideways
the first time a session outgrew the viewport (#356). Four CSS custom properties were
referenced and defined nowhere, silently dropping those declarations — most visibly the
context-usage ring, which had no transition at all (#356). The sidebar drawer's height cap
was double its real row height, so half of every open/close animation moved nothing (#356).

**States that left the user guessing.** Stop sent the interrupt and changed nothing until
the server reported the turn over, so on a slow provider it looked dead and got pressed
repeatedly — it now acknowledges itself and refuses repeat presses (#355). A dropped
connection was completely silent (#355). Session search showed "Searching…" from the first
keystroke, before the debounce fired any request (#355).

**Security.** Any web page could drive the local agent over WebSocket, because browsers
exempt WebSocket from the same-origin policy (#350, #353). Design Mode let the model
choose a preview command and ran it with no approval, after earlier phases had read the
project's README and sources (#353). `shell.openExternal` accepted any URL scheme,
including ones agents and vendors supply (#331).

**Data integrity.** `removeWorktree` deleted the checkout whenever git refused, but git's
most common refusal is that the checkout still holds uncommitted work (#361). A
connection blip could freeze a thread permanently or leave it truncated after reconnect
(#365). Removing a project stranded its isolated sessions' worktrees with no path left to
reach them (#366).

## Invariants — do not break these

The three that live elsewhere because they apply beyond the UI:

- **The per-delta path is the critical path.** See `AGENTS.md`.
- **Loopback is not a trust boundary, and `null` is the attacker's origin.** See
  `rules/security.md`.
- **Unstable callback identity in an effect dependency list is an infinite loop.** See
  `AGENTS.md` — this one cost ~170 leaked processes once.

The rest, specific to this surface:

**Overlays live outside the scroll container.** An absolutely positioned child of a
scroller scrolls away with the content. `.thread-shell` exists solely to be the
positioning context for the find bar and the jump button.

**Reserve space for anything that appears on completion.** `.reply` carries a
`padding-bottom` and its action row is absolute. An element that only renders when a turn
finishes, in normal flow, is a visible jump at the worst possible moment.

**`scrollbar-gutter: stable` on every scroller that centres its content.** Otherwise the
column moves sideways the first time it overflows.

**Programmatic scrolls are tracked by position, not by a flag.** `writtenScrollTop` holds
the value we wrote; a one-shot boolean gets out of step when the browser coalesces two
scroll events and then swallows a real user gesture.

**Every `var()` must resolve.** An unresolvable custom property inside a shorthand
invalidates the entire declaration, silently. `--ease-out`, `--dur-fast`, `--dur-slow`,
`--shadow-flyout`, `--surface-*`, `--text-*` are real; `--ease-in-out`, `--dur-med`,
`--shadow-lg`, `--text-4`, `--surface-1` are not.

**`memo()` without stable props is a no-op.** An inline arrow in the parent fails the
shallow compare every render. `Composer` has stable handlers; `Sidebar` and `StageHeader`
do not yet, and their comments say so.

**Modal sheets own the keyboard.** While Settings or the shortcuts dialog is open, global
shortcuts do not fire, focus moves into the dialog, and Escape closes it.

**localStorage reads are guarded like writes.** With site data blocked, merely touching
`localStorage` throws — and most reads run inside `useState` initializers on first render.
Use `readSetting` / `writeSetting` / `removeSetting` in `App.tsx`, `readStored` in
`theme.ts`.

**The working rail mounts once per turn.** It renders outside the virtualized rows —
translated to the first response row's offset, over space that row's padding reserves —
because a rail rendered inside a `Row` unmounts at the first token and whenever the row
leaves the overscan window, restarting the orb (#371). It is also deliberately not keyed
by turn id: the optimistic id is replaced by the server's mid-turn.

**Kills we cause are marked, and they go through `killTree`.** On Windows `taskkill`
reports exit code 1, so an unmarked intentional kill looks like a crash — that wrote a
phantom `claude exited with code 1` into the transcript on every Stop. And `child.kill()`
only ends the `cmd.exe` shim, leaving the real process holding file locks.

## Open work

Ordered by how much a user would notice.

**1. `Sidebar` and `StageHeader` memoization is inert.** The owner passes a dozen inline
arrows plus a fresh `inbox` object and `usageSources` array. Mechanical to fix with
`useCallback` / `useMemo` in `App.tsx`, but it touches a lot of call sites at once.

**2. Queue state is not refetched after a reconnect.** `resync` in `App.tsx` reloads
history and projects; missed `thread.queue` pushes are the one category it does not
repair, so `queuedTurns` stays stale until the user switches sessions.

**3. Server-side delta coalescing.** Every `item.delta` gets its own SQLite transaction
and WebSocket frame. Not catastrophic — `synchronous = NORMAL` avoids the fsync — but it
is hundreds of transactions and frames per second on a token-granularity provider, on the
path before the client sees anything. Buffer per item and flush on a ~16ms timer or on any
non-delta event; replay semantics are unchanged because deltas concatenate.

**4. Shiki re-tokenizes a growing code block every frame.** Completed blocks are memoized
by content, so only the in-progress one is affected — but that is a full TextMate pass over
the whole block, on the JavaScript regex engine (the CSP forbids WASM), 60 times a second.
Re-tokenize from the last complete line and reuse the cached prefix.

**5. No ping/pong heartbeat.** A half-open TCP connection produces no write error, so it
sits in the push bus indefinitely with pushes buffering in memory. The one case the
"a failed write closes the connection" rule does not cover.

**6. `historyBuffers` has a latent concurrency hazard.** Two overlapping `loadHistory`
calls for the same thread share one buffer entry and the earlier `finally` deletes it.
Not currently reachable — every caller is serialized by other guards — but it is one new
call site away from being real.

Deliberately not changing:

- **Grok and Pi stay "Planned" rows.** No dockable CLI exists. Do not build a facade.
- **Skills stay Codex-only.** There is no OSS interface for them. MCP is real for OpenCode.
- **Diff review decisions are keyed by a digest of the content they annotate.** This is
  what makes an "accepted" badge disappear when the agent edits that file again. Keying by
  path would tell the user they had reviewed content they never saw.

## Working here

`pnpm dev` brings up server (`127.0.0.1:4311`), Vite (`127.0.0.1:5183`) and Electron.
Gates before every PR: `pnpm exec prettier --write`, `pnpm typecheck`, the affected
package's `vitest run`, `pnpm lint`. Contracts changes ship as their own PR first.

Verify UI changes in the running app, not only in tests — computed styles through the
browser tools caught several things the tests could not see (whether a gutter is actually
reserved, whether focus really moved into a dialog, whether the overlay really sits
outside the scroller).

Tests written _before_ the fix repeatedly found bugs in the fix. Three of the overnight
regressions were caught that way, and every later verification pass found something in the
work that preceded it. Assume your own last change is the most likely source of the next
bug.
