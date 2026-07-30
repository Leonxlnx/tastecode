# Working together

Two humans and an agent, three machines, one trunk.

[git.md](./git.md) covers the mechanics — branches, commits, merges. This covers the part
git cannot decide: what gets worked on, by whom, and what happens when two people want the
same thing to look different.

## Where work lives

Three places, and each answers a different question. Putting a thing in the wrong one is
how a plan goes stale.

| Where                              | Question it answers        | How often it changes   |
| ---------------------------------- | -------------------------- | ---------------------- |
| [ROADMAP.md](../docs/ROADMAP.md)   | Which milestone, and why   | Rarely — per milestone |
| [FEATURES.md](../docs/FEATURES.md) | What the product will have | Rarely                 |
| **GitHub Issues**                  | What someone does next     | Daily                  |

**The roadmap is not a task list.** It says "M2 — many agents, many sessions" and why that
order. It does not say "add a session tab bar". That is an issue.

**Issues are not a design document.** An issue says what should be true when it is done. If
it needs three paragraphs of reasoning, that reasoning belongs in `docs/` and the issue
links to it.

We do not keep a `TODO.md`. A file that both of us edit every day is a merge conflict
waiting to happen, and it cannot be assigned, linked to a PR, or closed by one.

## Issues

Open one when the work is **not** starting in the next hour. Work you are about to do needs
a draft PR, not an issue — the PR already says what you are doing.

- **Title is imperative and specific.** `Add session tab bar`, not `sessions`.
- **Body says what "done" looks like.** One or two sentences. If you cannot state it, the
  issue is not ready to work on.
- **Set the milestone** — `M2`, `M3`. GitHub milestones, not labels: they carry a progress
  bar, so the roadmap stays honest without anyone editing the roadmap.
- **Label the area** — `area:server`, `area:ui`, `area:adapters`, `area:desktop`. That is
  how you see at a glance whether something is yours.
- **Assign it when you start**, not when you file it. An unassigned issue is available.
- **One issue, one PR**, where possible. If a PR closes three issues it was too big.

Close issues from the PR, never by hand: put `Closes #12` in the PR body and it closes on
merge. A checkbox someone forgot to tick is worse than no checkbox.

## Who does what

Soft ownership, so two people do not rewrite the same file on the same afternoon. Nobody is
locked out of anything — this says who is expected to pick it up, not who is permitted to.

| Area                                                 | Owner                                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| Server, adapters, protocol, tests                    | Claude                                                                       |
| UI implementation, visual polish                     | Blueemi                                                                      |
| Product direction, what gets built, design review    | Both humans                                                                  |
| Desktop shell, installer, updater, Windows specifics | Leon (Windows)                                                               |
| macOS specifics, notarization                        | Blueemi (macOS)                                                              |
| `packages/contracts`                                 | **Shared — both humans review.** A change here breaks three clients at once. |

If you are about to work outside your area, that is fine — open the draft PR first so the
owner sees it early rather than in a finished diff.

## Design disagreements

This is the one git cannot help with, so it needs an actual rule.

**Nobody silently replaces someone else's design.** Not in a PR about something else, not
"while I was in there anyway".

If you want something to look or behave differently:

1. Open it as **its own PR**, separate from any logic change.
2. Show **before and after** — screenshot, clip, whatever makes it visible.
3. Say what you think is wrong with the current one. "Cleaner" is not a reason.

**Both humans decide together.** Neither of us overrules the other; we talk until one of us
is convinced. If neither is, the existing design stays — not because it is better, but
because churn is worse than an imperfect button.

The reason this matters more than it sounds: a PR that mixes a design change into a logic
change forces the reviewer to accept both or neither. **One PR does one thing** is the rule
that makes disagreement cheap.

## The loop

What a normal piece of work looks like, start to finish:

1. `git pull` on `main`. Always start from fresh trunk.
2. Check open PRs. That is how you see what the other two are touching right now.
3. Branch. Naming in [git.md](./git.md).
4. First commit → **open a draft PR immediately.** The draft PR is the signal "I am in these
   files". It costs nothing and prevents the expensive kind of collision.
5. Push after every commit. Unpushed work is invisible work.
6. Keep it short — under two days, under ~400 lines. Long branches are what actually cause
   conflicts, not parallel work.
7. Mark ready. One approval from the other human.
8. Rebase-merge. Delete the branch.

Conflicts almost never come from two people editing at once. They come from a branch that
sat for a week. Short branches are the whole trick.

## Decisions we have made

Recorded so nobody re-litigates them from memory.

| Date       | Decision                                                                            |
| ---------- | ----------------------------------------------------------------------------------- |
| 2026-07-28 | Rebase-merge only. Squash disabled in the ruleset.                                  |
| 2026-07-28 | Draft PR from the first commit, not when the work is done.                          |
| 2026-07-30 | GitHub Issues for tasks. No `TODO.md`, no external tracker while we are two.        |
| 2026-07-30 | Design changes ship as their own PR with before/after. Both humans decide.          |
| 2026-07-30 | Admin bypass on `main` stays for now, revisited when both humans are pushing daily. |

## Things that are true about this repo

Worth knowing before you are surprised by them.

- **The repo is owned by a personal account**, so collaborators cannot be given admin.
  Blueemi has write access, which covers everything except bypassing review. Full admin
  would require moving the repo to an organization — worth doing before open-sourcing
  anyway.
- **CI runs Windows and macOS.** Both must be green. A platform-specific change must be
  _run_ on both, not just reviewed.
- **Everything in the repo is English** — code, comments, commits, issues, PRs. Chat between
  the humans is whatever they like.
