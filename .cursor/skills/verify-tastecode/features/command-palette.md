# Command palette

The command palette finds commands, projects, and chats. From an empty profile it still lists app commands such as Settings and New project.

## Sub-features

- `palette-open` opens the dialog from the keyboard shortcut.
- `palette-search` filters commands by the search box.
- `palette-run` runs the highlighted command and closes the palette.
- `palette-close` dismisses the dialog without running a command.

## How to get to it (user POV)

- Press Ctrl+K or Cmd+K.
- Choose `Command palette` from the window menu in the stage header when that menu is open.

## Driving it with drive.mjs

Preconditions:

- Onboarding is closed. The palette shortcut is ignored while the onboarding dialog is handling keys.
- `drive.mjs doctor` reports the disposable data directory.

- **Open.** The harness has no key-press helper yet. Open it from a control only if one is visible; otherwise report this entry point as not driven and do not claim the shortcut was verified.
- **Search.** When the dialog named `Command palette` is open, the search box is named `Search commands`. Run `node .cursor/skills/verify-tastecode/scripts/drive.mjs fill --label "Search commands"` only if that node is a label. The current search box uses `aria-label="Search commands"` and has no `<label>`, so `fill` will not find it. Report that gap instead of typing into a different field.
- **Close.** Choose `Close command palette` only when that button is focusable. Its button is `tabIndex={-1}` on the scrim, and `click` looks for `button` elements, so a scrim click may still hit it by name.
- **Proof.** When the dialog is open, run `node .cursor/skills/verify-tastecode/scripts/drive.mjs snapshot --path "$VERIFY_TASTECODE_EVIDENCE/command-palette/open.aria.txt"` and `node .cursor/skills/verify-tastecode/scripts/drive.mjs screenshot --path "$VERIFY_TASTECODE_EVIDENCE/command-palette/open.png"`. The artifacts name `Command palette` and show at least `Settings`.

## Gotchas

- `drive.mjs` cannot send Ctrl+K. Do not mark `palette-open` verified because Settings was opened another way.
- The search field has an accessible name and no label element. `fill --label` does not target it.
- Choosing `New project` from the palette opens the native folder picker.
- Onboarding captures Enter and clicks. Close it before trying the palette.
