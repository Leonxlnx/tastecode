# Roadmap

Planning date: **2026-07-28**. Durations are ranges for a two-person team plus an agent,
working alongside other commitments. They will be wrong; the sequence is what matters.

The ordering principle: **every milestone ends with something we can use ourselves.** No
milestone is pure infrastructure. If we cannot dogfood it, we cannot tell whether it is good.

---

## M0 — Skeleton that talks to one agent
**Goal: a window that runs a real Codex turn and shows streaming output.**

- Monorepo scaffold: pnpm workspaces, Turbo, TS strict, lint/format, CI on Windows + macOS
- Electron shell, hardened from the first commit (context isolation, sandbox, CSP, typed
  contextBridge)
- `packages/contracts` — the wire protocol and schemas
- Core server: WebSocket transport, ordered push bus, connection state machine
- **Adapter #1: Codex app-server** — the richest protocol, so it forces the domain model to
  be right rather than lowest-common-denominator
- Minimal thread UI: send a message, stream a response, render items
- SQLite event log + read model

**Exit:** we can run a real task end to end. Ugly is fine. Slow is not.

**Risks to hit early, on purpose:** native module builds (`better-sqlite3`, `node-pty`) on
both platforms, and Electron packaging. These break late and expensively if deferred.

---

## M1 — The thread is genuinely fast and pleasant
**Goal: the chat experience that justifies the whole project.**

- 1,000-message fixture thread committed as a performance test bed
- TanStack Virtual with `anchorTo: 'end'`, follow-on-append, prepend-stable history
- Streamdown + Shiki in a worker, two-phase code block rendering
- Item types rendered properly: reasoning, commands, file changes, plans, errors
- Collapse/expand, turn navigation, in-thread search
- Interrupt and steer
- Performance budgets wired into CI

**Exit:** the 1,000-message thread scrolls at 60fps and opens in under 150ms, and we both
prefer this to the terminal for reading agent output.

---

## M2 — Multi-agent and multi-session
**Goal: the orchestration table stakes.**

- Adapter #2: **ACP** — unlocks the long tail in one package
- Adapter #3: **Claude Code** via headless stream-json, with contract tests against the real
  binary and a version range
- Session manager: many concurrent sessions, per-project
- Git worktree isolation, one click, with safe cleanup
- Checkpoints on turn boundaries; restore
- Provider setup wizard: detect CLIs, guide install, never touch their credentials
- Cost and token accounting

**Exit:** three agents on three worktrees in one repo, simultaneously, without confusion.

---

## M3 — Review, approvals, and control
**Goal: safe to run autonomously.**

- Diff review: per-file, per-hunk, accept/reject, word-level highlighting
- Approval cards with scoped permissions (once / session / pattern / always)
- Mode indicator and global panic stop
- Terminal pane (`node-pty` / ConPTY)
- MCP server management
- Agent Skills browsing and per-project enablement
- Cross-session full-text search (FTS5)

**Exit:** we let an agent run autonomously on a real repo and feel comfortable doing it.

---

## M4 — The design agent
**Goal: the differentiator ships.**

- TasteSkill v2 integrated as a skill package (**dependency: authored externally by the team**)
- Headless render + multi-viewport screenshot (bundled Playwright)
- Multimodal critique loop: render → screenshot → rubric → revise
- Live preview pane with hot reload
- Direction gallery (three real thumbnails, not three paragraphs)
- Design token editor
- Reference board for target and anti-reference images
- Blind evaluation set (~20 briefs) with baseline comparison

**Exit:** a landing page produced by the agent that we would actually ship — and the eval
scores to back it up. **We use it to build our own marketing site.** If it cannot make our
landing page, it is not ready.

---

## M5 — The visual pass
**Goal: it stops looking like a dev build.**

- Full design system: tokens, type scale, palette, motion spec, elevation
- Every screen redesigned against it, including empty, loading, and error states
- Light and dark, both first-class
- Density modes, keybinding presets, command palette
- Onboarding and first-run flow as a designed surface
- Icon, brand, installer art

**Exit:** a screenshot of the app is convincing on its own, with no explanation.

---

## M6 — Ship Windows
**Goal: a stranger installs it and it works.**

- Windows code signing (Azure Trusted Signing, or a cloud EV certificate — see open
  questions) and an NSIS installer with no SmartScreen warning
- macOS signing + notarization
- Auto-update with staged rollout, and a tested rollback path
- Crash reporting (opt-in) and a diagnostics bundle for support
- Clean-VM install test on both platforms as a release gate
- Landing page live ([`docs/06-landing`](../06-landing/landing-page-plan.md))
- Docs: install, setup per provider, troubleshooting

**Exit:** clean Windows VM → first agent response in under five minutes.

---

## M7 — Open source
See the checklist in [ADR-0006](../02-decisions/ADR-0006-license-and-open-sourcing.md).
Full-history secret scan, LICENSE, SECURITY.md, CONTRIBUTING, templates, third-party license
audit. Announce with the landing page and signed installers already live — never announce
into an empty repo.

---

## M8 — Mobile remote control
See [`docs/07-mobile/mobile-plan.md`](../07-mobile/mobile-plan.md). The server-core
architecture is what makes this a client rather than a rewrite.

---

## Parallelization

The two humans and the agent are not serialized. Rough split:

- **Agent:** M0–M3 implementation, adapters, tests, docs.
- **Windows dev:** owns M6 signing/installer/update from M0 onward (it has long lead times
  — certificates and business verification take weeks, so start the paperwork during M0),
  plus Windows QA on every milestone.
- **macOS dev:** owns notarization, macOS QA, and second-reviewer duty.
- **Both:** design review at every milestone, and direction selection for M4/M5.

## Open questions that need human answers

Ordered by how soon they block something.

1. **Azure Trusted Signing eligibility.** It requires a US/Canada entity or an individual in
   the US/Canada with 3+ years of verifiable business history. If neither of us qualifies, we
   need a cloud-hosted EV certificate instead — different cost, different lead time.
   **This blocks M6 and has a multi-week lead time. Resolve during M0.**
2. **Product name and domain.** Blocks M5 (brand) and M6 (landing page). Renaming the repo is
   trivial; renaming after launch is not.
3. **Commercial intent — ever?** Determines the license and CLA choice in ADR-0006, and it is
   effectively irreversible once outside contributors arrive.
4. **TasteSkill v2 delivery date.** M4 depends on it. Everything before M4 is independent, so
   this is not urgent — but M4 cannot start without it.
5. **Do we want a web/self-host surface at launch?** Nearly free given the architecture, but
   it doubles the support surface and the security thinking.
