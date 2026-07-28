# Documentation

Everything here is planning. There is no application code yet.

**Nine documents. Keep it that way** — add to the right one rather than creating a tenth.

| Document | What's in it |
| --- | --- |
| [VISION](./VISION.md) | What we're building, the three bets, non-goals |
| [FEATURES](./FEATURES.md) | v1 scope, UX principles, the quality bar |
| [ROADMAP](./ROADMAP.md) | Milestones M0–M8, landing page, license, mobile, open questions |
| [ARCHITECTURE](./ARCHITECTURE.md) | How it's built and why — stack, adapters, storage, chat performance |
| [PROVIDERS](./PROVIDERS.md) | ⚠️ The credential rules, who we support, how we drive each engine |
| [DESIGN-AGENT](./DESIGN-AGENT.md) | The TasteSkill runtime — our differentiator |
| [RESEARCH](./RESEARCH.md) | The competitive field, dissected |
| [WORKFLOW](./WORKFLOW.md) | How we work: branches, commits, reviews, cross-platform rules |

Plus [AGENTS.md](../AGENTS.md) at the root — instructions for coding agents working here.

**New to the project?** Read VISION → WORKFLOW → ROADMAP, in that order.

---

## The five things to know if you read nothing else

1. **We spawn vendor CLIs; we never reuse their subscription credentials.** Anthropic
   restricted subscription OAuth to first-party products in March 2026, with server-side
   enforcement. This shapes the entire auth design.
   ([PROVIDERS §1](./PROVIDERS.md#1-the-rule))
2. **A local server owns all state; every client is thin.** That is what makes web and
   mobile possible later without a rewrite.
   ([ARCHITECTURE §1](./ARCHITECTURE.md#1-shape-of-the-system))
3. **Windows is the strategy, not a constraint.** The best competitor is macOS-only, the
   good open-source one is deprecated, and the kanban one's company shut down.
   ([RESEARCH](./RESEARCH.md))
4. **Nobody in the category competes on design output quality.** That is the TasteSkill
   wedge. ([DESIGN-AGENT](./DESIGN-AGENT.md))
5. **Small commits, short branches, both operating systems green before merge.**
   ([WORKFLOW](./WORKFLOW.md))
