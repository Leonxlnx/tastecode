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
- **Bug fixes go to `main` as well**, as a separate draft PR, whenever the affected code
  exists on `main`. Nightly-only code (extra providers, direct API, dashboards) stays on
  `nightly`.
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
- **"Latest TasteCode" means a build from the newest `nightly` commit**, not the published
  release. On Leon's laptop the nightly build folder is `D:\tastecode-nightly-build\repo`
  (installer in `release\`).

## Branches in one paragraph

`main` is the public beta source (currently released as v0.1.1) and ships only Codex, Claude
Code and Grok. `nightly` carries everything: extra providers, direct API connections, the
dashboard reference library. They are separate on purpose. Changes the beta needs go to
`main` and reach `nightly` by a normal `main` → `nightly` merge that must keep `nightly`'s
provider code; everything else targets `nightly`. Never rebase or force-push a shared
branch. See `AGENTS.md` and `rules/git.md`.

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
