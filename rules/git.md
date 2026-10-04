# Git rules

Two people, two operating systems, one trunk.

## Branches

Trunk is `main`. Protected: PR required, server-side rebase-merge only, no direct or
force-push. Branch, PR, CI and merge authorization follows [AGENTS.md](../AGENTS.md);
applicable approval already given in chat remains valid.

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

**Short-lived — under two days.** Longer than three means it's too big; split it. Merge
the target branch as it advances; never rebase or force-push a working branch. `spike/`
branches are throwaway and never merged; extract the learning into
[ARCHITECTURE.md](../docs/ARCHITECTURE.md) and delete the branch.

## Commits — small and frequent

**Many small commits, not few large ones.** This is a hard preference for this project.

- One logical change per commit. If the subject needs "and", split it.
- Commit when a thing _works_, not when a feature is done.
- Never mix a refactor with a behavior change. Refactor first, separately.
- Never mix formatting with logic.
- If the diff doesn't fit on one screen, ask whether it should be two commits.
- **Push often.** With two people in different places, unpushed work is invisible work.

Conventional Commits. The body explains _why_, not what the diff already shows.

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
- Body says _why_ and _how it was verified_. Screenshots or a clip for anything visual.
- **Follow the merge authorization in [AGENTS.md](../AGENTS.md).** Applicable human
  approval in chat or on GitHub remains valid; do not request it again. Required contracts,
  security and ownership review still applies. An agent never submits a GitHub review
  approving its own PR.
- **Rebase-merge, never squash.** Every commit on the branch lands on `main` individually
  and keeps its own message. This is why commits have to be clean and self-contained: on
  `main` they are the permanent record, not scratch work that gets collapsed away.
- Delete the branch on merge.

Never rewrite history on a branch someone else has pulled.

## How we run it

Agreed 2026-07-28.

|                 |                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Approval**    | Follow AGENTS.md; existing applicable authorization remains valid and does not waive verification or required review.    |
| **Visibility**  | Claude opens a **draft PR from the first commit** — not when the work is finished. Redirect early; that's what it's for. |
| **Merging**     | Merge when authorized under AGENTS.md and all required gates pass; do not ask again for an already authorized merge.     |
| **Merge style** | **Rebase, never squash.** Squash is disabled in the branch ruleset.                                                      |
| **Pushing**     | After every commit, not batched at the end. Work that is not pushed is invisible.                                        |

Who owns which area, how tasks are tracked, and what happens when two people want the same
screen to look different: [working-together.md](./working-together.md).

`main` is protected: PR required, rebase-merge only, no force-push, no deletion. The
ruleset may still report a missing GitHub review; a bypass-eligible collaborator may use
the bypass after the human responsible for the work has explicitly approved it.

## Verification gates

Run locally before merge: typecheck · lint + format · unit tests · desktop build.
Record the commands and results in the PR body.

GitHub Actions remain manual. Necessary verification runs for explicitly assigned work
are authorized under [AGENTS.md](../AGENTS.md), without repeated permission requests.
Automatic or recurring CI triggers still require an explicit request.

Platform-specific code must be run locally on the affected OS before release, not merely
reviewed.
