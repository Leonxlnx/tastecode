# Onboarding

Onboarding is the first-run dialog in the desktop window. It asks for a name, a theme, which coding agents to set up, and a project folder. Every page can be skipped, and the answers stay available in Settings.

## Sub-features

- `onboarding-welcome` shows `Welcome to TasteCode` and `Begin setup` on an empty disposable profile.
- `onboarding-name` saves a display name from the `Your name` field.
- `onboarding-appearance` applies `System`, `Light`, or `Dark` immediately.
- `onboarding-agents` lists Codex, Claude Code, and Grok with a setup action when the agent is not ready.
- `onboarding-project` offers `Choose a folder` and `Skip for now`.
- `onboarding-skip` closes the dialog from `Skip setup` and leaves the saved name on the account control.

## How to get to it (user POV)

- Open the desktop app with no projects and without a dismissed onboarding flag. The dialog appears on its own.
- There is no second button that reopens this exact pager during a normal session. Settings still edits name, appearance, and providers after dismissal.

## Driving it with drive.mjs

Preconditions:

- `drive.mjs doctor` reports ports `5183`, `4311`, and `9333` and the disposable data directory.
- The window text includes `Welcome to TasteCode`.
- No Electron profile exists yet under `$VERIFY_TASTECODE_DATA/desktop`.

- **Open the name page.** Choose `Begin setup`. Run `node .cursor/skills/verify-tastecode/scripts/drive.mjs click --name "Begin setup"` and then `node .cursor/skills/verify-tastecode/scripts/drive.mjs wait-text --text "What should we call you?"`. The heading reads `What should we call you?` and the field label is `Your name`.
- **Enter a name.** Type a display name. Run `node .cursor/skills/verify-tastecode/scripts/drive.mjs fill --label "Your name" --value "Verify Ada"`. The field shows `Verify Ada`.
- **Save and continue.** Choose `Continue`. Run `node .cursor/skills/verify-tastecode/scripts/drive.mjs click --name "Continue"` and then `node .cursor/skills/verify-tastecode/scripts/drive.mjs wait-text --text "Pick your look"`. The heading reads `Pick your look` and the choices are `System`, `Light`, and `Dark`.
- **Confirm the stored name.** Read the profile key and leave onboarding. Run `node .cursor/skills/verify-tastecode/scripts/drive.mjs storage --key harness.profile.displayName`, then `node .cursor/skills/verify-tastecode/scripts/drive.mjs click --name "Skip setup"` and `node .cursor/skills/verify-tastecode/scripts/drive.mjs wait-text --text "Verify Ada"`. The storage command prints `Verify Ada`, the onboarding dialog is gone, and the `Account` control shows `Verify Ada`.
- **Proof.** Capture the appearance page before skipping, and the account name after skipping. Run `node .cursor/skills/verify-tastecode/scripts/drive.mjs snapshot --path "$VERIFY_TASTECODE_EVIDENCE/onboarding/appearance.aria.txt"` and `node .cursor/skills/verify-tastecode/scripts/drive.mjs screenshot --path "$VERIFY_TASTECODE_EVIDENCE/onboarding/appearance.png"` while `Pick your look` is visible. After the account name is visible, run the snapshot and screenshot commands with `$VERIFY_TASTECODE_EVIDENCE/onboarding/account.aria.txt` and `$VERIFY_TASTECODE_EVIDENCE/onboarding/account.png`.

## Gotchas

- The next page is not visible until the leave animation finishes. Wait for the heading.
- `Continue` on the welcome page does not exist. The first button is `Begin setup`.
- `Skip setup` is hidden on the project page. That page uses `Skip for now`.
- `Choose a folder` opens the operating-system folder dialog. This harness cannot pick a folder there.
- `Set up Codex`, `Set up Claude Code`, and `Set up Grok` open Settings on top of onboarding. Do not click them when the proof only needs the name.
- Cursor is not an onboarding plan row. It appears later under Settings › Providers.
- A name typed into the field is not stored until React commits the input. Use `fill`, which inserts text into the focused field, then check `harness.profile.displayName`.
