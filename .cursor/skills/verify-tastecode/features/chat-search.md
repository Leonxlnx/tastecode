# Chat search

Chat search looks through titles, messages, commands, and tool output. With no projects and no chats it opens on an empty result, which is the state a fresh verification profile can prove.

## Sub-features

- `search-open` opens the search dialog.
- `search-empty` shows no chat rows when the profile has no chats.
- `search-close` returns to the sidebar.

## How to get to it (user POV)

- Choose `Search chats` in the sidebar. Its accessible name is `Search chats`.
- Press Ctrl+Shift+F or Cmd+Shift+F.
- Open the command palette and choose `Search chats` when that command is listed.

## Driving it with drive.mjs

Preconditions:

- Onboarding is closed so the sidebar control is reachable.
- The disposable profile has no chats.
- `drive.mjs doctor` reports the disposable data directory.

- **Open search.** Choose `Search chats`. Run `node .cursor/skills/verify-tastecode/scripts/drive.mjs click --name "Search chats"` and `node .cursor/skills/verify-tastecode/scripts/drive.mjs wait-text --text "Search"`. A dialog named `Search all chats` appears, with a field named `Search every chat`.
- **Empty state.** Leave the query empty. The results region named `Search results` has no chat title from this profile.
- **Close.** Choose `Close`. Run `node .cursor/skills/verify-tastecode/scripts/drive.mjs click --name "Close"`. The dialog is gone. There is a second control named `Close search`; either name dismisses the dialog.
- **Proof.** While the dialog is open, run `node .cursor/skills/verify-tastecode/scripts/drive.mjs snapshot --path "$VERIFY_TASTECODE_EVIDENCE/chat-search/empty.aria.txt"` and `node .cursor/skills/verify-tastecode/scripts/drive.mjs screenshot --path "$VERIFY_TASTECODE_EVIDENCE/chat-search/empty.png"`. The artifacts show `Search all chats` and no saved chat title.

## Gotchas

- The field's accessible name is `Search every chat`, and it is not wrapped in a `<label>`. `fill --label` will not type a query. An empty-state proof does not need a query.
- Ctrl+Shift+F is not sent by `drive.mjs`. Use the `Search chats` button for the driven entry point.
- Search is not proof of a chat. Creating a chat needs a project folder and a provider, which this fresh profile does not have.
