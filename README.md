# Personal Harness

> Working title. A beautiful, adaptive control panel for AI coding agents.
> Windows-first, cross-platform, and built around a design agent with real taste.

**Status: planning. No application code yet.** This repository currently holds research,
architecture decisions, and the build plan. See [`docs/`](./docs).

---

## What this is

Every serious coding agent today ships as a terminal program: Claude Code, Codex CLI,
Cursor CLI, OpenCode, Gemini CLI, Grok Build. They are powerful and ugly, and each one
locks you into its own session model, its own auth, its own config.

Personal Harness is the layer above them. One window. Every agent. Every subscription
you already pay for, plus your own API keys. Threads that load instantly at 500 messages.
Diffs you actually want to read. And a design agent that produces work you would ship,
not work that looks like it came out of a model.

We are not building another model wrapper. We are building the client the agents deserve.

## The three bets

1. **Aggregation.** Bring your own subscription *and* your own key — Claude, ChatGPT/Codex,
   Cursor, Kimi, GLM, Grok, OpenRouter, local models. The harness adapts to what you have.
2. **Craft.** The UI is the product. Speed, motion, typography, and density are features,
   not decoration. A 200-message thread must feel like a 5-message thread.
3. **Taste.** A first-class design agent (the *TasteSkill* system) that makes landing pages,
   portfolios, and product UI at a level ordinary agents cannot reach.

## Platforms

| Surface | Status |
| --- | --- |
| Windows desktop | Primary target, ships first |
| macOS desktop | Parity target, same codebase |
| Linux desktop | Best-effort |
| Mobile (remote control) | Planned after desktop v1 |
| Web / self-host | Falls out of the architecture |

## Team

Two people. One Windows developer, one macOS developer. Every decision in this repo assumes
both platforms are first-class and that no one has to leave their OS to review a change.

Read [WORKFLOW.md](./docs/WORKFLOW.md) before your first commit.

## Docs

| | |
| --- | --- |
| [VISION](./docs/VISION.md) | What we're building, the three bets, non-goals |
| [FEATURES](./docs/FEATURES.md) | v1 scope, UX principles, the quality bar |
| [ROADMAP](./docs/ROADMAP.md) | Milestones, landing page, license, mobile, open questions |
| [ARCHITECTURE](./docs/ARCHITECTURE.md) | How it's built and why — stack, adapters, storage, performance |
| [PROVIDERS](./docs/PROVIDERS.md) | Credential rules, supported providers, engine protocols |
| [DESIGN-AGENT](./docs/DESIGN-AGENT.md) | The TasteSkill runtime |
| [RESEARCH](./docs/RESEARCH.md) | The competitive field, dissected |
| [WORKFLOW](./docs/WORKFLOW.md) | Branches, commits, reviews, cross-platform rules |

## License

Undecided while private. Apache-2.0 is proposed — see
[ROADMAP → M7](./docs/ROADMAP.md#m7--open-source). The project is intended to be open
sourced.
