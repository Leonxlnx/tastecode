# Connection edge-case audit — 3 October 2026

Twenty agents reviewed separate app paths. Four more agents checked the fixes. The audit found **49 confirmed bugs: 31 fixed during the audit and 18 left as research findings**. There is also one limited handshake-recovery gap and one unproved event-order case. A follow-up the same day fixed the 18 research findings, the handshake gap and the event-order case locally. All 49 are now fixed in the working tree; see the [3 October triage](./audit-triage-2026-10-03.md#resolution-status).

This is a local audit of `main` at `430d14944` plus working changes. No branch, commit, pull request, push, or release was made. Other sessions changed providers and context settings during this audit. Those edits were preserved. Counts exclude duplicate reports and four findings in code removed by another session.

## Fixed locally

The regressions use fake providers, local sockets, temporary repositories, or isolated stores. New failure tests were checked against the broken path before the relevant fix where recorded in the detailed notes.

| ID  | Priority | Broken edge case now covered                                          | Code                                                      |
| --- | -------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| E01 | P1       | Malformed WebSocket target crashes token-protected server.            | [Source](../apps/server/src/server.ts)                    |
| E02 | P1       | Rejected WebSocket emits an unhandled protocol error.                 | [Source](../apps/server/src/server.ts)                    |
| E03 | P2       | Broken child stdin leaves RPC calls pending.                          | [Source](../packages/proc/src/jsonrpc.ts)                 |
| E04 | P2       | Invalid success reply treats a sent mutation as safe to retry.        | [Source](../apps/web/src/transport.ts)                    |
| E06 | P2       | Early queued completion leaves the next prompt stuck.                 | [Source](../apps/server/src/orchestrator.ts)              |
| E07 | P2       | Stop during cold resume still sends the prompt.                       | [Source](../apps/server/src/orchestrator.ts)              |
| E08 | P1       | Accepted turn stays running after app-server crash.                   | [Source](../packages/adapter-codex/src/adapter.ts)        |
| E09 | P2       | Provider-resolved approval and question cards remain pending.         | [Source](../packages/adapter-codex/src/adapter.ts)        |
| E10 | P1       | Approval Abort rejection can crash the server.                        | [Source](../packages/adapter-claude-code/src/adapter.ts)  |
| E12 | P2       | Reconnect drops output printed while offline.                         | [Source](../apps/web/src/ui/TerminalPane.tsx)             |
| E13 | P2       | Closing a terminal offline leaves its shell running.                  | [Source](../apps/web/src/ui/terminal-ownership.ts)        |
| E14 | P2       | Changing chat with one terminal tab leaks the old shell.              | [Source](../apps/web/src/ui/terminal-ownership.ts)        |
| E18 | P1       | Project MCP reload updates only one live session.                     | [Source](../apps/server/src/orchestrator.ts)              |
| E19 | P2       | Live session MCP discovery event never reaches UI.                    | [Source](../apps/server/src/orchestrator.ts)              |
| E20 | P2       | Old MCP list reply overwrites cache after reload.                     | [Source](../packages/adapter-codex/src/adapter.ts)        |
| E24 | P2       | Overlapping recovery advances cursor past a missing event.            | [Source](../apps/web/src/thread-controller.ts)            |
| E25 | P2       | Cached background chat skips events after a connection gap.           | [Source](../apps/web/src/thread-controller.ts)            |
| E26 | P2       | Partial background cache bypasses transcript memory limits.           | [Source](../apps/web/src/thread-state-cache.ts)           |
| E27 | P2       | Second Quit bypasses pending update cleanup.                          | [Source](../apps/desktop/src/main.ts)                     |
| E28 | P2       | Transient native-copy failure deletes verified installer bytes.       | [Source](../apps/desktop/src/release-updater.ts)          |
| E31 | P1       | Missing isolated checkout falls back to the main project folder.      | [Source](../apps/server/src/orchestrator.ts)              |
| E32 | P2       | Checkpoint restore leaves renamed file behind.                        | [Source](../apps/server/src/checkpoint.ts)                |
| E34 | P2       | Changing project during file read leaves Opening file stuck.          | [Source](../apps/web/src/ui/workspace/WorkspaceFiles.tsx) |
| E37 | P2       | Uncertain input reply stays locked after successful suffix recovery.  | [Source](../apps/web/src/thread-controller.ts)            |
| E38 | P2       | Failed approval reply has no visible error.                           | [Source](../apps/web/src/App.tsx)                         |
| E39 | P2       | Custom text equal to an option removes its input field.               | [Source](../apps/web/src/design-agent/UserInput.tsx)      |
| E40 | P2       | Late steer result restores work cleared by Stop all.                  | [Source](../apps/server/src/orchestrator.ts)              |
| E41 | P2       | Queue-cache eviction loses newer prompts on failed dispatch or steer. | [Source](../apps/server/src/orchestrator.ts)              |
| E42 | P2       | Scheduled database exception escapes timer and crashes server.        | [Source](../apps/server/src/lifecycle-scheduler.ts)       |
| E43 | P2       | Account check is never retried after reconnect.                       | [Source](../apps/web/src/App.tsx)                         |
| E50 | P2       | Late old dispatch clears a new runtime's queue lock.                  | [Source](../apps/server/src/orchestrator.ts)              |

The terminal close owner now survives pane removal and waits for a real connection. It handles outages longer than the request timeout, lease reacquisition, and bounded retries. Queue recovery handles cache eviction, late dispatch acknowledgements, provider replacement, and Stop all. A provider crash releases the dead runtime, preserves queued work, and lets the next send resume the saved chat.

## Research findings fixed after the audit

These cases were reproduced with local fakes or isolated data during the audit. The follow-up fixed each one in the working tree and added a regression test. Nothing is committed.

| ID  | Priority | Trigger and fix                                                                                                                                                       | Code                                                     |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| E11 | P2       | A Claude stream ends, then the user sends again. The session now emits `disconnected`; the server drops the dead runtime and the next send resumes the saved session. | [Source](../packages/adapter-claude-code/src/adapter.ts) |
| E15 | P2       | A login expires and `cancelLogin` rejects. A failure event now ends Signing in.                                                                                       | [Source](../apps/server/src/provider-controls.ts)        |
| E16 | P2       | An account read started during sign-out returns late. Reads are invalidated at sign-out start and completion.                                                         | [Source](../apps/web/src/ui/Settings.tsx)                |
| E17 | P2       | Providers is reopened while sign-out is pending. The new row follows the signed-out account and ignores the stale read.                                               | [Source](../apps/web/src/ui/Settings.tsx)                |
| E21 | P2       | A pasted file finishes saving after a chat switch. The path is added to its original draft and appears when that chat is shown again.                                 | [Source](../apps/web/src/App.tsx)                        |
| E22 | P2       | A native file over 25 MiB is dropped. Drops resolve the native path through `webUtils.getPathForFile` in the preload.                                                 | [Source](../apps/desktop/src/preload.ts)                 |
| E23 | P2       | A picked external image is reloaded or evicted from cache. The desktop keeps a picker-owned grant until the app quits.                                                | [Source](../apps/desktop/src/viewed-image-path.ts)       |
| E29 | P2       | A renderer crashes. It reloads once, then offers Reload while the server keeps running. Not run on Windows.                                                           | [Source](../apps/desktop/src/main.ts)                    |
| E30 | P2       | The packaged app starts with `HARNESS_PORT` set. The override is ignored with a warning, so server and renderer share one endpoint.                                   | [Source](../apps/desktop/src/main.ts)                    |
| E33 | P2       | A project is removed while a provider start is pending. A project generation fences the late start.                                                                   | [Source](../apps/server/src/orchestrator.ts)             |
| E35 | P2       | An ACP prompt fails while an approval is pending. Failure clears the responder and the approval badge.                                                                | [Source](../packages/adapter-acp/src/adapter.ts)         |
| E36 | P2       | The first Grok spawn fails. The native session is marked only after startup evidence, so retry creates it.                                                            | [Source](../packages/adapter-grok/src/adapter.ts)        |
| E44 | P2       | One model list stalls. Each provider's models are published as they arrive.                                                                                           | [Source](../apps/web/src/App.tsx)                        |
| E45 | P2       | Restore undo after a history import. The undo record keeps `provider_history_events` links.                                                                           | [Source](../apps/server/src/store.ts)                    |
| E46 | P2       | Old turns are imported after a newer local turn. Replay orders events first, and a migration rebuilds old snapshots once.                                             | [Source](../apps/server/src/history-replay.ts)           |
| E47 | P2       | The renderer reloads during a slow capture. Its captures are cancelled on reload or destruction.                                                                      | [Source](../apps/desktop/src/renderer-lifecycle.ts)      |
| E48 | P2       | A review page has a redirecting iframe. The origin gate applies only to main-frame redirects.                                                                         | [Source](../apps/desktop/src/preview-navigation.ts)      |
| E49 | P2       | A `target=_blank` POST form is submitted. The guest load keeps `postBody` and its content type.                                                                       | [Source](../apps/desktop/src/embedded-browser.ts)        |

E22 follows Electron's documented removal of `File.path` in version 32; the supported replacement is `webUtils.getPathForFile`. [Electron breaking changes](https://www.electronjs.org/docs/latest/breaking-changes#removed-filepath). E49 is supported by Electron's documented new-window `postBody` field. [Electron webContents](https://www.electronjs.org/docs/latest/api/web-contents#contentssetwindowopenhandlerhandler).

## Limited and excluded cases

- **E05, P3:** An accepted TCP connection that never completed its WebSocket handshake stayed in CONNECTING until the native browser timeout. The follow-up added a 10-second handshake deadline that retries cold connects and reconnects.
- **Candidate:** A late Codex completion could clear approvals for a newer turn in a fake event sequence. The live ordering is still unproved, but completion now clears only approvals for its own thread and turn.
- **Removed code, not counted:** Direct API cancellation between tools, direct API terminal-marker/EOF handling, Antigravity interrupt completion, and Cursor synchronous Design handoff. Another session removed these packages during the review.
- A crashed Codex control helper and the repeated-Quit issue were independently found by two reviewers. Each is counted once.

## Evidence and validation

[Full reviewer notes](./verification/edge-case-audit-2026-10-03.json) contain triggers, expected and actual results, guards checked, and reproduction details. Notes retain the state seen by each reviewer; the status table above is the final audit status. [Machine-readable findings](./verification/edge-case-findings-2026-10-03.json) use the same IDs.

Final package runs passed **3,151 tests; 4 were skipped**:

| Command                                           | Passed | Skipped |
| ------------------------------------------------- | -----: | ------: |
| `pnpm --filter @harness/server test`              |    802 |       1 |
| `pnpm --filter @harness/web test`                 |  1,708 |       0 |
| `pnpm --filter @harness/desktop test`             |    317 |       0 |
| `pnpm --filter @harness/adapter-codex test`       |    151 |       1 |
| `pnpm --filter @harness/adapter-claude-code test` |    105 |       0 |
| `pnpm --filter @harness/proc test`                |     68 |       2 |

`tsc --noEmit` passed for all six packages. Scoped Oxlint, Prettier, and `git diff --check` passed. A production Vite bundle passed with its output redirected to `/private/tmp/harness-edge-web-build-20261003`. The recursive build was not run while the shared dev stack was active.

Final QA also aligned the startup validator with the newly added context capability, updated an existing Grok test mock, and kept the context-helper return types precise. The eight validator-parity tests and 15 adapter-routing tests passed after those small integration corrections. These corrections are not counted as separate audit findings.

The earlier two server mock failures, web type error, and context-helper lint errors were corrected. Older failures caused by concurrent provider removal are superseded by the final results above. No hosted CI was started.

After the follow-up fixes, the root `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` all passed on the working tree, with only the existing Vite chunk-size warning. That run covered server 925 (1 skipped), web 1,891, desktop 359, Codex 156 (1 skipped), Claude Code 112, proc 95 (3 skipped), Grok 63, ACP 45, design agent 203, contracts 54 and tooling 64 tests.

Browser checks used real `TerminalPane` and `UserInput` components with a fake transport. The terminal displayed BEFORE, OFFLINE_RESULT, AFTER exactly once. Closing it offline sent one close after reconnect. Custom text remained editable when it matched an option and submitted “Yes, but later”. The [browser evidence](./verification/edge-case-browser-2026-10-03.png) is a test fixture, not a claim of full-app visual verification.

No real provider account, paid inference, actual update, signed installer, or Windows runtime was exercised. All audit-owned browser and dev-server processes were closed. A separately started shared dev stack was left running.

---

# Audit fixes delivered on 9 September 2026

All 19 findings and 9 prevention items from the codebase audit are implemented and merged. The existing provider-update UI and saved per-project branch choice are preserved. This record covers the listed findings; it does not claim that all future faults are known.

## Fixes

| Item | Result and source                                                                                                                                                                      | Behavior test                                                | Merged PR                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| F01  | Claude commits model and access settings after SDK success and serializes changes. [Code](../packages/adapter-claude-code/src/adapter.ts)                                              | [Test](../packages/adapter-claude-code/src/adapter.test.ts)  | [#1061](https://github.com/Leonxlnx/tastecode/pull/1061)                                                           |
| F02  | Stop all fences pending start, resume and design work. Late results are stopped before they can attach or send. [Code](../apps/server/src/orchestrator.ts)                             | [Test](../apps/server/src/audit-regressions.test.ts)         | [#1065](https://github.com/Leonxlnx/tastecode/pull/1065)                                                           |
| F03  | Owned process groups stop descendants and confirm exit. Failed cleanup keeps ownership for retry. [Code](../packages/proc/src/kill.ts)                                                 | [Test](../packages/proc/src/kill.test.ts)                    | [#1061](https://github.com/Leonxlnx/tastecode/pull/1061)                                                           |
| F04  | Restore, undo and branch changes share a guard at the real checkout root. Other worktrees remain independent. [Code](../apps/server/src/checkout-access.ts)                            | [Test](../apps/server/src/audit-regressions.test.ts)         | [#1065](https://github.com/Leonxlnx/tastecode/pull/1065)                                                           |
| F05  | Checkpoint and undo commits have durable Git refs. Old records migrate in batches; cached SHAs are checked. [Code](../apps/server/src/checkpoint.ts)                                   | [Test](../apps/server/src/checkpoint.test.ts)                | [#1065](https://github.com/Leonxlnx/tastecode/pull/1065)                                                           |
| F06  | API errors remove known credentials before logs, events and truncation. Error-body reads have size and time limits. [Code](../packages/adapter-api/src/sse.ts)                         | [Test](../packages/adapter-api/src/sse.test.ts)              | [#1062](https://github.com/Leonxlnx/tastecode/pull/1062)                                                           |
| F07  | Workspace read, list and write policy checks real targets and parent paths, including credential aliases. [Code](../apps/server/src/api-workspace-paths.ts)                            | [Test](../apps/server/src/api-workspace-paths.test.ts)       | [#1062](https://github.com/Leonxlnx/tastecode/pull/1062)                                                           |
| F08  | Session approval covers the complete reviewed input and real working folder. [Code](../packages/adapter-api/src/runtime.ts)                                                            | [Test](../packages/adapter-api/src/runtime.test.ts)          | [#1062](https://github.com/Leonxlnx/tastecode/pull/1062)                                                           |
| F09  | Nested-project snapshots, restore and diff use one repository root and explicit project scope. [Code](../apps/server/src/diff-review.ts)                                               | [Test](../apps/server/src/diff-review.test.ts)               | [#1065](https://github.com/Leonxlnx/tastecode/pull/1065)                                                           |
| F10  | Deleted, closed and replaced sessions reject late resumes and callbacks. Failed stops retain their checkout guard. [Code](../apps/server/src/orchestrator.ts)                          | [Test](../apps/server/src/audit-regressions.test.ts)         | [#1065](https://github.com/Leonxlnx/tastecode/pull/1065)                                                           |
| F11  | Claude, Cursor and OpenCode use unique turn IDs across adapter restart and resume. [Code](../packages/adapter-claude-code/src/adapter.ts)                                              | [Test](../packages/adapter-claude-code/src/adapter.test.ts)  | [#1061](https://github.com/Leonxlnx/tastecode/pull/1061)                                                           |
| F12  | Install, login, GitHub and update terminals track absolute output offsets after the retained log fills. [Code](../apps/web/src/ui/InstallTerminal.tsx)                                 | [Test](../apps/web/src/terminal-jobs.test.tsx)               | [#1067](https://github.com/Leonxlnx/tastecode/pull/1067)                                                           |
| F13  | Terminal jobs query retained server status after reconnect and recover missed exits without blind resubmission. [Code](../apps/web/src/provider-install.ts)                            | [Test](../apps/web/src/terminal-jobs.test.tsx)               | [#1067](https://github.com/Leonxlnx/tastecode/pull/1067)                                                           |
| F14  | Rename and pin failures report an error and reconcile state. Old failures cannot undo a newer edit. [Code](../apps/web/src/optimistic-mutations.ts)                                    | [Test](../apps/web/src/optimistic-mutations.test.ts)         | [#1069](https://github.com/Leonxlnx/tastecode/pull/1069)                                                           |
| F15  | The file tree refreshes on reopen, task completion, reconnect and explicit refresh, with stale-result guards. [Code](../apps/web/src/ui/workspace/WorkspaceFiles.tsx)                  | [Test](../apps/web/src/ui/workspace/WorkspaceFiles.test.tsx) | [#1072](https://github.com/Leonxlnx/tastecode/pull/1072)                                                           |
| F16  | Voice cancellation owns pending startup resources and releases late streams and audio contexts. [Code](../apps/web/src/voice-recorder.ts)                                              | [Test](../apps/web/src/voice-recorder-lifecycle.test.tsx)    | [#1073](https://github.com/Leonxlnx/tastecode/pull/1073)                                                           |
| F17  | Preview scripts run in an isolated world. Trusted native code checks and caps screenshot height. [Code](../apps/desktop/src/preview-capture.ts)                                        | [Test](../apps/desktop/src/preview-settle.test.ts)           | [#1068](https://github.com/Leonxlnx/tastecode/pull/1068)                                                           |
| F18  | Preview storage and cache cleanup both run. Failure is returned and blocks reuse of the shared partition. [Code](../apps/desktop/src/preview-session.ts)                               | [Test](../apps/desktop/src/preview-session.test.ts)          | [#1068](https://github.com/Leonxlnx/tastecode/pull/1068)                                                           |
| F19  | Task start accepts a base ref. Isolated tasks start from that ref; shared starts guard the branch change. [Code](../apps/server/src/worktree.ts)                                       | [Test](../apps/server/src/audit-regressions.test.ts)         | [#1065](https://github.com/Leonxlnx/tastecode/pull/1065), [#1070](https://github.com/Leonxlnx/tastecode/pull/1070) |
| R1   | NDJSON, JSON-RPC, API SSE and OpenCode native streams enforce frame limits before parsing. [Code](../packages/proc/src/frames.ts)                                                      | [Test](../packages/proc/src/frames.test.ts)                  | [#1061](https://github.com/Leonxlnx/tastecode/pull/1061), [#1062](https://github.com/Leonxlnx/tastecode/pull/1062) |
| R2   | Socket backlogs, pending calls and lazy validation queues have limits and deadlines. Expired replies release memory. [Code](../apps/web/src/transport.ts)                              | [Test](../apps/web/src/transport-retention.test.ts)          | [#1066](https://github.com/Leonxlnx/tastecode/pull/1066)                                                           |
| R3   | One desktop owner bounds validation, queue wait, capture, write and cleanup. Server cancellation reaches native work. [Code](../apps/desktop/src/preview-capture.ts)                   | [Test](../apps/desktop/src/preview-capture.test.ts)          | [#1068](https://github.com/Leonxlnx/tastecode/pull/1068)                                                           |
| R4   | ThreadController owns transcript, replay, queues, revisions, submissions and drafts outside App; delta batching remains. [Code](../apps/web/src/thread-controller.ts)                  | [Test](../apps/web/src/thread-controller.test.ts)            | [#1064](https://github.com/Leonxlnx/tastecode/pull/1064)                                                           |
| R5   | Typed ProviderControls and declared capabilities own provider account, model, login, usage, MCP and skills actions. [Code](../apps/server/src/provider-controls.ts)                    | [Test](../apps/server/src/provider-controls.test.ts)         | [#1063](https://github.com/Leonxlnx/tastecode/pull/1063)                                                           |
| R6   | A local Electron gate measures visible rows, streaming, switching, cold start and stable idle memory across three runs. [Code](../apps/desktop/scripts/verify-performance.js)          | [Test](../apps/desktop/src/performance-gate.test.ts)         | [#1074](https://github.com/Leonxlnx/tastecode/pull/1074)                                                           |
| R7   | History has size reports, export, dry-run pruning, required archives and space reclamation. A database lock excludes concurrent maintenance. [Code](../apps/server/src/history-cli.ts) | [Test](../apps/server/src/history-cli.test.ts)               | [#1065](https://github.com/Leonxlnx/tastecode/pull/1065)                                                           |
| R8   | Fast validators have compile-time field coverage and tests against canonical schemas. [Code](../apps/web/src/fast-validation.ts)                                                       | [Test](../apps/web/src/transport-validation-parity.test.ts)  | [#1066](https://github.com/Leonxlnx/tastecode/pull/1066)                                                           |
| R9   | MCP and skills viewers renew bounded watch leases. Idle controls stop when no viewer needs them. [Code](../apps/server/src/watch-leases.ts)                                            | [Test](../apps/server/src/provider-controls.test.ts)         | [#1063](https://github.com/Leonxlnx/tastecode/pull/1063)                                                           |

## Validation

Every code PR passed local lint and formatting, recursive typecheck, all package tests, root license tests and build on its exact source. The equivalent package commands are `pnpm lint`, `pnpm -r typecheck`, `pnpm -r test`, `node --test tools/scripts/release-licenses.test.js` and `pnpm -r build`. Existing Vite large-chunk warnings do not fail the build. No hosted CI run was started.

The real server and PTY recovered a retained output tail after 220,000 characters and a disconnected client, then recovered exit code 7. Real history size/export and maintenance exclusion checks passed. Native Electron preview tests covered isolated height reads, cleanup failure, dirty-partition reuse, stalled capture and cancellation.

A native Electron fixture mounted the real update controls, terminal and file tree. All 18 interaction checks passed, including failed update/retry, verified success, notice dismissal, real temporary file refresh, stale replies, task completion and reconnect. Provider responses were fixture data; no real provider update or login ran. The fixture does not cover outer App navigation.

The local performance gate passed three renderer runs and three cold starts. Each renderer visited 500 messages, streamed 1,920 deltas and switched five stores. Full-app stable idle memory stayed within 500 MB. See [the repeatable performance checks](./PERFORMANCE-CHECKS.md).

Native checks ran on macOS arm64. Windows process, filesystem and Electron checks are still required before a Windows release. Signed installers, real provider accounts and packaged microphone permissions were not tested. All owned test processes were closed.

## Delivery

- [#1060: feat(contracts): add audit recovery and lifecycle messages](https://github.com/Leonxlnx/tastecode/pull/1060) — f8284085
- [#1061: fix(adapters): preserve session safety across errors and shutdown](https://github.com/Leonxlnx/tastecode/pull/1061) — 77cf6771
- [#1062: fix(api): enforce credential and approval boundaries](https://github.com/Leonxlnx/tastecode/pull/1062) — 0f4d304d
- [#1063: refactor(server): give provider controls a bounded lifecycle](https://github.com/Leonxlnx/tastecode/pull/1063) — 6a627617
- [#1064: refactor(web): move task state into one lifecycle owner](https://github.com/Leonxlnx/tastecode/pull/1064) — aa62ebb9
- [#1065: fix(server): protect task checkouts and durable restore history](https://github.com/Leonxlnx/tastecode/pull/1065) — e50b45d2
- [#1066: fix(transport): bound queued work and validate deferred replies](https://github.com/Leonxlnx/tastecode/pull/1066) — dd2e1bce
- [#1067: fix(terminal): recover output and completion after reconnect](https://github.com/Leonxlnx/tastecode/pull/1067) — 69898ffb
- [#1068: fix(desktop): bound and cancel native preview lifetime](https://github.com/Leonxlnx/tastecode/pull/1068) — e125926a
- [#1069: fix(web): reconcile failed rename and pin writes](https://github.com/Leonxlnx/tastecode/pull/1069) — cb72e20a
- [#1070: fix(web): start isolated tasks from the saved branch](https://github.com/Leonxlnx/tastecode/pull/1070) — 2aff1841
- [#1071: feat(settings): add recoverable provider CLI updates](https://github.com/Leonxlnx/tastecode/pull/1071) — eb863158
- [#1072: fix(web): refresh workspace listings without stale replies](https://github.com/Leonxlnx/tastecode/pull/1072) — c40a9352
- [#1073: fix(web): release cancelled voice startup resources](https://github.com/Leonxlnx/tastecode/pull/1073) — a204ea8d
- [#1074: test(desktop): enforce native Electron performance budgets](https://github.com/Leonxlnx/tastecode/pull/1074) — d6d34b15
