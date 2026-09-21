# Skill usage audit — linux-release session (2026-09-20)

Task: audit `feat/linux-release-v1-current`, fix findings, rebuild/install beta.8, prep for second-PC install.
Installed skills on disk: 115 (`~/.agents/skills/`). Surfaced to coordinator: ~100 auto + INDEX.md injection via SessionStart hook.

## Verdict

Directly invoked: **5**. Materially applied via worker file-reads: **3**. Legit misses (should have used): **~10**. Everything else: correctly waived — wrong domain, trigger-gated, or duplicate coverage.

The pattern of misses matters more than the count: I used the **task-shaped** skills (review, audit) and skipped the **manner-of-work** skills (how to delegate, write, triage). Nothing in the loop forces those.

## Used — invoked as skills

| Skill          | When                   | Depth                                                                        | What it produced                                                                                                                                       |
| -------------- | ---------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ask-matt`     | session start, routing | INDEX.md + map.md read                                                       | routed the audit to `code-review` as the canonical flow                                                                                                |
| `code-review`  | audit phase            | SKILL.md read; protocol followed                                             | fixed point `origin/main`, spec found (`CLOUD-SESSION-PROMPT.md`), Standards+Spec parallel subagents, two-axis report                                  |
| `blast-radius` | audit phase            | SKILL.md + confidence-ladder + patterns + blast-radius-review read by worker | "one safety fact" report with executed-code proof (dist run, maintainer-script unpack)                                                                 |
| `unlazy`       | verification phase     | SKILL.md read                                                                | evidence re-verification discipline — provenance checked vs HEAD, acceptance re-run instead of trusting the report                                     |
| `principles`   | fix-planning phase     | pack invoked; principle names cited in worker briefs                         | boundary-discipline → port validation; type-system-discipline → PROTOCOL_VERSION; subtract-before-add → dead code; migrate-callers → URL consolidation |

Honest depth note: `principles` was applied as vocabulary in briefs — the 15 individual `principle-*` files were **not** each read. Correct per "load selectively", but not full-depth application.

## Applied without skill invocation (worker file-reads)

| Skill                         | How                                                     | Depth                                           |
| ----------------------------- | ------------------------------------------------------- | ----------------------------------------------- |
| `web-interface-guidelines`    | UI-review worker read rule files directly (aria, focus) | rules applied, produced 2 MEDIUM + LOW findings |
| `make-interfaces-feel-better` | UI-review worker per brief                              | hit-area/focus findings that became fixes       |
| `typescript-best-practices`   | cited by name in worker briefs                          | name-only, no file reads — weakest application  |

## Misses — should have been used

Ordered by how much they would have changed the work:

| Skill                                           | Why it applied                                                                                    | What was lost                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `unslop`                                        | AGENTS.md mandates it before user-facing output; it's in the curated `devin/skills` set           | My reports were denser than the contract allows                                    |
| `diagnosing-bugs`                               | Node 26 → 419-failure `localStorage` diagnosis was exactly its domain                             | I diagnosed correctly anyway, but skipped the skill's process                      |
| `triage`                                        | Converting 5 agents' findings → prioritized worker queue is a triage task                         | Ad-hoc prioritization instead of the skill's method                                |
| `implement`                                     | The fix phase (17 commits from spec-findings) is its literal use case                             | —                                                                                  |
| `tdd`                                           | Workers wrote tests alongside/after fixes, not red-first                                          | Weaker regression guarantees on some fixes                                         |
| `vitest`                                        | Workers wrote vitest tests without consulting the skill                                           | Possible convention drift in new tests                                             |
| `writing-for-agents`                            | 7 worker briefs written                                                                           | Briefs worked, but unverified against the skill's method                           |
| `better-accessibility` / `fixing-accessibility` | aria-label, focus-visible, hit-area fixes shipped                                                 | `web-interface-guidelines` covered most; these may have added WCAG-specific checks |
| `interface-review`                              | UI review was run via `web-interface-guidelines` instead                                          | Possibly the more specific tool for the job                                        |
| `performance`                                   | Ozone-relaunch fix is a startup-performance fix; it's in the curated set                          | No structured perf framing (minor)                                                 |
| `cua-driver`                                    | A polkit dialog sat waiting for the user; GUI automation could have detected/handled window state | Manual wait instead                                                                |
| `resolving-merge-conflicts`                     | Will be needed at the `main` merge                                                                | Not yet needed — flag for the merge session                                        |

## Waived — correct non-use, grouped

- **Motion/animation (14)**: `animate`, `animate-expo`, `animation-vocabulary`, `12-principles-of-animation`, `find-animation-opportunities`, `improve-animations`, `review-animations`, `transitions-dev`, `transitions-polish`, `gsap-*` (7) — no animation surface in a packaging/release task.
- **Other frameworks/stacks**: `next-*` (5), `react-*` (4), `react-native-*`/`upgrading-react-native`/`mobile-native`/`react-navigation`, `write-swift`, `rust-best-practices`, `chrome-extensions`, `migrate-radix-to-base`, `shadcn`, `expo-*` — repo is Electron+React, no Next/RN/Swift/Rust/Chrome-ext surface touched.
- **Design systems & taste**: `amicro-design-system`, `fec`, `pace` (trigger-gated: need explicit phrase + `disable-model-invocation`), `industrial-taste`, `tactile-ui`, `apple-design`, `emil-design-eng`, `better-colors`, `better-layout`, `better-typography`, `better-ui`, `better-interface`, `better-writing`, `pick-ui-library`, `variant`, `prototype`, `composition-patterns`, `explain-interface`, `ui-skills-root`, `antfu` — no greenfield design work; UI delta was small fixes, covered by the two UI rulesets used.
- **Misjudged by name (corrected)**: `desktop-auto-updates` — I first listed it as the top miss ("updater domain!"). Its actual scope: Pop!_OS _system_ update channels (APT, Flatpak, firmware), not Electron app updaters. Correct verdict: waived. Live demonstration of the AGENTS.md rule — never judge a skill by name alone; read SKILL.md first.
- **Meta/planning outputs not requested**: `grilling`, `handoff`, `wayfinder`, `to-spec`, `to-tickets`, `to-questionnaire`, `teach`, `research`, `break`, `wait-what`, `find-skills`, `fixing-metadata`, `wizard`, `improve-codebase-architecture`, `setup-ts-deep-modules`, `codebase-design`, `domain-modeling`, `modern-web-guidance`, `verification-skill`, `thermo-nuclear-code-quality-review` (overlaps `code-review`; chose one per `ask-matt` routing).
- **Stack tools used without skill**: `pnpm`, `turborepo`, `vite`, `tailwindcss` — commands run were routine (`pnpm test`, turbo pipeline); skill wouldn't have changed the invocation. Arguable for `vite`/`vitest` conventions — counted `vitest` as a miss above.

## Harness findings — for improvement sessions

1. **INDEX.md injection works.** It fired at session start, I read it, routed through it. This mechanism is proven.
2. **Truncated auto-list is real but mitigated.** ~100 of 115 surface; the rest are findable via INDEX.
3. **`principle-*` splits have `disable-model-invocation: true`** — symlinked into `~/.config/devin/skills/` but still hidden by the flag. If the intent was always-surface, the flag defeats it.
4. **`~/.config/devin/skills/` is hand-curated, not hook-synced** — not in the hook's `MIRRORS` list. Decide: intentional curation (then document) or add to MIRRORS.
5. **Miss pattern = manner-of-work skills.** Task-shaped skills fire on task keywords; `unslop`/`technical-writing`/`writing-for-agents`/`triage`/`implement` apply to _how_ work is done, not _what_ — nothing in the loop surfaces them at the moment they're needed. Candidates for the improvement session: a pre-output unslop hook, a "writing worker briefs → writing-for-agents" mapping, or an explicit checklist in AGENTS.md.
6. **`desktop-auto-updates` shows domain skills can be missed** even when the domain is the whole task — the name didn't obviously match "release/packaging audit". Keyword routing missed it; INDEX.md reading caught categories, not this leaf.
7. **Duplicates**: `unlazy`/`blast-radius`/`unslop`/`technical-writing`/`typescript-best-practices` exist in both `.agents/skills` and `.config/devin/skills` — harmless, loader dedupes.
