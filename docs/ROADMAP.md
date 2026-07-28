# Roadmap

Planned 2026-07-28. Every feature from [FEATURES.md](./FEATURES.md) lands in one of these.
Order matters; dates do not.

**Rule: every milestone ends with something we actually use ourselves.**

---

### M0 — Skeleton
Monorepo, CI on Windows + macOS, hardened Electron shell, wire protocol, core server,
SQLite event log. **First adapter: Codex app-server.** Minimal thread UI.
→ *A real agent turn streams into a window.*

Hit the painful things now: native modules (`better-sqlite3`, `node-pty`) and Electron
packaging on both OSes. Start Windows code-signing paperwork — it has weeks of lead time.

### M1 — The thread
Virtualized list, streaming markdown, syntax highlighting, all item types, collapse/expand,
turn navigation, in-thread search, interrupt, steer. Performance budgets in CI.
→ *We prefer it to the terminal for reading agent output.*

### M2 — Many agents, many sessions
ACP adapter (unlocks ~25 engines), Claude Code adapter, session manager, worktrees,
checkpoints, provider setup wizard, cost accounting.
→ *Three agents on three worktrees in one repo, no confusion.*

### M3 — Review & control
Diff review with per-hunk accept/reject, approval cards, mode indicator, panic stop,
terminal pane, MCP management, Agent Skills, cross-session search.
→ *We let an agent run autonomously and feel fine about it.*

### M4 — Design agent
TasteSkill integrated, preview pane, screenshot + critique loop, direction gallery, token
editor, reference board. **Blocked on TasteSkill v2 being ready.**
→ *It builds our own landing page. If it can't, it isn't done.*

### M5 — Visual pass
Full design system, every screen redesigned, empty/loading/error states, both themes,
density modes, keybindings, command palette, onboarding, brand and icon.
→ *A screenshot is convincing with no explanation.*

### M6 — Ship Windows
Code signing, NSIS installer, no SmartScreen warning, macOS notarization, auto-update with
rollback, crash reporting, clean-VM install test, landing page, docs.
→ *Clean Windows VM → first agent response in under five minutes.*

### M7 — Open source
Secret scan over full history, LICENSE (Apache-2.0 proposed), SECURITY.md,
CODE_OF_CONDUCT, CONTRIBUTING, templates, dependency license audit. Launch: GitHub release
→ Show HN → Reddit → X.
→ *Public, with signed installers and the landing page already live. Never announce into an
empty repo.*

### M8 — Mobile
Expo app reusing the same protocol. Session list, push notifications, read, approve, steer,
diff review, voice. Connection over Tailscale/LAN first — a relay only later, opt-in, and
end-to-end encrypted.
→ *Approve a diff from your phone.*

---

## Who does what

| | |
| --- | --- |
| **Claude** | M0–M3 implementation, adapters, tests, docs |
| **Windows dev** | Signing, installer, updater (starts M0 — long lead time), Windows QA every milestone |
| **macOS dev** | Notarization, macOS QA, second reviewer |
| **Both** | Design review at every milestone, direction choice for M4 + M5 |

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
