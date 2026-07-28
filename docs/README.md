# Documentation

Everything here is planning. There is no application code yet.

**Read in this order if you are new:**

1. [Vision](./00-vision.md) — what we are building and why
2. [Working rules](./05-team/working-rules.md) — how we work; read before your first commit
3. [Roadmap](./04-plan/roadmap.md) — the sequence and the open questions

## Research

Field research with sources. Each file carries a "last verified" date because this space
moves monthly.

- [Competitive landscape](./01-research/competitive-landscape.md) — T3 Code dissected, the
  rest of the field, and why Windows is the opening
- [Agent CLI protocols](./01-research/agent-cli-protocols.md) — how to drive every engine:
  Codex app-server, ACP, headless CLIs, and the extension standards
- [Provider & subscription matrix](./01-research/provider-subscription-matrix.md) — who we
  support, how, and the rules we must not break
- [UI performance](./01-research/ui-performance.md) — making 200+ message threads instant

## Decisions (ADRs)

Immutable once merged. To change a decision, write a new ADR that supersedes it.

- [ADR-0001 — Desktop shell: Electron, not Tauri](./02-decisions/ADR-0001-desktop-shell.md)
- [ADR-0002 — Core architecture and stack](./02-decisions/ADR-0002-architecture-and-stack.md)
- [ADR-0003 — Agent adapter layer and domain model](./02-decisions/ADR-0003-agent-adapter-layer.md)
- [ADR-0004 — Storage, checkpoints, and search](./02-decisions/ADR-0004-storage-and-search.md)
- [ADR-0005 — Credentials, provider terms, trust boundary](./02-decisions/ADR-0005-credentials-and-policy.md) ⚠️ **compliance-critical**
- [ADR-0006 — License and open sourcing](./02-decisions/ADR-0006-license-and-open-sourcing.md) *(proposed — needs a human decision)*

## Product

- [Product spec — v1](./03-product/product-spec.md)
- [Design agent (TasteSkill runtime)](./03-product/design-agent-spec.md)
- [UX principles](./03-product/ux-principles.md)

## Plan

- [Roadmap](./04-plan/roadmap.md)
- [Landing page plan](./06-landing/landing-page-plan.md)
- [Mobile remote control plan](./07-mobile/mobile-plan.md)

## Team

- [Working rules](./05-team/working-rules.md)

---

## The five things to know if you read nothing else

1. **We spawn vendor CLIs; we never reuse their subscription credentials.** Anthropic
   restricted subscription OAuth to first-party products in March 2026, with server-side
   enforcement. This shapes the entire auth design. ([ADR-0005](./02-decisions/ADR-0005-credentials-and-policy.md))
2. **A local server owns all state; every client is thin.** That is what makes web and
   mobile possible later without a rewrite. ([ADR-0002](./02-decisions/ADR-0002-architecture-and-stack.md))
3. **Windows is the strategy, not a constraint.** The best competitor is macOS-only, the
   good open-source one is deprecated, and the kanban one's company shut down.
   ([competitive landscape](./01-research/competitive-landscape.md))
4. **Nobody in the category competes on design output quality.** That is the TasteSkill
   wedge. ([design agent spec](./03-product/design-agent-spec.md))
5. **Small commits, short branches, both operating systems green before merge.**
   ([working rules](./05-team/working-rules.md))
