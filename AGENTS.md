# Agent instructions

For any coding agent working in this repo — Claude Code, Codex, Cursor, an ACP agent.

`pnpm dev` starts the server, renderer and desktop shell together.

**Where the project is:** M0, M1 and M2 are done — Codex, Claude Code and any ACP agent
(Gemini, Kimi, Qwen) all run with parallel sessions, isolated worktrees and rollback;
Codex and Claude also expose persistent usage. M3 (review and control) is next. See
[docs/ROADMAP.md](./docs/ROADMAP.md) and the open issues.

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
- **Never push to `main`.** Branch, PR, one human approval.
- **Never mix a refactor with a behavior change** in one commit.

## How to work

- **Many small commits**, one logical change each. Push after every one — unpushed work is
  invisible to the other two.
- **Open a draft PR on the first commit**, not when the work is finished. That draft is how
  everyone else sees which files you are in.
- **One PR does one thing.** Never fold a design change into a PR about logic; the reviewer
  would have to accept both or neither.
- **Keep branches under two days and ~400 lines.** Conflicts come from old branches, not
  from working at the same time.
- Put `Closes #<issue>` in the PR body rather than closing issues by hand.
- Conventional Commits. The body says _why_, not what the diff already shows.

## Before you mark a PR ready

- `pnpm typecheck`, `pnpm test`, `pnpm lint` all clean
- CI green on **both** `windows-latest` and `macos-latest`
- Platform-specific code **run** on both, not just reviewed
- Anything visual has a screenshot in the PR body

## Local verification when Actions are unavailable

- If GitHub Actions minutes or runners are unavailable, run the same checks locally from the repository root:
  ```text
  pnpm install --frozen-lockfile
  pnpm lint
  pnpm -r typecheck
  pnpm -r test
  pnpm -r build
  ```
- For UI or server changes, start `pnpm dev` and exercise the affected flow manually. Keep local binds on `127.0.0.1`.
- Local checks are a safety net, not proof of Windows/macOS compatibility. Test platform-specific code on both operating systems when possible.
- Record the commands and results in the PR body, state when hosted CI is pending, and rerun CI after the Actions billing reset before merging.

## Traps in this repo

Each of these cost someone hours. They are not preferences.

- **TypeScript is pinned to 5.9.3.** 7.x cannot resolve `@types/node` under pnpm. Do not
  "upgrade" it.
- **Use `127.0.0.1`, never `localhost`.** On Windows `localhost` resolves to IPv6 first and
  Electron gets a blank window.
- **Shiki runs the JavaScript regex engine, not WASM**, because our CSP blocks
  `wasm-unsafe-eval`. Do not weaken the CSP to fix a highlighting problem.
- **`packages/contracts` is shared.** A change there breaks three clients at once — it ships
  as its own PR, reviewed by both humans, before anyone builds against it.
- **Windows CLI shims are `.cmd` files.** `spawn('claude')` fails with EINVAL; use
  `spawnCli` from `@harness/proc`, which routes through `cmd.exe`.
- **Adapters are written against captured output**, not against published schemas. When a
  protocol and its documentation disagree, the wire wins — capture frames from the real
  binary before writing types.

## When unsure

Ambiguity that changes the shape of the work → ask. Ambiguity that does not → decide,
proceed, state the assumption in the PR. Don't stall with nothing delivered.
