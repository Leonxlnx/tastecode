# Contributing to TasteCode

Thanks for helping improve TasteCode. Please discuss substantial changes in an issue before
starting implementation so provider behavior, UI ownership, and cross-platform impact are
clear.

## Before you start

- Read `AGENTS.md` and the files under `rules/`.
- Keep repository content and commits in English.
- Start from the current target branch and work on a focused branch.
- Never commit credentials, tokens, private source, generated secrets, or machine-specific paths.
- Use Node-based tooling instead of shell scripts so Windows and macOS remain first-class.

## Development

Install Node 24 LTS and pnpm, then run:

```text
pnpm install
pnpm dev
```

Before requesting review, run:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Add or update tests for behavior changes. UI changes should include a screenshot or short
recording and should be checked at narrow and wide viewport sizes. Changes that touch native
desktop behavior need validation on the affected operating system.

## Pull requests

- Keep each pull request scoped to one understandable change.
- Explain what changed, why, user impact, and validation performed.
- Call out provider-specific behavior and platform-specific behavior explicitly.
- Do not mix refactors with product changes unless the refactor is required.
- Leave draft pull requests marked as draft until checks and manual acceptance pass.

## Contributions and licensing

By submitting a contribution, you agree that it may be distributed under the repository's
Apache License 2.0. Third-party code or assets must have compatible terms and clear
attribution.
