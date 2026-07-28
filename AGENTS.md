# Agent instructions

For any coding agent working in this repo — Claude Code, Codex, Cursor.

**This repo is planning only. There is no application code yet.**

## Read first

1. [rules/git.md](./rules/git.md) — branches, commits, PRs
2. [rules/code.md](./rules/code.md) — cross-platform, style, decisions
3. [rules/security.md](./rules/security.md) — credentials
4. [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — check whether a decision already exists
   before making a new one

## Hard rules

- **Never read, copy, or forward a vendor's subscription credential.** We spawn vendor
  binaries and let them authenticate themselves. Compliance requirement, not a preference —
  [rules/security.md](./rules/security.md).
- **Never commit a secret**, including in fixtures and examples.
- **Never write a `.sh` script.** Node/TypeScript only — we're a Windows + macOS team.
- **Never assume POSIX paths.** Use `node:path`.
- **Never push to `main`.** Branch, PR, one human approval.
- **Never mix a refactor with a behavior change** in one commit.

## Commits

Conventional Commits, small and frequent, one logical change each. The body says *why*.

## When unsure

Ambiguity that changes the shape of the work → ask. Ambiguity that doesn't → decide,
proceed, state the assumption in the PR. Don't stall with nothing delivered.
