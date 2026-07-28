# ADR-0006 — License and the path to open source

- **Status:** Proposed — needs a human decision before the repo goes public
- **Date:** 2026-07-28

## Context

The plan is: build privately, ship a landing page, then open source and scale. The license
determines who can take the work and what they can do with it, and it is effectively
irreversible once contributors arrive (relicensing requires every contributor's consent).

Category precedent, all permissive:

| Project | License |
| --- | --- |
| T3 Code | MIT |
| OpenCode | MIT |
| Codex CLI | Apache-2.0 |
| Crystal (before deprecation) | MIT |
| Nimbalyst | open source, free for individuals |

## Recommendation: **Apache-2.0**

Permissive like MIT — matching category norms and maximising adoption — but with two things
MIT lacks:

1. **An express patent grant.** Contributors grant patent rights; anyone who sues over
   patents loses their license. For a project two people will hand to strangers, this is
   meaningful protection at zero adoption cost.
2. **A trademark clause.** The code is free; the *name* is not automatically. If the product
   name comes to mean something, Apache-2.0 lets us keep it while the code stays open.

Pair it with a **CLA or DCO** so that a future relicense or dual-license remains possible.
DCO (a `Signed-off-by` line) is lighter-weight and less hostile to contributors; a CLA gives
more flexibility. **Recommendation: DCO.** In this community a CLA reads as a warning sign,
and we are not planning to relicense.

## Considered and not recommended

**MIT** — Maximum familiarity, shortest text, what T3 Code and OpenCode chose. Perfectly
defensible; pick it if you want zero friction and do not care about patents or the name.
The only real argument against is that it gives away slightly more than necessary.

**AGPL-3.0** — The network-copyleft "anti-cloud-giant shield": run a modified version as a
service and you must publish your modifications. Tempting if we ever fear someone hosting our
harness commercially.

Rejected for now because it does not fit this product:
- We are a **local-first desktop app**. The SaaS threat AGPL defends against barely applies.
- AGPL is banned by policy at many companies, so it would block adoption by exactly the
  professional developers we want.
- The historical evidence is weak: MongoDB found AGPL insufficient against AWS and moved to
  SSPL anyway.
- It complicates the future in which someone wants to embed our adapter packages.

**Source-available (BSL/SSPL/Fair Source)** — Costs us the "open source" label, fragments
goodwill, and buys protection against a threat we do not face. No.

**Dual license (AGPL + commercial)** — The standard open-core business model. Only relevant
if there is a commercial plan. There is not one yet, so deciding this now would be deciding
the business model by accident.

## Open questions for the humans

1. **Is there a commercial intent?** If the answer is ever "maybe a paid cloud/team tier,"
   say so now — it changes the license, the CLA choice, and how we structure packages. If
   the answer is "no, this is a gift," Apache-2.0 or MIT and move on.
2. **Do we want the product name protected?** If yes → Apache-2.0 plus a trademark policy
   file. If indifferent → MIT is fine.
3. **What is public at launch?** Recommendation: everything except the landing page's
   analytics config and any signing credentials. A half-open repo reads as bad faith.

## Pre-open-sourcing checklist

Before flipping the repo to public:

- [ ] Git history scanned for secrets (`gitleaks` over full history, not just HEAD)
- [ ] `LICENSE`, `NOTICE`, and per-file headers if Apache-2.0
- [ ] `CONTRIBUTING.md` with DCO instructions and the working rules
- [ ] `CODE_OF_CONDUCT.md`
- [ ] `SECURITY.md` with a disclosure address — we handle credentials, this is not optional
- [ ] Third-party license audit (`license-checker`) — no GPL surprises in the dependency tree
- [ ] Issue and PR templates
- [ ] README that a stranger can follow to a running build on Windows *and* macOS
- [ ] Landing page live (see [`docs/06-landing`](../06-landing/landing-page-plan.md))
- [ ] Signed installers published for both platforms — an unsigned first release makes a
      terrible first impression on Windows

## Consequences

- The `LICENSE` file is added at the moment of the decision, not at open-sourcing. Every
  commit made before it is licensed by default (i.e. not at all), which is fine while
  private and two-person, but the decision should not be left until launch week.
- If Apache-2.0: CI enforces license headers on new source files.
