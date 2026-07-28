# Code rules

## Cross-platform — non-negotiable

These are what silently break a two-OS team.

- **Line endings:** enforced by `.gitattributes`. Never set `core.autocrlf true`.
- **Paths:** always `node:path`. Never concatenate with `/` or `\`. Never assume a POSIX shell.
- **Scripts:** Node/TypeScript only. **Never a `.sh` file** — it breaks one of us.
- **Case sensitivity:** macOS is case-insensitive, Linux CI is not. Import paths must match
  filenames exactly.
- **Reserved names:** never create files named `con`, `aux`, `nul`, `prn`, `com1`–`com9`,
  `lpt1`–`lpt9`. Windows can't check them out and the repo becomes uncloneable.
- **Path length:** Windows caps at 260 chars. Keep nesting shallow — worktrees plus
  `node_modules` eat the budget fast.
- **Symlinks:** don't commit them. Windows needs Developer Mode or admin.
- If behavior differs between Windows and macOS, document it **at the code**, not later by
  the other person discovering it.

## Style

Match the surrounding code — comment density, naming, idiom. No explanatory comments for
obvious code. No TODOs without an issue link.

## Performance is a correctness property

The budgets in
[ARCHITECTURE.md → Long threads](../docs/ARCHITECTURE.md#long-threads-must-feel-instant)
are acceptance criteria. **A change that regresses one is a broken change.**

## Decisions

Non-obvious decisions go in [ARCHITECTURE.md](../docs/ARCHITECTURE.md) with the rejected
alternatives written down — that's the valuable part. To change one, edit it there and add a
change-log row. Never quietly diverge in code.

## Docs

**Five docs and three rule files. Keep it that way.** Add to the right one instead of
creating another. A new top-level doc needs a reason you can say out loud.

## Working with the agent

- Tasks come from the two humans; the agent plans and executes.
- Ambiguity that changes the _shape_ of the work → it asks. Ambiguity that doesn't → it
  decides, proceeds, and flags the assumption in the PR.
- The agent opens draft PRs early so you can redirect before the work is finished.
- **Design review is human.** The agent produces visuals; you decide if they're good.
