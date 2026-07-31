# Handoff

Written 2026-07-31 for whoever picks this up next — most likely a Codex agent with fresh
context. Read [AGENTS.md](./AGENTS.md) first for the rules; this is the state of play.

---

## What this is

**Personal Harness** — a Windows-first desktop control panel that drives every AI coding
agent CLI from one window. Electron + React, everything local.

The point is **not** that agent UIs are ugly. They are fine. The point is that each one
locks you into its vendor: Claude Code only runs Claude, Codex only runs Codex, and the
subscriptions you already pay for cannot be used side by side. This app drives all of them
through one interface, and the sessions live in one place.

Read [docs/VISION.md](./docs/VISION.md) before proposing anything that changes what the
product is.

### The team

| Who                   | Machine | Owns                                                |
| --------------------- | ------- | --------------------------------------------------- |
| **Leon** (`Leonxlnx`) | Windows | Product direction, design review, Windows specifics |
| **Blueemi**           | macOS   | UI implementation, macOS specifics                  |
| **The agent**         | —       | Server, adapters, protocol, tests                   |

Both humans decide design together. Neither overrules the other. See
[rules/working-together.md](./rules/working-together.md).

---

## Where the project stands

**M0 done. M1 done. M2 done. Its GitHub milestone closed with all 9 issues complete.**

### M0 — Skeleton ✅

Monorepo, CI on Windows and macOS, hardened Electron shell, wire protocol, core server,
first adapter (Codex), thread view, onboarding with real vendor OAuth.

### M1 — The thread ✅

Virtualised list, streaming markdown, syntax highlighting, collapse/expand, turn
navigation, in-thread search, interrupt, steer, approval cards, performance budgets
enforced in CI.

### M2 — Many agents, many sessions ✅

Done, all of it verified against real agents rather than mocks:

- **Claude Code adapter** — headless NDJSON, typed by hand from captured output
- **ACP adapter** — one integration covering Gemini CLI, Kimi CLI, Qwen Code
- **Provider registry** — adding an engine is a case in one file
- **Server owns projects, sessions and their event log** — a session survives a reload,
  a crash, and a restart
- **Several sessions run at once** without blocking or cross-wiring
- **Private git worktree per session** — two agents in one repository are safe, not merely
  concurrent
- **Rollback** — files and conversation together, from a checkpoint taken before each turn
- **Session switcher and parallel status** — running, attention and failed sessions remain
  visible while another session is open
- **Worktree controls** — a new session can request isolation, its branch is visible, and
  uncommitted work requires explicit confirmation before discard
- **Reachable rollback** — checkpoint history lists the exact files that would change and
  a completed restore can itself be undone
- **Persistent Codex/Claude usage** — per-session and per-day totals come from SQLite;
  Claude cost is shown only when Claude reports it, while Codex subscriptions show real
  rate-limit headroom from the Codex binary. ACP agents do not currently emit usage.

The final interface PRs were [#37](https://github.com/Leonxlnx/personalharness/pull/37)
(rollback), [#43](https://github.com/Leonxlnx/personalharness/pull/43) (isolated checkout
controls) and [#44](https://github.com/Leonxlnx/personalharness/pull/44) (usage). All were
rebase-merged after local gates and green Windows/macOS CI.

---

## Layout

```
apps/
  desktop/      Electron main + preload. Hardened; see below.
  server/       The core. Owns all state. Clients are thin renderers.
  web/          React renderer. Talks to the server over WebSocket.
packages/
  contracts/    Zod schemas for every wire message. The single source of truth.
  proc/         spawnCli, readNdjson, StdioJsonRpc — shared by all adapters.
  adapter-codex/        Tier 1: JSON-RPC app-server, generated TS bindings.
  adapter-claude-code/  Tier 3: headless NDJSON, hand-typed.
  adapter-acp/          Any agent speaking the Agent Client Protocol.
rules/          How we work. Read these.
docs/           Vision, architecture, roadmap, features.
```

### The server, file by file

| File              | What it does                                                                 |
| ----------------- | ---------------------------------------------------------------------------- |
| `server.ts`       | WebSocket server, request routing, schema validation                         |
| `orchestrator.ts` | Owns every live session. Worktrees, checkpoints, event recording.            |
| `adapters.ts`     | Provider registry. `providerRuntime(provider)` → a runnable session.         |
| `store.ts`        | SQLite. Projects, threads, event log, checkpoints. **Migrations live here.** |
| `worktree.ts`     | Private git checkouts. Refuses rather than forces.                           |
| `checkpoint.ts`   | Snapshots and rollback. Never touches the user's index.                      |
| `providers.ts`    | What is actually installed on this machine.                                  |
| `push-bus.ts`     | Broadcast to connected clients, with a monotonic sequence.                   |
| `workspace.ts`    | Branch and diff size for the context chip.                                   |

---

## How it fits together

```
renderer  ──WebSocket──>  server  ──>  orchestrator  ──>  adapter  ──stdio──>  vendor CLI
                            │              │
                            │              └──> store (SQLite: events, checkpoints)
                            └──> push bus ──> every connected client
```

**Everything is an event.** An adapter translates whatever its vendor emits into
`DomainEvent`, the orchestrator writes it to the log **and then** broadcasts it. That order
matters: a client reconnecting mid-turn replays from the log, so an event that went out but
was never recorded is one it can never get back.

**Capabilities, not guesses.** Each adapter reports `{steer, fork, interrupt,
reasoningItems, approvals, images}`. The UI hides what is unavailable rather than showing a
button that fails. This is why the model picker disappears for Claude Code.

**The renderer holds no durable state.** It caches what the server says. Everything
persists in SQLite under the platform's per-user data directory.

---

## Running it

```bash
pnpm install
pnpm dev          # server + vite + electron, all three
```

Other commands:

```bash
pnpm build        # every package
pnpm typecheck    # every package
pnpm test         # 170 tests
pnpm lint         # prettier --check
pnpm format       # prettier --write
```

`HARNESS_DATA_DIR` overrides where the database lives — use it for throwaway runs rather
than polluting real data.

**Do not run a `.sh` script.** Windows + macOS team; tooling is Node/TypeScript only.

---

## Traps

Every one of these cost hours. They are not preferences.

**TypeScript is pinned to 5.9.3.** 7.x cannot resolve `@types/node` under pnpm.
Reproduced minimally before pinning. Do not "upgrade" it.

**Use `127.0.0.1`, never `localhost`.** On Windows `localhost` resolves to IPv6 first,
Vite binds IPv4, and Electron gets a blank window with no error.

**Shiki runs the JavaScript regex engine, not WASM.** Our CSP blocks `wasm-unsafe-eval`.
Do not weaken the CSP to fix a highlighting problem — switch engines instead. The
highlighter is fully synchronous on purpose: Streamdown caches per block, so an async
callback resolves with a partial fence and the block stays broken forever.

**Windows CLI shims are `.cmd` files.** `spawn('claude')` fails with EINVAL. Use
`spawnCli` from `@harness/proc`, which routes through `cmd.exe`.

**`packages/contracts` is shared.** A change there breaks three clients at once. It ships
as its own PR, reviewed by both humans, before anyone builds against it.

**`CREATE TABLE IF NOT EXISTS` never adds a column.** New columns go in `ADDED_COLUMNS` in
`store.ts` **as well as** the schema. Forgetting this breaks the app only for people who
used it before the change — invisible in development, because a fresh database always has
every column.

**Adapters are written against captured frames, not published schemas.** When a protocol
and its documentation disagree, the wire wins. Two real examples: ACP's update
discriminator is `sessionUpdate`, not `type`; and a permissioned tool call is described
**only** in the permission request, never in an update — a unit test written from the docs
passed while the real thing was broken.

---

## Rules that are not negotiable

Full text in [rules/](./rules/). The ones that matter most:

**Never read, copy, or forward a vendor credential.** Not from
`~/.claude/.credentials.json`, not `~/.codex/auth.json`, not a keyring, not "just to check
whether they are signed in". We spawn the vendor's binary and let it authenticate itself.
This is a compliance requirement, not a style preference. See
[rules/security.md](./rules/security.md).

**Nothing leaves the machine.** No prompt, no path, no key, no source code goes to any
server we control. Ever.

**BYOK keys live in the OS credential store** — never in SQLite, a config file, or a log.
They reach child processes by environment, never argv.

**Everything in the repo is English** — code, comments, commits, PRs, issues. The humans
chat in German and English; none of that reaches the repo.

**Many small commits, pushed after each one.** Draft PR from the first commit — that draft
is how the other two see which files you are in.

**One PR does one thing.** Never fold a design change into a PR about logic; the reviewer
would have to accept both or neither.

**Rebase-merge, never squash.** Squash is disabled in the ruleset. Every commit lands on
`main` individually and keeps its message, so write them clean.

---

## Testing philosophy

**170 tests.** They are not there for coverage.

- Adapters are tested against **frames captured from real binaries**, kept as fixtures.
- Worktrees and checkpoints are tested against **a real git repository** in a temp
  directory. Mocking git would test that we can spell its arguments, which is not what goes
  wrong.
- Concurrency is tested with **injected fake runtimes**, because the property being
  protected belongs to the orchestrator, not to any vendor.
- Performance budgets assert **cost ratios, not rendered row counts**. happy-dom gives
  every element zero size and has no ResizeObserver, so the virtualiser renders nothing;
  propping that up takes enough mocks that the test would measure the mocks.

**Verify against a real agent before claiming something works.** Every M2 feature was run
end to end, and each run found something the tests had not:

- Two Claude Code sessions writing the same file proved isolation held.
- A rollback restored the right contents but **staged** them — only visible in
  `git status`, not in the file.
- Pointing a new build at yesterday's database found the missing migration.

---

## Open decisions

These need a human. Do not decide them alone.

**Blueemi has five open PRs outside M2.** As of this handoff, each has green Windows and
macOS CI but still needs human review:

- [#38](https://github.com/Leonxlnx/personalharness/pull/38) adds only the pasted-image
  materialization contract.
- [#39](https://github.com/Leonxlnx/personalharness/pull/39) adds only auto-review
  contracts and compatibility guards. Its body says `Closes #20`, although the actual
  Codex/server/UI implementation is explicitly deferred; remove that closure before merge.
- [#40](https://github.com/Leonxlnx/personalharness/pull/40) adds only voice-dictation
  contracts. Recorder, permissions, server and transcription remain deferred.
- [#41](https://github.com/Leonxlnx/personalharness/pull/41) improves the responsive
  session sidebar. Its body still requires a mobile screenshot, but the PR is marked ready
  without one.
- [#42](https://github.com/Leonxlnx/personalharness/pull/42) removes the vendor-credential
  compliance rule. **Do not merge it.** It conflicts with the hard rule in `AGENTS.md` and
  `rules/security.md`; subscription credentials stay owned by vendor binaries.

The separate design-agent work is reserved on branch `feat/design-agent-v2`. Keep it out
of server session state, shared contracts and the M2 UI files that just landed.

**Blueemi cannot be made an admin.** This was attempted and it is not possible: the
repository is owned by a **personal account**, which supports only owner + collaborators
with push. GitHub's API accepts `permission=admin` and returns HTTP 204, then silently
ignores it — verified twice. Adding Blueemi to the branch ruleset's bypass list also fails,
because a personal repo has no role between "write" and "owner".

What Blueemi **can** already do: push branches, open PRs, approve Leon's PRs, and merge any
PR once approved. The only thing missing is bypassing review.

The real fix is **transferring the repo to a GitHub organization** — free, keeps history,
issues, PRs and stars, and redirects old URLs. It is also the better home before open
sourcing. Only Leon can do this: Settings → Danger Zone → Transfer.

**Windows code signing.** Weeks of lead time, blocks M6. Nobody has started it.

**Product name and domain.** Not decided. Affects the landing page and the org name if the
repo moves.

**TasteSkill v2.** M4 is blocked on it. Leon is authoring it separately.

---

## What I would do next

In order:

1. **Review Blueemi's split PRs.** #38–#41 are small and green, but contracts must land
   before their implementations. Fix #39's premature issue closure, require #41's promised
   screenshot, and reject #42 unless the compliance requirement itself changes outside
   this repository.

2. **Start M3 — Review & control.** Per-hunk diff accept/reject, mode indicator, panic stop,
   terminal pane, MCP management, Agent Skills, cross-session search. Its goal is "let an
   agent run autonomously and feel fine about it", which is exactly what isolation and
   rollback now provide. The milestone exists but has no issues yet.

3. **Design foundation, whenever Leon wants it.** `styles/tokens.css` already has a clear
   position: neutral greyscale, colour reserved for meaning, never decoration. Colours are
   fully tokenised — one raw hex left in the whole of `app.css`. **Spacing is not**: 321
   hardcoded px values and no scale. A spacing scale plus a light theme are pure CSS,
   collide with nobody, and everything later builds on them.

### M2 behavior worth preserving

**Usage:** do not show a currency figure unless the provider reports it. Claude's
`total_cost_usd` is real; Codex subscription users instead see provider-reported headroom.
The SQLite aggregation treats Codex updates as cumulative and Claude updates as per-turn.

**Rollback:** keep the changed-file inspection before confirmation and the one-time undo
afterwards. Removing either makes a technically correct restore unsafe to use.

---

## Protocol reference

30 methods, all validated against Zod schemas in `packages/contracts/src/protocol.ts`.

**System and providers**
`system.info` · `providers.list` · `models.list` · `acp.agents`

**Auth** — all of it delegated to the vendor's own binary
`auth.status` · `auth.startLogin` · `auth.cancelLogin` · `auth.useApiKey` · `auth.signOut`

**Projects**
`projects.list` · `projects.add` · `projects.rename` · `projects.remove` · `projects.pin`

**Sessions**
`thread.start` · `thread.sendTurn` · `thread.interrupt` · `thread.close` · `thread.rename` ·
`thread.delete` · `thread.history` · `thread.respondToApproval`

**Isolation and rollback**
`thread.checkpoints` · `thread.changedSince` · `thread.restore` · `thread.undoRestore` ·
`thread.unsavedWork` · `thread.discardWorktree`

**Usage**
`usage.summary`

**Workspace**
`workspace.info`

Push channels: `server.welcome`, `thread.event`, `auth.event`.

---

## Repository facts

- `main` is protected: PR required, **1 approval**, rebase-merge only, no force-push, no
  deletion. There is an admin bypass, which is how the agent has been merging. As of
  2026-07-30 the agreed position is to keep it until both humans push daily.
- CI runs `windows-latest` **and** `macos-latest`. Both must be green.
- Platform-specific code must be **run** on both, not just reviewed.
- Issues carry a milestone (M2, M3, M5) and an `area:` label.
- Close issues from the PR body with `Closes #N`, never by hand.
