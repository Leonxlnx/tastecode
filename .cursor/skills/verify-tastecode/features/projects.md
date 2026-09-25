# Projects

Projects are folders in the sidebar. A new desktop profile has none, which is why onboarding asks for the first one. Adding a project uses the operating-system folder picker.

## Sub-features

- `projects-empty` shows onboarding, then an empty sidebar after setup is skipped.
- `projects-add` starts the folder picker from the sidebar, the shortcut, or the command palette.
- `projects-named` shows the folder's display name in the sidebar after the picker returns.

## How to get to it (user POV)

- Choose `New project` in the sidebar. Its accessible name is `New project`.
- Press Ctrl+Shift+O or Cmd+Shift+O.
- Open the command palette and choose `New project`.
- On the onboarding project page, choose `Choose a folder`.

## Driving it with drive.mjs

Preconditions:

- Onboarding is closed so the sidebar is the top layer.
- `drive.mjs doctor` reports the disposable data directory.
- The proof machine can complete a native folder dialog, or the run stops before claiming a folder was added.

- **Empty sidebar.** After `Skip setup`, look at the sidebar. Run `node .cursor/skills/verify-tastecode/scripts/drive.mjs wait-text --text "New project"`. The `New project` control is present and no project name from a previous profile is listed.
- **Start add.** Choose `New project`. Run `node .cursor/skills/verify-tastecode/scripts/drive.mjs click --name "New project"`. The operating-system folder picker opens. This harness does not select a folder.
- **Proof of the empty state.** Before opening the picker, run `node .cursor/skills/verify-tastecode/scripts/drive.mjs snapshot --path "$VERIFY_TASTECODE_EVIDENCE/projects/empty.aria.txt"` and `node .cursor/skills/verify-tastecode/scripts/drive.mjs screenshot --path "$VERIFY_TASTECODE_EVIDENCE/projects/empty.png"`. The artifacts show TasteCode and `New project` without a selected project.

## Gotchas

- The folder picker is not a DOM dialog. A click on `New project` or `Choose a folder` is not proof that a project was added.
- Dismiss a stray picker before the next CDP click, or the click lands behind it.
- Project names are stored in the server database under `HARNESS_DATA_DIR`. Cleanup deletes that directory. Do not point `HARNESS_DATA_DIR` at the real TasteCode data folder.
