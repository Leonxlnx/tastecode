# Audit triage — 3 October 2026

One list of every finding from the three audits run on 3 October 2026, checked against the
current working tree (local `main` at `430d14944` plus uncommitted changes). Each finding was
traced in source; a few were reproduced with throwaway scripts. Line numbers drift while other
sessions edit the tree, so find code by name.

**Sources**

- `E01`–`E50`: connection edge-case audit, [AUDIT-FIXES.md](./AUDIT-FIXES.md)
- `#1`–`#53`: [app-and-design-agent-audit-2026-10-03.md](./app-and-design-agent-audit-2026-10-03.md)
- `NN-NNN`: astra audit, `scratch/astra-audits-2026-10-03/reports/` (975 findings across 10
  lenses; 8 lenses were still in progress). Astra repeats many findings across lenses; duplicate
  IDs are listed together.

**Severity**

- **Critical**: permission or security bypass, user data loss, or an app/server crash in an
  everyday flow.
- **High**: a common flow is broken or stuck with no in-app recovery, or silent permanent loss
  behind an uncommon trigger.
- **Medium**: real, but needs a race or unusual sequence, or is recoverable by retry or reload.
- **Low**: cosmetic, rare setup, or minor.

**Totals** (rows, with duplicates grouped): 3 critical · 11 high · 32 medium · 40 low, all
fixed in the working tree · 31 fixed before this triage · 1 dismissed · 23 astra critical/high
claims verified and fixed · the remaining astra medium/low claims are tracked in
[Astra follow-up status](#astra-follow-up-status-4-october-2026).

> This record was written against an uncommitted working tree, which is why it says "working
> tree" throughout. Since 4 October every fix it lists, the follow-up below included, is on
> `main`.

## Resolution status

Every confirmed row and every listed astra critical/high claim is resolved in the working tree.
The finding tables further down are kept as the original record.

**Validation:** `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` all pass on the
working tree. That covers server 925, web 1,891, desktop 359, Codex 156, Claude Code 112, proc 95,
Grok 63, ACP 45, design agent 203, contracts 54 and tooling 64 tests. Only the known Vite
chunk-size warning remains. A built server on a spare port accepted no Origin, `file://` and
`http://127.0.0.1:5183`. It closed `http://127.0.0.1:5173`, `http://localhost:5183` and
`https://example.com` with code 1008.

**Not validated:** No Windows runtime run (`spawnCli` cmd escaping, IPC shutdown, renderer crash
recovery, `dev.js` port ownership). No real provider account, signed installer or live update.

**Contract changes** in `packages/contracts`:

- PR `review` requires `commitId`; `merge` and `enable_auto_merge` require `expectedHeadOid`.
- `pullRequests.files` takes the expected head and base OIDs and returns `headRefOid` and
  `baseRefOid`.
- `UserInputQuestion` gains optional `multiSelect`.
- New `workspace.searchFiles` RPC.

**Behavior decisions:**

- "Archive" is now "Delete" everywhere, with the same 10-second Undo window. Selecting or sending
  in a pending chat cancels its deletion.
- Starting a chat no longer deletes old "New session" chats.
- An access change that a running or non-resumable session cannot apply is refused, not
  silently saved.
- Restore (#33) cannot erase provider memory. The next prompt carries a one-time hidden notice
  that later turns were removed, and that notice survives a restart.
- A second Design run in the same non-isolated checkout is refused (#10).
- Pasted files are never pruned by age.

### Critical and high

| ID(s)               | Status | Fix                                                                                                                                                |
| ------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1                  | Fixed  | Print-mode Grok applies the new mode to its next turn. A session without live mode changes restarts when idle and resumable; otherwise it refuses. |
| 02-086 group        | Fixed  | `Object.hasOwn` icon lookup, with a regression test.                                                                                               |
| #8, 03-129          | Fixed  | Merges and auto-merge pass `--match-head-commit`; reviews carry the inspected `commit_id`.                                                         |
| 10-107, 02-055, #50 | Fixed  | Delete wording (see above); selecting or sending cancels a pending deletion; Shift-select covers visible rows only.                                |
| 01-050, #53         | Fixed  | New checkouts go to `trees` beside the database (`HARNESS_WORKTREE_DIR` overrides). Pasted files go to app data; old temp paths stay readable.     |
| 08-004              | Fixed  | Exact-origin WebSocket gate; see validation above.                                                                                                 |
| 03-105 group        | Fixed  | Replies target the thread's first comment.                                                                                                         |
| 06-019 group        | Fixed  | `spawnCli` runs native executables directly and escapes cmd metacharacters for `.cmd`/`.bat` shims. Not run on Windows.                            |
| 03-085              | Fixed  | Onboarding no longer covers the sign-in and install terminal.                                                                                      |
| 02-003 group        | Fixed  | The automatic "New session" cleanup is removed.                                                                                                    |
| #11                 | Fixed  | Uploaded SVG logos from the asset manifest pass Build.                                                                                             |
| #39, E11            | Fixed  | Claude and ACP sessions report a disconnect; the server drops the dead runtime and the next send resumes the saved session.                        |
| 04-010 group        | Fixed  | `@opencode-ai/sdk` removed from both license tables; the license test passes 5/5. `licenses/npm/opencode-sdk-1.18.11-MIT.txt` is now unreferenced. |
| E22                 | Fixed  | Drops resolve native paths through `webUtils.getPathForFile`.                                                                                      |

### Medium

| ID(s)              | Status | Fix                                                                                                |
| ------------------ | ------ | -------------------------------------------------------------------------------------------------- |
| #3                 | Fixed  | Side chats keep durable import markers through close and restart.                                  |
| #35                | Fixed  | Approval and input requests take precedence over Working.                                          |
| #33                | Fixed  | One-time hidden restore notice, stored in the database (see above).                                |
| #5, 02-004 group   | Fixed  | Failed-start drafts return to their own chat; the resumed first send keeps the moved draft.        |
| #4                 | Fixed  | Side chats record the parent's checkout for locks and checkpoints.                                 |
| #34                | Fixed  | Side chat startup is fenced by Stop all and shutdown.                                              |
| #9                 | Fixed  | Stop all suspends Design, aborts preview start and capture, and cancels native capture.            |
| #21, #23, #24, #25 | Fixed  | Side chat answer retry, generation checks, duplicate-safe resend, and attachments kept on failure. |
| #29                | Fixed  | The server rejects a missing queued prompt; edit restores text only after confirmed deletion.      |
| 02-025 group       | Fixed  | Switching chats cancels a running dictation, so its text never reaches another chat.               |
| #20, #14, #17      | Fixed  | Video and PDF preview types; font magic-byte checks; legitimate interface states allowed.          |
| #37                | Fixed  | Search skips dropped rows until it has a full page plus one, so `hasMore` is accurate.             |
| #28                | Fixed  | Refresh reloads the open file too.                                                                 |
| #46, #47           | Fixed  | File diffs are keyed by path; a successful send keeps a newer draft.                               |
| #42                | Fixed  | Claude tool approval cards carry the tool name and arguments.                                      |
| #41, E36           | Fixed  | Grok marks a native session only after startup evidence.                                           |
| E16                | Fixed  | Account reads are invalidated at sign-out start and completion.                                    |
| #51, E28           | Fixed  | A verified download is kept after any preparation failure except an invalid signature or package.  |
| E29                | Fixed  | A crashed renderer reloads once, then offers Reload. Not run on Windows.                           |
| #36, E45           | Fixed  | Restore undo keeps `provider_history_events` links.                                                |
| 02-005 group       | Fixed  | The Undo token is stored before refreshes.                                                         |
| 01-002, 05-012     | Fixed  | Access changes are serialized per chat; dispatch waits for them.                                   |
| 01-005 group       | Fixed  | A failed Stop rejects without marking the turn idle or releasing locks.                            |
| 09-033, 10-060     | Fixed  | The delta flush timer catches database errors and retries.                                         |
| 09-031, 08-013     | Fixed  | `gh` stdin errors are handled.                                                                     |

### Low

All fixed: #2, #10, #12, #13 (review requires every planned viewport), #15, #16, #18, #19, #22
(Side chat questions render inline), #26, #30 (server-side `workspace.searchFiles`), #31, #32,
#38, #40, #43 (multi-select questions), #45/E35, #52, E05 (10-second connect timeout), E15, E17,
E21 (a pending paste stays with its original draft), E30, E33, E44, E46 (old replay snapshots
are rebuilt once), E47, E48, E49, the Codex candidate, 07-044, 01-004, 01-001, 01-036, 09-075,
01-074, 05-056/09-152, 02-006 and 04-029 (IPC shutdown; not run on Windows).

E23 is fixed for reload and cache eviction. An app restart still ends the picker's
authorization, so a thumbnail for an external image picked before the restart is unavailable.

The leftovers noted under "Fixed in the uncommitted working tree" are also fixed: queued work
resumes after a provider crash (E03/E08/#6), validator-load failures are indeterminate (E04),
and an uncertain answer reloads history (E37).

### Astra claims that were not verified before

All listed claims were checked and fixed: 01-003 (archives include provider history), 01-006
(a double restore failure keeps the original files as a recovery checkpoint), 01-030,
01-033/09-113, 01-059/05-053 (diff rejection takes exclusive checkout access), 01-083, 09-072,
02-007, 02-010 (prompt checkpoints match only the following local snapshot), 02-015, 02-038,
02-043, 02-081, 02-087, 10-166, 03-056/09-082, 08-077/03-057, 03-129, 06-037, 06-044, 10-055,
07-037, 07-058 (one brief correction, then a visible failure) and 04-001. The roughly 880 astra
medium/low claims remain unverified.

## Critical

| ID(s)                          | What happens                                                                                                                                                                                                                                                                                 | Where                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| #1                             | A live Grok chat switched from Full access to Ask keeps running every turn with `--permission-mode bypassPermissions` until the idle runtime is released (about 5 min) or the app restarts. Print-mode Grok has no `setApproval`, so only the saved setting changes.                         | `orchestrator.ts` `setThreadApproval`; `adapters.ts` `AgentSession.setApproval`; `adapter-grok/src/adapter.ts` `grokTurnArgs` |
| 02-086, 03-001, 09-083, 10-017 | Inline code such as `constructor`, `__proto__` or `Foo.constructor` in a reply crashes rendering ("Cannot read properties of undefined (reading 'Icon')"). The chat view has no error boundary of its own, so the whole app falls to the recovery screen. Reproduced. In committed code too. | `apps/web/src/ui/FileTypeIcon.tsx` `iconKind` (plain-object lookup)                                                           |
| #8                             | Merge runs `gh pr merge <url> --<method>` without `--match-head-commit`. The PR detail never refreshes, so commits pushed after the user reviewed get merged unseen. The fix needs a `packages/contracts` field first.                                                                       | `apps/server/src/pull-requests.ts` merge action                                                                               |

## High

| ID(s)                          | What happens                                                                                                                                                                                                                                                                                                                                                           | Where                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 10-107, 02-055, #50            | "Archive chat" permanently deletes the transcript and checkpoints after 10 s; there is no archive to restore from. Clicking View in the toast and sending a prompt still lets the timer delete the chat and the new turn (02-055). Shift-select includes chats in collapsed sections and beyond page limits, so bulk delete can remove chats the user never saw (#50). | `App.tsx` `archiveSession`; `ui/ArchiveToast.tsx`; `ui/InboxSidebar.tsx` range select        |
| 01-050, #53                    | Durable data lives in the OS temp folder: isolated chat checkouts in `os.tmpdir()/tastecode-trees` (no production override), and pasted attachments in `<temp>/TasteCode/pasted-files` whose paths are saved in chat history. OS temp cleanup can remove uncommitted work in an isolated chat, break old image previews, and stop a paused Design run.                 | `orchestrator.ts` `#worktreeRoot`; `apps/desktop/src/main.ts` pasted-file writer             |
| 08-004                         | With no access token, the server accepts WebSocket connections from any loopback origin on any port. A page from the Design preview, the user's own dev server, or an agent-built site with injected script can open a terminal through the control socket and run commands, bypassing Ask.                                                                            | `apps/server/src/server.ts` `allowedOrigin`                                                  |
| 03-105, 10-159, 08-069, 09-032 | Replying to a PR review thread that already has a reply fails: the reply targets the last comment's id, and GitHub's replies endpoint only accepts the thread's first comment.                                                                                                                                                                                         | `ui/pull-requests/PullRequestDetailPane.tsx` `ReviewThreadCard`                              |
| 06-019, 10-108, 08-003         | On Windows, `spawnCli` routes through `cmd.exe`. The PR files URL `…/files?per_page=100&page=1` has no spaces, so it is passed unquoted and split at `&`; the stray `page=1` command fails and the PR Files request likely errors. Body text goes through stdin, so this is not an injection. Traced in code; not run on Windows.                                      | `packages/proc/src/cli.ts`; `pull-requests.ts` files endpoint                                |
| 03-085                         | First-run onboarding covers the CLI sign-in and install terminal. Opening the terminal closes Settings, and Settings is the only thing that hides onboarding (`z-index: 60`). Hits every new desktop user who sets up a provider from onboarding.                                                                                                                      | `App.tsx` `openProviderLoginTerminal`, `<Onboarding hidden={settingsOpen}>`                  |
| 02-003, 10-004, 08-024, 09-006 | Starting a new chat deletes every non-isolated chat in that project still titled "New session", with no content check, permanently. A populated chat keeps that title if renamed to it or if its first automatic rename request failed.                                                                                                                                | `App.tsx` `beginSession`                                                                     |
| #11                            | An uploaded SVG logo passes the Assets phase, then Build rejects it as an unmanifested standalone SVG. The asset manifest is locked, so the run fails every time.                                                                                                                                                                                                      | `packages/design-agent/src/source-quality.ts`                                                |
| #39, E11                       | After the Claude CLI process dies, every send fails with "prompt stream is not running" for about 5 idle minutes. The Claude session has no disconnect signal, so the server keeps the dead adapter. Grok MCP mode (ACP) has the same gap.                                                                                                                             | `adapter-claude-code/src/adapter.ts` `#sendTurn`; `apps/server/src/adapters.ts` `sessionFor` |
| 04-010, 10-027, 09-066         | Release blocker in the working tree: the license notice table still lists `@opencode-ai/sdk` after the provider removal. `node --test tools/scripts/release-licenses.test.js` fails 1 of 5 tests.                                                                                                                                                                      | `licenses/direct-runtime-dependencies.json`                                                  |
| E22                            | Dropping a file over 25 MiB is refused. Electron 43 removed `File.path`, so every drop is copied through the 25 MiB clipboard path; `webUtils.getPathForFile` is exposed only for folder drops.                                                                                                                                                                        | `ui/Composer.tsx` `file.path`; `apps/desktop/src/preload.ts`                                 |

## Medium

All confirmed in the current code.

| ID(s)                                  | What happens                                                                                                                                                                                                                                | Where                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| #3                                     | A closed Side chat returns as a saved chat within about 15 s. Side chats are skipped at import only while their row exists; closing deletes the row and leaves no tombstone. Side chats are also cleared at every restart.                  | `orchestrator.ts` `closeSideThread`; `provider-history.ts`       |
| #35                                    | The sidebar shows Working while the agent waits for an approval or answer: `inboxStatus` returns `working` for any active turn before checking approvals and inputs.                                                                        | `orchestrator.ts` `inboxStatus`                                  |
| #33                                    | Checkpoint restore rewinds files and the stored transcript, but the provider session still remembers the removed turns. A design gap, not a regression.                                                                                     | `orchestrator.ts` `restoreCheckpoint`                            |
| #5                                     | If a new chat fails to start after the user switched chats, `restoreDraft` writes its text and attachments into the chat that is active at failure time.                                                                                    | `App.tsx` `restoreDraft`                                         |
| 02-004, 10-006, 08-070                 | Text typed while a new chat starts is moved to the new chat's draft, then the resumed first send calls `forgetDraft` and erases it.                                                                                                         | `App.tsx` `moveDraft` then `forgetDraft(threadId)`               |
| #4                                     | Side chats are saved without the parent's private checkout, so their lock and checkpoints cover the main folder. Restore in an isolated main chat can rewrite files the Side chat agent is writing.                                         | `orchestrator.ts` side-thread `addThread`, `#repoPath`           |
| #34                                    | Side chat startup never checks Stop all, so a Side chat that is starting attaches after Stop all and can run a prompt sent during startup.                                                                                                  | `orchestrator.ts` side-thread creation                           |
| #9                                     | Stop all does not cancel Design preview or screenshot capture, and the chat's own Stop button is hidden then; the next Design phase still starts. Contradicts F02 in AUDIT-FIXES.md.                                                        | `orchestrator.ts` design phase driver, `panicStop`               |
| #21                                    | A failed Side chat answer stays on "Submitting answers…": the handler swallows the error, so the question form never gets its retry state.                                                                                                  | `ui/workspace/WorkspaceSideChat.tsx` `answer`                    |
| #23                                    | A late Side chat send error clears the running state and restores its text into whichever chat is shown now; there is no generation or parent check.                                                                                        | `WorkspaceSideChat.tsx` `sendPrompt` catch                       |
| #24                                    | A lost Side chat send reply is treated as a failure; resending uses a new submission id, so the server cannot detect the duplicate.                                                                                                         | `WorkspaceSideChat.tsx` `sendPrompt` catch                       |
| #25                                    | Blocked or failed Side chat sends restore the text but drop the attachments.                                                                                                                                                                | `WorkspaceSideChat.tsx` `sendPrompt`                             |
| #29                                    | Editing a queued prompt deletes it without waiting; if the server already drained it, both the original and the edited prompt run. Very narrow window.                                                                                      | `ui/Composer.tsx` `editQueuedTurn`                               |
| 02-025, 03-055, 08-058, 09-142         | Voice dictation that finishes after a chat switch inserts into, or sends through, the newly selected chat; the composer is not remounted per chat.                                                                                          | `ui/ComposerVoiceControl.tsx`; `Composer.tsx` `onTranscript`     |
| #20                                    | The static Design preview serves no video or PDF types. A local video makes preview start throw and the run fails; PDF links return 404.                                                                                                    | `apps/server/src/design-static-preview.ts`                       |
| #14                                    | A downloaded font is checked only for being non-empty, so an HTML error page saved as `.woff2` passes and the site silently falls back to another font.                                                                                     | `packages/design-agent/src/assets.ts`                            |
| #17                                    | Hard-error placeholder patterns reject legitimate interface copy such as "not connected", "test data" and "local preview".                                                                                                                  | `packages/design-agent/src/copywriting.ts`                       |
| #37                                    | Search `hasMore` is computed after the results query drops rows (removed projects keep their threads and search index), so "Load more" disappears early.                                                                                    | `apps/server/src/store.ts` session search                        |
| #28                                    | "Refresh files" reloads folders only; the open file keeps stale or deleted contents.                                                                                                                                                        | `ui/workspace/WorkspaceFiles.tsx` `refreshDirectories`           |
| #46                                    | `PullRequestFileDiff` has no `key`, so an unsent inline comment moves to the same line of the next file and posts there publicly.                                                                                                           | `ui/pull-requests/PullRequestFiles.tsx`                          |
| #47                                    | A successful PR comment send runs `setBody('')`, erasing a new draft typed while the send was pending.                                                                                                                                      | `PullRequestDetailPane.tsx`                                      |
| #42                                    | Claude approval cards for MCP and other tools use kind `permissions` with no tool arguments, and no tool name unless the CLI sends a title.                                                                                                 | `adapter-claude-code/src/adapter.ts` `approvalRequest`           |
| #41, E36                               | If Grok's first launch fails, `#nativeSessionCreated` is already true, so every retry uses `--resume` for a session that never existed; the chat is unusable.                                                                               | `adapter-grok/src/adapter.ts` `sendTurn`                         |
| E16                                    | An account read that starts during sign-out can return afterwards and show the provider signed in again until the next refresh.                                                                                                             | `ui/Settings.tsx`                                                |
| #51                                    | Failed update preparation keeps the verified download only for errors with codes like `ENOSPC`; `ditto`, `hdiutil`, `codesign`, timeouts and Squirrel errors delete about 500 MB and trigger silent re-downloads. E28 is only partly fixed. | `apps/desktop/src/release-updater.ts` `isTemporaryFileError`     |
| E29                                    | On Windows, a renderer crash is only logged; closing hides the window, so tray Open shows the same dead page until tray Quit.                                                                                                               | `apps/desktop/src/main.ts` `render-process-gone`                 |
| #36, E45                               | Undoing a restore re-inserts events without their `provider_history_events` links, so retired imported history comes back permanently.                                                                                                      | `apps/server/src/store.ts` `saveRestoreUndo`, `applyRestoreUndo` |
| 02-005, 10-142, 08-056, 09-145         | The restore Undo token is stored only after three refreshes succeed; a failed refresh loses Undo, and retrying Restore replaces the original backup.                                                                                        | `App.tsx` `restoreCheckpoint`                                    |
| 01-002, 05-012                         | Two quick access-mode changes: if the first fails, it restores the cached broader mode while the second succeeds; cold resume reads the cache first.                                                                                        | `orchestrator.ts` `setThreadApproval`, `#resumeThread`           |
| 01-005, 02-074, 05-026, 08-048, 09-118 | A failed Stop records `thread.error`, which marks the turn idle and releases the checkout lock while the agent may still be writing.                                                                                                        | `orchestrator.ts` `interrupt`, `thread.error` handling           |
| 09-033, 10-060                         | A SQLite error (disk full, lock timeout) in the delta flush timer is not caught; with no global handler, the server process crashes.                                                                                                        | `apps/server/src/recorded-delta-buffer.ts` `#flushWindow`        |
| 09-031, 08-013                         | The `gh` child's stdin has no `error` listener; an EPIPE when `gh` exits before reading a large body crashes the server.                                                                                                                    | `pull-requests.ts` `runGh`                                       |

## Low

All confirmed in code unless noted.

| ID(s)                          | What happens                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| #2                             | ACP "Allow once" would save "Allow always" if an agent offered only lasting approval. No known agent does; latent.      |
| #10                            | Two Design chats in one non-isolated folder overwrite each other's `.taste` files and both fail.                        |
| #12                            | "Create exactly index.html. Use photos from unsplash.com." makes `unsplash.com` a required file.                        |
| #13                            | Visual review can pass with a desktop screenshot only.                                                                  |
| #15                            | An external video counts as resolved with no local file or license.                                                     |
| #16                            | The reveal helper skips scroll animations under React Strict Mode in dev.                                               |
| #18                            | JPEG shape checks ignore EXIF rotation, so correct portrait phone photos can fail.                                      |
| #19                            | "Build an interface" counts as an explicit request for the Inter font.                                                  |
| #22                            | Side chat questions render inside the main chat's composer (portal targets the first `.composer__box`).                 |
| #26                            | Failed Side chat history recovery discards live events received while loading.                                          |
| #30                            | File filter only searches folders already opened (lazy tree; no server-side search).                                    |
| #31                            | A failed session search leaves old results under the new query.                                                         |
| #32                            | Thread search can show "5/2" after results shrink.                                                                      |
| #38                            | An MCP credential failure during isolated startup leaves a checkout and branch with no chat.                            |
| #40                            | A failed first Grok turn drops project instructions from the retry.                                                     |
| #43                            | Claude multi-select questions become single-choice; the shared question contract has no multi-select. By design today.  |
| #45, E35                       | An ACP prompt failure leaves the old approval responder and an "approval" sidebar badge until restart.                  |
| #52                            | Many older-version feed entries above a new release could cause a false "up to date". Practically unreachable.          |
| E15                            | Expired login with a rejecting `cancelLogin` stays on "Signing in". Not reachable from the shipped UI on `main`.        |
| E17                            | Reopening Providers during a pending sign-out can show a stale signed-in row.                                           |
| E21                            | A pasted file is dropped from the draft if the user switches chat before it finishes saving.                            |
| E23                            | Picked external images lose their thumbnail after reload or cache eviction.                                             |
| E30                            | `HARNESS_PORT` set for the packaged app splits server and renderer endpoints.                                           |
| E33                            | Removing a project while a provider start is pending re-adds it under its folder name.                                  |
| E44                            | One stalled model list hides healthy providers' models for up to 120 s.                                                 |
| E46                            | Older turns imported after a newer local turn can hide the latest diff and plan on reopen.                              |
| E47                            | Reloading the renderer during a slow capture blocks the retry behind the abandoned capture.                             |
| E48                            | A redirecting iframe is blank in review screenshots.                                                                    |
| E49                            | A `target=_blank` POST form in the embedded browser becomes a GET.                                                      |
| E05                            | A stalled WebSocket handshake waits for the browser timeout. Practically unreachable against the local server.          |
| Codex candidate                | A late Codex completion denies approvals without checking turn or thread. Reachability unproved.                        |
| 07-044                         | A Codex question id such as `constructor` crashes the question view (same class as the transcript crash). Not verified. |
| 01-004, 10-028, 08-001, 09-002 | Restore trims NUL-delimited names; needs a filename starting with a space. Astra rated critical.                        |
| 01-001, 08-002, 09-003         | The legacy database move skips `-wal`; only the one-time PersonalHarness migration after a crash. Astra rated critical. |
| 01-036, 10-029, 08-017, 09-004 | Provider filtering can drop checkpoint retention; needs a `nightly` database and a manual prune. Astra rated critical.  |
| 09-075, 10-115                 | Patch path rewriting can hit the wrong file; the path must contain the repo root as a substring. Astra rated critical.  |
| 01-074                         | Restore can lose edits to force-staged ignored files. Astra rated critical.                                             |
| 05-056, 09-152                 | Discarding a worktree can delete files of a chat that opened that worktree as its own project. Astra rated critical.    |
| 02-006, 08-057                 | Legacy project-list migration can drop entries when the server stays down. One-time. Astra rated critical.              |
| 04-029                         | Windows Quit kills the server without a graceful flush; at most about 4 ms of streamed text. Astra rated critical.      |

## Dismissed

| ID(s)                 | Why                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #44                   | Claude SDK 0.3.232 creates a fresh `AbortController` per request and the adapter listens synchronously; and the card clears when the turn ends anyway. |
| #9 (as written)       | Per-chat Stop cannot be pressed during capture. The real gap is Stop all, listed under Medium.                                                         |
| #6, #7, #27, #48, #49 | Already fixed in the working tree (see below).                                                                                                         |

## Fixed in the uncommitted working tree

Confirmed present on disk; regression tests exist and pass. None is committed.

| ID(s)                   | Fix                                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| E01, E02                | WebSocket error handler attached before origin and access checks.                                                                                  |
| E03, E08, #6            | JSON-RPC stdin failure rejects pending calls; a Codex crash fails the turn and detaches. Leftover: a queued prompt waits for the next user action. |
| E04                     | Invalid replies raise `IndeterminateRequestError`. Leftover: validator-load failure path.                                                          |
| E06, E07, E40, E41, E50 | Queue, cold-resume, steer and dispatch races in the orchestrator.                                                                                  |
| E09, E20                | Codex resolved cards cleared; stale MCP list replies dropped.                                                                                      |
| E10, #7                 | Approval Abort rejection caught and logged.                                                                                                        |
| E12, E13, E14, #48, #49 | Terminal replays retained output, closes offline shells, shows errors with Restart.                                                                |
| E18, E19                | MCP reload covers every live session; changes reach the UI.                                                                                        |
| E24, E25, E26, E37      | Thread recovery and cache limits. E37 leftover: invalid reply on version mismatch.                                                                 |
| E27                     | Repeated Quit waits for pending update cleanup.                                                                                                    |
| E28                     | Partly fixed; see #51.                                                                                                                             |
| E31                     | A missing isolated checkout blocks resume instead of falling back.                                                                                 |
| E32                     | Checkpoint restore uses `--no-renames`.                                                                                                            |
| E34, #27                | Project switch clears "Opening file…".                                                                                                             |
| E38, E43                | Approval reply errors shown; account check retried after reconnect.                                                                                |
| E39                     | Custom text equal to an option stays editable.                                                                                                     |
| E42                     | Scheduler timer catches database errors.                                                                                                           |

## Not verified yet

These were checked and fixed later the same day; see [Resolution status](#resolution-status).
Astra critical/high claims that were not checked against code at triage time (astra's own
labels):

- **Server and checkpoints:** 01-003 prune archives omit imported-history data (critical);
  01-006 restore can change files and fail before Undo; 01-030 Design timeout followed by a late
  prompt; 01-033 / 09-113 file rejection patches a different HEAD; 01-059 / 05-053 diff
  rejection bypasses the checkout guard; 01-083 Un-settle and Wake re-settle old chats; 09-072
  saved Git-directory paths break pruning.
- **Web:** 02-007 / 10-005 / 08-025 / 09-101 rejected access change leaves a false label;
  02-010 / 10-102 prompt timestamps pick the wrong checkpoint; 02-015 removed composer resources
  return; 02-038 Inbox caches retain project graphs; 02-043 / 08-062 / 10-101 removing the
  active project leaves its chat selected; 02-081 rejecting a nested Side chat command discards
  its draft (critical); 02-087 restore uses the previous checkpoint while a new one loads;
  10-166 Send availability keeps the old Codex sign-in.
- **PR review:** 03-056 / 09-082 PR file cache shows the wrong comparison; 08-077 / 03-057
  opening PR Files deletes the unsent review draft; 03-129 approval not bound to the inspected
  commit.
- **Adapters and history:** 06-037 ACP edit patches cannot support Undo; 06-044 failed Grok
  history reads hide a transcript; 10-055 / 06-041 / 09-126 Grok history merges reused tool ids.
- **Design agent:** 07-037 / 08-005 quadratic CSS scan on brace-free files; 07-058 malformed
  briefs retry without limit.
- **Dev tooling:** 04-001 / 10-014 / 09-067 `tools/scripts/dev.js` kills unrelated port owners.

The remaining astra medium/low findings were worked through afterwards; see
[Astra follow-up status](#astra-follow-up-status-4-october-2026) for which are fixed and which
are not checked yet.

## Suggested order

Everything except the commits in step 1 is done in the working tree.

1. Fix the license gate, then commit the uncommitted fixes in reviewable PRs.
2. Critical: #1, the transcript crash, #8.
3. High: Archive cluster, temp-folder storage, loopback trust, PR replies, Windows PR files,
   onboarding, "New session" deletion, #11, #39, E22.
4. Medium, most common first: #3, #35, #5 and 02-004, #20, #14, #17, #37, #28, #42, then the
   race-dependent rest.

## Astra follow-up status (4 October 2026)

Every one of the 975 astra findings, with its current state. After the triage above, the remaining astra findings were checked against code one at a time, most severe first. Fixes come with regression tests, with the exception noted below. All of these fixes are on `main`.

- **Fixed in this follow-up:** 149
- **Already fixed when checked:** 11 (the code no longer had the problem)
- **Handled in the triage above:** 104
- **Not checked yet:** 711

**Validation of the follow-up:** for each fix, the narrowest relevant tests and the affected package's typecheck passed. Most new tests were also confirmed to fail without their fix; the last pull-request batch was not, and its `GH_HOST` pin has no test. The root `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` have not been rerun since the follow-up started. Nothing was run on Windows.

**Contract changes in the follow-up** (`packages/contracts`):

- Pull-request review threads gain optional `commentsTruncated`; pull-request detail gains optional `reviewThreadsUnavailable`.

### Fixed in this follow-up

Duplicate findings that share one fix are listed together.

| IDs                                                                                                            | Severity   | Finding                                                                               | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01-007                                                                                                         | medium bug | Direct-send early completion can strand queued prompts                                | Turn-start barrier tracks early turn.completed; sendTurn finally drains queue; regression test                                                                                                                                                                                                                                                                                                                                                                |
| 01-008                                                                                                         | medium bug | Idle eviction forgets sessions before cleanup succeeds                                | #releaseIdleRuntime routes through #stopThreadProvider so stop is tracked/retried; eviction waits for stop; tests                                                                                                                                                                                                                                                                                                                                             |
| 01-011, 08-034, 09-005, 10-114                                                                                 | medium bug | Checkpoint repository lookup rejects its own saved paths                              | already fixed: checkpointRepository resolves git-common-dir against repoPath; covered by existing test                                                                                                                                                                                                                                                                                                                                                        |
| 01-018, 01-019, 06-002, 06-003, 08-010, 08-011, 09-007                                                         | medium bug | Background cleanup discards an asynchronous dispose result                            | runBackgroundCompletion: one deadline across start/send/completion, interrupt bounded to 5 s, dispose awaited; failed dispose reported via onCleanupError (orchestrator logs) and the folder kept; a late start is disposed when it lands; tests                                                                                                                                                                                                              |
| 01-020, 03-121, 08-055, 09-120, 10-075                                                                         | medium bug | Old PR reads can refill caches after a successful mutation                            | Server: #invalidate drops the in-flight detail/review-thread read, and an old read rejects instead of writing the cache (earlier triage). Now also: the detail pane retires loads that started before a successful action (request id bump, flags reset), so the old read can neither restore state nor show a spurious error. Tests: server 'starts a fresh detail read after a change...', web 'ignores a refresh that started before a successful change'. |
| 01-022, 06-004, 08-006                                                                                         | medium bug | MCP edits remove nightly-only provider blocks from active config                      | mcp-config keeps unsupported provider blocks as opaque data and writes them back; test                                                                                                                                                                                                                                                                                                                                                                        |
| 01-023, 06-024, 08-007, 09-013                                                                                 | medium bug | A failed lossy MCP save removes the active configuration                              | lossy save stages the replacement first, copies the original to a unique backup, then renames; active file stays on failure; test                                                                                                                                                                                                                                                                                                                             |
| 01-029, 05-061                                                                                                 | medium bug | Preview cleanup can report success while its process survives                         | runner: spawnOwned + killTree, stop rejects when tree or port survives; orchestrator keeps failed handles in #unstoppedDesignPreviews, retries on close/discard/shutdown, propagates to close, Stop all and disposeAll; tests                                                                                                                                                                                                                                 |
| 01-031                                                                                                         | medium bug | Queue-claim errors escape a detached drain promise                                    | #drainQueue wraps #drainQueueOnce and logs failures so queued turns survive a claim error; test                                                                                                                                                                                                                                                                                                                                                               |
| 01-034                                                                                                         | medium bug | New Git repositories cannot show changes before the first commit                      | snapshotBase: unborn HEAD uses empty tree, parentless snapshot commits; diff-review base = head or empty tree; tests in checkpoint/diff-review                                                                                                                                                                                                                                                                                                                |
| 01-045                                                                                                         | medium bug | Inherited object keys are mistaken for existing MCP servers                           | own-property checks and defineProperty storage; parse walks JSON by hand so **proto** survives; test                                                                                                                                                                                                                                                                                                                                                          |
| 01-048                                                                                                         | medium bug | Stop all closes attached idle Codex chats                                             | panicStop interrupts only busy sessions; failed interrupt disconnects instead of close; tests                                                                                                                                                                                                                                                                                                                                                                 |
| 01-049                                                                                                         | medium bug | Persistence failure after provider start loses cleanup ownership                      | #startThread persistence failure stops provider, awaits stop, removes worktree, rethrows original; test                                                                                                                                                                                                                                                                                                                                                       |
| 01-051                                                                                                         | medium bug | Worktree discard does not enforce provider shutdown on the server                     | discardWorktree checks dirtiness, then closes the chat and awaits provider stop inside checkout exclusion; failed stop keeps checkout; tests                                                                                                                                                                                                                                                                                                                  |
| 01-054                                                                                                         | medium bug | Lifecycle pushes precede transaction commit                                           | refreshLifecycle collects changes and publishes only after batchLifecycleUpdates commits; rollback test                                                                                                                                                                                                                                                                                                                                                       |
| 01-057                                                                                                         | medium bug | Grok MCP sessions ignore later model and effort changes                               | AcpAdapter gains argsFor/settings: a turn with other model/effort relaunches and session/loads the same session; refuses visibly when loadSession is false; Grok MCP uses it; tests                                                                                                                                                                                                                                                                           |
| 01-058                                                                                                         | medium bug | A silent login start blocks later authentication operations                           | ProviderControls bounds login startup (loginStartTimeoutMs, default 60s): the start rejects and releases the auth queue, the late handle stays owned in #lateLogins and is canceled when it arrives (disposeAll retries it); test 'releases sign-in work behind a start that never answers…'                                                                                                                                                                  |
| 01-060                                                                                                         | medium bug | A direct scheduling failure can stop all future lifecycle wakes                       | #schedule installs a bounded retry timer when nextAt() throws, then rethrows; test                                                                                                                                                                                                                                                                                                                                                                            |
| 01-061                                                                                                         | medium bug | Isolated startup loses a nested project's working folder                              | createWorktree returns workPath (show-prefix inside checkout); thread stores/starts in nested folder; discard removes checkout root; tests                                                                                                                                                                                                                                                                                                                    |
| 01-062                                                                                                         | medium bug | Hidden checkpoints depend on the user's Git identity                                  | commit-tree runs with fixed TasteCode checkpoint identity env; test with user.useConfigOnly                                                                                                                                                                                                                                                                                                                                                                   |
| 01-063                                                                                                         | medium bug | Idle eviction ignores negotiated resume support                                       | AgentSession.resumable (ACP: negotiated loadSession) gates idle release in #attachThread; test                                                                                                                                                                                                                                                                                                                                                                |
| 01-064                                                                                                         | medium bug | One MCP sign-in result releases another sign-in's runtime guard                       | MCP sign-in guard tracks in-flight starts and login IDs per runtime; only the finished login releases it; test                                                                                                                                                                                                                                                                                                                                                |
| 01-065                                                                                                         | medium bug | Failed startup cleanup loses its session and can remove a live checkout               | startedSession wraps a failed dispose in StartupCleanupError; orchestrator keeps the session in #stoppingSessions (retried now and at shutdown), retains the checkout, removes the worktree only after a confirmed stop, and rethrows the original start error; test                                                                                                                                                                                          |
| 01-067, 01-071, 01-073, 03-108, 03-122, 08-059, 08-076, 08-081, 08-084, 09-034, 09-151, 09-163, 10-077, 10-117 | medium bug | A pending review can make the whole PR detail response invalid                        | PR detail: pending reviews dropped; teams sent as team_reviewers; per-thread commentsTruncated; failed conversations flagged reviewThreadsUnavailable and not cached; repository failures propagate; exact branch dedupe; GH_HOST pinned to github.com                                                                                                                                                                                                        |
| 01-072, 06-025, 09-076                                                                                         | medium bug | Windows custom harnesses ignore mixed-case Path overrides                             | mergeLaunchEnvironment: Windows case-insensitive layer merge (adapter > custom > inherited), one PATH key; tests                                                                                                                                                                                                                                                                                                                                              |
| 01-075, 06-050                                                                                                 | medium bug | Relative PATH entries use the server folder instead of launch cwd                     | PATH lookup resolves relative entries against launch cwd, returns absolute; test                                                                                                                                                                                                                                                                                                                                                                              |
| 01-076, 08-083                                                                                                 | medium bug | Grok accepts MCP settings its launch paths cannot enforce                             | adapter-acp exports validateAcpMcpServer (new mcp.ts, ./mcp subpath) rejecting hide records and stdio cwd; wired as Grok validateMcpServer; launch still skips old hide records. Tests in adapter-acp, provider-controls, orchestrator.                                                                                                                                                                                                                       |
| 01-081                                                                                                         | medium bug | Partial duplicate-history repair is marked complete before both writes succeed        | load() merges a duplicate holding real replies before the canonical merge records loaded_revision, so a failure or crash between the writes leaves the repair retryable; mirror deletion still follows the canonical merge. Test: retries a duplicate repair that failed after the canonical chat was read.                                                                                                                                                   |
| 01-085                                                                                                         | medium bug | Side chat close retries skip retained provider cleanup                                | closeSideThread with a missing row retries the retained provider stop; test                                                                                                                                                                                                                                                                                                                                                                                   |
| 04-004                                                                                                         | medium bug | Staging cleanup changes a ready update into an error                                  | Staging cleanup failure is logged and never replaces the handover result or original error                                                                                                                                                                                                                                                                                                                                                                    |
| 04-005                                                                                                         | medium bug | Native shortcuts bypass shortcut recording and modal guards                           | Native menu actions carry click/accelerator source; accelerators share shortcutRoute guards; recording suspends menu shortcuts via setIgnoreMenuShortcuts                                                                                                                                                                                                                                                                                                     |
| 04-014, 04-036, 07-024, 07-041                                                                                 | medium bug | Capture does not wait for images changed by scrolling                                 | Settle remeasures height while scrolling (steps from the 12k cap, 3s scroll and 5.5s total budget), collects images after scrolling plus a late-image pass; screenshots carry documentHeight/capturedHeight; review prompt and completion qualify a cropped capture                                                                                                                                                                                           |
| 04-016, 10-160                                                                                                 | medium bug | Pasted long filenames lose the media extension                                        | Stem truncated by UTF-8 byte budget, extension kept                                                                                                                                                                                                                                                                                                                                                                                                           |
| 04-025, 04-031, 07-023, 07-047, 07-051, 07-052, 07-055, 04-015, 07-025                                         | medium bug | Clipped controls cause false blocking Design repairs                                  | DOM audit walks open shadow roots (bounded 20k, coverage partial when cut short or a defined custom element may hide a closed root), skips inert and ancestor-clipped targets, flags partly clipped, exempts controls with a large label, unique >>> selectors, audits from document origin then restores scroll; review gate ignores h1Count 0 under partial coverage and names clipped targets                                                              |
| 04-033                                                                                                         | medium bug | Native actions are lost while a replacement window loads                              | NativeMenuDispatch queues actions per webContents until preload reports listener ready; reset on navigation/crash                                                                                                                                                                                                                                                                                                                                             |
| 04-034                                                                                                         | medium bug | Background server failure loses its restart guidance                                  | Supervisor keeps gaveUp state with deliberate restart(); notice re-shown when a window is created, offers Restart server                                                                                                                                                                                                                                                                                                                                      |
| 04-037                                                                                                         | medium bug | Release workflow cannot resume earlier successful artifacts                           | Package job exposes per-platform artifact outputs; writer checks run/source and downloads those names; test updated                                                                                                                                                                                                                                                                                                                                           |
| 05-004                                                                                                         | medium bug | Idle runtime eviction forgets a process when disposal fails                           | Duplicate of 01-008: idle eviction routed through tracked stop path; tests                                                                                                                                                                                                                                                                                                                                                                                    |
| 05-013                                                                                                         | medium bug | Early completion of a direct send can strand the next prompt                          | Duplicate of 01-007: early completion drain after start barrier release; test                                                                                                                                                                                                                                                                                                                                                                                 |
| 05-014                                                                                                         | medium bug | Accepted steer can execute again as a new turn                                        | Acknowledged steer is consumed and recorded on the captured turn even if it ended; no restore/resend; tests updated                                                                                                                                                                                                                                                                                                                                           |
| 05-015                                                                                                         | medium bug | Codex helper death leaves browser sign-in pending                                     | ProviderControls #listen handles the shared helper's 'disconnected': an owned Codex login with a returned id is expired, released (no cancel RPC) and reported failed at once. Test: fails a browser sign-in at once when its helper process exits.                                                                                                                                                                                                           |
| 05-025                                                                                                         | medium bug | Stop all archives idle Codex chats                                                    | Duplicate of 01-048: panicStop skips idle sessions; failed interrupt disconnects; tests                                                                                                                                                                                                                                                                                                                                                                       |
| 05-040                                                                                                         | medium bug | History import skips existing isolated provider sessions                              | ProviderHistory refresh resolves native ownership first and checks native.projectPath (not the private worktree cwd) against registered projects; removed-project, internal, ephemeral and busy guards unchanged. Tests: isolated chat import, removed project skip.                                                                                                                                                                                          |
| 05-041                                                                                                         | medium bug | Design work can write after its checkout guard is released                            | Preview/capture tasks that outlive their turn hold a design checkout writer until they settle; restore/branch switch refused meanwhile; test                                                                                                                                                                                                                                                                                                                  |
| 05-046                                                                                                         | medium bug | One MCP login can release another login's runtime                                     | Duplicate of 01-064: per-login MCP sign-in guard                                                                                                                                                                                                                                                                                                                                                                                                              |
| 05-055, 06-047                                                                                                 | medium bug | Windows skill path casing can undo a successful installation                          | Skill install verification uses filesystem identity (dev+ino, Windows no-index fallback) for match and discovery-error containment; test                                                                                                                                                                                                                                                                                                                      |
| 05-057                                                                                                         | medium bug | A replacement Side chat can survive closing its parent                                | Parent close records closed before awaiting Side chat stop, so a replacement start refuses to attach; test                                                                                                                                                                                                                                                                                                                                                    |
| 05-059                                                                                                         | medium bug | Overlapping Stop all calls release each other's guard                                 | panicStop shares one in-flight promise among callers; guard held until it ends; test                                                                                                                                                                                                                                                                                                                                                                          |
| 05-060                                                                                                         | medium bug | Queued Claude turns can fail native history echo matching                             | importedEvents matches a local user prompt by either its displayed (enqueue) time or its local turn start time, keeping the 60s bound and one-to-one matching. Test: recognizes the echo of a prompt that waited in the queue.                                                                                                                                                                                                                                |
| 05-064                                                                                                         | medium bug | Partial duplicate-history repair is marked complete                                   | Duplicate of 01-081: retained duplicate is merged before the canonical loaded_revision commit.                                                                                                                                                                                                                                                                                                                                                                |
| 05-066                                                                                                         | medium bug | Lifecycle pushes escape a transaction that later rolls back                           | Duplicate of 01-054: lifecycle pushes after commit                                                                                                                                                                                                                                                                                                                                                                                                            |
| 05-067                                                                                                         | medium bug | Idle-prune callbacks let storage errors escape                                        | Timer/microtask idle prune wrapped: logs storage error, retries after 30 s; test                                                                                                                                                                                                                                                                                                                                                                              |
| 06-005                                                                                                         | medium bug | Codex custom wrappers receive the server folder as workspace                          | Codex runtime passes customHarnessSpawn(harness, workspacePath); test proves cwd and HARNESS_WORKSPACE_PATH on start and resume                                                                                                                                                                                                                                                                                                                               |
| 06-012                                                                                                         | medium bug | Grok MCP ignores model and effort changes after startup                               | Same fix as 01-057 (ACP argsFor relaunch + visible refusal)                                                                                                                                                                                                                                                                                                                                                                                                   |
| 06-039, 10-071                                                                                                 | medium bug | Signal-killed custom commands can pass verification                                   | captureCli returns signal; runCustomHarness requires code 0 and reports the signal; test                                                                                                                                                                                                                                                                                                                                                                      |
| 07-011                                                                                                         | medium bug | A Build correction can erase the publishing warning                                   | Build correction keeps the earlier Verify-before-publishing note; correction prompts repeat the rule; test                                                                                                                                                                                                                                                                                                                                                    |
| 07-022                                                                                                         | medium bug | Repair correction uses the wrong failure response schema                              | Correction prompts are phase-aware (Repair failed shape uses summary); Repair parser maps a Build-shaped error to summary; tests                                                                                                                                                                                                                                                                                                                              |
| 07-028                                                                                                         | medium bug | Checkpoint restore can race with active Design capture and rewrite restored artifacts | Duplicate of 05-041: design capture holds checkout writer                                                                                                                                                                                                                                                                                                                                                                                                     |
| 07-029, 07-063                                                                                                 | medium bug | Cold Review recovery can report a stopped or wrong preview URL                        | Cold restore of Review (no live preview or missing screenshots) or Repair (missing screenshots) recaptures through #captureDesignReview, which restarts the preview from the saved plan and records the real URL; test added                                                                                                                                                                                                                                  |
| 07-031                                                                                                         | medium bug | Static and command previews can claim the same starting port                          | static preview avoids ports claimed by starting command previews; command readiness ignores TasteCode static responses; test                                                                                                                                                                                                                                                                                                                                  |
| 07-032, 09-138                                                                                                 | medium bug | Encoded static URL prefixes fail their own readiness check                            | static requestFile compares decoded segments, rejects decoded separators; test                                                                                                                                                                                                                                                                                                                                                                                |
| 07-034                                                                                                         | medium bug | Missing preview executables lose their recoverable error code                         | watchPreviewChild keeps the spawn error code and cause; test                                                                                                                                                                                                                                                                                                                                                                                                  |
| 07-036                                                                                                         | medium bug | Normal-task fallback still auto-answers the user's questions                          | Design question interceptor skips the response phase and pending continueNormally; test 'shows questions from a normal continuation instead of answering them'                                                                                                                                                                                                                                                                                                |
| 07-042                                                                                                         | medium bug | An old preview stop can kill a resumed run's new preview                              | Suspended resume awaits the old preview stop; #stopDesignPreview binds to the preview present at call time plus previews made under the aborted signal (WeakMap tag), never a newer run's; tests 'resumes a suspended preview only after the old preview startup settles'                                                                                                                                                                                     |
| 07-043                                                                                                         | medium bug | Shutdown misses preview startup launched from Repair                                  | #designPreviewTasks is a per-thread task set via #trackDesignPreviewTask; Repair capture is tracked; owners include task threads so close/shutdown wait; test 'waits at shutdown for a preview that Repair is still starting'                                                                                                                                                                                                                                 |
| 07-048                                                                                                         | medium bug | An Assets correction exception can leave Codex Design stuck                           | #queueDesignCorrection catches prompt-construction failures, logs them and returns undefined so the caller records the failed completion and fails the run with the original error; test 'fails the run when an Assets correction cannot be built'                                                                                                                                                                                                            |
| 07-049                                                                                                         | medium bug | Late queue steering can strand the next Design phase                                  | #drainQueueOnce returns while a Design flow is live (preview/capture gaps included); test 'keeps a restored steer queued while Design captures between phases'                                                                                                                                                                                                                                                                                                |
| 07-053                                                                                                         | medium bug | A successful Preview correction consumes Review's retry                               | #captureDesignReview resets correcting/correctionErrors on entering Review; test 'gives Review its own correction after a Preview correction succeeds'                                                                                                                                                                                                                                                                                                        |
| 07-057                                                                                                         | medium bug | Stale phase-start rejection deletes saved Design progress                             | New #failOwnedDesignFlow ignores (and logs) start failures once the captured flow no longer owns the thread; used by automatic phase sends, restore send, suspended resume and the fresh-start catch; test 'keeps the saved run when a phase start rejects after shutdown'                                                                                                                                                                                    |
| 07-060                                                                                                         | medium bug | A suspended complete phase cannot resume                                              | #suspendDesignFlow rewinds an unfinalized complete phase to preview and drops the stale completion, so continue recreates preview and review; test 'reviews again when an accepted final Review loses its provider turn'                                                                                                                                                                                                                                      |
| 07-064                                                                                                         | medium bug | A failed Review can consume a Repair slot before Repair starts                        | #suspendDesignFlow releases a Repair slot reserved by Review when the Repair prompt was never sent (pendingPrompt present, not correcting); test 'releases the Repair slot when Review fails before Repair starts'                                                                                                                                                                                                                                            |
| 07-066, 08-053, 09-010, 10-095                                                                                 | medium bug | Failed command-preview cleanup loses its retry owner                                  | covered by the preview stop rework: killTree confirms termination, port check rejects, orchestrator retains failed handles for retry                                                                                                                                                                                                                                                                                                                          |
| 07-067                                                                                                         | medium bug | An expired preview handle can stop an unrelated process                               | POSIX preview uses spawnOwned (group retired on exit); killTree skips exited Windows roots; port confirmation only when the tree was running at stop                                                                                                                                                                                                                                                                                                          |
| 07-069                                                                                                         | medium bug | Leading preview options can select a different package script                         | packageScriptRun shared by validation and launch; leading options keep the validated script; test                                                                                                                                                                                                                                                                                                                                                             |
| 08-015, 09-097                                                                                                 | medium bug | Real DMG preparation failures still delete the verified download                      | Already fixed by #51/E28 follow-up: discard only on isInvalidUpdate; added numeric execFile exit-status test                                                                                                                                                                                                                                                                                                                                                  |
| 08-031                                                                                                         | medium bug | Startup benchmarks can migrate real user configuration                                | Benchmark sets HARNESS_CONFIG_DIR under its temp data root                                                                                                                                                                                                                                                                                                                                                                                                    |
| 08-075, 09-081                                                                                                 | medium bug | Persistence failure after startup leaves a live provider without an owner             | Thread persistence failure after start already stopped the session through #stopThreadProvider; the remaining gap (sidebarSettings read before attach) is closed by attaching first; tests 'stops a started agent when its thread cannot be saved' and 'keeps a started agent attached when a later settings read fails'                                                                                                                                      |
| 09-014, 09-015, 10-030, 10-094, 10-155                                                                         | medium bug | Main rewrites away valid nightly MCP settings                                         | duplicate of the MCP config fixes (01-022/01-045/01-023)                                                                                                                                                                                                                                                                                                                                                                                                      |
| 09-020                                                                                                         | medium bug | Native preview verification hooks the obsolete capture API                            | Proof hooks debugger Page.captureScreenshot; verify:preview passes natively                                                                                                                                                                                                                                                                                                                                                                                   |
| 09-079                                                                                                         | medium bug | History import misses case and separator aliases of the same project                  | History refresh resolves a session folder to a registered project by exact key, else by same resolved, case-folded spelling confirmed by file-system identity (dev+ino); imports are filed under the stored project key (addProviderThread projectPath). Test: files a session saved under another spelling.                                                                                                                                                  |
| 09-098                                                                                                         | medium bug | Split stdout markers can make startup proof time out                                  | Supervisor buffers stdout/stderr per stream, emits whole lines, flushes the tail at end, caps an unterminated line at 64 KiB; test for split marker                                                                                                                                                                                                                                                                                                           |
| 10-032, 10-033                                                                                                 | medium bug | Background work starts its deadline too late                                          | Same as 01-019/01-018 background deadline and owned cleanup fix; async/rejecting dispose tests added                                                                                                                                                                                                                                                                                                                                                          |
| 10-063                                                                                                         | medium bug | History pruning resolves a saved Git directory as a checkout                          | already fixed: checkpointRepository resolves git-common-dir against the stored path (works for a .git dir); history-cli prune test with saved git-directory exists                                                                                                                                                                                                                                                                                            |
| 10-096                                                                                                         | medium bug | Review versions omit the HEAD used to compute the diff                                | already fixed: review version digests base and snapshot tree; stale HEAD tests exist                                                                                                                                                                                                                                                                                                                                                                          |
| 10-116                                                                                                         | medium bug | Overlapping Stop all requests release their gate too early                            | panicStop coalesces overlapping callers into one in-flight promise (05-059), so the gate stays set until the shared stop finishes; the interrupt-timeout force-stop now only disposes the runtime it captured                                                                                                                                                                                                                                                 |
| 08-039                                                                                                         | low bug    | AVIF works in the picker but fails on paste or drop                                   | Paste/drop accepts AVIF (ftyp brand check), ICO and APNG like the picker                                                                                                                                                                                                                                                                                                                                                                                      |
| 07-040                                                                                                         | low issue  | Successful captures accumulate during long app uptime                                 | Capture sweep also runs every 6 h (unref'd) and continues past a single failed entry; restored runs recapture deleted evidence                                                                                                                                                                                                                                                                                                                                |

### Already fixed when checked

| IDs                    | Severity   | Finding                                                | What changed                                                                                                                                                                                                                                         |
| ---------------------- | ---------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01-021, 08-068, 10-076 | medium bug | Changing a PR base leaves its file patches stale       | Files are keyed by head and base OIDs, verified before and after the read; a base change invalidates cached and in-flight pages (earlier triage, with tests).                                                                                        |
| 01-035, 10-034         | medium bug | GitHub stdin errors have no handler                    | runGh attaches a stdin error handler that settles through the single finish() path (earlier triage).                                                                                                                                                 |
| 05-058                 | medium bug | A timed-out Design start can send its prompt later     | Timeout path already disposes the runtime (disconnect) after interrupt; existing test asserts disposal and no second send                                                                                                                            |
| 07-054                 | medium bug | A timed-out Design start can begin provider work later | Duplicate of 05-058: timeout disposes runtime                                                                                                                                                                                                        |
| 08-012, 09-008, 10-031 | medium bug | Idle eviction loses failed process cleanup ownership   | Idle eviction already routes through #stopThreadProvider(threadId, session): the session stays in #stoppingSessions until disposal succeeds, #ensureThread waits for it, shutdown retries it (test 'retries a failed idle-runtime stop at shutdown') |
| 09-119                 | medium bug | Diff rejection does not take the shared checkout lock  | #rejectDiff already runs the review under #checkoutAccess.exclusive(diffRepoPath) after its per-thread checks                                                                                                                                        |

### Handled in the triage above

These IDs appear in the triage tables above, which record their state: 01-001, 01-002, 01-003, 01-004, 01-036, 01-050, 01-074, 02-003, 02-004, 02-005, 02-006, 02-055, 02-081, 02-086, 04-029, 05-012, 05-056, 08-001, 08-002, 08-017, 08-024, 08-056, 09-002, 09-003, 09-004, 09-006, 09-075, 10-004, 10-028, 10-142, 08-004, 01-005, 01-006, 01-030, 01-033, 01-059, 01-083, 02-007, 02-010, 02-015, 02-025, 02-043, 02-074, 02-087, 03-055, 03-056, 03-085, 03-105, 04-010, 05-026, 05-053, 06-019, 06-037, 06-044, 07-058, 08-048, 08-058, 08-062, 08-069, 08-077, 09-031, 09-032, 09-033, 09-066, 09-067, 09-072, 09-083, 09-101, 09-113, 09-118, 09-142, 09-145, 10-005, 10-014, 10-017, 10-027, 10-029, 10-055, 10-102, 10-108, 10-159, 10-166, 02-038, 04-001, 07-037, 08-003, 08-025, 03-001, 03-057, 03-129, 06-041, 07-044, 08-013, 08-057, 08-070, 09-082, 09-126, 09-152, 10-006, 10-060, 10-101, 10-115, 08-005, 10-107.

### Not checked yet

These have not been compared with the code, so each is still only astra's claim. Severity and category are astra's own labels. In every claim checked so far the code observation was accurate, but astra overrated how severe its edge cases were.

| Severity     | Count |
| ------------ | ----- |
| medium bug   | 320   |
| medium issue | 99    |
| medium qol   | 5     |
| medium slop  | 8     |
| low bug      | 54    |
| low issue    | 58    |
| low qol      | 71    |
| low slop     | 89    |
| nit bug      | 1     |
| nit slop     | 6     |

| ID     | Severity     | Finding                                                                     | Where                                                       |
| ------ | ------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 01-009 | medium bug   | Shutdown does not join pending provider starts and resumes                  | apps/server/src/server.ts                                   |
| 01-010 | medium bug   | Late startup failure leaves the listener and data lease owned               | apps/server/src/server.ts                                   |
| 01-012 | medium bug   | Retired imported patches still pass the Undo check                          | apps/server/src/store.ts                                    |
| 01-014 | medium bug   | Imported item revisions change order inside a turn                          | apps/server/src/store.ts                                    |
| 01-015 | medium bug   | Delta timer errors escape the persistence boundary                          | apps/server/src/recorded-delta-buffer.ts                    |
| 01-016 | medium bug   | PTY close keeps a failed promise and cannot retry termination               | apps/server/src/terminal.ts                                 |
| 01-017 | medium bug   | An image-only main prompt blocks Side chat                                  | apps/server/src/side-chat.ts                                |
| 01-040 | medium bug   | A long terminal job can lose status immediately on exit                     | apps/server/src/terminal.ts                                 |
| 01-053 | medium bug   | A failed replay refresh makes Retry return an old transcript                | apps/server/src/store.ts                                    |
| 01-055 | medium bug   | One valid large diff disconnects healthy clients                            | apps/server/src/push-bus.ts                                 |
| 01-070 | medium bug   | Failed native refresh blocks the last saved transcript                      | apps/server/src/server.ts                                   |
| 01-077 | medium bug   | Daily cost loses a cumulative baseline after a per-turn sample              | apps/server/src/store.ts                                    |
| 01-080 | medium bug   | Stop misses a prompt waiting for native history                             | apps/server/src/server.ts                                   |
| 02-001 | medium bug   | Find results do not refresh after structural transcript updates             | apps/web/src/ui/ThreadSearch.tsx                            |
| 02-002 | medium bug   | Search misses output from tools that complete out of order                  | apps/web/src/thread-search-index.ts                         |
| 02-008 | medium bug   | Late restore reads replace another project's workspace state                | apps/web/src/App.tsx                                        |
| 02-009 | medium bug   | An old checkpoint failure clears the new chat's checkpoints                 | apps/web/src/App.tsx                                        |
| 02-014 | medium bug   | Failed validator loading loses pushes and mislabels accepted mutations      | apps/web/src/transport.ts                                   |
| 02-016 | medium bug   | Side chat applies buffered text to the next parent                          | apps/web/src/ui/workspace/WorkspaceSideChat.tsx             |
| 02-017 | medium bug   | Strict Mode leaves deferred archiving unable to render                      | apps/web/src/ui/useDeferredArchiveQueue.ts                  |
| 02-020 | medium bug   | Escaped file links reveal the wrong path                                    | apps/web/src/ui/CompletedMarkdown.tsx                       |
| 02-021 | medium bug   | Streaming Markdown removes underscores from identifiers                     | apps/web/src/ui/live-markdown.ts                            |
| 02-024 | medium bug   | Turn completion changes the keyboard-selected palette action                | apps/web/src/ui/CommandPalette.tsx                          |
| 02-026 | medium bug   | Editing another provider suppresses an earlier save failure                 | apps/web/src/ui/ProviderTuning.tsx                          |
| 02-031 | medium bug   | An old Side chat replay clears the new replay's event buffer                | apps/web/src/ui/workspace/WorkspaceSideChat.tsx             |
| 02-033 | medium bug   | Failed project removal restores a stale selection                           | apps/web/src/App.tsx                                        |
| 02-034 | medium bug   | Initial and project-selected new chats ignore pinned defaults               | apps/web/src/App.tsx                                        |
| 02-036 | medium bug   | Sidebar membership changes jump back to the active chat                     | apps/web/src/ui/Sidebar.tsx                                 |
| 02-039 | medium bug   | A stopped Inbox clock restarts with an old time                             | apps/web/src/ui/InboxSidebar.tsx                            |
| 02-040 | medium bug   | Keybinding settings accept shortcuts that fixed handlers consume            | apps/web/src/shortcuts.ts                                   |
| 02-044 | medium bug   | Archive all chats skips pinned chats                                        | apps/web/src/ui/Sidebar.tsx                                 |
| 02-045 | medium bug   | A worktree confirmation drops the rest of a bulk archive                    | apps/web/src/App.tsx                                        |
| 02-046 | medium bug   | Plain Markdown fast path misclassifies indented code                        | apps/web/src/ui/Markdown.tsx                                |
| 02-050 | medium bug   | An old diff refresh can overwrite a completed review decision               | apps/web/src/ui/DiffReview.tsx                              |
| 02-052 | medium bug   | Find counts tool-output matches but leaves them hidden                      | apps/web/src/ui/Thread.tsx                                  |
| 02-053 | medium bug   | An unsent Side chat draft follows an unrelated parent                       | apps/web/src/ui/workspace/WorkspaceSideChat.tsx             |
| 02-054 | medium bug   | A consumed global-search jump repeats on normal chat entry                  | apps/web/src/App.tsx                                        |
| 02-056 | medium bug   | Concurrent chat startups lose an earlier pending rename                     | apps/web/src/App.tsx                                        |
| 02-057 | medium bug   | Pinning a starting chat never saves the canonical pin                       | apps/web/src/App.tsx                                        |
| 02-058 | medium bug   | Inbox time buckets suppress scheduled relative-label updates                | apps/web/src/ui/InboxSidebar.tsx                            |
| 02-059 | medium bug   | Resource inventory remains cached after its watch lease expires             | apps/web/src/ui/ComposerResourcePicker.tsx                  |
| 02-060 | medium bug   | File-link preprocessing rewrites a final inline-code example                | apps/web/src/project-file-link.ts                           |
| 02-061 | medium bug   | Past failures disappear from every visible chat surface                     | apps/web/src/ui/Thread.tsx                                  |
| 02-062 | medium bug   | Diff word highlighting duplicates a line after a leading insertion          | apps/web/src/ui/DiffReview.tsx                              |
| 02-069 | medium bug   | A late login refresh overwrites the selected provider's account             | apps/web/src/App.tsx                                        |
| 02-070 | medium bug   | Legacy-envelope detection hides ordinary command output                     | apps/web/src/ui/Thread.tsx                                  |
| 02-071 | medium bug   | An obsolete Side chat startup closes the session just adopted by a new view | apps/web/src/ui/workspace/WorkspaceSideChat.tsx             |
| 02-072 | medium bug   | Composition confirmation runs rename and search actions                     | apps/web/src/ui/Sidebar.tsx                                 |
| 02-073 | medium bug   | Failed custom-harness discovery drops the saved service tier                | apps/web/src/App.tsx                                        |
| 02-076 | medium bug   | Reasoning that starts empty appears twice while streaming                   | apps/web/src/ui/turns.ts                                    |
| 02-078 | medium bug   | Reopening the Side chat tab repeats its last command                        | apps/web/src/App.tsx                                        |
| 02-079 | medium bug   | Resource chips route Side chat commands into the main chat                  | apps/web/src/ui/Composer.tsx                                |
| 02-083 | medium bug   | CRLF closing fences keep later prose inside live code blocks                | apps/web/src/ui/live-markdown.ts                            |
| 02-084 | medium bug   | A valid large history causes repeated client reconnects                     | apps/web/src/transport.ts                                   |
| 02-091 | medium bug   | Failed project additions have no visible error or batch reconciliation      | apps/web/src/App.tsx                                        |
| 02-092 | medium bug   | Header rename drafts can rename the next selected chat                      | apps/web/src/ui/StageHeader.tsx                             |
| 02-093 | medium bug   | A closing emphasis star before newline is rendered literally                | apps/web/src/ui/live-markdown.ts                            |
| 03-002 | medium bug   | An MCP save can close another server's unsaved editor                       | apps/web/src/ui/McpSettings.tsx                             |
| 03-007 | medium bug   | Missed MCP OAuth completion leaves sign-in controls blocked                 | apps/web/src/ui/McpSettings.tsx                             |
| 03-009 | medium bug   | A chat switch can apply a rename to the wrong chat                          | apps/web/src/ui/StageHeader.tsx                             |
| 03-012 | medium bug   | One provider's edit suppresses another provider's save error                | apps/web/src/ui/ProviderTuning.tsx                          |
| 03-020 | medium bug   | Reserved digit shortcuts can be saved but do not run                        | apps/web/src/ui/KeybindSettings.tsx                         |
| 03-030 | medium bug   | Archive all omits pinned chats                                              | apps/web/src/ui/Sidebar.tsx                                 |
| 03-031 | medium bug   | StrictMode leaves the archive queue unable to request renders               | apps/web/src/ui/useDeferredArchiveQueue.ts                  |
| 03-032 | medium bug   | Bulk archive abandons chats after checkout confirmation                     | apps/web/src/App.tsx                                        |
| 03-041 | medium bug   | Streaming text loses literal intraword underscores                          | apps/web/src/ui/live-markdown.ts                            |
| 03-046 | medium bug   | Sent non-image attachments disappear from the transcript                    | apps/web/src/ui/Thread.tsx                                  |
| 03-051 | medium bug   | Inline diff highlighting can duplicate an entire line                       | apps/web/src/ui/DiffReview.tsx                              |
| 03-052 | medium bug   | Restore stays active while another checkpoint is loading                    | apps/web/src/ui/RollbackDialog.tsx                          |
| 03-053 | medium bug   | Resource-chip changes back to the initial value are not saved               | apps/web/src/ui/Composer.tsx                                |
| 03-058 | medium bug   | A silent PR reload can strand the Refresh spinner                           | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 03-061 | medium bug   | Side-chat delta buffers survive a change of parent chat                     | apps/web/src/ui/workspace/WorkspaceSideChat.tsx             |
| 03-063 | medium bug   | Directory errors disappear when a file is open                              | apps/web/src/ui/workspace/WorkspaceFiles.tsx                |
| 03-064 | medium bug   | Two review panels can scroll each other's fallback files                    | apps/web/src/ui/workspace/WorkspaceReview.tsx               |
| 03-066 | medium bug   | Page load completion overwrites an address being typed                      | apps/web/src/ui/workspace/WorkspaceBrowser.tsx              |
| 03-069 | medium bug   | File-to-directory changes hide descendants in review navigation             | apps/web/src/ui/workspace/review-file-tree.ts               |
| 03-075 | medium bug   | Multiline error and reconnect notices overlap                               | apps/web/src/styles/app.css                                 |
| 03-082 | medium bug   | Retry can leave Skills settings stuck on Checking                           | apps/web/src/ui/SkillsSettings.tsx                          |
| 03-083 | medium bug   | Closing the context popup during a drag leaves an unsaved value             | apps/web/src/ui/ProviderTuning.tsx                          |
| 03-084 | medium bug   | Reopening Side chat replays the last slash prompt                           | apps/web/src/ui/workspace/WorkspaceSideChat.tsx             |
| 03-087 | medium bug   | A changing command list can retarget the selected action                    | apps/web/src/ui/CommandPalette.tsx                          |
| 03-090 | medium bug   | Base-branch options merge distinct case-sensitive refs                      | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 03-094 | medium bug   | Editing a refreshed comment can restore stale text                          | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 03-095 | medium bug   | An idle Inbox clock can delay new time labels by hours                      | apps/web/src/ui/InboxSidebar.tsx                            |
| 03-096 | medium bug   | Ordinary command output can be mistaken for a legacy envelope               | apps/web/src/ui/Thread.tsx                                  |
| 03-103 | medium bug   | Encoded filename characters can redirect a local file link                  | apps/web/src/ui/CompletedMarkdown.tsx                       |
| 03-104 | medium bug   | Thread Find misses structural transcript changes                            | apps/web/src/ui/ThreadSearch.tsx                            |
| 03-106 | medium bug   | A pending diff refresh can overwrite a hunk decision                        | apps/web/src/ui/DiffReview.tsx                              |
| 03-109 | medium bug   | A dismissed failed provider update cannot reopen                            | apps/web/src/ui/ProviderUpdates.tsx                         |
| 03-110 | medium bug   | Terminal recovery can take focus from a chat draft                          | apps/web/src/ui/TerminalPane.tsx                            |
| 03-113 | medium bug   | Confirmed PR action errors appear behind their modal                        | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 03-123 | medium bug   | Tool output with a text-like key loses sibling data                         | apps/web/src/ui/tool-call-text.ts                           |
| 03-125 | medium bug   | A running Inbox clock can skip a relative-time label for an hour            | apps/web/src/ui/InboxSidebar.tsx                            |
| 03-126 | medium bug   | IME confirmation can trigger actions before composition ends                | apps/web/src/ui/CommandPalette.tsx                          |
| 03-135 | medium bug   | Reordering tabs after closing the active tab can switch tools               | apps/web/src/ui/workspace/WorkspacePanel.tsx                |
| 03-139 | medium bug   | A late provider setup reply reverses navigation away from Settings          | apps/web/src/ui/Settings.tsx                                |
| 04-002 | medium bug   | Dev shutdown loses groups after their leader exits                          | tools/scripts/dev.js                                        |
| 04-003 | medium bug   | Dev startup timeout leaves owned processes running                          | tools/scripts/dev.js                                        |
| 04-021 | medium bug   | Feed gate skips versions with build metadata                                | tools/scripts/check-update-feed.js                          |
| 04-026 | medium bug   | Dev shutdown can start an unowned desktop process                           | tools/scripts/dev.js                                        |
| 04-035 | medium bug   | Dev restart misses German Windows listeners                                 | tools/scripts/dev.js                                        |
| 05-001 | medium bug   | Failed Codex history reads hide previously imported turns                   | packages/adapter-codex/src/rollout-records.ts               |
| 05-003 | medium bug   | Failed Codex disposal cannot retry process termination                      | packages/adapter-codex/src/adapter.ts                       |
| 05-005 | medium bug   | Codex model discovery ignores later pages                                   | packages/adapter-codex/src/adapter.ts                       |
| 05-006 | medium bug   | Malformed known Codex requests receive no response                          | packages/adapter-codex/src/adapter.ts                       |
| 05-007 | medium bug   | Compatibility fallback restores explicitly hidden Codex models              | packages/adapter-codex/src/adapter.ts                       |
| 05-008 | medium bug   | Empty MCP content hides a structured result                                 | packages/adapter-codex/src/map-item.ts                      |
| 05-011 | medium bug   | A null MultiEdit entry fails Claude turns and history reads                 | packages/adapter-claude-code/src/events.ts                  |
| 05-017 | medium bug   | Windows npm shims break both providers' updater detection                   | packages/adapter-codex/src/updates.ts                       |
| 05-020 | medium bug   | Claude Winget updates compare against an npm version                        | packages/adapter-claude-code/src/updates.ts                 |
| 05-022 | medium bug   | Claude usage probes lose failed process cleanup                             | packages/adapter-claude-code/src/limits.ts                  |
| 05-027 | medium bug   | Failed Claude interrupt changes a later success to Interrupted              | packages/adapter-claude-code/src/adapter.ts                 |
| 05-028 | medium bug   | Malformed rich history records suppress valid fallback content              | packages/adapter-codex/src/history-transcript.ts            |
| 05-029 | medium bug   | Imported Codex rename diffs show the old destination                        | packages/adapter-codex/src/history-items.ts                 |
| 05-031 | medium bug   | Claude edit diffs invent blank lines and miscount marker text               | packages/adapter-claude-code/src/events.ts                  |
| 05-032 | medium bug   | Claude history cache ignores index-only metadata updates                    | packages/adapter-claude-code/src/history.ts                 |
| 05-033 | medium bug   | MCP sign-in refresh keeps the old Codex inventory                           | packages/adapter-codex/src/adapter.ts                       |
| 05-035 | medium bug   | Imported mixed tool content loses resource links                            | packages/adapter-codex/src/history-items.ts                 |
| 05-037 | medium bug   | Claude effort changes start a replacement before cleanup settles            | packages/adapter-claude-code/src/adapter.ts                 |
| 05-044 | medium bug   | A failed Codex header read keeps a saved chat undiscoverable                | packages/adapter-codex/src/history.ts                       |
| 06-001 | medium bug   | Failed adapter disposal permanently defeats cleanup retries                 | packages/proc/src/jsonrpc.ts                                |
| 06-006 | medium bug   | Dead Grok ACP runtimes are reused on Retry                                  | packages/adapter-acp/src/adapter.ts                         |
| 06-007 | medium bug   | Stock Grok ACP startup has no deadline                                      | packages/adapter-acp/src/adapter.ts                         |
| 06-008 | medium bug   | Sparse ACP edit completion replaces the real file path                      | packages/adapter-acp/src/events.ts                          |
| 06-009 | medium bug   | ACP tool chunks lose line breaks and indentation                            | packages/adapter-acp/src/events.ts                          |
| 06-010 | medium bug   | ACP reasoning joins across intervening tools and answers                    | packages/adapter-acp/src/events.ts                          |
| 06-013 | medium bug   | Grok output-token totals count reasoning twice                              | packages/adapter-grok/src/adapter.ts                        |
| 06-014 | medium bug   | Grok updates inspect a different executable from chats                      | packages/adapter-grok/src/updates.ts                        |
| 06-015 | medium bug   | Grok fallback history marks an unanswered prompt complete                   | packages/adapter-grok/src/history-transcript.ts             |
| 06-016 | medium bug   | Recovered setup-terminal output stays invisible                             | apps/web/src/provider-install.ts                            |
| 06-017 | medium bug   | Malformed login URLs can prevent terminal completion recovery               | apps/web/src/provider-install.ts                            |
| 06-020 | medium bug   | Windows cleanup treats a dead parent as a stopped process tree              | packages/proc/src/kill.ts                                   |
| 06-021 | medium bug   | Update discovery can select a file that launch will skip                    | packages/proc/src/updates.ts                                |
| 06-027 | medium bug   | Provider-rejected skills reappear as enabled                                | apps/server/src/skill-inventory.ts                          |
| 06-028 | medium bug   | Skill installation exposes an incomplete final folder                       | apps/server/src/skill-install.ts                            |
| 06-033 | medium bug   | Grok diffs count unchanged lines as edits and lose newline state            | packages/adapter-grok/src/adapter.ts                        |
| 06-038 | medium bug   | Each ACP edit replaces the earlier turn diff                                | packages/adapter-acp/src/events.ts                          |
| 06-045 | medium bug   | Saved Grok tools retain only their first file diff                          | packages/adapter-grok/src/history-transcript.ts             |
| 06-051 | medium bug   | Setup cancellation can block retry or change back to success                | apps/web/src/provider-install.ts                            |
| 06-054 | medium bug   | ACP final accounting removes the known context meter                        | packages/adapter-acp/src/adapter.ts                         |
| 06-055 | medium bug   | Incoming RPC handler errors leave requests unanswered                       | packages/proc/src/jsonrpc.ts                                |
| 06-057 | medium bug   | Grok frame overflow releases the checkout before shutdown                   | packages/adapter-grok/src/adapter.ts                        |
| 06-058 | medium bug   | Provider detection accepts directories as installed executables             | packages/proc/src/cli.ts                                    |
| 06-060 | medium bug   | Grok history can assign a later prompt ID to an earlier turn                | packages/adapter-grok/src/history-transcript.ts             |
| 06-063 | medium bug   | Renewing an expired watch does not restart notifications                    | apps/web/src/provider-watch.ts                              |
| 07-001 | medium bug   | Generated gradients contain invalid color syntax                            | packages/design-agent/src/gradients.ts                      |
| 07-002 | medium bug   | Live Brand output can bypass palette safety checks                          | packages/design-agent/src/brand-phase.ts                    |
| 07-003 | medium bug   | Generated caches can prevent Design from starting                           | packages/design-agent/src/workspace-files.ts                |
| 07-004 | medium bug   | Asset validation and approval can select different files                    | packages/design-agent/src/assets.ts                         |
| 07-006 | medium bug   | Raster validation accepts files with no image payload                       | packages/design-agent/src/raster-metadata.ts                |
| 07-008 | medium bug   | Exact-file parsing corrupts names, lists and later corrections              | packages/design-agent/src/build-phase.ts                    |
| 07-009 | medium bug   | Concept labels do not cover related copy fields                             | packages/design-agent/src/copywriting.ts                    |
| 07-010 | medium bug   | Non-rendered SVG text can block Build                                       | packages/design-agent/src/source-quality.ts                 |
| 07-012 | medium bug   | An explicit reference revision can select its base instead                  | packages/design-agent/src/reference-library.ts              |
| 07-013 | medium bug   | Reserved-prefix catalog IDs lose their reference images                     | packages/design-agent/src/reference-library.ts              |
| 07-014 | medium bug   | Mixed filename case admits incomplete reference fragments                   | packages/design-agent/src/reference-library-index.ts        |
| 07-016 | medium bug   | Page can approve an impossible Assets contract                              | packages/design-agent/src/page.ts                           |
| 07-017 | medium bug   | Unsupported preview inputs bypass the correction path                       | packages/design-agent/src/preview.ts                        |
| 07-018 | medium bug   | Switching chats deletes partial question answers                            | apps/web/src/design-agent/UserInput.tsx                     |
| 07-033 | medium bug   | Nested static entry files resolve assets from the wrong directory           | packages/design-agent/src/preview.ts                        |
| 07-038 | medium bug   | Password answers lose meaningful spaces before submission                   | apps/web/src/design-agent/UserInput.tsx                     |
| 07-045 | medium bug   | Generated reference IDs reject ordinary site folder names                   | packages/design-agent/src/reference-library-index.ts        |
| 07-046 | medium bug   | SVG approval compares path spelling instead of file identity                | packages/design-agent/src/source-quality.ts                 |
| 07-050 | medium bug   | Repeated section labels apply another reference's review status             | packages/design-agent/src/reference-library-index.ts        |
| 07-059 | medium bug   | SVG baseline hashes include unrelated sibling content                       | packages/design-agent/src/source-quality.ts                 |
| 07-061 | medium bug   | Inline asset approval can freeze unrelated application source               | packages/design-agent/src/source-quality.ts                 |
| 07-062 | medium bug   | Assets can freeze a file that the exact deliverable rule forbids            | packages/design-agent/src/asset-phase.ts                    |
| 08-014 | medium bug   | Timed-out PTY closure cannot retry the stop                                 | apps/server/src/terminal.ts                                 |
| 08-018 | medium bug   | A database failure in the delta timer can stop the server                   | apps/server/src/recorded-delta-buffer.ts                    |
| 08-019 | medium bug   | Malformed Codex requests are logged but never answered                      | packages/adapter-codex/src/adapter.ts                       |
| 08-020 | medium bug   | Duplicate request identities abandon earlier RPC responders                 | packages/adapter-codex/src/adapter.ts                       |
| 08-023 | medium bug   | Validator import failure turns accepted work into an apparent rejection     | apps/web/src/transport.ts                                   |
| 08-026 | medium bug   | Removed resource chips return from saved drafts                             | apps/web/src/ui/Composer.tsx                                |
| 08-027 | medium bug   | Missed MCP OAuth completion leaves settings locked                          | apps/web/src/ui/McpSettings.tsx                             |
| 08-029 | medium bug   | Dev startup can stop an unrelated app on its chosen ports                   | tools/scripts/dev.js                                        |
| 08-030 | medium bug   | Dev shutdown loses the group when its leader exits                          | tools/scripts/dev.js                                        |
| 08-044 | medium bug   | Server history replies can exceed the client's effective limit              | apps/web/src/transport.ts                                   |
| 08-046 | medium bug   | Built-in Grok MCP startup has no RPC deadline                               | packages/adapter-acp/src/adapter.ts                         |
| 08-049 | medium bug   | Adapter disposal can lose its process or become impossible to retry         | packages/proc/src/jsonrpc.ts                                |
| 08-060 | medium bug   | Query-only Unicode normalization hides exact search matches                 | apps/server/src/store.ts                                    |
| 08-061 | medium bug   | Codex MCP pagination has no progress or total-work bound                    | packages/adapter-codex/src/adapter.ts                       |
| 08-063 | medium bug   | Uncertain PR actions are presented as safe retries                          | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 08-064 | medium bug   | Comment editors reopen stale text after a PR refresh                        | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 08-073 | medium bug   | ACP limit stops overwrite failure with a successful terminal status         | packages/adapter-acp/src/adapter.ts                         |
| 08-078 | medium bug   | Retired imported diffs can still authorize file Undo                        | apps/server/src/store.ts                                    |
| 09-001 | medium bug   | Generated brand gradients use invalid CSS                                   | packages/design-agent/src/gradients.ts                      |
| 09-009 | medium bug   | Windows cleanup treats an exited leader as a stopped process tree           | packages/proc/src/kill.ts                                   |
| 09-012 | medium bug   | Windows shim arguments can be parsed as cmd syntax                          | packages/proc/src/cli.ts                                    |
| 09-024 | medium bug   | Windows npm shims are not recognized by provider update detection           | packages/proc/src/updates.ts                                |
| 09-025 | medium bug   | Grok chat and provider controls resolve different executables               | packages/adapter-grok/src/adapter.ts                        |
| 09-026 | medium bug   | ACP output loses whitespace at every frame boundary                         | packages/adapter-acp/src/events.ts                          |
| 09-028 | medium bug   | Codex smoke exits before cleanup and treats failed turns as success         | packages/adapter-codex/src/smoke.ts                         |
| 09-030 | medium bug   | Claude history ignores index-only metadata changes                          | packages/adapter-claude-code/src/history.ts                 |
| 09-037 | medium bug   | IME confirmation keys trigger actions before composition ends               | apps/web/src/ui/CommandPalette.tsx                          |
| 09-038 | medium bug   | Settings takes focus from its portalled provider dialog                     | apps/web/src/ui/Settings.tsx                                |
| 09-039 | medium bug   | Menu treats non-tabbable radios as Tab stops                                | apps/web/src/ui/Menu.tsx                                    |
| 09-040 | medium bug   | Command shortcuts take macOS Control text-editing keys                      | apps/web/src/shortcuts.ts                                   |
| 09-041 | medium bug   | Keybind settings accept shortcuts that reserved actions override            | apps/web/src/shortcuts.ts                                   |
| 09-042 | medium bug   | Media, search and PR dialogs let commands act on the hidden app             | apps/web/src/ui/MediaViewer.tsx                             |
| 09-049 | medium bug   | Failed legacy project imports remove their retry data                       | apps/web/src/App.tsx                                        |
| 09-050 | medium bug   | The first chat after startup ignores a pinned provider default              | apps/web/src/App.tsx                                        |
| 09-051 | medium bug   | Switching chats during header rename can rename the next chat               | apps/web/src/ui/StageHeader.tsx                             |
| 09-052 | medium bug   | Archive all chats skips pinned chats                                        | apps/web/src/ui/Sidebar.tsx                                 |
| 09-053 | medium bug   | StrictMode replay disables archive queue render requests                    | apps/web/src/ui/useDeferredArchiveQueue.ts                  |
| 09-054 | medium bug   | Refreshed PR comments open a stale edit buffer                              | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 09-055 | medium bug   | File-link decoding changes valid filename characters                        | apps/web/src/ui/CompletedMarkdown.tsx                       |
| 09-056 | medium bug   | File-to-directory changes hide added descendants in Review                  | apps/web/src/ui/workspace/review-file-tree.ts               |
| 09-057 | medium bug   | Review merges distinct macOS Git filenames containing backslashes           | apps/web/src/ui/workspace/review-file-tree.ts               |
| 09-058 | medium bug   | Approved SVGs fail when manifest case differs from disk case                | packages/design-agent/src/source-quality.ts                 |
| 09-059 | medium bug   | Loopback addresses with query strings default to HTTPS                      | apps/web/src/ui/workspace/browser-url.ts                    |
| 09-061 | medium bug   | Search indexing misses updates to earlier parallel items                    | apps/web/src/thread-search-index.ts                         |
| 09-062 | medium bug   | Thread Find memoizes results across in-place index changes                  | apps/web/src/ui/ThreadSearch.tsx                            |
| 09-063 | medium bug   | Large live-overlay metadata retains every preceding frame                   | apps/web/src/thread-store.ts                                |
| 09-068 | medium bug   | Development shutdown loses descendants after the leader exits               | tools/scripts/dev.js                                        |
| 09-069 | medium bug   | Windows PID reuse can make development startup loop forever                 | tools/scripts/dev.js                                        |
| 09-070 | medium bug   | Adding a release-checklist row silently moves saved choices                 | docs/feature-inventory.html                                 |
| 09-074 | medium bug   | Native menu actions bypass modal and key-recording guards                   | apps/web/src/App.tsx                                        |
| 09-086 | medium bug   | Full-size image failures remain hidden behind thumbnails                    | apps/web/src/ui/MediaViewer.tsx                             |
| 09-087 | medium bug   | Review navigation can scroll the other workspace panel                      | apps/web/src/ui/workspace/WorkspaceReview.tsx               |
| 09-088 | medium bug   | Browser guest events overwrite an address being typed                       | apps/web/src/ui/workspace/WorkspaceBrowser.tsx              |
| 09-089 | medium bug   | Directory read failures disappear while a file is displayed                 | apps/web/src/ui/workspace/WorkspaceFiles.tsx                |
| 09-090 | medium bug   | History archives omit which imported events are still active                | apps/server/src/store.ts                                    |
| 09-093 | medium bug   | A timed-out terminal close cannot retry termination                         | apps/server/src/terminal.ts                                 |
| 09-095 | medium bug   | Rejected adapter disposal promises make stop retries permanent failures     | packages/proc/src/jsonrpc.ts                                |
| 09-096 | medium bug   | Malformed Codex requests are logged but never answered                      | packages/adapter-codex/src/adapter.ts                       |
| 09-099 | medium bug   | License-expression validation accepts operators without licenses            | tools/scripts/release-licenses.js                           |
| 09-102 | medium bug   | Fast-mode shortcuts do not save the current chat's tier                     | apps/web/src/App.tsx                                        |
| 09-104 | medium bug   | A context save for one provider hides another provider's error              | apps/web/src/ui/ProviderTuning.tsx                          |
| 09-106 | medium bug   | Silent PR reloads can leave Refresh permanently spinning                    | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 09-108 | medium bug   | Vite mode-file endpoints do not reach the generated CSP                     | apps/web/vite.config.ts                                     |
| 09-109 | medium bug   | Validator import failure loses accepted-call uncertainty and queued pushes  | apps/web/src/transport.ts                                   |
| 09-110 | medium bug   | CRLF closing fences stay inside streamed code blocks                        | apps/web/src/ui/live-markdown.ts                            |
| 09-111 | medium bug   | Raster headers without image data pass the Design ready gate                | packages/design-agent/src/raster-metadata.ts                |
| 09-114 | medium bug   | Ambiguous shortened refs become invalid isolated-task branch names          | apps/server/src/workspace.ts                                |
| 09-115 | medium bug   | Hidden-provider chats bypass isolated-checkout deletion guards              | apps/server/src/server.ts                                   |
| 09-121 | medium bug   | Adaptive sidebar clock drops relative-time updates                          | apps/web/src/ui/InboxSidebar.tsx                            |
| 09-122 | medium bug   | Closing the context ruler mid-drag leaves an unsaved displayed value        | apps/web/src/ui/ProviderTuning.tsx                          |
| 09-123 | medium bug   | Loading search and media overlays cannot be closed                          | apps/web/src/ui/SessionSearchHost.tsx                       |
| 09-124 | medium bug   | Voice waveform disappears on the standard light theme                       | apps/web/src/ui/VoiceWaveform.tsx                           |
| 09-125 | medium bug   | Grok frame overflow drops process ownership before termination              | packages/adapter-grok/src/adapter.ts                        |
| 09-129 | medium bug   | First-chat startup can discard a newer unsent draft                         | apps/web/src/App.tsx                                        |
| 09-130 | medium bug   | Removing a project leaves the selected chat attached to another project     | apps/web/src/App.tsx                                        |
| 09-131 | medium bug   | Project-add failures have no visible action error                           | apps/web/src/App.tsx                                        |
| 09-132 | medium bug   | Ordinary command output is misread as a legacy tool envelope                | apps/web/src/ui/Thread.tsx                                  |
| 09-133 | medium bug   | LEFT review comments use the original instead of current line               | apps/web/src/ui/pull-requests/PullRequestFiles.tsx          |
| 09-135 | medium bug   | Newlines in macOS filenames break both synthetic diff formats               | apps/web/src/ui/pull-requests/diffs-patch.ts                |
| 09-143 | medium bug   | Voice send submits removed attachments and clears newer ones                | apps/web/src/ui/ComposerVoiceControl.tsx                    |
| 09-144 | medium bug   | Clearing restored resource chips does not update the saved draft            | apps/web/src/ui/Composer.tsx                                |
| 09-146 | medium bug   | Late checkpoint operations update another chat's visible state              | apps/web/src/App.tsx                                        |
| 09-147 | medium bug   | Retired imported diffs still pass the Undo API's stale check                | apps/server/src/store.ts                                    |
| 09-148 | medium bug   | Underscore search matches can be absent from result snippets                | apps/server/src/store.ts                                    |
| 09-149 | medium bug   | Closing one Temporary chat tab destroys the other panel's session           | apps/web/src/ui/workspace/WorkspaceSideChat.tsx             |
| 09-150 | medium bug   | An expired Side chat close request loses process cleanup ownership          | apps/web/src/ui/workspace/WorkspaceSideChat.tsx             |
| 09-155 | medium bug   | A second touch can move or finish another pointer's panel drag              | apps/web/src/ui/panel-resize.ts                             |
| 09-161 | medium bug   | Grok MCP startup can hold an uncancellable checkout owner forever           | packages/adapter-acp/src/adapter.ts                         |
| 09-162 | medium bug   | Existing Design assets can validate one file and protect another            | packages/design-agent/src/file-snapshot.ts                  |
| 10-001 | medium bug   | ACP output tests accept lost whitespace                                     | packages/adapter-acp/src/events.ts                          |
| 10-002 | medium bug   | Gradient tests require invalid CSS                                          | packages/design-agent/src/gradients.ts                      |
| 10-007 | medium bug   | Live-map metadata retains old stream frames                                 | apps/web/src/thread-store.ts                                |
| 10-008 | medium bug   | Removed draft resources reappear after navigation                           | apps/web/src/ui/Composer.tsx                                |
| 10-009 | medium bug   | Archive all chats excludes pinned chats                                     | apps/web/src/ui/Sidebar.tsx                                 |
| 10-015 | medium bug   | Dev shutdown loses descendants after their leader exits                     | tools/scripts/dev.js                                        |
| 10-018 | medium bug   | A rename can move to the newly selected chat                                | apps/web/src/ui/StageHeader.tsx                             |
| 10-019 | medium bug   | Strict Mode disables deferred archive updates                               | apps/web/src/ui/useDeferredArchiveQueue.ts                  |
| 10-020 | medium bug   | Fast-mode shortcuts do not save the chat choice                             | apps/web/src/App.tsx                                        |
| 10-022 | medium bug   | The voice waveform is invisible in light mode                               | apps/web/src/ui/VoiceWaveform.tsx                           |
| 10-042 | medium bug   | Feature checklist edits shift saved selections                              | docs/feature-inventory.html                                 |
| 10-046 | medium bug   | Open thread search misses newly appended matches                            | apps/web/src/ui/ThreadSearch.tsx                            |
| 10-047 | medium bug   | Non-tail completion leaves stale search text                                | apps/web/src/thread-search-index.ts                         |
| 10-048 | medium bug   | Voice Send uses attachments from before transcription                       | apps/web/src/ui/ComposerVoiceControl.tsx                    |
| 10-050 | medium bug   | Action refresh can leave PR Refresh permanently busy                        | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 10-051 | medium bug   | Refreshed PR comments edit their old text                                   | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 10-052 | medium bug   | File-to-directory changes hide review tree entries                          | apps/web/src/ui/workspace/review-file-tree.ts               |
| 10-054 | medium bug   | Automatic naming replaces a manual startup title                            | apps/web/src/App.tsx                                        |
| 10-057 | medium bug   | Asset validation accepts undecodable image files                            | packages/design-agent/src/raster-metadata.ts                |
| 10-064 | medium bug   | A stalled dev startup leaves detached children running                      | tools/scripts/dev.js                                        |
| 10-065 | medium bug   | An idle Inbox can defer its next clock tick by an hour                      | apps/web/src/ui/InboxSidebar.tsx                            |
| 10-066 | medium bug   | Resource mutations can lose request and draft ownership                     | apps/web/src/ui/SkillsSettings.tsx                          |
| 10-081 | medium bug   | Resource picker cache outlives its change subscription                      | apps/web/src/ui/ComposerResourcePicker.tsx                  |
| 10-084 | medium bug   | Closing a compaction drag can leave an unsaved value displayed              | apps/web/src/ui/ProviderTuning.tsx                          |
| 10-085 | medium bug   | Settings cannot retry some first failed reads                               | apps/web/src/ui/ProviderTuning.tsx                          |
| 10-087 | medium bug   | Global chat shortcuts escape PR dialogs                                     | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 10-089 | medium bug   | Review navigation IDs collide across workspace hosts                        | apps/web/src/ui/workspace/WorkspaceReview.tsx               |
| 10-090 | medium bug   | Side-chat delta batches survive a parent change                             | apps/web/src/ui/workspace/WorkspaceSideChat.tsx             |
| 10-098 | medium bug   | PATH lookup accepts directories as executable tools                         | packages/proc/src/cli.ts                                    |
| 10-099 | medium bug   | Legacy project migration discards failed additions                          | apps/web/src/App.tsx                                        |
| 10-100 | medium bug   | Pinned model defaults are bypassed on some new-chat paths                   | apps/web/src/App.tsx                                        |
| 10-104 | medium bug   | Hidden-provider rows consume main search pages                              | apps/server/src/store.ts                                    |
| 10-105 | medium bug   | Retired imported diffs remain eligible for reversal                         | apps/server/src/store.ts                                    |
| 10-109 | medium bug   | Reference IDs match other IDs by substring                                  | packages/design-agent/src/reference-library.ts              |
| 10-110 | medium bug   | Failed custom-harness discovery can erase a saved service tier              | apps/web/src/App.tsx                                        |
| 10-111 | medium bug   | Empty MCP text content suppresses structured results                        | packages/adapter-codex/src/map-item.ts                      |
| 10-118 | medium bug   | Command PATH filtering retains relative lookup directories                  | apps/server/src/safe-command-environment.ts                 |
| 10-123 | medium bug   | An old checkpoint-read failure clears the new chat's checkpoints            | apps/web/src/App.tsx                                        |
| 10-128 | medium bug   | Lazy validation failure rolls back already accepted sends                   | apps/web/src/transport.ts                                   |
| 10-132 | medium bug   | Profile image checks accept an undecodable avatar                           | apps/web/src/profile-preferences.ts                         |
| 10-133 | medium bug   | Malformed auth URL text interrupts login state updates                      | apps/web/src/provider-install.ts                            |
| 10-134 | medium bug   | Unsent side-chat drafts move to a different parent                          | apps/web/src/ui/workspace/WorkspaceSideChat.tsx             |
| 10-135 | medium bug   | Find does not reveal matches inside collapsed activity                      | apps/web/src/ui/Thread.tsx                                  |
| 10-140 | medium bug   | A failed Claude interrupt still marks the turn interrupted                  | packages/adapter-claude-code/src/adapter.ts                 |
| 10-141 | medium bug   | Sparse ACP completion erases the file-change path                           | packages/adapter-acp/src/events.ts                          |
| 10-143 | medium bug   | Failed process cleanup is cached and cannot be retried                      | packages/proc/src/jsonrpc.ts                                |
| 10-144 | medium bug   | Grok leaks a new prompt when stopping its old child fails                   | packages/adapter-grok/src/adapter.ts                        |
| 10-145 | medium bug   | MCP sign-in cannot recover a completion missed while offline                | apps/web/src/ui/McpSettings.tsx                             |
| 10-146 | medium bug   | An old diff refresh can overwrite a successful review decision              | apps/web/src/ui/DiffReview.tsx                              |
| 10-147 | medium bug   | A later provider-setting edit hides an earlier provider's error             | apps/web/src/ui/ProviderTuning.tsx                          |
| 10-149 | medium bug   | Ordinary command output is mistaken for a legacy tool envelope              | apps/web/src/ui/Thread.tsx                                  |
| 10-150 | medium bug   | Left-side PR comments prefer historical line numbers                        | apps/web/src/ui/pull-requests/PullRequestFiles.tsx          |
| 10-154 | medium bug   | A bounded subagent wait timeout is labeled finished                         | packages/adapter-codex/src/map-item.ts                      |
| 10-157 | medium bug   | Search treats IME confirmation as chat navigation                           | apps/web/src/ui/SessionSearch.tsx                           |
| 10-161 | medium bug   | Composer width changes leave its height stale                               | apps/web/src/ui/Composer.tsx                                |
| 10-164 | medium bug   | Pending modal shells have no working close controls                         | apps/web/src/ui/LazyMediaViewer.tsx                         |
| 10-165 | medium bug   | ACP Full mode asks when only one-time allowance is offered                  | packages/adapter-acp/src/adapter.ts                         |
| 10-167 | medium bug   | Root-relative PR image paths are mistaken for GitHub uploads                | apps/web/src/ui/pull-requests/pull-request-image-source.ts  |
| 10-169 | medium bug   | Existing terminals read appearance before the root updates it               | apps/web/src/ui/TerminalPane.tsx                            |
| 10-170 | medium bug   | Empty Claude edit text becomes an added blank line                          | packages/adapter-claude-code/src/events.ts                  |
| 10-172 | medium bug   | Claude usage queries discard process-cleanup ownership                      | packages/adapter-claude-code/src/limits.ts                  |
| 10-173 | medium bug   | Claude change counts mistake hunk payload for file headers                  | packages/adapter-claude-code/src/events.ts                  |
| 10-174 | medium bug   | A completed login read can invalidate another provider's account read       | apps/web/src/App.tsx                                        |
| 10-175 | medium bug   | Claude tool inputs are shown as exact patches without enough change data    | packages/adapter-claude-code/src/events.ts                  |
| 01-013 | medium issue | Search snippets have no character budget                                    | apps/server/src/store.ts                                    |
| 01-032 | medium issue | Tests pin checkpoints in the real source checkout                           | apps/server/src/orchestrator.test.ts                        |
| 01-043 | medium issue | Static preview assets use unbounded synchronous reads                       | apps/server/src/design-static-preview.ts                    |
| 02-011 | medium issue | Live transition metadata retains all large streaming snapshots              | apps/web/src/thread-store.ts                                |
| 02-012 | medium issue | Collapsed activity rows still mount and multiply stream subscriptions       | apps/web/src/ui/Thread.tsx                                  |
| 02-013 | medium issue | Closed activity summaries scan the full tool group every frame              | apps/web/src/ui/Thread.tsx                                  |
| 02-022 | medium issue | Sealed Markdown leaves repeatedly replace the entire text prefix            | apps/web/src/ui/Markdown.tsx                                |
| 02-023 | medium issue | Open Find repeats a full-history search on every stream frame               | apps/web/src/ui/ThreadSearch.tsx                            |
| 02-032 | medium issue | Closed tool details still parse and format full output                      | apps/web/src/ui/Thread.tsx                                  |
| 02-048 | medium issue | Selected-chat delta buffers grow while animation frames are paused          | apps/web/src/thread-controller.ts                           |
| 02-090 | medium issue | Modal Tab boundaries include controls excluded from native Tab order        | apps/web/src/ui/Menu.tsx                                    |
| 03-006 | medium issue | Dialog focus trapping counts radio buttons that Tab skips                   | apps/web/src/ui/Menu.tsx                                    |
| 03-010 | medium issue | Voice recording feedback disappears in light mode                           | apps/web/src/ui/VoiceWaveform.tsx                           |
| 03-011 | medium issue | Zoom controls disappear while in use                                        | apps/web/src/ui/ZoomHud.tsx                                 |
| 03-034 | medium issue | Keyboard archive loses its place in the sidebar                             | apps/web/src/ui/Sidebar.tsx                                 |
| 03-038 | medium issue | Search results omit their matching text from accessible names               | apps/web/src/ui/SessionSearch.tsx                           |
| 03-039 | medium issue | Inbox selection is visual only                                              | apps/web/src/ui/InboxSidebar.tsx                            |
| 03-045 | medium issue | Closed tool rows decode their full output                                   | apps/web/src/ui/Thread.tsx                                  |
| 03-047 | medium issue | One tool delta wakes and scans its whole mounted activity group             | apps/web/src/ui/Thread.tsx                                  |
| 03-049 | medium issue | Long streamed fences repeatedly rewrite their full text prefix              | apps/web/src/ui/Markdown.tsx                                |
| 03-054 | medium issue | Resource suggestions do not expose the active option to the textbox         | apps/web/src/ui/Composer.tsx                                |
| 03-065 | medium issue | Workspace resizing has no keyboard control                                  | apps/web/src/ui/workspace/WorkspacePanel.tsx                |
| 03-070 | medium issue | Narrow workspace panels retain layouts for a wide window                    | apps/web/src/ui/workspace-panel.css                         |
| 03-072 | medium issue | An expanded workspace leaves hidden chat controls focusable                 | apps/web/src/styles/app.css                                 |
| 03-073 | medium issue | Touch users cannot reveal text-prompt actions                               | apps/web/src/styles/thread.css                              |
| 03-074 | medium issue | Dark onboarding labels have insufficient contrast                           | apps/web/src/styles/onboarding.css                          |
| 03-076 | medium issue | Large question cards extend outside the visible stage                       | apps/web/src/design-agent/user-input.css                    |
| 03-089 | medium issue | Global shortcuts can move focus behind loaded modal dialogs                 | apps/web/src/ui/MediaViewer.tsx                             |
| 03-101 | medium issue | The dark Stop button's glyph has very low contrast                          | apps/web/src/styles/tokens.css                              |
| 03-102 | medium issue | Default dark file references are hard to read                               | apps/web/src/styles/tokens.css                              |
| 03-115 | medium issue | Opening a PR filter category can lose keyboard focus                        | apps/web/src/ui/pull-requests/PullRequestsView.tsx          |
| 03-120 | medium issue | Cold loading overlays block the window without owning focus                 | apps/web/src/ui/SurfaceSkeletons.tsx                        |
| 03-127 | medium issue | A hover-revealed sidebar can hide its focused input                         | apps/web/src/ui/Sidebar.tsx                                 |
| 03-131 | medium issue | Trimming live reasoning forces whole-prefix Markdown rebuilds               | apps/web/src/ui/Thread.tsx                                  |
| 03-133 | medium issue | Light-theme Design text loses contrast on focus and hover                   | apps/web/src/styles/app.css                                 |
| 03-136 | medium issue | Settings steals Tab from a nested provider dialog                           | apps/web/src/ui/Settings.tsx                                |
| 03-137 | medium issue | Light-theme queued Steer text has insufficient contrast                     | apps/web/src/styles/tokens.css                              |
| 04-006 | medium issue | Diagnostics redaction misses compound keys and quoted value tails           | apps/desktop/src/local-diagnostics.ts                       |
| 04-007 | medium issue | Diagnostics queue has no memory bound                                       | apps/desktop/src/local-diagnostics.ts                       |
| 04-009 | medium issue | macOS release proof checks a different app from the shipped archives        | tools/scripts/verify-release-assets.js                      |
| 04-019 | medium issue | Viewed-image test requires Windows symlink privilege                        | apps/desktop/src/viewed-image-path.test.ts                  |
| 04-022 | medium issue | Feed gate passes a release order that strands older clients                 | tools/scripts/check-update-feed.js                          |
| 04-023 | medium issue | Normal packaging leaves implicit draft uploads enabled                      | apps/desktop/package.json                                   |
| 04-028 | medium issue | Download tests assume POSIX directory permissions on Windows                | apps/desktop/src/update-download.test.ts                    |
| 05-019 | medium issue | Unanswered Codex control reads retain a helper indefinitely                 | packages/adapter-codex/src/adapter.ts                       |
| 05-023 | medium issue | Orchestrator tests retain checkpoints in the developer checkout             | apps/server/src/orchestrator.test.ts                        |
| 05-052 | medium issue | Codex header discovery does not bound physical rows or bytes                | packages/adapter-codex/src/history.ts                       |
| 05-062 | medium issue | Inline tool images escape text filtering                                    | packages/adapter-codex/src/binary-content.ts                |
| 05-065 | medium issue | Claude metadata discovery exceeds its byte-window bound                     | packages/adapter-claude-code/src/history.ts                 |
| 06-029 | medium issue | Installed skill paths are not checked for Windows portability               | apps/server/src/skill-install.ts                            |
| 06-030 | medium issue | Skill inventory reads the complete definition without a bound               | apps/server/src/skill-inventory.ts                          |
| 06-032 | medium issue | An incompatible provider roster keeps the same protocol version             | packages/contracts/src/protocol.ts                          |
| 06-036 | medium issue | Shared background selection contains provider-specific policy               | apps/server/src/background-model.ts                         |
| 06-043 | medium issue | Grok history eagerly reads and parses both full transcripts                 | packages/adapter-grok/src/history.ts                        |
| 06-053 | medium issue | ACP tool output writes repeated full snapshots on every chunk               | packages/adapter-acp/src/events.ts                          |
| 06-056 | medium issue | Claude custom verification claims compatibility from help text              | apps/server/src/adapters.ts                                 |
| 06-062 | medium issue | ACP approval cards discard available command and file details               | packages/adapter-acp/src/adapter.ts                         |
| 07-019 | medium issue | Question choices hide their meaning                                         | apps/web/src/design-agent/UserInput.tsx                     |
| 07-020 | medium issue | Tall question cards clip required choices                                   | apps/web/src/design-agent/user-input.css                    |
| 07-030 | medium issue | The static preview listener omits required request-origin checks            | apps/server/src/design-static-preview.ts                    |
| 07-035 | medium issue | Static asset responses block and allocate without byte bounds               | apps/server/src/design-static-preview.ts                    |
| 07-039 | medium issue | Provider question text breaks accessible group names                        | apps/web/src/design-agent/UserInput.tsx                     |
| 07-056 | medium issue | Repeated asset records multiply synchronous PNG decoding                    | packages/design-agent/src/assets.ts                         |
| 08-009 | medium issue | Codex and ACP do not redact resolved MCP secrets at output boundaries       | packages/adapter-codex/src/adapter.ts                       |
| 08-021 | medium issue | Static preview reads whole non-HTML files without a size limit              | apps/server/src/design-static-preview.ts                    |
| 08-022 | medium issue | Skill inventory loads entire files to read short metadata                   | apps/server/src/skill-inventory.ts                          |
| 08-080 | medium issue | Closed live activity scans its whole tool group every published frame       | apps/web/src/ui/Thread.tsx                                  |
| 08-085 | medium issue | An older permission failure can restore Full access on resume               | apps/server/src/orchestrator.ts                             |
| 09-011 | medium issue | The safe PATH filter still allows project-relative executables              | apps/server/src/safe-command-environment.ts                 |
| 09-016 | medium issue | Claude compatibility can pass on help text alone                            | apps/server/src/adapters.ts                                 |
| 09-017 | medium issue | Grok's declared version warning is never wired into detection               | apps/server/src/providers.ts                                |
| 09-021 | medium issue | Updater tests mistake POSIX permissions for Windows file locks              | apps/desktop/src/update-download.test.ts                    |
| 09-022 | medium issue | Symlink fixtures fail before assertions on ordinary Windows accounts        | apps/desktop/src/viewed-image-path.test.ts                  |
| 09-035 | medium issue | Workspace file reads omit policy checks on the requested alias              | apps/server/src/workspace-files.ts                          |
| 09-043 | medium issue | Screen readers cannot discover the saved key combinations                   | apps/web/src/ui/KeybindSettings.tsx                         |
| 09-064 | medium issue | Closed activity groups rescan completed work on each output frame           | apps/web/src/ui/Thread.tsx                                  |
| 09-073 | medium issue | Unknown Grok frames disappear without a visible fallback                    | packages/adapter-grok/src/adapter.ts                        |
| 09-077 | medium issue | Static Design preview omits the required HTTP Origin gate                   | apps/server/src/design-static-preview.ts                    |
| 09-080 | medium issue | Operational checkpoint failures are silently treated as non-repositories    | apps/server/src/orchestrator.ts                             |
| 09-084 | medium issue | Resource-picker arrows do not expose the active option to screen readers    | apps/web/src/ui/Composer.tsx                                |
| 09-139 | medium issue | Repository-local database WAL files are not ignored                         | .gitignore                                                  |
| 09-154 | medium issue | The hidden main chat remains in the keyboard focus order                    | apps/web/src/styles/app.css                                 |
| 10-010 | medium issue | The native preview proof hooks an obsolete capture API                      | apps/desktop/scripts/preview-proof.ts                       |
| 10-011 | medium issue | Download tests assume POSIX directory permissions                           | apps/desktop/src/update-download.test.ts                    |
| 10-012 | medium issue | Hosted gates omit root tooling tests                                        | .github/workflows/ci.yml                                    |
| 10-013 | medium issue | Benchmarks and tests can migrate real user configuration                    | apps/desktop/scripts/benchmark-startup.js                   |
| 10-016 | medium issue | Replay eviction benchmark always misses its expected total                  | apps/server/src/store-replay-cache.bench.ts                 |
| 10-035 | medium issue | Orchestrator tests snapshot the developer checkout                          | apps/server/src/orchestrator.test.ts                        |
| 10-062 | medium issue | Split log chunks can stall startup measurements                             | apps/desktop/src/server-supervisor.ts                       |
| 10-067 | medium issue | A failing heartbeat test can leave its child alive                          | packages/proc/src/index.test.ts                             |
| 10-068 | medium issue | The typecheck gate excludes already broken test types                       | packages/proc/tsconfig.json                                 |
| 10-072 | medium issue | A symlink fixture fails on ordinary Windows setups                          | apps/desktop/src/viewed-image-path.test.ts                  |
| 10-079 | medium issue | Hidden chat controls remain reachable from the keyboard                     | apps/web/src/styles/app.css                                 |
| 10-086 | medium issue | Screen readers cannot read the configured shortcuts                         | apps/web/src/ui/KeybindSettings.tsx                         |
| 10-092 | medium issue | The Codex smoke command reports failed turns as success                     | packages/adapter-codex/src/smoke.ts                         |
| 10-112 | medium issue | Quoted multiword secrets are only partly scrubbed                           | apps/desktop/src/local-diagnostics.ts                       |
| 10-120 | medium issue | Native terminal tests load the user's shell environment                     | apps/server/src/terminal.test.ts                            |
| 10-148 | medium issue | The dialog focus trap mistakes roving buttons for Tab stops                 | apps/web/src/ui/Menu.tsx                                    |
| 10-153 | medium issue | Mac release proof checks an adjacent app rather than archive contents       | tools/scripts/verify-release-assets.js                      |
| 01-042 | medium qol   | PR option lists keep temporary failures with no Retry                       | apps/server/src/pull-requests.ts                            |
| 08-008 | medium qol   | MCP credential references have no app setup path                            | apps/web/src/ui/McpSettings.tsx                             |
| 09-046 | medium qol   | Context settings have no retry after an initial read failure                | apps/web/src/ui/ProviderTuning.tsx                          |
| 10-021 | medium qol   | Keybind settings accept unusable reserved shortcuts                         | apps/web/src/shortcuts.ts                                   |
| 10-058 | medium qol   | One optional reference manifest blocks the whole library                    | packages/design-agent/src/reference-library-index.ts        |
| 01-024 | medium slop  | Replay-cache benchmark requires a snapshot that was evicted                 | apps/server/src/store-replay-cache.bench.ts                 |
| 09-078 | medium slop  | Unit tests write durable checkpoint refs into the source checkout           | apps/server/src/orchestrator.test.ts                        |
| 09-091 | medium slop  | The 65-thread replay benchmark contradicts snapshot retention               | apps/server/src/store-replay-cache.bench.ts                 |
| 10-037 | medium slop  | The worktree crash test never reuses its stale path                         | apps/server/src/worktree.test.ts                            |
| 10-038 | medium slop  | Settings tests depend on a warmed lazy import                               | apps/web/src/App.test.tsx                                   |
| 10-040 | medium slop  | Long-history tests no longer enforce history exclusion                      | packages/adapter-codex/src/adapter.resume.test.ts           |
| 10-070 | medium slop  | Hidden activity rows subscribe to the entire group                          | apps/web/src/ui/Thread.tsx                                  |
| 10-136 | medium slop  | Live activity rendering repeatedly scans completed group members            | apps/web/src/ui/Thread.tsx                                  |
| 02-042 | low bug      | Update state can reach a listener after unsubscribe                         | apps/web/src/bridge.ts                                      |
| 02-049 | low bug      | Search title highlighting uses incompatible normalized offsets              | apps/web/src/ui/SessionSearch.tsx                           |
| 02-063 | low bug      | Video shortcuts are blocked by the viewer's normal focus path               | apps/web/src/ui/MediaViewer.tsx                             |
| 02-075 | low bug      | Image generation is labelled as image viewing during a turn                 | apps/web/src/ui/Thread.tsx                                  |
| 02-080 | low bug      | Archive animation removes virtual sidebar row placement                     | apps/web/src/ui/useArchiveMotion.ts                         |
| 02-082 | low bug      | Failed conflict refresh is reported as a successful diff refresh            | apps/web/src/ui/DiffReview.tsx                              |
| 03-008 | low bug      | Sign-in window feedback can falsely report failure                          | apps/web/src/ui/McpSettings.tsx                             |
| 03-021 | low bug      | Truncated profile photos replace valid avatars                              | apps/web/src/profile-preferences.ts                         |
| 03-027 | low bug      | Sign-in code copy failures have no feedback                                 | apps/web/src/ui/Settings.tsx                                |
| 03-028 | low bug      | Opening diagnostics ignores failure                                         | apps/web/src/ui/Settings.tsx                                |
| 03-079 | low bug      | Base menu styling overrides danger text                                     | apps/web/src/styles/app.css                                 |
| 03-088 | low bug      | Queue drag placement uses an undefined color token                          | apps/web/src/styles/app.css                                 |
| 03-093 | low bug      | PR metadata Retry sends the wrong refresh field                             | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 03-099 | low bug      | Failed PR metadata still announces loading                                  | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 03-118 | low bug      | The video loading spinner loses its center                                  | apps/web/src/styles/media-viewer.css                        |
| 03-132 | low bug      | Live image generation is labeled as image viewing                           | apps/web/src/ui/Thread.tsx                                  |
| 03-134 | low bug      | Archive motion moves virtual chat rows to the list origin                   | apps/web/src/ui/useArchiveMotion.ts                         |
| 03-138 | low bug      | CRLF closing fences stay inside streamed code                               | apps/web/src/ui/live-markdown.ts                            |
| 04-008 | low bug      | Split server output breaks startup measurement                              | apps/desktop/src/server-supervisor.ts                       |
| 04-020 | low bug      | Native haptic throttle drops a queued semantic cue                          | apps/desktop/src/macos-haptics.ts                           |
| 04-030 | low bug      | Feed checker accepts histories the installed app cannot scan                | tools/scripts/check-update-feed.js                          |
| 05-002 | low bug      | Filtered damaged rollout rows change generated item IDs                     | packages/adapter-codex/src/rollout-records.ts               |
| 05-030 | low bug      | Codex history undercounts changed lines beginning with markers              | packages/adapter-codex/src/history-items.ts                 |
| 05-045 | low bug      | Claude answer keys drop whitespace from the original question               | packages/adapter-claude-code/src/adapter.ts                 |
| 05-047 | low bug      | Failed subagent controls are labeled as successful                          | packages/adapter-codex/src/map-item.ts                      |
| 05-048 | low bug      | MCP IDs collide with inherited object properties                            | apps/server/src/mcp-config.ts                               |
| 06-026 | low bug      | Valid MCP IDs collide with inherited object keys                            | apps/server/src/mcp-config.ts                               |
| 06-031 | low bug      | YAML description markers appear in the skill UI                             | apps/server/src/skill-inventory.ts                          |
| 06-059 | low bug      | Preview PATH filtering keeps equivalent relative entries                    | apps/server/src/safe-command-environment.ts                 |
| 06-061 | low bug      | A failed prior-child stop leaves the next Grok prompt file behind           | packages/adapter-grok/src/adapter.ts                        |
| 07-026 | low bug      | Free-text palette roles can select a background as the accent               | packages/design-agent/src/gradients.ts                      |
| 08-033 | low bug      | Failed custom-harness saves leave configuration copies                      | apps/server/src/custom-harnesses.ts                         |
| 08-037 | low bug      | Skill descriptions retain YAML block markers                                | apps/server/src/skill-inventory.ts                          |
| 08-040 | low bug      | Split stdout chunks can stall the startup benchmark                         | apps/desktop/src/server-supervisor.ts                       |
| 08-047 | low bug      | Codex smoke reports failed turns as success and exits before cleanup        | packages/adapter-codex/src/smoke.ts                         |
| 08-051 | low bug      | MCP IDs and credential references collide with inherited properties         | apps/server/src/mcp-config.ts                               |
| 08-052 | low bug      | Generated gradient recipes use invalid CSS color syntax                     | packages/design-agent/src/gradients.ts                      |
| 08-054 | low bug      | PR base-branch choices discard case-distinct branches                       | apps/server/src/pull-requests.ts                            |
| 08-067 | low bug      | Signal termination can pass custom CLI verification                         | apps/server/src/custom-harness-launch.ts                    |
| 08-071 | low bug      | Fast-mode shortcut does not save the active chat's choice                   | apps/web/src/App.tsx                                        |
| 08-074 | low bug      | A failed previous-process stop leaves the next Grok prompt unowned          | packages/adapter-grok/src/adapter.ts                        |
| 09-036 | low bug      | Workspace info omits untracked changes and unborn branches                  | apps/server/src/workspace.ts                                |
| 09-092 | low bug      | Skill description parsing displays YAML block markers                       | apps/server/src/skill-inventory.ts                          |
| 09-094 | low bug      | One unknown context provider discards valid sibling settings                | apps/server/src/store.ts                                    |
| 09-100 | low bug      | Checklist storage errors stop controls or leave counts stale                | docs/feature-inventory.html                                 |
| 09-141 | low bug      | Reusing a completed capture ID deletes its successful screenshots           | apps/desktop/src/preview-capture.ts                         |
| 10-023 | low bug      | Queue drop markers use an undefined color                                   | apps/web/src/styles/app.css                                 |
| 10-026 | low bug      | Inbox timing suppresses the label update it schedules                       | apps/web/src/ui/InboxSidebar.tsx                            |
| 10-069 | low bug      | The video spinner's animation removes its centering                         | apps/web/src/styles/media-viewer.css                        |
| 10-078 | low bug      | YAML block markers leak into skill descriptions                             | apps/server/src/skill-inventory.ts                          |
| 10-126 | low bug      | The skill-row reset overrides intended paragraph gaps                       | apps/web/src/styles/settings.css                            |
| 10-139 | low bug      | PR check summary counts skipped checks as successful                        | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 10-162 | low bug      | Checklist storage errors stop setup or leave counts stale                   | docs/feature-inventory.html                                 |
| 10-163 | low bug      | Search highlighting uses incompatible text normalization                    | apps/web/src/ui/SessionSearch.tsx                           |
| 01-039 | low issue    | Custom Claude verification overstates help-text evidence                    | apps/server/src/adapters.ts                                 |
| 01-044 | low issue    | Skill inventory reads whole documents for small metadata                    | apps/server/src/skill-inventory.ts                          |
| 01-066 | low issue    | Snapshot cache refs accumulate across process restarts                      | apps/server/src/checkpoint.ts                               |
| 01-068 | low issue    | Thread usage reads repeatedly scan old usage across all chats               | apps/server/src/store.ts                                    |
| 01-069 | low issue    | Deleted Side chat IDs stay in cancellation maps                             | apps/server/src/orchestrator.ts                             |
| 01-079 | low issue    | Architecture promises a non-Git checkpoint fallback that does not run       | docs/ARCHITECTURE.md                                        |
| 01-084 | low issue    | Static preview listener omits the required Origin check                     | apps/server/src/design-static-preview.ts                    |
| 01-086 | low issue    | Shared background selection owns vendor-specific preference rules           | apps/server/src/orchestrator.ts                             |
| 02-019 | low issue    | Keyboard resource selection lacks an accessible active option               | apps/web/src/ui/Composer.tsx                                |
| 02-029 | low issue    | Inactive voice waveforms keep generating SVG frames                         | apps/web/src/ui/VoiceWaveform.tsx                           |
| 02-041 | low issue    | Shared login code contains vendor-specific protocol repair                  | apps/web/src/provider-install.ts                            |
| 02-051 | low issue    | Resource completion consumes modified editing keys                          | apps/web/src/ui/Composer.tsx                                |
| 03-003 | low issue    | Cancelling a limit reset loses keyboard focus                               | apps/web/src/ui/AccountLimits.tsx                           |
| 03-013 | low issue    | The closed model picker omits its current state from its accessible name    | apps/web/src/ui/ModelSelector.tsx                           |
| 03-019 | low issue    | Current key combinations are hidden from screen readers                     | apps/web/src/ui/KeybindSettings.tsx                         |
| 03-022 | low issue    | Automatic color contrast uses the wrong foreground threshold                | apps/web/src/theme-colors.ts                                |
| 03-024 | low issue    | Data and privacy has a broken accessible section name                       | apps/web/src/ui/Settings.tsx                                |
| 03-025 | low issue    | Sidebar mode radios lack radio keyboard behavior                            | apps/web/src/ui/Settings.tsx                                |
| 03-035 | low issue    | Project rename has no accessible field name                                 | apps/web/src/ui/Sidebar.tsx                                 |
| 03-042 | low issue    | Jump to latest ignores reduced motion                                       | apps/web/src/ui/Thread.tsx                                  |
| 03-043 | low issue    | Design progress places its second timer inside an atomic live region        | apps/web/src/ui/Thread.tsx                                  |
| 03-059 | low issue    | PR filter menus do not announce the selected choice                         | apps/web/src/ui/pull-requests/PullRequestsView.tsx          |
| 03-067 | low issue    | Workspace tabs lose focus on close and lack arrow navigation                | apps/web/src/ui/workspace/WorkspaceTabs.tsx                 |
| 03-091 | low issue    | PR reply and edit fields have no accessible names                           | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 03-092 | low issue    | PR tabs omit their keyboard navigation pattern                              | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 03-098 | low issue    | Project options has an invisible icon on keyboard focus                     | apps/web/src/styles/app.css                                 |
| 03-100 | low issue    | Provider setup terminals keep their old theme                               | apps/web/src/ui/InstallTerminal.tsx                         |
| 03-112 | low issue    | Small file trees spread rows across the panel height                        | apps/web/src/ui/workspace-panel.css                         |
| 03-116 | low issue    | Closing Thread Find does not restore focus                                  | apps/web/src/ui/ThreadSearch.tsx                            |
| 03-124 | low issue    | File lists expose current selection only visually                           | apps/web/src/ui/workspace/WorkspaceFiles.tsx                |
| 03-128 | low issue    | An open PR diff can retain the previous System theme                        | apps/web/src/ui/pull-requests/PullRequestDiffRenderer.tsx   |
| 04-024 | low issue    | Hosted checks omit the update-feed tests                                    | .github/workflows/release-artifact-proof.yml                |
| 04-027 | low issue    | Update API request budget is understated                                    | docs/ARCHITECTURE.md                                        |
| 05-038 | low issue    | Malformed MCP fixture requests escape the HTTP handler                      | packages/adapter-claude-code/scripts/verify-mcp-runtime.mjs |
| 05-042 | low issue    | Architecture promises checkpoint coverage the code does not provide         | docs/ARCHITECTURE.md                                        |
| 07-021 | low issue    | The Design guide describes unavailable providers and old flow rules         | docs/DESIGN-AGENT.md                                        |
| 07-065 | low issue    | Live Page approval accepts missing planning decisions                       | packages/design-agent/src/page-phase.ts                     |
| 08-032 | low issue    | Manual CI omits root release safety tests                                   | .github/workflows/ci.yml                                    |
| 08-038 | low issue    | Static preview omits the required HTTP accept gate                          | apps/server/src/design-static-preview.ts                    |
| 08-042 | low issue    | Updater documentation understates its API request bound                     | apps/desktop/src/github-release-provider.ts                 |
| 08-066 | low issue    | Data and privacy settings have a broken accessible region name              | apps/web/src/ui/Settings.tsx                                |
| 09-071 | low issue    | Required workflow rules contradict current AGENTS instructions              | rules/git.md                                                |
| 09-105 | low issue    | Data and privacy has an invalid accessible heading reference                | apps/web/src/ui/Settings.tsx                                |
| 09-134 | low issue    | Zoom HUD hides while a keyboard control has focus                           | apps/web/src/ui/ZoomHud.tsx                                 |
| 09-140 | low issue    | Release-check documentation understates paginated API requests              | docs/ARCHITECTURE.md                                        |
| 09-158 | low issue    | License notices falsely say the release gate never copies license text      | THIRD_PARTY_NOTICES.md                                      |
| 10-043 | low issue    | The Design guide misstates current validation rules                         | docs/DESIGN-AGENT.md                                        |
| 10-044 | low issue    | Required workflow docs conflict with AGENTS                                 | rules/git.md                                                |
| 10-061 | low issue    | Workspace metadata calls tracked-only counts dirty totals                   | apps/server/src/workspace.ts                                |
| 10-073 | low issue    | Updater docs understate the API request bound                               | docs/ARCHITECTURE.md                                        |
| 10-074 | low issue    | Claude compatibility docs promise a handshake the check does not run        | docs/ARCHITECTURE.md                                        |
| 10-082 | low issue    | Settings headings generate invalid ARIA references                          | apps/web/src/ui/Settings.tsx                                |
| 10-091 | low issue    | The provider matrix still calls Claude a CLI adapter                        | docs/PROVIDERS.md                                           |
| 10-113 | low issue    | Architecture promises a missing non-Git checkpoint fallback                 | docs/ARCHITECTURE.md                                        |
| 10-152 | low issue    | Current dashboard headers cite stale dates and commits                      | docs/dashboard.html                                         |
| 10-158 | low issue    | Default dark file references have low text contrast                         | apps/web/src/styles/tokens.css                              |
| 10-168 | low issue    | License metadata validation accepts malformed expressions                   | tools/scripts/release-licenses.js                           |
| 10-171 | low issue    | Full-access copy says Undo is unavailable when it remains present           | apps/web/src/ui/approval-modes.ts                           |
| 01-027 | low qol      | Invalid environment port prevents help and explicit override                | apps/server/src/headless-cli.ts                             |
| 01-028 | low qol      | PR metadata Retry sends the wrong field                                     | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 01-037 | low qol      | Search snippets disagree with indexed word boundaries                       | apps/server/src/store.ts                                    |
| 01-038 | low qol      | Hidden providers can consume entire search pages                            | apps/server/src/store.ts                                    |
| 01-047 | low qol      | YAML description markers appear in skill labels                             | apps/server/src/skill-inventory.ts                          |
| 01-052 | low qol      | Signal shutdown reports success after cleanup fails                         | apps/server/src/main.ts                                     |
| 01-056 | low qol      | PR branch choices merge names that differ only by case                      | apps/server/src/pull-requests.ts                            |
| 02-018 | low qol      | Show the descriptions supplied with question choices                        | apps/web/src/design-agent/UserInput.tsx                     |
| 02-030 | low qol      | Show when a full-size image failed to load                                  | apps/web/src/ui/MediaViewer.tsx                             |
| 02-035 | low qol      | Fast-mode keyboard changes do not persist for the chat                      | apps/web/src/App.tsx                                        |
| 02-037 | low qol      | Keep archive Undo visible for the whole undo period                         | apps/web/src/ui/ArchiveToast.tsx                            |
| 02-047 | low qol      | Retry unavailable context controls after reconnect                          | apps/web/src/ui/ProviderTuning.tsx                          |
| 02-088 | low qol      | Full access description wrongly says Undo is unavailable                    | apps/web/src/ui/approval-modes.ts                           |
| 02-089 | low qol      | Reveal the selected chat beyond the collapsed sidebar cutoff                | apps/web/src/ui/Sidebar.tsx                                 |
| 03-005 | low qol      | Use the correct folder action name on macOS                                 | apps/web/src/ui/StageHeader.tsx                             |
| 03-017 | low qol      | Make context-setting load failures recoverable                              | apps/web/src/ui/ProviderTuning.tsx                          |
| 03-018 | low qol      | Keep model search when changing providers                                   | apps/web/src/ui/ModelSelectorPanel.tsx                      |
| 03-026 | low qol      | Background model load failures have no retry                                | apps/web/src/ui/Settings.tsx                                |
| 03-033 | low qol      | Opening an older chat can leave its sidebar row hidden                      | apps/web/src/ui/Sidebar.tsx                                 |
| 03-036 | low qol      | Undo disappears before the archive deadline                                 | apps/web/src/ui/ArchiveToast.tsx                            |
| 03-040 | low qol      | Inbox copy actions fail silently                                            | apps/web/src/ui/InboxSidebar.tsx                            |
| 03-044 | low qol      | Thread Find does not open from the composer                                 | apps/web/src/ui/Thread.tsx                                  |
| 03-048 | low qol      | Finishing a turn removes work the user is reading                           | apps/web/src/ui/Thread.tsx                                  |
| 03-050 | low qol      | Plain replies leave bare web and email addresses noninteractive             | apps/web/src/ui/Markdown.tsx                                |
| 03-060 | low qol      | Media shortcuts are suppressed at every normal keyboard target              | apps/web/src/ui/MediaViewer.tsx                             |
| 03-062 | low qol      | Side-chat drafts carry into unrelated parent chats                          | apps/web/src/ui/workspace/WorkspaceSideChat.tsx             |
| 03-077 | low qol      | Long choice labels hide the words that distinguish them                     | apps/web/src/design-agent/user-input.css                    |
| 03-078 | low qol      | Effort bars have very narrow pointer targets                                | apps/web/src/styles/provider-tuning.css                     |
| 03-081 | low qol      | Show the explanations supplied with question choices                        | apps/web/src/design-agent/UserInput.tsx                     |
| 03-097 | low qol      | Keep past failure reasons accessible after retry                            | apps/web/src/ui/Thread.tsx                                  |
| 03-107 | low qol      | Full access copy wrongly says Undo is unavailable                           | apps/web/src/ui/approval-modes.ts                           |
| 03-111 | low qol      | Visible error text is difficult to copy                                     | apps/web/src/styles/tokens.css                              |
| 03-114 | low qol      | Check summaries call skipped checks successful                              | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 03-117 | low qol      | Stopping a chat shows false project guidance                                | apps/web/src/ui/Composer.tsx                                |
| 03-130 | low qol      | Empty file results need a clear explanation                                 | apps/web/src/ui/workspace/WorkspaceFiles.tsx                |
| 04-011 | low qol      | Draft uploader accepts a destination unrelated to the app feed              | tools/scripts/upload-draft-release.js                       |
| 04-012 | low qol      | Partial checksum output prevents a clean retry                              | tools/scripts/release-checksums.js                          |
| 04-017 | low qol      | Linked images have no Copy Image action                                     | apps/desktop/src/image-context-menu.ts                      |
| 04-032 | low qol      | GUI launcher requires callers to clear a known Node-mode trap               | apps/desktop/scripts/start.js                               |
| 05-018 | low qol      | Skills never show missing MCP dependency warnings                           | packages/adapter-codex/src/adapter.ts                       |
| 05-039 | low qol      | Claude compatibility warning matches the wrong version range                | packages/adapter-claude-code/src/adapter.ts                 |
| 05-043 | low qol      | Failed queued sends return to the queue without a reason                    | apps/server/src/orchestrator.ts                             |
| 05-051 | low qol      | MCP inventory load failure has no visible retry feedback                    | packages/adapter-codex/src/adapter.ts                       |
| 06-018 | low qol      | Setup failures hide the lost-terminal recovery reason                       | apps/web/src/provider-install.ts                            |
| 06-023 | low qol      | Short-command startup errors lose their error code                          | packages/proc/src/cli.ts                                    |
| 06-034 | low qol      | Grok control-command errors hide their explanation                          | packages/adapter-grok/src/adapter.ts                        |
| 06-035 | low qol      | Background writing hides provider error details                             | apps/server/src/background-model.ts                         |
| 06-046 | low qol      | Full ACP access still stops at Allow-once-only requests                     | packages/adapter-acp/src/adapter.ts                         |
| 06-052 | low qol      | Custom verification errors discard the CLI's useful reason                  | apps/server/src/custom-harness-launch.ts                    |
| 07-027 | low qol      | Label gradient recipes with their supported theme                           | packages/design-agent/src/gradients.ts                      |
| 07-068 | low qol      | Empty repair reviews receive the opposite validation diagnostic             | packages/design-agent/src/review-phase.ts                   |
| 07-070 | low qol      | Snapshot errors omit the file that must be restored                         | packages/design-agent/src/file-snapshot.ts                  |
| 08-028 | low qol      | Successful desktop OAuth handoff reports a blocked popup                    | apps/web/src/ui/McpSettings.tsx                             |
| 08-043 | low qol      | Access-denied socket closes lose their useful reason                        | apps/web/src/transport.ts                                   |
| 08-045 | low qol      | Background approvals wait without an answer path                            | apps/server/src/background-model.ts                         |
| 08-072 | low qol      | Project-add failures have no visible explanation                            | apps/web/src/App.tsx                                        |
| 08-079 | low qol      | Inline image viewers replace Download with a broken folder action           | apps/web/src/ui/Thread.tsx                                  |
| 08-082 | low qol      | PR check summary calls skipped and neutral checks successful                | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 09-023 | low qol      | Linked images have no Copy Image menu action                                | apps/desktop/src/image-context-menu.ts                      |
| 09-029 | low qol      | The documented Codex smoke command is missing                               | packages/adapter-codex/src/smoke.ts                         |
| 09-044 | low qol      | MCP sign-in can report a blocked browser after successful handoff           | apps/web/src/ui/McpSettings.tsx                             |
| 09-047 | low qol      | Mac folder actions are labelled Explorer                                    | apps/web/src/ui/Sidebar.tsx                                 |
| 09-048 | low qol      | Clipboard failures leave no visible feedback                                | apps/web/src/ui/InboxSidebar.tsx                            |
| 09-127 | low qol      | Native browser-open errors give the user no feedback                        | apps/desktop/src/image-context-menu.ts                      |
| 09-128 | low qol      | Diagnostics-folder actions ignore the open failure result                   | apps/desktop/src/main.ts                                    |
| 09-156 | low qol      | Full access falsely tells users that Undo is unavailable                    | apps/web/src/ui/approval-modes.ts                           |
| 10-036 | low qol      | Test fixtures leave resources without explicit cleanup                      | apps/server/src/mcp-config.test.ts                          |
| 10-053 | low qol      | Folder errors disappear when a file is open                                 | apps/web/src/ui/workspace/WorkspaceFiles.tsx                |
| 10-059 | low qol      | An empty repair review gets the opposite error                              | packages/design-agent/src/review-phase.ts                   |
| 10-088 | low qol      | Read-only PR viewers are offered edits that must fail                       | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 10-103 | low qol      | Project-add failures have no visible recovery                               | apps/web/src/App.tsx                                        |
| 01-025 | low slop     | Store tests do not close their per-test SQLite connection                   | apps/server/src/store.test.ts                               |
| 01-026 | low slop     | Provider-removal test fixtures bypass type checking                         | apps/server/src/store.test.ts                               |
| 01-041 | low slop     | File-system tests leave temporary fixtures                                  | apps/server/src/workspace.test.ts                           |
| 01-046 | low slop     | Failed custom-harness saves leave temporary config copies                   | apps/server/src/custom-harnesses.ts                         |
| 01-078 | low slop     | Isolated-checkout test compares the saved path with itself                  | apps/server/src/orchestrator.test.ts                        |
| 01-082 | low slop     | Worktree crash test creates a fresh path instead of reusing the stale one   | apps/server/src/worktree.test.ts                            |
| 02-027 | low slop     | Unused voice button duplicates the active control                           | apps/web/src/ui/ComposerVoiceButton.tsx                     |
| 02-028 | low slop     | Avatar validation and its valid fixture accept a header-only image          | apps/web/src/profile-preferences.ts                         |
| 02-064 | low slop     | The removed-provider late-response test never delivers its response         | apps/web/src/usage-limits-state.test.ts                     |
| 02-065 | low slop     | Highlighting microbenchmarks only exercise plain-text fallback              | apps/web/src/ui/highlighter-runtime.bench.ts                |
| 02-066 | low slop     | The turn-completion benchmark starts from an already-completed turn         | apps/web/src/thread-turn-timing.bench.ts                    |
| 02-067 | low slop     | The shortcut dispatch matrix only proves event cancellation                 | apps/web/src/App.test.tsx                                   |
| 02-077 | low slop     | Saved-branch restart test accepts a call from the earlier mount             | apps/web/src/App.test.tsx                                   |
| 02-085 | low slop     | Automatic-review replay test compares the live reducer with itself          | apps/web/src/thread-store.test.ts                           |
| 03-004 | low slop     | A project-only MCP list retains an unreachable global toggle                | apps/web/src/ui/McpSettings.tsx                             |
| 03-015 | low slop     | Reduced-motion sliders repaint while invisible                              | apps/web/src/ui/dither-kit/DitherSlider.tsx                 |
| 03-016 | low slop     | The old dither waveform has no production user                              | apps/web/src/ui/dither-kit/DitherWaveform.tsx               |
| 03-023 | low slop     | Settings tests assert calls to disconnected mocks                           | apps/web/src/ui/Settings.test.tsx                           |
| 03-037 | low slop     | Sidebar retains unused account and provider-name props                      | apps/web/src/ui/Sidebar.tsx                                 |
| 03-068 | low slop     | The expanded Plan component has no production caller                        | apps/web/src/ui/Plan.tsx                                    |
| 03-071 | low slop     | Obsolete UI style families have no consumers                                | apps/web/src/ui/workspace-panel.css                         |
| 03-080 | low slop     | Motion tests require button transitions the cascade disables                | apps/web/src/styles/fast-mode-motion.test.ts                |
| 03-086 | low slop     | An old voice-button component has no caller                                 | apps/web/src/ui/ComposerVoiceButton.tsx                     |
| 04-013 | low slop     | License expression check accepts invalid grammar                            | tools/scripts/release-licenses.js                           |
| 04-018 | low slop     | Project path test leaks its temporary fixtures                              | apps/desktop/src/project-file-path.test.ts                  |
| 05-009 | low slop     | Codex smoke check masks failure and exits before cleanup                    | packages/adapter-codex/src/smoke.ts                         |
| 05-010 | low slop     | Permission-abort test only checks an object constructor                     | packages/adapter-codex/src/adapter.test.ts                  |
| 05-021 | low slop     | Claude verification cleanup stops at a rejected cleanup promise             | packages/adapter-claude-code/scripts/verify-mcp-runtime.mjs |
| 05-024 | low slop     | Orchestrator tests leave MCP folders and an orphan worktree                 | apps/server/src/orchestrator.test.ts                        |
| 05-034 | low slop     | Long-history regression fixture no longer crosses its frame cap             | packages/adapter-codex/src/adapter.resume.test.ts           |
| 05-036 | low slop     | Worktree persistence assertion compares a field with itself                 | apps/server/src/orchestrator.test.ts                        |
| 05-050 | low slop     | Checkpoint regression tests do not isolate their claimed safeguards         | apps/server/src/orchestrator.test.ts                        |
| 05-063 | low slop     | Design queue-recovery test passes before provider acceptance                | apps/server/src/orchestrator.test.ts                        |
| 06-011 | low slop     | Removed ACP roster leaves unreachable model and version code                | packages/adapter-acp/src/adapter.ts                         |
| 06-022 | low slop     | A process test uses an undefined type name                                  | packages/proc/src/index.test.ts                             |
| 06-040 | low slop     | Tests leave config roots and Grok prompt folders behind                     | apps/server/src/mcp-config.test.ts                          |
| 06-042 | low slop     | Grok's exported support version is stale and unused                         | packages/adapter-grok/src/adapter.ts                        |
| 06-048 | low slop     | Failed custom-harness saves leave temporary files                           | apps/server/src/custom-harnesses.ts                         |
| 06-049 | low slop     | Provider removal leaves unreachable probe placeholders                      | apps/server/src/providers.ts                                |
| 07-005 | low slop     | An unused workflow model has misleading recovery tests                      | packages/design-agent/src/run.ts                            |
| 07-007 | low slop     | Artifact tests leave temporary workspaces behind                            | packages/design-agent/src/assets.test.ts                    |
| 07-015 | low slop     | The preview readiness marker is unused                                      | packages/design-agent/src/preview.ts                        |
| 08-016 | low slop     | Removed ACP launch options leave unreachable branches                       | packages/adapter-acp/src/adapter.ts                         |
| 08-035 | low slop     | Side-chat activity text uses an undeclared field                            | apps/server/src/side-chat.ts                                |
| 08-036 | low slop     | Preview readiness markers are accepted but ignored                          | packages/design-agent/src/preview.ts                        |
| 08-041 | low slop     | Symlink security test leaks fixtures and silently passes setup failures     | apps/desktop/src/project-file-path.test.ts                  |
| 08-050 | low slop     | Replay tests never exercise valid plan and diff turn identities             | apps/server/src/history-replay.test.ts                      |
| 08-065 | low slop     | Metadata Retry sends an unused field instead of refresh                     | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 09-018 | low slop     | Test fixtures leave temporary folders and repositories behind               | apps/server/src/mcp-config.test.ts                          |
| 09-027 | low slop     | ACP retains unreachable model and version paths after provider removal      | packages/adapter-acp/src/adapter.ts                         |
| 09-045 | low slop     | The inherited MCP server toggle has no reachable caller                     | apps/web/src/ui/McpSettings.tsx                             |
| 09-060 | low slop     | Old Review line styles no longer have a renderer                            | apps/web/src/ui/workspace-panel.css                         |
| 09-065 | low slop     | Highlight benchmarks measure fallback dispatch instead of tokenization      | apps/web/src/ui/highlighter-runtime.bench.ts                |
| 09-085 | low slop     | The old Composer voice button has no callers                                | apps/web/src/ui/ComposerVoiceButton.tsx                     |
| 09-103 | low slop     | The branch-restart test reuses pre-restart calls as evidence                | apps/web/src/App.test.tsx                                   |
| 09-107 | low slop     | PR metadata Retry sends a field the contract ignores                        | apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx     |
| 09-112 | low slop     | The automatic-review replay test calls the live reducer twice               | apps/web/src/thread-store.test.ts                           |
| 09-116 | low slop     | The crash-prune test never checks its stale worktree registration           | apps/server/src/worktree.test.ts                            |
| 09-117 | low slop     | Provider removal leaves a parameterized test with no cases                  | apps/server/src/orchestrator-limits.test.ts                 |
| 09-136 | low slop     | Removed-source usage test never sends its claimed late response             | apps/web/src/usage-limits-state.test.ts                     |
| 09-137 | low slop     | Short-window settings test only checks DOM presence                         | apps/web/src/ui/Settings.test.tsx                           |
| 09-153 | low slop     | Side chat activity snapshots emit a field absent from their declared type   | apps/server/src/side-chat.ts                                |
| 09-157 | low slop     | Removed custom-model tests still assert on disconnected spies               | apps/web/src/ui/Settings.test.tsx                           |
| 09-159 | low slop     | Duplicate Composer selectors overwrite their own surface declarations       | apps/web/src/styles/app.css                                 |
| 09-160 | low slop     | The platform shortcut dispatch matrix only checks event cancellation        | apps/web/src/App.test.tsx                                   |
| 10-003 | low slop     | The late usage response test never delivers its response                    | apps/web/src/usage-limits-state.test.ts                     |
| 10-024 | low slop     | Removed provider forms leave unused CSS                                     | apps/web/src/styles/settings.css                            |
| 10-025 | low slop     | A motion test ignores the cascade that disables its motion                  | apps/web/src/styles/model-selector-theme.test.ts            |
| 10-039 | low slop     | Custom-model removal test asks for an obsolete label                        | apps/web/src/ui/Settings.test.tsx                           |
| 10-041 | low slop     | Provider removal leaves a zero-case test matrix                             | apps/server/src/orchestrator-limits.test.ts                 |
| 10-049 | low slop     | The highlighting benchmark measures only plain fallback                     | apps/web/src/ui/highlighter-runtime.bench.ts                |
| 10-056 | low slop     | ACP removal leaves unreachable model and version hooks                      | packages/adapter-acp/src/adapter.ts                         |
| 10-080 | low slop     | Queue drag test expects the wrong pointer half                              | apps/web/src/ui/Composer.test.tsx                           |
| 10-083 | low slop     | The stream performance test accepts no-op deltas                            | apps/web/src/ui/Thread.perf.test.tsx                        |
| 10-093 | low slop     | The shortcut matrix checks cancellation without dispatch                    | apps/web/src/App.test.tsx                                   |
| 10-097 | low slop     | The panic race test has no proof its second send started                    | apps/server/src/orchestrator.test.ts                        |
| 10-106 | low slop     | The branch restoration test never checks the restored base                  | apps/web/src/App.test.tsx                                   |
| 10-119 | low slop     | The thread-isolation test checks counts without ownership                   | apps/server/src/store.test.ts                               |
| 10-121 | low slop     | The startup Stop test accepts a missing first send                          | apps/web/src/App.test.tsx                                   |
| 10-122 | low slop     | The listing profile samples memory at unequal stages                        | apps/server/src/workspace-listing.profile.ts                |
| 10-124 | low slop     | Hover-gating tests can match across closed media blocks                     | apps/web/src/styles/hover-gating.test.ts                    |
| 10-125 | low slop     | Motion tests treat a missing CSS rule as passing                            | apps/web/src/styles/keyboard-search-motion.test.ts          |
| 10-129 | low slop     | Frame benchmarks stop checking notifications after their first success      | apps/web/src/thread-frame-store.bench.ts                    |
| 10-130 | low slop     | The live-versus-replay test compares the same reducer twice                 | apps/web/src/thread-store.test.ts                           |
| 10-131 | low slop     | An obsolete voice button has no consumer                                    | apps/web/src/ui/ComposerVoiceButton.tsx                     |
| 10-137 | low slop     | A sidebar viewport spy leaks into later test cases                          | apps/web/src/ui/Sidebar.test.tsx                            |
| 10-138 | low slop     | The short-window Settings test never checks scrolling                       | apps/web/src/ui/Settings.test.tsx                           |
| 10-151 | low slop     | Preview plans accept a readiness field that the runner ignores              | packages/design-agent/src/preview.ts                        |
| 10-156 | low slop     | Checkout persistence is tested against the same field                       | apps/server/src/orchestrator.test.ts                        |
| 10-127 | nit bug      | File links use an invalid underline-offset property                         | apps/web/src/styles/markdown.css                            |
| 02-068 | nit slop     | File-link buttons use an invalid underline-offset property                  | apps/web/src/styles/markdown.css                            |
| 03-029 | nit slop     | A removed-provider comment documents an email helper                        | apps/web/src/ui/Settings.tsx                                |
| 03-119 | nit slop     | A misspelled underline property has no effect                               | apps/web/src/styles/markdown.css                            |
| 05-016 | nit slop     | Removed providers leave an empty parameterized test                         | apps/server/src/orchestrator-limits.test.ts                 |
| 05-049 | nit slop     | Model provenance comments deny the implemented fallback catalogs            | packages/contracts/src/domain.ts                            |
| 09-019 | nit slop     | Provider comments misdescribe discovery behavior                            | apps/server/src/providers.ts                                |
