# Contributing

The repository is private and the team is two people plus an agent. This file will grow
before the repo goes public (see the checklist in
[ADR-0006](./docs/02-decisions/ADR-0006-license-and-open-sourcing.md)).

For now, everything you need is in
**[`docs/05-team/working-rules.md`](./docs/05-team/working-rules.md)**.

## The short version

| | |
| --- | --- |
| Trunk | `main`, protected, always releasable |
| Branches | `<type>/<area>-<description>`, short-lived (< 2 days) |
| Commits | Conventional Commits, **small and frequent**, one logical change each |
| PRs | Small (< ~400 lines), draft early, one human approval, squash-merge |
| CI | Must be green on `windows-latest` **and** `macos-latest` |
| Platform code | Must be *run* on both operating systems before merge, not just reviewed |
| Secrets | Never committed; runtime credentials live in the OS credential store |
| Scripts | Node/TypeScript only, never `.sh` |
| Decisions | Non-obvious ones become an ADR, with the rejected options written down |

## Setup

Nothing to set up yet — there is no application code. When there is:

```bash
pnpm install
pnpm dev
```

Prerequisites will be Node 24 LTS, pnpm 11, and Git. Windows needs Windows 10 1809+ for
ConPTY and should have `core.longpaths` enabled:

```bash
git config --global core.longpaths true
```

## Reporting something

Open an issue. If it is security-related and involves credentials, do not open a public
issue — a `SECURITY.md` with a disclosure address lands before the repo goes public.
