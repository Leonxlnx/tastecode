# Git rules

Two people, two operating systems, one trunk.

## Branches

Trunk is `main`. Protected: PR required, 1 approval, rebase-merge only, no force-push.

```
<type>/<area>-<short-description>

feat/chat-virtualized-list
fix/pty-windows-conpty-resize
docs/adapter-notes
chore/ci-windows-matrix
spike/acp-prototype
design/thread-visual-pass
```

Types: `feat` `fix` `docs` `chore` `refactor` `perf` `test` `spike` `design`

**Short-lived — under two days.** Longer than three means it's too big; split it. Rebase on
`main` daily. `spike/` branches are throwaway and never merged; extract the learning into
[ARCHITECTURE.md](../docs/ARCHITECTURE.md) and delete the branch.

## Commits — small and frequent

**Many small commits, not few large ones.** This is a hard preference for this project.

- One logical change per commit. If the subject needs "and", split it.
- Commit when a thing *works*, not when a feature is done.
- Never mix a refactor with a behavior change. Refactor first, separately.
- Never mix formatting with logic.
- If the diff doesn't fit on one screen, ask whether it should be two commits.
- **Push often.** With two people in different places, unpushed work is invisible work.

Conventional Commits. The body explains *why*, not what the diff already shows.

```
feat(chat): pin scroll to bottom during token streaming

anchorTo:'end' handles the resize storm from streaming deltas; without it
the viewport walks upward on every delta.
```

Scopes: `chat` `adapters` `desktop` `server` `design-agent` `ci` `docs`

Not acceptable: `update stuff`, `fixes`, `wip`, `more work on chat`. (`wip` is fine on your
own branch while working — clean them up before marking the PR ready, since they land on `main` as-is.)

## Pull requests

- **Everything goes through a PR.** No direct pushes to `main`, including by the agent.
- **Small** — under ~400 changed lines. A big feature is a stack of small PRs behind a flag.
- **Draft early** — open it when the branch exists, not when the work is finished. Cheapest
  way to keep the other person oriented.
- Body says *why* and *how it was verified*. Screenshots or a clip for anything visual.
- **One approval** from the other human. The agent opens and updates PRs; it never approves.
- **Rebase-merge, never squash.** Every commit on the branch lands on `main` individually
  and keeps its own message. This is why commits have to be clean and self-contained: on
  `main` they are the permanent record, not scratch work that gets collapsed away.
- Delete the branch on merge.

Never rewrite history on a branch someone else has pulled.

## How we run it

Agreed 2026-07-28.

| | |
| --- | --- |
| **Approval** | Either human approves. Neither approves their own PR. |
| **Visibility** | Claude opens a **draft PR from the first commit** — not when the work is finished. Redirect early; that's what it's for. |
| **Merging** | Claude merges once approved. Nothing lands without a human sign-off anyway. |
| **Merge style** | **Rebase, never squash.** Squash is disabled in the branch ruleset. |
| **Pushing** | After every commit, not batched at the end. Work that is not pushed is invisible. |

Ownership, so we don't collide:

| Area | Owner |
| --- | --- |
| Desktop shell, installer, updater, everything Windows | Windows dev |
| macOS specifics, notarization | macOS dev |
| Server, adapters, UI, tests, docs | Claude |
| `packages/contracts` | **Shared — both humans review.** A change here breaks three clients at once. |

`main` is protected: PR required, 1 approval, rebase-merge only, no force-push, no deletion.
There is currently an **admin bypass** so a solo owner isn't deadlocked —
**remove it once the second collaborator is added**, or the rule is decorative.

## CI gates

Green on **both** `windows-latest` and `macos-latest` before merge:
typecheck · lint + format · unit tests · desktop build.

A broken Windows build blocks the merge even if macOS is green, and vice versa.

**Platform-specific code must be *run* on both OSes before merge — not just reviewed.**
This is the rule most likely to save us.
