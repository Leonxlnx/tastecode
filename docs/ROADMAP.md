# Roadmap

Planned 2026-07-28. Every feature from [FEATURES.md](./FEATURES.md) lands in one of these.
Order matters; dates do not.

**Rule: every milestone ends with something we actually use ourselves.**

---

### M0 — Skeleton ✅

Monorepo, CI on Windows + macOS, hardened Electron shell, wire protocol, core server.
**First adapter: Codex app-server.** Thread UI, prompt bar, onboarding with real
browser sign-in.
→ _A real agent turn streams into a window._ **Done.**

Shipped beyond the original plan, because building it demanded them: real vendor OAuth
(the URL opens on the vendor's site and they report completion), live model and reasoning
-effort lists read from the provider, permission modes mapped onto Codex's approval
policy and sandbox, attachments, git branch and diff in the context chip, rename/pin/
search in the rail, and settings.

Deferred out of M0 rather than done: the SQLite event log. Projects and sessions live in
localStorage until the server takes ownership in M2 — it was not needed to prove the pipe
works, and building it before the UI shape settled would have meant building it twice.

**Still open and not blocked by code:** Windows code-signing paperwork. Weeks of lead
time, blocks M6. See [open questions](#open-questions).

### M1 — The thread ✅

Virtualised list, streaming markdown, syntax highlighting, all item types,
collapse/expand, turn navigation, in-thread search, interrupt, steer. Performance
budgets in CI.
→ _We prefer it to the terminal for reading agent output._ **Done.**

Brought forward from M3: **approval cards**. Without them the safest permission
mode declined every command, so `Ask first` was unusable — the mode most people
should be running was the one that did not work.

Also shipped beyond plan, because the data was already arriving and we were
discarding it: the agent's plan for the turn, the turn-level diff, live token
spend, command duration and exit codes, and streaming reasoning and command
output.

### M2 — Many agents, many sessions

ACP adapter (unlocks ~25 engines), Claude Code adapter, session manager, worktrees,
checkpoints, provider setup wizard, cost accounting.
→ _Three agents on three worktrees in one repo, no confusion._

Done so far: **Claude Code adapter**, **ACP adapter**, and the provider registry
underneath both. Adding an engine is now a case in one file rather than a change
to session handling, and ACP means one integration covers Gemini, Kimi, Qwen and
anything else that adopts the protocol.

Both adapters were written against frames captured from the running binaries.
For ACP that mattered twice: the published schema names the update discriminator
differently from the wire, and a permissioned tool call is described only in the
permission request — a unit test written from the docs passed while the real
thing was broken.

Still open in M2: session manager, worktrees, checkpoints, cost accounting, and
the server taking ownership of projects and sessions from localStorage.

### M3 — Review & control

Diff review with per-hunk accept/reject, mode indicator, panic stop, terminal pane,
MCP management, Agent Skills, cross-session search. _(Approval cards landed early
in M1.)_
→ _We let an agent run autonomously and feel fine about it._

### M4 — Design agent

TasteSkill integrated, preview pane, screenshot + critique loop, direction gallery, token
editor, reference board. **Blocked on TasteSkill v2 being ready.**
→ _It builds our own landing page. If it can't, it isn't done._

### M5 — Visual pass

Full design system, every screen redesigned, empty/loading/error states, both themes,
density modes, keybindings, command palette, onboarding, brand and icon.
→ _A screenshot is convincing with no explanation._

### M6 — Ship Windows

Code signing, NSIS installer, no SmartScreen warning, macOS notarization, auto-update with
rollback, crash reporting, clean-VM install test, landing page, docs.
→ _Clean Windows VM → first agent response in under five minutes._

### M7 — Open source

Secret scan over full history, LICENSE (Apache-2.0 proposed), SECURITY.md,
CODE_OF_CONDUCT, CONTRIBUTING, templates, dependency license audit. Launch: GitHub release
→ Show HN → Reddit → X.
→ _Public, with signed installers and the landing page already live. Never announce into an
empty repo._

### M8 — Mobile

Expo app reusing the same protocol. Session list, push notifications, read, approve, steer,
diff review, voice. Connection over Tailscale/LAN first — a relay only later, opt-in, and
end-to-end encrypted.
→ _Approve a diff from your phone._

---

## Who does what

|                 |                                                                                      |
| --------------- | ------------------------------------------------------------------------------------ |
| **Claude**      | M0–M3 implementation, adapters, tests, docs                                          |
| **Windows dev** | Signing, installer, updater (starts M0 — long lead time), Windows QA every milestone |
| **macOS dev**   | Notarization, macOS QA, second reviewer                                              |
| **Both**        | Design review at every milestone, direction choice for M4 + M5                       |

---

## Open questions — need a human answer

1. **Windows code-signing eligibility.** Azure Trusted Signing needs a US/Canada entity, or
   an individual there with 3+ years of verifiable business history. If neither of us
   qualifies → cloud EV certificate instead. **Blocks M6, weeks of lead time, resolve during
   M0.**
2. **Product name + domain.** Blocks M5 and M6.
3. **Any commercial intent, ever?** Decides the license, and it's irreversible once outside
   contributors arrive.
4. **When is TasteSkill v2 ready?** Only M4 depends on it.
5. **Web / self-host surface at launch?** Nearly free architecturally, but doubles the
   support and security surface.
