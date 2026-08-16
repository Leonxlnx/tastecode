# TasteCode handoff

Updated: 2026-08-16  
Repository: `D:\personalharness`  
Source snapshot before this document: `main` at `eeccaf81`

This is a concise continuation guide, not a replacement for GitHub or the durable project docs.
Read `AGENTS.md`, `rules/`, `docs/dashboard.html`, `docs/feature-inventory.html`, open issues, and
open pull requests before changing code.

## Current verified state

- Public-beta work targets `main` by branch and pull request. Never push directly to `main`.
- `nightly` carries the complete provider roster. Do not unpark providers on `main` without Leon.
- The shipped beta providers are Codex, Claude Code, and Grok.
- At this snapshot the open `main` pull requests are:
  - #895, automatic updates, Ready.
  - #897, first-project onboarding, Draft.
- Both open pull requests have active owner worktrees. Inspect and coordinate before touching their
  files or merging them.
- The user's running desktop app was deliberately not restarted during the performance work.

## Completed performance work

PR #923 merged as `54edfedb`: `perf(server): compact fresh thread replay`.  
PR #924 merged as `eeccaf81`: documentation closeout.

Root cause: opening a persisted thread asked SQLite for every durable event and sent the complete
event log to the renderer. The live streaming and rendering paths were already bounded and fast;
fresh history transfer was the real long-thread bottleneck.

The landed behavior is intentionally small:

- `apps/server/src/history-replay.ts` removes superseded item deltas and old diff, plan, and usage
  snapshots from a fresh replay.
- `Orchestrator.history(threadId, 0)` returns that state-equivalent compact replay.
- `Orchestrator.history(threadId, afterSeq)` returns the exact durable tail unchanged. Reconnects do
  not lose or combine events.
- `apps/server/src/side-chat.ts` supplies the existing provider-neutral item projection instead of
  introducing a second replay implementation.
- SQLite history, schemas, contracts, renderer behavior, CSS, design, and animation are unchanged.

## Measured result

The largest measured real thread contained 6,495 events. Loopback `thread.history` results:

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Response events | 6,495 | 603 | -90.7% |
| Response size | 18.81 MB | 1.85 MB | -90.2% |
| Median RPC latency | 466.17 ms | 109.18 ms | -76.6% |
| p95 RPC latency | 537.58 ms | 128.04 ms | -76.2% |

Final-head validation replayed all 70 current durable user threads through both paths:

- 0 reconstructed-state differences.
- 104.60 MB of full history became 19.91 MB, an 81.0% reduction.
- The benchmark server used `127.0.0.1:45701`; it was stopped and the copied database was deleted.

## Verification already completed

- Focused history, Side chat, and orchestrator tests: 149/149.
- Full lint: green.
- Full typecheck: all 15 participating workspace projects green.
- Full test rerun: web 784, server 372, desktop 60, and every package/adapter green.
- Full build: all 15 participating workspace projects green.
- One unrelated Pull Requests routing test timed out in the first contended run. It then passed
  three isolated runs and the complete clean rerun.

## Codex Desktop comparison

- TasteCode's measured active-tail and streamed-delta work was already effectively constant-time.
- Before #923, Codex had the better long-history architecture because its app-server API can omit
  turns on resume and page them separately.
- TasteCode now avoids the measured full-log waste while preserving its durable event model.
- Codex still has a pagination advantage for histories far beyond today's data. Add pagination only
  when real measurements show compact snapshots no longer meet the latency budget.
- Do not claim a global memory winner from the existing process sample. The observed Codex session
  was a busy, very long session and was not an apples-to-apples packaged-app benchmark.

## Safe continuation

1. Fetch `origin/main`; do not assume the root worktree is current or clean.
2. Inspect open PRs, issues, worktrees, and owned ports before choosing files.
3. Use a dedicated worktree and a small branch. Push each logical commit.
4. Merge `main` into an active branch if the target advances. Never rebase or force-push it.
5. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before Ready.
6. Exercise server or UI behavior locally without replacing another owner's running app stack.
7. Merge through a PR and update the dashboard and feature inventory immediately when status moves.

There is no remaining action in the compact-history performance slice.

## Design agent addendum

The Design Agent task should append its current verified status, exact PRs, evidence, blockers, and
next action here. Keep measured performance facts above unchanged unless newer evidence supersedes
them.
