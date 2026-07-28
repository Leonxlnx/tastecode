# Roadmap

Planning date: **2026-07-28**. Durations are ranges for a two-person team plus an agent
working alongside other commitments. They will be wrong; the sequence is what matters.

**Ordering principle: every milestone ends with something we can use ourselves.** No
milestone is pure infrastructure. If we cannot dogfood it, we cannot tell whether it is good.

| | Milestone | Ends when |
| --- | --- | --- |
| **M0** | [Skeleton that talks to one agent](#m0--skeleton-that-talks-to-one-agent) | A real Codex turn streams into a window |
| **M1** | [The thread is fast and pleasant](#m1--the-thread-is-fast-and-pleasant) | We prefer it to the terminal for reading agent output |
| **M2** | [Multi-agent and multi-session](#m2--multi-agent-and-multi-session) | Three agents, three worktrees, one repo, no confusion |
| **M3** | [Review, approvals, control](#m3--review-approvals-and-control) | We let an agent run autonomously and feel fine about it |
| **M4** | [The design agent](#m4--the-design-agent) | It builds our own landing page |
| **M5** | [The visual pass](#m5--the-visual-pass) | A screenshot is convincing with no explanation |
| **M6** | [Ship Windows](#m6--ship-windows) | Clean VM → first agent response in under five minutes |
| **M7** | [Open source](#m7--open-source) | Repo public, signed installers and landing page already live |
| **M8** | [Mobile remote control](#m8--mobile-remote-control) | Approve a diff from your phone |

---

## M0 — Skeleton that talks to one agent

- Monorepo scaffold: pnpm workspaces, Turbo, TS strict, lint/format, CI on Windows + macOS
- Electron shell, hardened from the first commit (context isolation, sandbox, CSP, typed
  contextBridge)
- `packages/contracts` — the wire protocol and schemas
- Core server: WebSocket transport, ordered push bus, connection state machine
- **Adapter #1: Codex app-server** — the richest protocol, so it forces the domain model to
  be right rather than lowest-common-denominator
- Minimal thread UI: send a message, stream a response, render items
- SQLite event log + read model

Ugly is fine. Slow is not.

**Risks to hit early, on purpose:** native module builds (`better-sqlite3`, `node-pty`) on
both platforms, and Electron packaging. These break late and expensively if deferred.

**Also starts here:** Windows code-signing paperwork. It has a multi-week lead time and
blocks M6. See [open questions](#open-questions).

---

## M1 — The thread is fast and pleasant

The chat experience that justifies the whole project.

- 1,000-message fixture thread committed as a performance test bed
- TanStack Virtual with `anchorTo: 'end'`, follow-on-append, prepend-stable history
- Streamdown + Shiki in a worker, two-phase code block rendering
- Item types rendered properly: reasoning, commands, file changes, plans, errors
- Collapse/expand, turn navigation, in-thread search
- Interrupt and steer
- Performance budgets wired into CI

**Exit:** the 1,000-message thread scrolls at 60fps and opens in under 150ms.

---

## M2 — Multi-agent and multi-session

The orchestration table stakes.

- Adapter #2: **ACP** — unlocks the long tail in one package
- Adapter #3: **Claude Code** via headless stream-json, with contract tests against the real
  binary and a declared version range
- Session manager: many concurrent sessions per project
- Git worktree isolation, one click, with safe cleanup
- Checkpoints on turn boundaries; restore
- Provider setup wizard: detect CLIs, guide install, never touch their credentials
- Cost and token accounting

---

## M3 — Review, approvals, and control

Safe to run autonomously.

- Diff review: per-file, per-hunk, accept/reject, word-level highlighting
- Approval cards with scoped permissions (once / session / pattern / always)
- Mode indicator and global panic stop
- Terminal pane (`node-pty` / ConPTY)
- MCP server management
- Agent Skills browsing and per-project enablement
- Cross-session full-text search (FTS5)

---

## M4 — The design agent

The differentiator ships. Full spec: [DESIGN-AGENT.md](./DESIGN-AGENT.md).

- TasteSkill v2 integrated as a skill package — **dependency: authored externally by the team**
- Headless render + multi-viewport screenshot (bundled Playwright)
- Multimodal critique loop: render → screenshot → rubric → revise
- Live preview pane with hot reload
- Direction gallery (three real thumbnails, not three paragraphs)
- Design token editor
- Reference board for target and anti-reference images
- Blind evaluation set (~20 briefs) with baseline comparison

**Exit:** a landing page produced by the agent that we would actually ship, with eval scores
to back it up. **We use it to build our own marketing site.** If it cannot make our landing
page, it is not ready.

---

## M5 — The visual pass

It stops looking like a dev build.

- Full design system: tokens, type scale, palette, motion spec, elevation
- Every screen redesigned against it, including empty, loading and error states
- Light and dark, both first-class
- Density modes, keybinding presets, command palette
- Onboarding and first-run flow as a designed surface
- Icon, brand, installer art

---

## M6 — Ship Windows

### The build

- Windows code signing (Azure Trusted Signing, or a cloud EV certificate — see open
  questions) and an NSIS installer with no SmartScreen warning
- macOS signing + notarization
- Auto-update with staged rollout and a tested rollback path
- Crash reporting (opt-in) and a diagnostics bundle for support
- Clean-VM install test on both platforms as a release gate
- Docs: install, setup per provider, troubleshooting

### The landing page

Ships **before** open-sourcing. It is the artifact that decides whether the launch lands.

**The meta-point: the landing page for a product whose differentiator is a design agent must
be built by that design agent.** It is the proof and the demo in one artifact — and the real
acceptance test for M4.

Positioning, to be sharpened:

> **Every coding agent you pay for, in one window that was actually designed.**

Three supporting claims, in priority order:

1. **Bring everything.** Claude, Codex, Cursor, Kimi, GLM, Grok, OpenRouter, local models —
   your subscriptions and your keys, together for the first time.
2. **Built for Windows first.** The honest gap in the market. Say it plainly; the audience
   that needs to hear it has been ignored by every competitor.
3. **A design agent with taste.** Show the output, do not describe it.

Plus the trust line, which is a genuine differentiator and reads as confidence:

> **Your credentials never touch us.** We ask your tools to work; we never ask for your
> passwords. Nothing leaves your machine.

**Structure**

1. **Hero** — one sentence, one action, and *the app itself*: a real screenshot or short
   loop of a real session, taken on Windows. Not an abstract illustration.
2. **The problem** — brief and concrete. Six terminals, five logins, one unreadable
   scrollback.
3. **The provider wall** — every logo, with what each gives you. This section does more
   sales work than any copy on the page; the reaction we want is "wait, it does *my*
   provider?"
4. **The thread** — a demo of a 500-message thread scrolling at 60fps. Speed must be *felt*;
   a bullet point claiming it is worthless.
5. **The design agent** — before/after. Generic AI landing page on the left, TasteSkill
   output on the right. The most persuasive thing we can show, and it needs no words.
6. **Trust** — credentials, local-first, open source. Short.
7. **Download** — Windows first in the list, macOS beside it. Signed, with version and size.
8. **Footer** — GitHub, docs, changelog.

Deliberately absent: fake testimonials, invented logos, a pricing table for a free product,
a newsletter modal, "trusted by 10,000 developers."

**Technical:** static, prerendered (Astro or Next static export), zero client JS above the
fold, self-hosted fonts, no third-party requests, no cookie banner because no cookies.
Lighthouse 100 on performance and accessibility — a slow landing page for a product that
sells speed is self-refuting. Lives in the monorepo as `apps/marketing` so screenshots and
copy stay in sync with the product. Previews on every PR so design review is a link.
Analytics privacy-preserving and self-hostable, or none; ad-tech would contradict the
"nothing leaves your machine" promise.

**Assets:** Windows screenshots in both themes at 2x (highest-leverage asset), a 20–30s
screen recording with no narration, the design-agent before/after pair, logo, wordmark,
favicon, OG image, and signed installers published before the page goes live.

---

## M7 — Open source

### License — proposed, needs a human decision

Category precedent is uniformly permissive: T3 Code MIT, OpenCode MIT, Codex CLI Apache-2.0,
Crystal MIT.

**Recommendation: Apache-2.0.** Permissive like MIT — matching norms, maximising adoption —
with two things MIT lacks: an **express patent grant** (contributors grant patent rights;
anyone suing over patents loses their license), and a **trademark clause** (the code is free,
the name is not automatically). Pair it with **DCO** rather than a CLA — a `Signed-off-by`
line is lighter-weight, and in this community a CLA reads as a warning sign.

Considered and not recommended:

- **MIT** — maximum familiarity, what T3 Code and OpenCode chose. Perfectly defensible; pick
  it if you want zero friction and do not care about patents or the name.
- **AGPL-3.0** — the network-copyleft "anti-cloud-giant shield." Rejected: we are a
  local-first desktop app, so the SaaS threat barely applies; AGPL is banned by policy at
  many companies, blocking exactly the professional developers we want; and the evidence is
  weak anyway — MongoDB found AGPL insufficient against AWS and moved to SSPL.
- **Source-available (BSL/SSPL/Fair Source)** — costs the "open source" label, fragments
  goodwill, buys protection against a threat we do not face.
- **Dual license (AGPL + commercial)** — only relevant if there is a commercial plan.
  Deciding it now would be deciding the business model by accident.

**Note:** every commit made before a `LICENSE` file exists is licensed by default, i.e. not
at all. Fine while private and two-person, but do not leave this to launch week.

### Pre-public checklist

- [ ] Git history scanned for secrets (`gitleaks` over full history, not just HEAD)
- [ ] `LICENSE`, `NOTICE`, per-file headers if Apache-2.0
- [ ] `CONTRIBUTING.md` with DCO instructions
- [ ] `CODE_OF_CONDUCT.md`
- [ ] `SECURITY.md` with a disclosure address — we handle credentials, this is not optional
- [ ] Third-party license audit — no GPL surprises in the dependency tree
- [ ] Issue and PR templates
- [ ] README a stranger can follow to a running build on Windows *and* macOS
- [ ] Landing page live
- [ ] Signed installers published for both platforms

### Launch channels

Order matters; each primes the next.

1. GitHub release with signed installers
2. Hacker News ("Show HN") — the Windows gap is the angle, not the AI
3. r/LocalLLaMA, r/ClaudeAI, r/ChatGPTCoding — the provider-aggregation angle
4. X/Twitter with the design-agent before/after as the lead image
5. Ask Theo/T3 for a look — T3 Code is adjacent, not identical, and the category benefits
   from more than one good client. Genuinely, not as a growth hack.

**Never announce into an empty repo.**

---

## M8 — Mobile remote control

Post-v1. Documented so the architecture does not preclude it. No mobile work happens before
the desktop app is good.

### The use case

Not "code on your phone." Nobody wants that. The real one:

> You start a long task at your desk. You leave. The agent finishes, or gets stuck on an
> approval, or asks a question. You handle it from your phone in thirty seconds instead of
> the task sitting dead for four hours.

Mobile is for **monitoring, approving, reviewing, and steering.** Read the diff, tap
approve, send a one-line correction, get a push notification when it finishes. Full
authoring stays on the desktop.

### Why it is a client, not a rewrite

The server-core design in [ARCHITECTURE.md §1](./ARCHITECTURE.md#1-shape-of-the-system)
already puts all state behind a typed WebSocket protocol. Mobile is another client sharing
`packages/contracts`. That is the entire reason that design was chosen.

### The hard part is the connection, not the app

| Approach | How | Trade-off |
| --- | --- | --- |
| **Overlay network** (Tailscale/WireGuard) | Phone and desktop join a private network, direct connection | Best privacy, no infrastructure for us, requires user setup. T3 Code ships a `tailscale` package — same conclusion. |
| **Relay server** | Both ends connect out to a relay we host; traffic end-to-end encrypted | Best UX by far, but we operate infrastructure — uncomfortable against "nothing leaves your machine" unless the E2E encryption is real, audited and explained. Happy Coder does this openly. |
| **Direct / LAN + SSH tunnel** | Same network, or user-managed tunnel | Zero infrastructure, works today for advanced users, useless outside the house. |

**Recommendation:** overlay-network and LAN first — no infrastructure, no new trust claims,
satisfies power users. Treat a relay as a later, opt-in, clearly-explained convenience with
genuine end-to-end encryption. **Shipping a relay first would quietly break the strongest
promise on our landing page.**

### App stack

**Expo / React Native** — reuses `packages/contracts` and the domain types verbatim, one
codebase for iOS and Android, over-the-air updates, and neither of us wants to learn Swift
and Kotlin while also shipping a desktop app.

The UI is **not** a port of the desktop layout. Mobile gets its own information architecture:
session list with live status, a thread view optimized for reading, a diff view built for a
narrow screen, an approval sheet, and a composer with voice input. Everything else is
deliberately absent.

Note that virtualization and streaming markdown need re-solving — TanStack Virtual and
Streamdown are DOM-bound. Budget real time; do not assume the web solution transfers.

### Feature order

1. Session list with live status, push notifications on turn completion / approval needed
2. Read a thread
3. Approve or deny, with the command and directory clearly shown
4. Send a message / steer
5. Review a diff, accept or reject
6. Start a new session from a template
7. Voice input — genuinely good on mobile, and Omnara has validated demand

### Security

Higher stakes than desktop: a stolen phone must not equal a shell on the developer's machine.

- Device pairing with explicit approval on the desktop, a visible device list, revocation
- Biometric unlock, required
- Approval decisions authorize arbitrary command execution — no "approve all" from mobile,
  and a short session timeout
- End-to-end encryption if a relay is ever used, with key material never touching the relay

### Prior art to study

**Happy Coder** (open source, E2E encrypted, iOS/Android/web — the closest reference
implementation of the relay model) · **Omnara** (monitor, review diffs, approve; two-way
voice appears to be a genuine draw) · **Anthropic's own Remote Control** (sets the baseline
expectation) · **Nimbalyst iOS** · **T3 Code** (`apps/mobile` plus `packages/tailscale` and
`packages/ssh`).

---

## Parallelization

The two humans and the agent are not serialized.

- **Agent:** M0–M3 implementation, adapters, tests, docs.
- **Windows dev:** owns M6 signing/installer/update from M0 onward — certificates and
  business verification take weeks, so start the paperwork during M0 — plus Windows QA on
  every milestone.
- **macOS dev:** owns notarization, macOS QA, second-reviewer duty.
- **Both:** design review at every milestone, direction selection for M4 and M5.

---

## Open questions

Ordered by how soon they block something.

1. **Azure Trusted Signing eligibility.** Requires a US/Canada entity, or an individual in
   the US/Canada with 3+ years of verifiable business history. If neither of us qualifies we
   need a cloud-hosted EV certificate instead — different cost, different lead time.
   **Blocks M6, multi-week lead time, resolve during M0.**
2. **Product name and domain.** Blocks M5 (brand) and M6 (landing page). Renaming the repo
   is trivial; renaming after launch is not.
3. **Commercial intent — ever?** Determines the license and CLA choice, and it is
   effectively irreversible once outside contributors arrive. If the answer is ever "maybe a
   paid cloud or team tier," say so now.
4. **TasteSkill v2 delivery date.** M4 depends on it. Everything before M4 is independent, so
   this is not urgent — but M4 cannot start without it.
5. **Do we want a web / self-host surface at launch?** Nearly free given the architecture,
   but it doubles the support surface and the security thinking.
