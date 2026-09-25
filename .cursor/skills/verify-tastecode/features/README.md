# TasteCode verification map

This directory is the maintained source for verifying the user-facing behavior of TasteCode. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch with `node .cursor/skills/verify-tastecode/scripts/drive.mjs launch` from the repository root.
- Node on `PATH` is `>=22.18.0`. Linux has `DISPLAY` set.
- `VERIFY_TASTECODE_DATA`, `VERIFY_TASTECODE_STATE`, and `VERIFY_TASTECODE_EVIDENCE` point at three different directories. Data and state are disposable. Evidence is kept.
- The disposable data directory starts empty, so the desktop window opens onboarding.
- Run `drive.mjs doctor` and require Node `>=22.18.0`, ports `5183`, `4311`, and `9333`, and a page on `http://127.0.0.1:5183`.
- Never drive an instance that was not started by this verification run.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer accessible names (`Begin setup`, `Your name`, `Account`, `Settings`, `Command palette`) over CSS selectors or screen coordinates.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run window actions through `node .cursor/skills/verify-tastecode/scripts/drive.mjs`.
- Wait for the next heading or dialog name after a click. Onboarding animates between pages.
- Restore nothing in the user's real TasteCode profile. The disposable directories are the only state this run may create.
- Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an accessibility snapshot and a screenshot with TasteCode visible.
- Stored values need a second user-facing view. For the profile name, that view is the `Account` button after setup closes.
- Record the feature file and the entry point in the transcript.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with drive.mjs` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Onboarding](./onboarding.md) covers the first-run welcome, name, appearance, agents, and project pages.
- [Settings](./settings.md) covers the settings dialog, provider accounts, and appearance.
- [Projects](./projects.md) covers adding a project folder from the sidebar, shortcut, and command palette.
- [Command palette](./command-palette.md) covers opening the palette and running Settings from it.
- [Chat search](./chat-search.md) covers opening search and the empty result state before any chat exists.
