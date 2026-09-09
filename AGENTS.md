# Agent instructions

For any coding agent working in this repo — Claude Code, Codex, Cursor, an ACP agent.

`pnpm dev` starts the server, renderer and desktop shell together.

**Where the project is:** M0 through M3 are done. M4 (the design agent) is next. See
[docs/ROADMAP.md](./docs/ROADMAP.md) for durable status and GitHub issues/PRs for live work.

**Branch model (Leon and Bluedev, 2026-08-08):** `main` is the public beta for roughly the
next four weeks and becomes the stable release at v1. `nightly` is the integration branch:
every new change lands there first and nothing is hidden on it — it carries the full
provider roster (Codex, Claude Code, Grok plus the parked Cursor, OpenCode, Antigravity,
ACP and API-connection surfaces, all working). Work that the beta itself needs (fixes and
polish for the three shipped plans) still goes to `main` by PR and reaches `nightly` on the
next sync; everything else targets `nightly`. Keep `nightly` synchronized by merging `main`
and resolving conflicts without rewriting published history. Do not un-park a provider on
`main` without Leon saying so. The Rust + GPUI rewrite is preserved only on
`archive/rust-rewrite-2026-08-15`; do not merge it back into `main` without Leon saying so.
[docs/dashboard.html](./docs/dashboard.html) is the release checklist.

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
- **Stay on the current branch unless the user explicitly asks otherwise.** Do not create a
  branch or worktree, or switch branches, as a routine setup step.
- **Never open a PR unless the user explicitly asks for one.**
- **Never include Rust-port or mobile-app branch changes in a PR unless the user
  explicitly names that scope.** Broad requests such as “PR everything,” “ship all local
  changes,” or “everything” do not authorize either branch; exclude them by default.
- **Never push to `main`.** Branch, PR, merge. An agent may **merge its own PR without
  waiting** when the work is confidently finished: all four gates green locally, the flow
  exercised against the running app, and nothing in the PR touches `packages/contracts`,
  security, or another assignee's files. When any of that is in doubt, wait for the human
  responsible for the work. Approval from the other human is always optional.
- **Never rebase a working branch, and never force-push one.** If its target branch advances
  or GitHub reports conflicts, merge the target into the working branch, resolve every
  conflict explicitly, rerun the affected checks, and push normally. For agents, this
  overrides any branch-sync instruction to rebase. GitHub's server-side rebase-merge remains
  the final PR merge method because it does not rewrite the published working branch.
- **Never mix a refactor with a behavior change** in one commit.
- **Build shared features for every provider.** Contracts, persistence, orchestration and UI
  must still work when the user has only a direct API provider configured. A vendor CLI,
  SDK or app-server may add capabilities, but must never become the foundation for shared
  product behavior.
- **Keep provider behavior checks inside adapters.** Shared code reads declared capabilities
  and degrades honestly when an engine lacks one; it never branches behavior on a provider name.
  Codex-backed voice dictation is the only approved exception.

## How to work

- **You are rarely alone in this repo.** Several agent sessions (and both humans) often work
  in parallel. Expect `main` to move under you, expect open draft PRs and `scratch/`
  worktrees you did not create, and expect the shared dev stack on ports 4311/5183 to be
  restarted by someone else — a fresh `pnpm dev` deliberately replaces the running one.
  Before starting: check open PRs and worktrees, fetch and compare with the target branch
  instead of assuming, and never delete or modify a worktree, branch, or running process
  you did not create.
- **Many small commits**, one logical change each. Push after every one — unpushed work is
  invisible to the other two.
- **Every issue has exactly one directly responsible assignee from creation.** The
  assignee owns the next action; update it before handing work to someone else. The first
  draft PR says which files active work changes.
- **One PR does one thing.** Never fold a design change into a PR about logic; the reviewer
  would have to accept both or neither.
- **Keep branches under two days and ~400 lines.** Conflicts come from old branches, not
  from working at the same time.
- Put `Closes #<issue>` in the PR body rather than closing issues by hand.
- Conventional Commits. The body says _why_, not what the diff already shows.
- Do not create a handoff snapshot. Keep durable facts in `docs/`, current ownership in
  assigned issues and active changes in draft PRs so a restarted agent reads live state.
- **Keep `docs/dashboard.html` current.** It is the human-readable snapshot of progress —
  milestones, the kanban board, and the provider matrix. Whenever your change moves any of
  that (a PR merges, an issue opens or closes, a provider's status or the roadmap shifts),
  update the dashboard in the same PR or immediately after merging, and bump its
  updated-date and main SHA. A stale dashboard is worse than none. The same applies to
  `docs/feature-inventory.html`, the exhaustive feature checklist: when a feature ships,
  changes shape, or is removed, its line changes in the same PR.

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
- **Anything on the per-delta path is on the critical path.** A streamed answer produces
  hundreds of `item.delta` events a second, and every one of them runs the store reduce and
  re-renders whatever is subscribed. Work that is fine once per turn is not fine here:
  scanning the transcript, copying the item array, rebuilding derived lists, re-tokenizing a
  code block. Before adding anything to that path, ask what it costs times the length of the
  session — that multiplication is why a long chat used to feel worse than a short one.
- **Never put an unstable callback identity in an effect dependency list when the effect's
  trigger condition persists across renders.** Notify → parent re-renders → new identity →
  effect refires → notify: an invisible infinite loop. One of these hammered `models.list`
  until ~170 `opencode serve` processes were alive at once and the pagefile was exhausted
  (#283). Latch one-shot notifications with a ref, and give callbacks that end up in
  dependency lists a stable identity (`useCallback` in the owner).

## When unsure

Ambiguity that changes the shape of the work → ask. Ambiguity that does not → decide,
proceed, state the assumption in the PR. Don't stall with nothing delivered.
