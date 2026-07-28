# Personal Harness

> Working title. A beautiful, adaptive control panel for AI coding agents.
> Windows-first, cross-platform, built around a design agent with real taste.

**Status: planning. No application code yet.**

---

## What this is

Every serious coding agent ships as a terminal program: Claude Code, Codex, Cursor,
OpenCode, Gemini CLI, Grok Build. Powerful engines, ugly clients — each with its own auth,
its own config, its own session model.

Personal Harness is the layer above them. One window. Every agent. Every subscription you
already pay for, plus your own API keys. Threads that stay instant at 500 messages. Diffs
you actually want to read. And a design agent that produces work you would ship.

## Docs

| | |
| --- | --- |
| [VISION](./docs/VISION.md) | What we're building and why |
| [FEATURES](./docs/FEATURES.md) | Every feature, as a list |
| [ROADMAP](./docs/ROADMAP.md) | M0–M8 and the open questions |
| [ARCHITECTURE](./docs/ARCHITECTURE.md) | How it's built, and what we rejected |
| [DESIGN-AGENT](./docs/DESIGN-AGENT.md) | The differentiator *(written at M4)* |

## Rules

Read these before your first commit.

| | |
| --- | --- |
| [rules/git](./rules/git.md) | Branches, commits, PRs, CI |
| [rules/code](./rules/code.md) | Cross-platform, style, decisions |
| [rules/security](./rules/security.md) | ⚠️ Credentials — the one that gets people banned |

## Team

Two people. One Windows developer, one macOS developer. Every decision assumes both
platforms are first-class and that nobody has to leave their OS to review a change.

## License

Undecided while private. Apache-2.0 proposed — see
[ROADMAP → M7](./docs/ROADMAP.md#m7--open-source). Intended to be open sourced.
