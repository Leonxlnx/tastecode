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
claims verified and fixed · about 880 astra medium/low claims not yet verified. Nothing is
committed.

> Every fix exists only as uncommitted changes in a working tree of about 360 paths (61 of them
> untracked), mixed with the provider removal. Commit them in reviewable PRs, contracts first,
> before anything resets the tree.

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

The remaining ~880 astra medium/low findings are unverified. In every astra claim checked so
far, the code observation was accurate; its severity labels were inflated for edge cases.

## Suggested order

Everything except the commits in step 1 is done in the working tree.

1. Fix the license gate, then commit the uncommitted fixes in reviewable PRs.
2. Critical: #1, the transcript crash, #8.
3. High: Archive cluster, temp-folder storage, loopback trust, PR replies, Windows PR files,
   onboarding, "New session" deletion, #11, #39, E22.
4. Medium, most common first: #3, #35, #5 and 02-004, #20, #14, #17, #37, #28, #42, then the
   race-dependent rest.
