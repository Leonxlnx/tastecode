# Settings

Settings is the dialog for profile, appearance, providers, models, and app data. Provider accounts for Codex, Claude Code, Grok, and Cursor are listed under Accounts.

## Sub-features

- `settings-open` opens the dialog from the account menu or the command palette.
- `settings-providers` shows the Accounts list, including Cursor.
- `settings-appearance` shows theme controls that match the onboarding choices.
- `settings-close` returns to the app with `Back to app`.

## How to get to it (user POV)

- Open the `Account` menu at the bottom of the sidebar and choose `Settings`.
- Open the command palette and choose `Settings`.
- Press Ctrl+, or Cmd+, (`Open settings` in the keybind list).
- During onboarding, choose `Set up` on a coding agent that still needs attention. That opens Providers and keeps onboarding underneath.

## Driving it with drive.mjs

Preconditions:

- Onboarding is closed. Follow `onboarding.md` through `Skip setup`, or start from a profile that already dismissed onboarding.
- `drive.mjs doctor` reports the disposable data directory.

- **Account entry.** Choose `Account`, then `Settings`. Run `node .cursor/skills/verify-tastecode/scripts/drive.mjs click --name "Account"` and `node .cursor/skills/verify-tastecode/scripts/drive.mjs click --name "Settings"`. A dialog named `Settings` appears. The default category is Providers.
- **See Cursor.** Wait until the accounts finish their first check. Run `node .cursor/skills/verify-tastecode/scripts/drive.mjs wait-text --text "Cursor"`. The Accounts group includes `Cursor` as well as `Codex`, `Claude Code`, and `Grok`.
- **Appearance category.** Choose `Appearance`. Run `node .cursor/skills/verify-tastecode/scripts/drive.mjs click --name "Appearance"` and `node .cursor/skills/verify-tastecode/scripts/drive.mjs wait-text --text "Appearance"`. The appearance section is shown.
- **Close.** Choose `Back to app`. Run `node .cursor/skills/verify-tastecode/scripts/drive.mjs click --name "Back to app"`. The Settings dialog is gone and the sidebar is visible again.
- **Proof.** Capture the Providers page with Cursor visible. Run `node .cursor/skills/verify-tastecode/scripts/drive.mjs snapshot --path "$VERIFY_TASTECODE_EVIDENCE/settings/providers.aria.txt"` and `node .cursor/skills/verify-tastecode/scripts/drive.mjs screenshot --path "$VERIFY_TASTECODE_EVIDENCE/settings/providers.png"`.

## Gotchas

- The first paint can say `Checking account…` for every provider. Wait for a settled status such as `Not signed in`, `Sign in`, or `Not installed` before treating the row as ready.
- `Sign in` on a provider can open a browser or an install terminal. Do not click it unless the proof is specifically the sign-in flow.
- Ctrl+, toggles settings. Pressing it again closes the dialog.
- Onboarding's agent list does not include Cursor. Use this Settings page to see that row.
