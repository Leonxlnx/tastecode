# App and Design Agent Audit

Date: 2026-10-03

Review snapshot: local `main` at `430d149440`, including local changes present during the review. File references use the line numbers checked during that review.

The audit found **53 issues**. Three subagents reviewed separate areas, followed by source checks and safe reproductions. The audit made no source changes.

Concurrent work fixed one queue bug and deleted code tied to 11 earlier findings. Those findings are excluded below.

## Fix these eight first

| #   | Issue                                                                                                                                           | Source                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Grok can keep Full access after selecting Ask.** The saved setting changes, but command permissions do not.                                   | [orchestrator.ts:2572](../apps/server/src/orchestrator.ts#L2572)                                                                         |
| 2   | **“Allow once” can grant “Always.”** This occurs when an ACP permission request offers only lasting approval. It also affects Grok’s MCP path.  | [approvals.ts:32](../packages/adapter-acp/src/approvals.ts#L32)                                                                          |
| 3   | **Closed temporary chats can return as saved chats.** Providers retain them, then history import adds them back.                                | [orchestrator.ts:1313](../apps/server/src/orchestrator.ts#L1313), [provider-history.ts:143](../apps/server/src/provider-history.ts#L143) |
| 4   | **Side chat protects the wrong folder for isolated chats.** Restore can change its working files while the agent still writes there.            | [orchestrator.ts:1329](../apps/server/src/orchestrator.ts#L1329)                                                                         |
| 5   | **A failed new chat can overwrite another chat’s draft.** Switch chats while startup waits; failure restores text into the newly selected chat. | [App.tsx:2933](../apps/web/src/App.tsx#L2933)                                                                                            |
| 6   | **A Codex process crash can leave the chat “working” forever.** Stop fails, queued work waits, and the folder stays busy.                       | [jsonrpc.ts:126](../packages/proc/src/jsonrpc.ts#L126)                                                                                   |
| 7   | **Claude’s permission-card Stop can crash the server.** A failed interrupt creates an unhandled promise rejection.                              | [Claude adapter:497](../packages/adapter-claude-code/src/adapter.ts#L497)                                                                |
| 8   | **Merge can include unseen commits.** A push after opening the dialog is not checked against the commit the user reviewed.                      | [pull-requests.ts:651](../apps/server/src/pull-requests.ts#L651)                                                                         |

## Design agent

| #   | Issue                                                                                                                                          | Source                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 9   | Stop during screenshot capture can still start the next Design phase.                                                                          | [orchestrator.ts:4039](../apps/server/src/orchestrator.ts#L4039)               |
| 10  | Two Design chats in one folder overwrite each other’s `.taste` files, then fail validation.                                                    | [artifact-store.ts:9](../packages/design-agent/src/artifact-store.ts#L9)       |
| 11  | A valid uploaded SVG logo can pass Assets, then fail Build.                                                                                    | [source-quality.ts:67](../packages/design-agent/src/source-quality.ts#L67)     |
| 12  | Exact-file parsing reads later prose as filenames. `Create exactly index.html. Use photos from unsplash.com.` wrongly requires `unsplash.com`. | [build-phase.ts:211](../packages/design-agent/src/build-phase.ts#L211)         |
| 13  | Visual review can pass with only a desktop screenshot and no mobile check.                                                                     | [preview.ts:55](../packages/design-agent/src/preview.ts#L55)                   |
| 14  | An HTML error page can pass validation as a downloaded font.                                                                                   | [assets.ts:302](../packages/design-agent/src/assets.ts#L302)                   |
| 15  | An external video can count as resolved without a checked file or license.                                                                     | [assets.ts:289](../packages/design-agent/src/assets.ts#L289)                   |
| 16  | The supplied reveal helper loses scroll animations under React Strict Mode. Cleanup marks unplayed effects as played.                          | [reveal.js:32](../packages/design-agent/references/motion/reveal.js#L32)       |
| 17  | Valid interface text such as “Not connected” is rejected as unfinished copy.                                                                   | [copywriting.ts:88](../packages/design-agent/src/copywriting.ts#L88)           |
| 18  | JPEG size checks ignore rotation metadata. Correct portrait photos can fail their shape check.                                                 | [raster-metadata.ts:42](../packages/design-agent/src/raster-metadata.ts#L42)   |
| 19  | “Build an interface” wrongly counts as an explicit request for the Inter font.                                                                 | [typography.ts:85](../packages/design-agent/src/typography.ts#L85)             |
| 20  | Static previews reject local video files. Common downloads such as PDFs also return 404.                                                       | [design-static-preview.ts:14](../apps/server/src/design-static-preview.ts#L14) |

## Chat and file UI

| #   | Issue                                                                                            | Source                                                                               |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 21  | A failed Side chat answer stays on “Submitting answers…” with no retry.                          | [WorkspaceSideChat.tsx:353](../apps/web/src/ui/workspace/WorkspaceSideChat.tsx#L353) |
| 22  | Side chat questions appear inside the main chat’s composer.                                      | [UserInput.tsx:21](../apps/web/src/design-agent/UserInput.tsx#L21)                   |
| 23  | A late Side chat error can clear another chat’s running state and insert the wrong draft.        | [WorkspaceSideChat.tsx:280](../apps/web/src/ui/workspace/WorkspaceSideChat.tsx#L280) |
| 24  | A lost Side chat send reply can cause duplicate work when the user retries.                      | [WorkspaceSideChat.tsx:291](../apps/web/src/ui/workspace/WorkspaceSideChat.tsx#L291) |
| 25  | Side chat restores failed or blocked message text but loses its attachments.                     | [WorkspaceSideChat.tsx:267](../apps/web/src/ui/workspace/WorkspaceSideChat.tsx#L267) |
| 26  | Failed Side chat recovery discards live events received while history was loading.               | [WorkspaceSideChat.tsx:162](../apps/web/src/ui/workspace/WorkspaceSideChat.tsx#L162) |
| 27  | Switching projects during a file read can leave “Opening file…” stuck.                           | [WorkspaceFiles.tsx:136](../apps/web/src/ui/workspace/WorkspaceFiles.tsx#L136)       |
| 28  | “Refresh files” does not refresh the open file’s contents. Deleted files can remain displayed.   | [WorkspaceFiles.tsx:169](../apps/web/src/ui/workspace/WorkspaceFiles.tsx#L169)       |
| 29  | Editing a queued prompt starts before its removal succeeds. Both old and edited prompts can run. | [Composer.tsx:1230](../apps/web/src/ui/Composer.tsx#L1230)                           |
| 30  | File filtering cannot find files inside folders that have not been opened.                       | [WorkspaceFiles.tsx:666](../apps/web/src/ui/workspace/WorkspaceFiles.tsx#L666)       |
| 31  | Failed searches leave old results under the new query or project filter.                         | [SessionSearch.tsx:174](../apps/web/src/ui/SessionSearch.tsx#L174)                   |
| 32  | Thread search can show impossible counts such as “5/2” after results shrink.                     | [ThreadSearch.tsx:48](../apps/web/src/ui/ThreadSearch.tsx#L48)                       |

## Session state and provider handling

| #   | Issue                                                                                                         | Source                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 33  | Checkpoint restore rewinds files and visible history, but the agent still remembers the removed turns.        | [orchestrator.ts:2460](../apps/server/src/orchestrator.ts#L2460)            |
| 34  | Stop all misses Side chat while its provider is still starting. It can attach after Stop finishes.            | [orchestrator.ts:1321](../apps/server/src/orchestrator.ts#L1321)            |
| 35  | Waiting questions show as Working. Approval badges can also revert to Working after a list refresh.           | [orchestrator.ts:2018](../apps/server/src/orchestrator.ts#L2018)            |
| 36  | Undoing a restore can bring back discarded branches of imported chat history.                                 | [store.ts:3376](../apps/server/src/store.ts#L3376)                          |
| 37  | Deleting earlier search results can make pagination stop before later matches.                                | [store.ts:2852](../apps/server/src/store.ts#L2852)                          |
| 38  | An MCP setup failure during isolated startup can leave a worktree with no chat entry.                         | [orchestrator.ts:1202](../apps/server/src/orchestrator.ts#L1202)            |
| 39  | After a Claude process ends, Retry can keep failing instead of restoring the session.                         | [Claude adapter:751](../packages/adapter-claude-code/src/adapter.ts#L751)   |
| 40  | A failed first Grok attachment can silently remove project instructions from the retry.                       | [Grok adapter:381](../packages/adapter-grok/src/adapter.ts#L381)            |
| 41  | A failed first Grok launch makes later attempts resume a session that never existed.                          | [Grok adapter:419](../packages/adapter-grok/src/adapter.ts#L419)            |
| 42  | Some Claude MCP approval cards omit the tool name, target, and arguments. Users cannot see what they approve. | [Claude adapter:1194](../packages/adapter-claude-code/src/adapter.ts#L1194) |
| 43  | Claude questions that allow several choices become single-choice questions.                                   | [Claude adapter:1227](../packages/adapter-claude-code/src/adapter.ts#L1227) |
| 44  | Already-cancelled Claude requests can still create approval or question cards that wait forever.              | [Claude adapter:1054](../packages/adapter-claude-code/src/adapter.ts#L1054) |
| 45  | ACP request failures leave approval cards and streamed items open. This affects Grok with MCP.                | [ACP adapter:355](../packages/adapter-acp/src/adapter.ts#L355)              |

## PR review, terminal, and Inbox

| #   | Issue                                                                                             | Source                                                                                             |
| --- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 46  | Switching PR files can submit an unsent inline comment to the wrong file.                         | [PullRequestFiles.tsx:248](../apps/web/src/ui/pull-requests/PullRequestFiles.tsx#L248)             |
| 47  | A successful PR comment send erases the next draft typed while that send was pending.             | [PullRequestDetailPane.tsx:1955](../apps/web/src/ui/pull-requests/PullRequestDetailPane.tsx#L1955) |
| 48  | Terminal reconnect or reopen misses retained output and can show a blank shell.                   | [TerminalPane.tsx:203](../apps/web/src/ui/TerminalPane.tsx#L203)                                   |
| 49  | Workspace terminal failures hide the error and provide no visible Retry button.                   | [TerminalPane.tsx:379](../apps/web/src/ui/TerminalPane.tsx#L379)                                   |
| 50  | Inbox Shift-selection includes chats in collapsed sections. Bulk actions can change hidden chats. | [InboxSidebar.tsx:294](../apps/web/src/ui/InboxSidebar.tsx#L294)                                   |

## Desktop

| #   | Issue                                                                                                           | Source                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 51  | Failed update preparation deletes the verified download, forcing another full download.                         | [release-updater.ts:95](../apps/desktop/src/release-updater.ts#L95)                   |
| 52  | Later low-version tags can push a newer release outside the feed window, causing a false “up to date” result.   | [github-release-provider.ts:178](../apps/desktop/src/github-release-provider.ts#L178) |
| 53  | Pasted attachments live only in the OS temp folder. Temp cleanup breaks old images and saved Design references. | [main.ts:874](../apps/desktop/src/main.ts#L874)                                       |

## Validation and limits

Validation used source traces, six browser reproductions, and tests held in memory. No paid provider calls or Windows tests were run. This was not a full live-app test. All temporary test pages and servers were closed after the audit.
