# Mobile remote control — plan

**Status: post-v1.** Documented now so the architecture does not preclude it. No mobile work
happens before the desktop app is good.

---

## The use case

Not "code on your phone." Nobody wants that. The real one:

> You start a long task at your desk. You leave. The agent finishes, or gets stuck on an
> approval, or asks a question. You handle it from your phone in thirty seconds instead of
> the task sitting dead for four hours.

Concretely, the mobile app is for: **monitoring, approving, reviewing, and steering.** Read
the diff, tap approve, send a one-line correction, get a push notification when it finishes.
Full authoring stays on the desktop.

## Why the architecture already supports it

[ADR-0002](../02-decisions/ADR-0002-architecture-and-stack.md) puts all state and
orchestration in a local server behind a typed WebSocket protocol. The desktop renderer is
already just a client. Mobile is **another client of the same server**, sharing
`packages/contracts`. That is the entire reason the server-core design was chosen, and it is
why this document can be short.

## The hard part is not the app — it is the connection

Getting a phone on cellular to a laptop behind NAT is the whole problem. Three approaches,
and the field has already sorted itself:

| Approach | How | Trade-off |
| --- | --- | --- |
| **Overlay network** (Tailscale/WireGuard) | Phone and desktop join a private network; direct connection | Best privacy, no infrastructure for us, requires the user to set up Tailscale. T3 Code ships a `tailscale` package — they reached the same conclusion. |
| **Relay server** | Both ends connect out to a relay we host; traffic is end-to-end encrypted so the relay sees ciphertext | Best UX by far, but we operate infrastructure — which sits uncomfortably against the "nothing leaves your machine" promise unless the E2E encryption is real, audited, and explained. Happy Coder does this openly and is a good model to study. |
| **Direct / LAN + SSH tunnel** | Same network, or user-managed tunnel | Zero infrastructure, works today for advanced users, useless outside the house. |

**Recommendation:** ship overlay-network and LAN first (no infrastructure, no new trust
claims, satisfies power users), and treat a relay as a later, opt-in, clearly-explained
convenience with genuine end-to-end encryption. Shipping a relay first would quietly break
the strongest promise on our landing page.

## App stack

**Expo / React Native.** Reasons: reuses `packages/contracts` and the domain types verbatim;
one codebase for iOS and Android; over-the-air updates; and neither of us wants to learn
Swift and Kotlin while also shipping a desktop app.

The UI is **not** a port of the desktop layout. Mobile gets its own information architecture:
a session list with live status, a thread view optimized for reading, a diff view built for a
narrow screen, an approval sheet, and a composer with voice input. Everything else is
deliberately absent.

Note that virtualization and streaming markdown need re-solving on React Native —
TanStack Virtual and Streamdown are DOM-bound. Budget real time for it; do not assume the
web solution transfers.

## Features, in order

1. Session list with live status, and push notifications on turn completion / approval needed
2. Read a thread
3. Approve or deny, with the command and directory clearly shown
4. Send a message / steer
5. Review a diff, accept or reject
6. Start a new session from a template
7. Voice input — genuinely good on mobile, and Omnara has validated demand for it

## Security

Higher stakes than desktop: a stolen phone must not equal a shell on the developer's
machine.

- Device pairing with explicit approval on the desktop, and a visible device list with
  revocation
- Biometric unlock, required
- Approval decisions are the highest-privilege action in the product — they authorize
  arbitrary command execution. Treat them accordingly: no "approve all" from mobile, and a
  short session timeout.
- End-to-end encryption if a relay is ever used, with the key material never touching the
  relay

## Prior art worth studying

- **Happy Coder** — open source, E2E encrypted, iOS/Android/web, free. The closest thing to
  a reference implementation of the relay model.
- **Omnara** — Claude Code and Codex from your phone; monitor, review diffs, approve.
  Notable for two-way voice coding, which appears to be a genuine draw.
- **Anthropic's own Remote Control** — first-party mobile Claude Code. Sets the baseline
  expectation and confirms the use case is real.
- **Nimbalyst iOS** — kanban, visual diffs, voice, push notifications, multi-agent.
- **T3 Code** — `apps/mobile` plus `packages/tailscale` and `packages/ssh` in the monorepo.

## Sources

- [Happy — Remote Control for Claude Code & Codex](https://happy.engineering/)
- [Omnara](https://remote.omnara.com/)
- [Anthropic just released a mobile version of Claude Code called Remote Control](https://venturebeat.com/orchestration/anthropic-just-released-a-mobile-version-of-claude-code-called-remote)
- [Best Apps to Control Coding Agents from Mobile (2026 Update)](https://codeongrass.com/blog/best-app-to-control-coding-agents-from-mobile/)
