# Agent instructions

For any coding agent working in this repo — Claude Code, Codex, Cursor, an ACP agent.

`pnpm dev` starts the server, renderer and desktop shell together.

**Where the project is:** M0 through M3 are done. Codex, Claude Code and any ACP agent
(Gemini, Kimi, Qwen) run with parallel sessions, isolated worktrees, rollback, review
controls, a real terminal, MCP and Agent Skills. M4 (the design agent) is next. See
[docs/ROADMAP.md](./docs/ROADMAP.md) for durable status and GitHub issues/PRs for live work.

## Read first

1. [rules/working-together.md](./rules/working-together.md) — how work is planned and split
2. [rules/git.md](./rules/git.md) — branches, commits, PRs
3. [rules/code.md](./rules/code.md) — cross-platform, style, decisions
4. [rules/security.md](./rules/security.md) — credentials
5. [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — check whether a decision already exists
   before making a new one

## Hard rules

- **Everything in the repo is English** — code, comments, commit messages, PR text, issues.
  The humans chat in German and English; none of that reaches the repo.
- **Never commit a secret**, including in fixtures and examples.
- **Never write a `.sh` script.** Node/TypeScript only — we are a Windows + macOS team.
- **Never assume POSIX paths.** Use `node:path`.
- **Never push to `main`.** Branch, PR, then explicit approval from the human responsible
  for the work. Approval from the other human is optional.
- **Never mix a refactor with a behavior change** in one commit.

## How to work

- **Many small commits**, one logical change each. Push after every one — unpushed work is
  invisible to the other two.
- **Every issue has exactly one directly responsible assignee from creation.** The
  assignee owns the next action; update it before handing work to someone else. The first
  draft PR says which files active work changes.
- **Open a draft PR on the first commit**, not when the work is finished. That draft is how
  everyone else sees which files you are in.
- **One PR does one thing.** Never fold a design change into a PR about logic; the reviewer
  would have to accept both or neither.
- **Keep branches under two days and ~400 lines.** Conflicts come from old branches, not
  from working at the same time.
- Put `Closes #<issue>` in the PR body rather than closing issues by hand.
- Conventional Commits. The body says _why_, not what the diff already shows.
- Do not create a handoff snapshot. Keep durable facts in `docs/`, current ownership in
  assigned issues and active changes in draft PRs so a restarted agent reads live state.

## Before you mark a PR ready

- `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` all clean locally
- Exercise the affected flow with `pnpm dev` for UI or server changes
- Anything visual has a screenshot in the PR body
- Record the local commands and results in the PR body

## Hosted CI

- GitHub Actions are manual to preserve included minutes. **Never start a hosted CI run
  unless Leon explicitly asks for it.**
- Platform-specific changes still need a local run on the affected OS before release.
- Keep local binds on `127.0.0.1`.

## Traps in this repo

Each of these cost someone hours. They are not preferences.

- **TypeScript is pinned to 5.9.3.** 7.x cannot resolve `@types/node` under pnpm. Do not
  "upgrade" it.
- **Use `127.0.0.1`, never `localhost`.** On Windows `localhost` resolves to IPv6 first and
  Electron gets a blank window.
- **Shiki runs the JavaScript regex engine, not WASM**, because our CSP blocks
  `wasm-unsafe-eval`. Do not weaken the CSP to fix a highlighting problem.
- **`packages/contracts` is shared.** A change there breaks three clients at once — it ships
  as its own PR before anyone builds against it. Approval from the human responsible for
  the work is sufficient; review by the other human is optional.
- **Windows CLI shims are `.cmd` files.** `spawn('claude')` fails with EINVAL; use
  `spawnCli` from `@harness/proc`, which routes through `cmd.exe`.
- **Adapters are written against captured output**, not against published schemas. When a
  protocol and its documentation disagree, the wire wins — capture frames from the real
  binary before writing types.

## When unsure

Ambiguity that changes the shape of the work → ask. Ambiguity that does not → decide,
proceed, state the assumption in the PR. Don't stall with nothing delivered.
