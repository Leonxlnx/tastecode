# Agent instructions

Instructions for any coding agent working in this repository (Claude Code, Codex, Cursor —
`CLAUDE.md` symlinks here in spirit; keep both in sync if you add one).

## What this repo is

Personal Harness — a desktop control panel for AI coding agents. Currently **planning only**;
there is no application code. See [`docs/README.md`](./docs/README.md).

## Before you change anything

1. Read [`docs/05-team/working-rules.md`](./docs/05-team/working-rules.md). It is short and
   it is binding.
2. Check whether an [ADR](./docs/02-decisions/) already decides the question. If one does,
   follow it. If you believe it is wrong, write a new ADR that supersedes it — do not
   quietly diverge in code.

## Hard rules

- **Never read, copy, or forward a vendor's subscription credential** (`~/.claude/.credentials.json`,
  `~/.codex/auth.json`, keyrings, anything). We spawn vendor binaries and let them
  authenticate themselves. This is a compliance requirement.
  See [ADR-0005](./docs/02-decisions/ADR-0005-credentials-and-policy.md).
- **Never commit a secret**, including in a test fixture or an example.
- **Never write a `.sh` script.** Repo scripts are Node/TypeScript. We are a Windows + macOS
  team and a bash-only script breaks one of us.
- **Never assume POSIX paths.** Use `node:path`. Never concatenate paths with `/`.
- **Never push to `main`.** Branch, PR, one human approval.
- **Never mix a refactor with a behavior change** in the same commit.

## Commit style

Conventional Commits, small and frequent. One logical change per commit; if the subject
needs "and", split it. The body explains *why*, not what the diff already shows.

```
feat(chat): pin scroll to bottom during token streaming

TanStack Virtual's anchorTo:'end' handles the resize storm from streaming
deltas; without it the viewport walks upward on every delta.
```

## When you are unsure

Ambiguity that changes the *shape* of the work → ask. Ambiguity that does not → decide,
proceed, and state the assumption in the PR body. Do not stall with nothing delivered.

## Performance is a correctness property here

The budgets in [`docs/01-research/ui-performance.md`](./docs/01-research/ui-performance.md)
are acceptance criteria, not aspirations. A change that regresses one is a broken change.

## Style

Match the surrounding code. Comment density, naming, and idiom should be indistinguishable
from what is already there. Do not add explanatory comments for obvious code, and do not
leave TODOs without an issue link.
