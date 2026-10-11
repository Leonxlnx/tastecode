# TasteCode: current state (2026-10-11)

Written at Leon's request so that any new Claude Code session, on any machine, can pick up
the work without the claude.ai project it was done in. It updates the 2026-10-09 handoff,
`docs/CLAUDE-HANDOFF.md`, which exists on `nightly` only (from `main`, read it with
`git show origin/nightly:docs/CLAUDE-HANDOFF.md`); where they differ, this file wins. It
is a snapshot taken at 2026-10-11 14:30 UTC: recheck live state before acting on any number
here.

Working rules for Claude sessions are in the root [`CLAUDE.md`](../../../CLAUDE.md).

## 1. Branches and releases

| Item                        | State                                                                            |
| --------------------------- | -------------------------------------------------------------------------------- |
| `main` (public beta source) | `6958324e`, still moving daily                                                   |
| `nightly` (everything)      | `b41be070`                                                                       |
| Divergence                  | merge base `3e67df35` (2026-10-04); `main` is 291 commits ahead, `nightly` 71    |
| Published release           | **v0.1.1** (2026-09-20). Also published: beta.9, beta.7, beta.6, a Linux preview |
| Draft releases              | v0.1.2 "packaging proof" (not ready, see the 2026-10-09 handoff §10), beta.8     |
| Leon's installed build      | built from `nightly` `b41be070` on 2026-10-10                                    |

The repo is public. Hosted CI is manual-only (`ci.yml`), so PRs show no checks unless a run
is dispatched; local gates go in the PR body.

## 2. Waiting on Leon

Nothing below has been done. Each needs Leon's explicit go.

### main → nightly sync

`nightly` lacks almost everything `main` received since 2026-10-04 (settings redesign, many
fixes). A test merge of `origin/main` into `origin/nightly` on 2026-10-11 conflicts in 13
files:

```
apps/desktop/src/main.ts
apps/desktop/src/own-renderer.test.ts        (add/add)
apps/desktop/src/own-renderer.ts             (add/add)
apps/server/src/history-cli.test.ts
apps/server/src/orchestrator.test.ts
apps/server/src/orchestrator.ts
apps/web/src/App.test.tsx
apps/web/src/ui/InboxSidebar.tsx
apps/web/src/ui/Settings.tsx
docs/dashboard.html
packages/adapter-acp/src/adapter.lifecycle.test.ts
packages/adapter-acp/src/adapter.ts
packages/adapter-acp/src/events.ts
```

Many are the same bug fixes landed on both branches by different PRs (the 2026-10-09 bug
hunt merged into `nightly`, the equivalent fixes landed on `main`). Do it as a normal merge
on a branch, keep `nightly`'s provider code, run all four gates, open a draft PR. PRs #1410,
#1423 and #1424 were closed on 2026-10-11 because their fixes are on `main`; `nightly` only
gets them through this sync.

### Close spam and obsolete PRs (13)

- taste-skill, spam or off-topic: #115, #85, #74, #73, #68, #65, #54, #43, #13
- taste-skill, already fixed or duplicate: #40 (fixed on main), #17 (duplicate of #41), #3
  (obsolete, author can reopen against `skills/`)
- tastecode-landingpage #1 (August public-beta prep; the site was redesigned since)

### Close done or empty issues (21)

- tastecode, fix verified: #1282 (`0a530e9b`), #1013 (`341ae701`), #1009 (`77cf6771`,
  `3a3a1f25`), #956 (`7d1c8278`), #1010 (`8544fbac`, nightly), #955 (`dfcaa47f` on nightly;
  main hides API since `756052cd`), #1279 (settled by `756052cd`; custom endpoints are on
  nightly)
- taste-skill, empty, spam or answered: #118, #117, #116, #101, #92, #90, #72, #70, #69
  (duplicate of #78), #66, #63, #52, #44, #35

### Contributor PRs that need a product or taste decision

- Mixer159 UI set, all taste calls: #1300 sidebar thread list (labels a permanent delete as
  "Archive"), #1301 command palette restyle (renames "New chat" to "New thread"), #1302 +
  #1305 Claude fast mode with an extra-usage warning (only useful together), #1303 effort
  knob, #1304 model picker on the provider rail.
- #1287 (yqecea) Linux release line: commit to Linux as a platform? About +13k lines and
  many conflicts. Its branch also has two stray root files (`Pasted Text.txt`,
  `SKILL-USAGE.md`).
- #1163 (yqecea) write-only harness env values: are they secrets?
- #1165 (yqecea) manual update mode, dialogs, Linux close/tray behaviour: split out the
  dialog and zoom fixes.
- #1288 (traviswieser) example copywriting skill: ship example skills at all?
- Issue #950: in-app Claude subscription login. Either get written approval from Anthropic
  or remove that login flow from `main`.

### taste-skill branches blocked by a ruleset

16 merged branches in `Leonxlnx/taste-skill` cannot be deleted because that repo's ruleset
rejects branch deletion (GitHub error GH013). They go once Leon lifts or edits the ruleset.

## 3. Open tastecode PRs (20)

| PR                  | Author       | Base    | Next step                                                                                    |
| ------------------- | ------------ | ------- | -------------------------------------------------------------------------------------------- |
| #1467, #1469–#1471  | Blueemi      | main    | New drafts from Karol's sessions today (history paging, right panel, terminal cleanup). His. |
| #1153               | Blueemi      | main    | macOS title-bar drag. Karol drags a real window on a Mac build, then merge.                  |
| #1240               | yqecea       | main    | Electron fuses. One small conflict, then packaged Mac + Windows smoke.                       |
| #1164               | yqecea       | main    | Readiness/drain. Resolve conflicts, keep main's shutdown IPC, land before #1210.             |
| #1210               | yqecea       | main    | Process ownership. After #1164; drop the no-op retry.                                        |
| #1168               | yqecea       | main    | Ask the author to fix: it loosens the normal perf gate.                                      |
| #1272               | DeryFerd     | main    | Ask the author to guard the newer symlink tests too.                                         |
| #1163, #1165, #1287 | yqecea       | main    | Leon's call, see §2.                                                                         |
| #1288               | traviswieser | nightly | Leon's call, see §2.                                                                         |
| #1300–#1305         | Mixer159     | main    | Leon's call (taste), see §2.                                                                 |

Since the 2026-10-10 board, #1162, #1280, #1281, #1325 and #1326 are no longer open.

## 4. Done in the 2026-10-09 to 10-11 project

- **Bug hunt.** 16 fixes found on 2026-10-09. #1409 and #1411–#1422 merged into `nightly`
  and #1465 into `main` on 2026-10-10 with Leon's go; every fix that applies to `main` is on
  `main`. #1410, #1423, #1424 closed (see the sync above). #1411 and #1416 were confirmed on
  real Windows.
- **Branch cleanup.** About 220 merged or superseded remote branches deleted across the
  repos on 2026-10-10, each with a recorded SHA. Around 74 branches were kept on purpose
  (open-PR heads, bases, screenshot/evidence branches such as the orphan
  `assets/pr-screenshots` that old PR bodies link to, Karol's WIP, `taste-skill-v2`).
  Do not delete branches by name pattern.
- **Triage.** Every branch, PR and issue in the five repos was sorted with a next step. The
  result is summarized in §2 and §3.

## 5. Known bugs, not fixed yet

From the 2026-10-09 bug hunt, checked against `nightly` `60a2d384`. Line numbers will have
drifted. Security-relevant findings are deliberately not listed in this public file; Leon
has them.

Needs a decision:

1. **Update check can miss the highest release.** `apps/desktop/src/github-release-provider.ts`
   reads the Atom feed, which lists the 10 most recently published entries, not the highest
   versions. Linux preview tags and an out-of-order publish (beta.8 after 0.1.1) can hide
   the newest version. Always falling back to the release list costs API quota. Leon and
   Karol to decide. Affects `main` too.
2. **macOS: Ctrl+letter fires app shortcuts** (`apps/web/src/shortcuts.ts`). Ctrl+N/P/K in
   the composer start a new chat, open the switcher or the palette instead of the standard
   Mac text motions. A test asserts it, so it may be intended. Karol to decide.
3. **Cursor on Windows: multi-line prompts fail** (`packages/adapter-cursor/src/adapter.ts`
   passes the prompt on argv, which `spawnCli` rejects through a `.cmd` shim). Needs a check
   of what `cursor-agent` accepts on stdin.
4. **Design: marketing sites classified as dashboards** (`packages/design-agent/src/brief.ts`).
   "site", "one-pager" or "Webseite" plus "app"/"analytics"/"admin" becomes a dashboard
   run. Changing the heuristic shapes what gets designed: Leon's call.

Real bugs:

5. Orchestrator leaks a pending turn start if a check throws before the `try` in
   `#sendDesignTurn` (`apps/server/src/orchestrator.ts`); restores then fail with "Chats
   are still working".
6. Discarding a chat whose nested project subfolder was deleted forgets a dirty worktree
   without warning (`orchestrator.ts` with `worktree.ts`).
7. A failed provider-history import blocks every thread, local ones included
   (`apps/server/src/server.ts`).
8. One bad entry in `providers.json` makes every API connection unusable
   (`apps/server/src/model-connections.ts`).
9. Codex user-input events can fail the contracts schema (empty strings, out-of-range
   `autoResolutionMs`), so the question is dropped while Codex waits
   (`packages/adapter-codex/src/schemas.ts` vs `contracts/src/domain.ts`).
10. ACP permission ids can collide (`approval-${Date.now()}` in `adapter-acp/src/adapter.ts`).
11. Grok and Antigravity show "not on PATH" right after install or on a macOS GUI launch
    (`desktop-path.ts` lacks `~/.grok/bin` and `%LOCALAPPDATA%\agy\bin`).
12. `runCli`/`captureCli` never close the child's stdin, so CLIs waiting for EOF hang until
    the 5 s timeout (`packages/proc/src/cli.ts`).
13. macOS DMG update cleanup can fail a good update if `hdiutil detach` fails twice
    (`apps/desktop/src/dmg-update.ts`, throw from `finally`).
14. A late checkpoint-load failure from the previous chat can empty the new chat's restore
    list (`App.tsx`).
15. Add-project failures are silent; with several dropped folders one failure stops the rest
    (`App.tsx`, `void addProject()`).
16. The keybind recorder accepts combos that can never fire (`ui/KeybindSettings.tsx`).
17. `harness.modelByThread:<id>` localStorage keys are never removed on chat delete.
18. Relative markdown links navigate the whole app in web/dev builds
    (`ui/CompletedMarkdown.tsx`).
19. A checkpoint note can point at a snapshot that gc later deletes (`checkpoint.ts`).
20. `tools/scripts/dev.js` matches the English `LISTENING` from `netstat`, so on German
    Windows ("ABHÖREN") stale dev ports are not cleared.
21. Connection-state listeners in `apps/web/src/transport.ts` are unguarded, the same
    pattern #1422 fixed for push listeners.

Data, Leon decides: six "mobile" reference images in
`packages/design-agent/references/library/catalog.json` are landscape desktop crops
(`ariyana-studio-11-cta`, `fabrica-07-showreel`, `stodio-02-partners`, `mitchy-11-cta`,
`obvia-11-testimonial`, `sidrano-02-partners`).

## 6. Other repos

| Repo                                                | What it is                                      | Notes                                                                                                       |
| --------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `Leonxlnx/tastecode-landingpage`                    | tastecode.dev (Next.js, Vercel, `main` is live) | Secondary. Preview branch first; nothing goes live until Leon says go. Its own `CONTEXT.md` is the handoff. |
| `Leonxlnx/design-taste` (private)                   | Design Taste plugin                             | See the 2026-10-09 handoff §8.                                                                              |
| `Leonxlnx/taste-skill`                              | Open-source design skills, tasteskill.dev       | ~40 community PRs, most are Leon's content calls.                                                           |
| `Leonxlnx/taste-skill-landing`, `Leonxlnx/Leonxlnx` | Skill site, profile                             | Context only.                                                                                               |

## 7. Practical notes

- A fresh cloud clone of this repo is shallow: `git fetch --unshallow` before merge-base
  work.
- In a fresh worktree, build the shared packages (`pnpm -r --filter "./packages/*" build`)
  before running vitest or tsc in one package.
- `D:\personalharness` on Leon's laptop is an old, dirty checkout with other agents'
  worktrees. Do not pull, reset or clean it (2026-10-09 handoff §1).
