# Claude Code instructions

Claude Code loads this file automatically. The repository's agent rules live in
`AGENTS.md` and apply to every agent; they are imported here:

@AGENTS.md

## Current state: read before acting

[docs/handoff/2026-10-11/CURRENT-STATE.md](./docs/handoff/2026-10-11/CURRENT-STATE.md) is the
latest handoff: release state, the `main`/`nightly` gap, open PRs, what is waiting on Leon,
and known bugs. It supersedes the 2026-10-09 handoff (`docs/CLAUDE-HANDOFF.md`, on
`nightly` only; from `main` use `git show origin/nightly:docs/CLAUDE-HANDOFF.md`) wherever
the two differ. Both are dated snapshots: recheck live GitHub state
(`git fetch`, open PRs, releases) before relying on a number in them.

## Who is who

- **Leon** (`Leonxlnx`): owner. Product direction, Windows, all taste calls. Writes casually,
  mixes English and German; everything in the repo stays English.
- **Karol** (`Blueemi`, "bluedev"): macOS, including signing and notarization, and much of
  the visual UI.
- **yqecea**: Linux release line and process-ownership PRs.

## Working with Leon

These rules come from Leon. When a Claude session works for him, they take precedence over
the more permissive merge rule in `AGENTS.md`.

- **Never decide anything that is a matter of taste**: visual design, layout, copy, look and
  feel, naming that users see. Find the options, report them, and let Leon choose. Do not
  change them on your own.
- **Draft PRs by default. Merge only when Leon says so for those specific PRs.** A "go" for
  one set of PRs is not a standing go for the next.
- **Bug fixes go to `dev` like everything else.** A fix the public beta needs before the
  next promotion also gets a separate draft PR against `main` (a hotfix) when the affected
  code exists on `main`; Leon merges it, and it is then merged down to `nightly` and `dev`.
- **Clean up after merges without asking.** Once a PR is merged, delete its branch after
  checking the tip is unchanged and no open PR uses it; keep a restore list (branch + SHA).
  Do not offer it as an option. Still ask before anything other people see (closing
  contributor PRs or issues, commenting on them).
- **Report results, not pointers.** When work finishes, hits a blocker or needs Leon, give
  him a short plain summary of what was done or found. "See the PR" is not a summary.
- **Do the work yourself.** Leon does not want commands handed to him to run, or repeated
  approval questions for work he already authorized. Ask only when the answer changes the
  goal, a taste call, or something that cannot be undone.
- **Be exact.** Do not call something tested, signed, released or fixed unless it was. Leon
  has been burned by premature success claims.
- **"Latest TasteCode" or "the dev version" means a build from the newest `dev` commit**;
  "the nightly version" means a build from `nightly`. Neither is the published release. On
  Leon's laptop the build folder is `D:\tastecode-nightly-build\repo` (installer in
  `release\`); check out the branch Leon asked for there before building.

## Branches in one paragraph

Three long-lived branches, in this order: `dev` → `nightly` → `main`. All work starts from
`dev` and lands there by PR. `nightly` takes promotions from `dev` (merge-commit PR) when a
set of changes works; `main`, the public beta (currently released as v0.1.1, shipping only
Codex, Claude Code and Grok), takes promotions from `nightly` only after Leon tested it.
Hotfixes for the beta may go to `main` as draft PRs and are merged down to `nightly` and
`dev` the same day. Never rebase or force-push a shared branch. See `AGENTS.md` and
`rules/git.md`.

## Permissions (why sessions can or cannot bypass)

- Bypass permissions only exist in Claude Code that Leon starts himself:
  `claude --dangerously-skip-permissions`, `permissions.defaultMode: "bypassPermissions"` in
  `~/.claude/settings.json`, or in the desktop app with Settings > Claude Code > "Allow
  bypass permissions mode" turned on.
- Sessions started from a claude.ai project on Leon's laptop (Remote Control) always run in
  auto mode, and cloud sessions never get bypass. That is how the product works, not a
  misconfiguration.
- In auto mode, a blocked action is allowed with an `autoMode.allow` entry (plain-language
  rule, keep `"$defaults"`) in the user settings file (`C:\Users\User\.claude\settings.json`
  on Leon's laptop). Project `.claude/settings*.json` files are not read for it, and
  `Bash(node:*)`-style allow rules are suspended in auto mode. Settings load when a session
  starts, so restart the session after changing them.
- Cloud sessions cannot delete remote branches (the git proxy only allows pushes to the
  session's own branch). Branch deletes need a local session.
