<img src="apps/desktop/assets/tastecode-icon.png" alt="TasteCode" width="96" />

# TasteCode

> A beautiful, adaptive control panel for AI coding agents.
> Windows-first, cross-platform, built around a design agent with real taste.

**Status: M0 complete.** Runs, drives a real Codex session, and is nowhere near finished.
See the [roadmap](./docs/ROADMAP.md).

---

## What this is

Every good agent client is locked to one vendor. The Claude app runs Claude, the Codex app
runs Codex, Cursor runs Cursor — and none of them will ever run the others. The moment you
use two, you are back to three windows with three histories and nothing shared.

TasteCode is the layer above them. One window. Every agent. Every subscription you
already pay for, plus your own API keys. Threads that stay instant at 500 messages. Diffs
you actually want to read. And a design agent that produces work you would ship.

## Running it

Needs Node 22+, pnpm, and at least one agent CLI on your PATH. Today that means
[Codex](https://developers.openai.com/codex); others land in M2.

```bash
pnpm install
pnpm dev
```

That starts the core server, the renderer and the desktop shell together. Sign in from
inside the app — it opens the vendor's own page in your browser.

## What works today

Codex sessions with streaming output · real browser sign-in and plan detection · live
model and reasoning-effort lists from the provider · permission modes (ask / auto / full)
· file attachments · git branch and diff in the prompt bar · project and session rename,
pin and search.

## Docs

|                                        |                                        |
| -------------------------------------- | -------------------------------------- |
| [VISION](./docs/VISION.md)             | What we're building and why            |
| [FEATURES](./docs/FEATURES.md)         | Every feature, as a list               |
| [ROADMAP](./docs/ROADMAP.md)           | M0–M7 and the open questions           |
| [ARCHITECTURE](./docs/ARCHITECTURE.md) | How it's built, and what we rejected   |
| [PROVIDERS](./docs/PROVIDERS.md)       | Agent and direct API integration plan  |
| [DESIGN-AGENT](./docs/DESIGN-AGENT.md) | The differentiator _(written at M4)_   |
| [UI-HANDOFF](./docs/UI-HANDOFF.md)     | Chat surface: invariants and open work |
| [CREDITS](./CREDITS.md)                | Contributors and project references    |
| [LICENSING](./docs/LICENSING.md)       | License status and release checklist   |

## Layout

```
apps/
  desktop    Electron shell + the one narrow native bridge
  web        The interface
  server     Core server: orchestration, adapters, git
packages/
  contracts  Wire protocol. Single source of truth for every client
  adapter-*  One package per agent. Codex today
```

## Rules

Read these before your first commit.

|                                       |                                                  |
| ------------------------------------- | ------------------------------------------------ |
| [rules/git](./rules/git.md)           | Branches, commits, PRs, CI                       |
| [rules/code](./rules/code.md)         | Cross-platform, style, decisions                 |
| [rules/security](./rules/security.md) | ⚠️ Credentials — the one that gets people banned |

## Team

Two people. One Windows developer, one macOS developer. Every decision assumes both
platforms are first-class and that nobody has to leave their OS to review a change.

Questions and beta feedback: [hello@tasteskill.dev](mailto:hello@tasteskill.dev).

## License

Undecided while private. Apache-2.0 proposed — see
[LICENSING](./docs/LICENSING.md). Intended to be open sourced.
