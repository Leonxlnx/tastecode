# GPT-6 De Facto Repository Transformation Plan

**Track: LINUX SUPPORT FOR TASTECODE. Planning only. Not a new product.**

Reviewed on 2026-09-14. Planning branch: `docs/gpt-6-defacto-linux-20260914`, based on **`feat/linux-release-v1-main` at `b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b`**. Current upstream comparison: **`main` at `759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9`**.

This branch contains planning documents only. It does not certify a Linux binary. Do not push to main, merge this branch into main, rebase/force-push published work, dispatch hosted Actions, publish a release, change repository visibility, or modify the user's installed application during this planning pass.

The [overall TasteCode proposal](https://github.com/Leonxlnx/tastecode/blob/docs/gpt-6-defacto-overall-20260914/gpt-6-defacto.md) is a separate maintainer-review track. Linux work may proceed independently of acceptance of that proposal, but it must remain support inside this repository: same product identity, domain model, data paths and provider contracts. Shared improvements should have one portable implementation, not Linux-only replacement services or storage formats.

## 0. Executive decision

**Do not continue the old Linux branch as if it were current main. Reconcile first, then simplify.** The integration candidate is 18 commits ahead and 114 behind the reviewed main. Main has since acquired material lifecycle, security, performance and product fixes. A wholesale copy of older Linux server, supervisor, process or store files would undo newer work.

The minimal credible Linux target is the existing Electron application and Node server, with a small Linux platform policy, correct PTY ownership, exact x64 packaging, and honest physical qualification. Keep the current utility-process core-server launch. Keep existing SQLite, event/protocol boundaries, provider adapters and renderer optimizations. Do not create a Linux app package, alternate backend, daemon, database, theme or product brand.

The highest-leverage decisions are:

1. Converge ordinary process ownership on current main's `spawnOwned` plus awaitable `killTree`. Preserve the distinct Linux PTY-session safety logic; it solves a different problem.
2. Make readiness, graceful stop and confirmed exit work through the **actual utility-process transport**, not only older Node child IPC. Retain ownership after failed cleanup.
3. Choose an explainable Linux v1 close policy: closing the last real application window requests the same safe Quit path. Do not hide indefinitely because constructing a Tray object appeared successful. Minimize remains available; Windows/macOS policies are unchanged. This is an intentional Linux behavior decision.
4. Keep **manual Linux updates for v1**, which the Linux source already selects. Remove auto-update-channel verification machinery from the Linux distribution contract after consumer checks. Manual downloads still need exact artifacts, provenance, checksums and licenses; they do not need a future incremental-update metadata parser.
5. Build once, prove the default packaged launcher's native modules, bind physical results to exact artifacts, and distinguish unpacked qualification from a release candidate and a shipped release.

The expected simplification is fewer ordinary process APIs, no tray-host liveness scheme, no v1 Linux auto-update protocol, and one release identity. No 10x/100x gain or large production LOC reduction is claimed without measurements.

## 1. Repository model and branch ownership

### Verified branch inventory

| Ref | Inspected head | Meaning for this plan |
| --- | --- | --- |
| `main` | `759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9` | Current overall source comparison; commit time 2026-09-14T16:10:19Z |
| `feat/linux-release-v1-main` | `b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b` | Chosen Linux integration candidate; commit time 2026-09-09T03:35:40Z |
| `feat/linux-release-v1` | `889195601ef49a935bb72cb47a8576478d89dc54` | Another published Linux line; commit time 2026-09-09T03:10:57Z; must reconcile, not assume included |
| `feat/linux-architecture-foundation` | `12cbe7e41cc526c39c855543f5c821471125c3c9` | Historical foundation; inspect for unique requirements, not a release baseline |

Comparing reviewed main to the candidate gives **18 ahead / 114 behind**, merge base `797db3c670c0d2ca3bebc26b41ea089605520730`. Comparing `8891956...` to `b1e4a1d...` gives **18 ahead / 83 behind** with the same merge base. The candidate is therefore **not a descendant of the other release branch**. The selection is an explicit inference based on the newer integration line and focused Linux delta, not proof that all older Linux work is included.

GitHub comparison file statistics describe the changes since the merge base. They are not a direct diff of current main versus the complete candidate tree. L00 must produce both comparisons before changing code.

### Product and architecture

The current application has three app directories (`desktop`, `server`, `web`) and twelve package directories: nine adapters plus contracts, design-agent and proc. Linux should not change these counts. The desktop owns native windows and a core-server process; the server owns projects, tasks, providers, PTYs, SQLite, checkpoints and credential access; React owns bounded display state. The server can also run without the desktop.

The Linux candidate adds AppImage/deb x64 packaging, desktop identity/window handling, GNU keyring packaging/license coverage, native binding proof, lifecycle work, conservative PTY session termination and physical/release evidence tooling. These are useful foundations. However, main's newer `utilityProcess` launch and process ownership APIs are not present in the same form in the candidate.

### Preserve identity and existing data

Retain `appId: dev.tastecode.desktop`, visible product name `Taste Code`, existing TasteCode data paths, executable `tastecode`, and the configured desktop-entry identity. Keep the existing `PersonalHarness` keyring service until an explicitly tested migration exists. Do not make Windows/macOS use Linux paths or a Linux-only process service. No separate repository or alternative TasteCode distribution name is authorized.

Sources: [main desktop entry][M01], [Linux desktop package][L01], [Linux supervisor][L02], [main supervisor][M02], [Linux process code][L03], [main process code][M03].

## 2. Evidence and baselines

### FACT / MEASURED from remote source

- Exact refs, commit relationships and candidate selection above were freshly inspected.
- Main's default owned server uses `utilityProcess.fork`; its fallback uses Node mode. The Linux supervisor instead directly owns a ChildProcess and sends a Node IPC shutdown message.
- Main's ordinary-process cleanup is already awaitable/retryable and owns POSIX groups at spawn. Linux has an older `ownProcessTree`/`ownedProcessSpawnOptions`/`terminateTree` API plus distinct PTY-session functions.
- The Linux update controller returns `manual` on packaged Linux. In that mode it does not start the updater or download/install a candidate.
- Linux release tooling nevertheless requires and deeply validates a Linux channel YAML/blockmap contract. `linux-updater-metadata.js` and its test file were added as 329 and 257 lines respectively in the inspected Linux delta.
- The native proof runner executes the packaged application with `ELECTRON_RUN_AS_NODE=1`. That is not the default utility-process application path in current main.
- Linux acceptance runs `build`, then `dist:linux:dir`, whose dist preparation builds again. The repeated invocation is observed; elapsed cost is not measured.
- The acceptance script permits Linux x64, Pop!_OS or Ubuntu **24.04**, native Wayland, COSMIC or GNOME, a user D-Bus session, Node >=22.18.0, pnpm 11.8.0 and a clean worktree. Its report remains `awaiting-manual-desktop-acceptance` after automated steps.
- Artifact provenance, exact version/architecture filtering, checksums, dependency inspection and license checks already exist. Do not propose them as absent.

### INFERENCE

Source divergence is the largest immediate regression risk. Ordinary-process convergence should delete older duplicate APIs, while PTY session handling remains necessary. A manual-only v1 can remove the unused update-channel contract. Actual utility-process proof is required to transfer native confidence to the new default launcher. A Tray constructor succeeding is insufficient evidence that a user can restore a hidden window on the target desktop.

### UNKNOWN / must measure

No complete local source checkout, authored-LOC inventory, dependency graph analysis, application test/build, native binding execution, package installation, real provider flow, performance measurement or physical Wayland QA occurred in this audit. Unpublished local commits and the user's currently installed OS are unknown to this source snapshot. Do not assume the test machine is 24.04 from memory; record `/etc/os-release`, compositor and session.

Previous local or macOS reports are historical evidence only. Neither a checked-in HTML checklist nor a source-level native-proof function establishes that a final AppImage/deb passes. “Not tested” and “environment blocked” remain different from “failed,” and neither is “passed.”

## 3. Tools, skills, agents and evidence boundary

The connected GitHub tools supplied fixed-ref files, directory metadata, branch history/comparisons, code search, issue/PR inspection and planning-branch/document writes. Search covered default main, so candidate files were read by exact ref. Repository writes are limited here to this plan.

The local environment offered Git, Node, Python and text utilities, but direct remote Git resolution failed and no authenticated full checkout was obtained. pnpm and coding-agent executables were not available. No parallel subagent tool was exposed. Consequently no parallel agents, repository-wide static analyzer or runtime QA are claimed.

Installed skills were searched. Five relevant guidance tracks were read: `react-best-practices`, `verification`, `agent-browser-verify`, `investigation-mode` and `deep-research`. The catalog did not contain five dedicated code-audit skills; the named Thermo Nuclear Code Review / Cursor skill was not found. Browser guidance was consulted, not executed. Missing coverage was supplied by separate architecture, deletion, complexity, runtime, build, security, correctness, testing, product, persistence, integration and history review tracks.

All major findings below name source and symbols. Performance and physical claims remain delegated gates, not implied accomplishments of this planning run.

## 4. Current architecture and critical integration traps

### Core-server launch

Current main's desktop wraps a utility process behind `SupervisedServerProcess`; it retains a Node-mode fallback. Its stop method is currently synchronous. Candidate Linux instead adds an asynchronous stop around a raw ChildProcess, with an IPC message understood by `apps/server/src/shutdown.ts`. Copying that supervisor into main would lose the newer launch abstraction.

The candidate stop path also clears child/lifetime ownership before awaiting its shutdown. Concurrent calls or a failed signal/cleanup can therefore lose the handle needed for a later retry. The desired contract is not “make stop async” alone: concurrent callers must share an attempt and ownership must survive failure until actual exit.

### Process and terminal ownership

Main already provides owned spawn plus asynchronous group termination and preserves failed-stop protections. Linux's PTY session cleanup additionally accounts for controlling sessions, changing process groups, start-time identity and unrelated/reused PIDs. Ordinary child groups and interactive PTY job sessions are not interchangeable. Consolidate the former; protect the latter.

### Packaging and proof

The candidate packages two Linux x64 formats and records build provenance. Automated unpacked acceptance and release-artifact checks are separate tools because they inspect different things. They should share source/artifact identity, not be merged into a giant release manager. Proof currently using Node mode must be extended to current main's actual utility launcher.

### UI/runtime delivery

Main already contains substantial provider, transport, thread, preview and animation improvements. Linux integration must preserve them. Manual Linux updates already avoid a runtime updater dependency on desktop startup, but release tooling still carries auto-update metadata complexity. The close-to-tray path must not make a task-running window unreachable on a desktop without an effective tray surface.

## 5. External architecture comparison

Primary evidence was checked on 2026-09-14; this is a comparison of choices, not imported architecture.

- [T3 Code internals](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md), fetched blob `6ca41871679aaa83465050ac72f1efa5d14923b7`: execution stays with the owning environment. Its Linux notes emphasize pre-ready desktop identity and portal registration timing. Preserve that lesson where TasteCode uses those facilities, not its additional mobile/multi-environment frameworks. A cached older workspace-layout URL returned 404 and was not treated as current authority.
- [OpenCode server documentation](https://opencode.ai/docs/server/): a headless server owns execution and serves clients. TasteCode already has this useful boundary; Linux does not need a second backend or an HTTP/SSE migration.
- [VS Code utility-process owner](https://github.com/microsoft/vscode/blob/main/src/vs/platform/utilityProcess/electron-main/utilityProcess.ts), fetched blob `c1dd46b4c1771f1b59bda15b78198085f63b5155`: explicit spawn/message/exit/crash handling is a relevant pattern. Its larger service/telemetry framework is not a requirement for TasteCode.

[Electron utility process](https://www.electronjs.org/docs/latest/api/utility-process) and [parentPort](https://www.electronjs.org/docs/latest/api/parent-port) documentation distinguish utility messaging from Node child IPC. Verify the exact installed Electron version. Do not disable sandboxing or assume a successful signal acknowledges drained tasks.

[electron-updater documentation](https://www.electron.build/docs/api/electron-updater/) is distinct from Electron's built-in autoUpdater documentation. The manual Linux decision is a product/scope simplification, **not a claim that electron-updater cannot support Linux or deb**. Newer documentation defaults must not be assumed for pinned builder 26.15.3/updater 6.8.9.

## 6. Master findings

### Prioritized index

| ID | Category | Severity / confidence | Leverage | Tasks |
| --- | --- | --- | --- | --- |
| LF01 | Source integration | High / High | Prevent loss of newer main fixes and unique older Linux work | L00 |
| LF02 | Ordinary process API duplication | High / High | One current owned-child contract instead of competing APIs | L01 |
| LF03 | PTY ownership and retry | High / High safety requirement | Preserve unrelated-process safety and recoverable cleanup | L02 |
| LF04 | Readiness/shutdown transport | High / High | Correct current utility runtime and failed-stop ownership | L03/L04 |
| LF05 | Hidden-window reachability | High product risk / Medium unmeasured incidence | Delete dependence on tray-host detection for v1 | L05 |
| LF06 | Default-runtime native proof gap | High release gate / High | Test the binary's actual launcher, not a fallback only | L06 |
| LF07 | Manual/runtime versus automatic/release mismatch | Medium / High | Remove an unused update metadata contract and its maintenance burden | L07 |
| LF08 | Build/proof identity duplication | Medium / High | One prepared build and consistent artifact/physical evidence | L08 |
| LF09 | Qualification versus release status | High release gate / High | Explicit supported matrix, no source-only readiness claims | L09/L12 |
| LF10 | Inherited custom-environment plaintext | High / High | Shared portable fix; do not invent Linux-only credential schema | L10/L11 |

### LF01 — Reconcile branch history before implementation

**Evidence:** fixed refs/comparisons in section 1; current main supervisor/process implementation versus the candidate. **Problem/root cause:** Linux support was developed against an older base while main continued delivery. The name `-main` does not make the branch current or subsume the other Linux line.

**Target:** a fresh Linux implementation branch with a documented three-line comparison and an ordinary merge of the current target. Resolve conflicts by behavior/ownership, not choosing ours/theirs wholesale. **Delete:** superseded duplicate implementations only after tests; no branch deletion. **Change:** adapt Linux-specific behavior into current main structure. **Add:** a small reconciliation ledger, not another architecture document set. **Preserve:** all newer main security/performance/product fixes and useful unique Linux tests. **Intentional behavior:** none from the merge itself.

**Complexity/LOC:** net unknown until direct-tree inventory. **Performance/product:** preserve current capabilities; no speedup claimed. **Risks:** silent overwrite of nonconflicting but semantically obsolete code. **Dependencies:** none. **Verification:** diff every conflict family, run root gates and both OS regression suites, prove every retained Linux behavior. **Rollback:** revert bounded follow-on changes; abort an unresolved merge in the isolated worktree without resetting anyone else's work. **Priority P0, High confidence.**

### LF02 — Converge ordinary-process ownership on current main

**Evidence:** [candidate process functions][L03] versus [main process functions][M03]; candidate adapters/server callers listed in the branch comparison. Main has `spawnOwned` and awaitable `killTree`; candidate also exposes `ownProcessTree`, `ownedProcessSpawnOptions`, synchronous `killTree` and `terminateTree`.

**Target:** ordinary children use current main's contract. Await termination where correctness requires it. Keep registration at spawn, failure retry, verified group ownership and Windows semantics. **Delete:** obsolete ordinary-child API exports/callers once zero supported consumers remain. **Add:** no new ProcessManager, backend interface or service. **Preserve:** late stdout through close-based settlement, bounded frames, environment/argv handling and all F03/F10 protections documented in main's prior audit.

**Intentional behavior:** failed stop remains visibly failed and retryable. **Impact:** fewer concepts; exact LOC unknown. **Risks:** ignored promises, unowned negative PID, Windows taskkill regressions, mixed API imports after merge. **Verification:** full consumer search, typecheck, proc/adapter/server tests, real owned parent/descendant plus unrelated sentinel. **Rollback:** revert caller+primitive changes together after owned tests finish. **Priority P0, High confidence.**

### LF03 — PTY sessions are a justified exception, not slop

**Evidence:** [Linux process code][L03], `ownPtySession`, `terminatePtySession`, `cleanupExitedPtySession`; [terminal owner][L04]; main terminal closing maps and rejected close-all attempt [M04]. Linux uses procfs session/group/start-time identity and conservative setup/termination rather than a bare process-name kill.

**Target:** one retained PTY owner, one current stop attempt and one actual-exit observation. Failed attempts are retryable; checkout guards survive failure. Keep the identity checks needed for Linux job-control groups. **Delete:** duplicate ownership state and permanent failed-attempt caching, not generation/session checks. **Add:** no systemd/cgroup service requirement. **Preserve:** 4 ms output batching, bounded tail, absolute offsets, retained exit status and single final notification.

**Impact:** ownership becomes easier to explain; no promised large LOC cut or runtime gain. **Risks:** PID reuse, process-group changes, session setup races, zombies, a stopped leader never resumed on error. **Verification:** test actual PTY sessions with foreground/background jobs, late leader exit, setup timeout, failed cleanup/retry and unrelated same-name process. Prove failure unfreezes any temporarily stopped process it owns. **Rollback:** never discard still-live ownership records or remove protection to make a test pass. **Priority P0, High confidence in requirement; physical behavior unverified here.**

### LF04 — A Node shutdown message does not cover the utility runtime

**Evidence:** [candidate supervisor][L02], [candidate shutdown][L05], [main desktop launcher][M01], [main supervisor][M02]. Candidate asynchronous stop clears handles before completion and uses Node IPC; main launches a utility process and currently has a synchronous stop contract. Main also relies on a textual listening milestone; the candidate's readiness tests are valuable but not sufficient after integration.

**Target:** a small ready/shutdown message shape carried by both supported transports; one retained supervisor generation; one server drain. Actual binding plus required recovery precede ready. Confirmed process exit precedes owner release. **Delete:** log-parsing control authority, success-on-failed-close exit and old duplicate shutdown wrappers after convergence. **Preserve:** utility default, legacy fallback until separately retired, startup overlap, restart limits and all failed-stop checkout protection.

**Behavior change:** failed Quit/restart remains blocked and visible; no replacement server until the old owner resolves. **Risks:** wrong message payload normalization, partial startup, reentrant quit, updater callbacks. **Verification:** deterministic promises plus real utility and Node-mode fixtures, malformed/stale messages, concurrent stop, error then late exit, retry and storage access ordering. **Rollback:** lifecycle callers and wrappers together. **Priority P0, High confidence.**

### LF05 — Remove Linux v1 hidden-tray liveness dependency

**Evidence:** [tray construction][L06] catches construction/empty-icon errors; [close predicate][L07] hides on non-macOS when `hasRecoverySurface` is true. A constructed object is not physical proof of a reachable tray on COSMIC/GNOME.

**Target decision:** on Linux, closing the last real application window requests the shared safe Quit path; minimize remains minimize. Do not hide the only application window merely because a tray object exists. Remove Linux-only tray creation if its only consumer is this hide flow; preserve shared Windows tray behavior and macOS dock/window behavior. No new background daemon or compositor-specific host-monitoring code.

**Preserved:** second-instance restores the real window, explicit Quit is safe, running tasks are stopped through the same drain with failure visible. **Intentional change:** Linux v1 does not promise background execution after closing its only window. Clearly document this before qualification. **Complexity:** deletes recovery-surface guesswork; LOC conditional on remaining consumers. **Risks:** users expecting keep-running-on-close. **Verification:** with/without tray host, actual close/minimize/second-instance, active PTY/provider and failing shutdown. **Rollback:** only restore close-to-hide with physical recovery-surface evidence and an explicit product decision, not constructor success. **Priority P1, Medium incidence confidence.**

### LF06 — Native binding proof must use the shipped default launcher

**Evidence:** [runner][L08] executes packaged Node mode; current main uses a utility process. **Target:** exercise SQLite, keyring and PTY through the actual packaged core-server entry in an isolated profile, then installed-app workflows. Retain fallback proof only while supported. **Delete:** Node-mode proof being treated as normal-launcher proof. **Add:** minimal test-only/authorized proof path; no public privileged endpoint.

**Preserve:** asar paths, native prebuild policy, disposable credentials and zero user-profile writes. **Performance:** measurement only. **Risks:** host native module fallback, missing executable bits, unavailable D-Bus/Secret Service, native ABI or utility permissions. **Verification:** record exact module resolution, launch mode, version, SHA and OS; real PTY write/resize/read/exit and credential save/read/delete. Missing desktop services are BLOCKED. **Rollback:** prior qualified artifact with user data preserved. **Priority P0 release gate, High confidence.**

### LF07 — Manual updates make the v1 auto-update metadata parser unnecessary

**Evidence:** [Linux update mode][L09] returns `manual`; [release evidence][L10] nevertheless requires verified Linux channel metadata and blockmap parsing; [metadata verifier][L11] and [tests][L12] exist specifically for that contract.

**Target decision:** Linux v1 distribution comprises the exact AppImage/deb, checksums and required evidence/notices. It does not advertise or consume an automatic Linux update channel. Keep manual HTTPS download/install UX. Prevent Linux channel publication; an unavoidable builder-generated sidecar stays in a private build area, never in the curated distribution set.

**Delete:** `linux-updater-metadata.js` and its dedicated tests after a full consumer check; channel/blockmap-only logic in Linux evidence/shared helpers; mandatory channel YAML in the Linux manifest. The two dedicated files account for **586 added lines in the inspected branch delta**, which is a candidate deletion bound, not a measured net reduction. Do not delete Windows/macOS updater code, general publisher safeguards, artifact SHA checks, embedded source provenance, licenses or architecture/version filtering.

**Add:** a smaller test proving Linux manual mode does not load/call the updater and the distribution manifest rejects update-channel sidecars. **Behavior preserved:** existing manual Linux update mode. **Intentional change:** no promise of a future auto-update channel in the v1 release package. **Risks:** hidden uploader consumer or changing global publish config. **Dependencies:** consumer inventory and pinned-builder inspection. **Verification:** exact allowlist, no updater calls in packaged Linux, manual upgrade preserves data. **Rollback:** restore the isolated verifier only alongside a deliberately reintroduced update-channel contract. **Priority P1, High confidence.**

### LF08 — Build and physical proof must describe the same inputs

**Evidence:** [acceptance][L13] runs a build then dist preparation; [provenance][L14] and [release evidence][L10] already check source and artifact identity. **Target:** one Node-driven preparation builds once, packages both targets and exposes exact identities to subsequent automated and physical steps. Retain separate proof types with shared identity.

**Delete:** duplicate build invocation and ambiguous current-looking unbound proof. **Preserve:** frozen lock, clean worktree, actual resource checks, exact version/arch filtering, configured deb dependencies, licenses and checksums. **Add:** only missing cross-report identity validation and fixture tests. **Performance:** one actual build per preparation; measure elapsed change. **Risks:** unsafe skip-build flag, stale preload/resources, proof after artifact replacement. **Verification:** tampered binary, changed SHA/version, wrong arch, stale evidence and partial build all fail closed; manual result does not auto-promote status. **Rollback:** rebuild from a known commit and invalidate old proof rather than relabel it. **Priority P1, High confidence.**

### LF09 — A source-complete branch is not a qualified Linux release

**Evidence:** acceptance explicitly stops at awaiting manual desktop acceptance; the physical checklist is substantial; no live artifact/desktop execution occurred in this audit. **Target:** three explicit milestones in section 18. **Delete:** ambiguous “Linux ready” status that mixes source, unpacked and installed proof. **Preserve:** current 24.04 scope unless separate testing expands it. **Add:** one source/artifact/environment-bound result, not another dashboard.

**Verification:** real Pop!_OS COSMIC native Wayland plus the separately advertised Ubuntu/GNOME target; AppImage and installed deb; actual credentials, terminal, providers, dialogs, window behavior, clean quit, performance and manual upgrade. **Rollback:** last qualified binary, no profile wipe. **Priority P0 release gate; High confidence in the proof gap.**

### LF10 — Shared secret persistence remains a Linux release concern

**Evidence:** main [custom schema][M05], [store][M06], [launch][M07] accept and serialize arbitrary custom environment strings. Linux uses the same product capability and OS credential infrastructure. **Target:** apply one portable credential-reference/write-only contract, the same as the overall proposal, without a Linux-only data fork. Upstream acceptance of the overall planning PR is not required to implement the fix in the Linux work branch.

**Delete:** plaintext custom environment values from stored/read DTOs and raw error propagation. **Add:** versioned reference metadata and a reference-only recovery record, reusing existing keyring primitives. **Preserve:** command/argv/cwd/provider behavior, existing keyring service name and app data identity. All custom environment values migrate, avoiding an unreliable secret classifier. **Intentional change:** values become write-only and keyring availability is required for affected custom settings.

**Risks:** locked keyring, native value limits, failed delete, migration interruption and cross-platform format drift. **Verification:** disposable sentinel across disk/read responses/logs/argv versus intended child environment; restart at each migration boundary. **Rollback:** preserve a reference-capable reader, never downgrade into plaintext. **Priority P1, High confidence.**

## 7. Deletion ledger

| Delete candidate | Prerequisite | What explicitly survives |
| --- | --- | --- |
| Older ordinary-process API exports and wrappers | L01 consumers all use current main contract | Linux PTY identity/session functions and Windows safety |
| Readiness inferred from stdout | L03/L04 typed ready and real bind tests | Human logs and current startup overlap |
| Handle removal before stop completes | L04 exit-owned lifecycle | Retry state and failure guards |
| Permanent failed PTY stop cache | L02 real retry proof | Protected checkout and final output |
| Linux close-to-hidden-window dependency | L05 product choice and real QA | Minimize, second-instance, shared Windows tray/macOS behavior |
| Linux-only tray construction with no remaining purpose | L05 complete consumer search | Shared non-Linux tray helper if used |
| `tools/scripts/linux-updater-metadata.js` | L07 manual-only manifest and no other consumer | Binary hashes/provenance and general release safety |
| `tools/scripts/linux-updater-metadata.test.js` | Dedicated behavior no longer exists; replacement manual-policy tests | Tests for surviving artifact integrity |
| Channel/blockmap-only Linux helper branches | L07 consumer check | Version/arch/exact artifact names and checksums |
| Duplicate build within acceptance | L08 single identified preparation | Standalone dist correctness and all gates |
| Plain custom environment config/readback | L10/L11 completed migration | Executable metadata and launch behavior |
| Stale “current” branch/status claims | Source-bound result replaces them | Historical reports/checklist evidence |

Do not delete the 1,384-line physical checklist merely because it is large. First determine whether its interactive evidence workflow is used; preserve it unless the same useful workflow is deliberately replaced. No whole provider, renderer, server or desktop package is approved for removal. Lockfile/tool cleanup unrelated to Linux support belongs to the overall track unless integration makes it necessary.

## 8. DRY and duplication strategy

The unification unit is ownership, not filenames. Ordinary children converge on one spawn/terminate contract. PTYs retain their own session identity. Desktop and CLI share the server's drain function but have thin transport-specific message adapters. Artifact and physical reports share identity but not an invented common “all checks passed” status.

Eliminating the unused Linux update-channel contract makes its parser, blockmap tests and channel-only helper branches unnecessary. This is preferable to refactoring that parser into a cleaner unused abstraction. Choosing close-to-Quit removes the need to prove tray-host availability continuously. One prepared build removes duplicated work without adding a build cache service.

Keep provider-specific translation where protocols differ. Do not DRY security policies across external URLs, preview navigation, filesystem validation and approval decisions; their trust boundaries differ.

## 9. Minimal target architecture

```text
The same TasteCode desktop application
  platform policy: identity, window close, external links, manual update
  one owned core-server generation
       |
       +-- utility process by default
       +-- Node-mode fallback only while explicitly supported
       |
  existing server / typed protocol / SQLite / provider adapters
       |
       +-- current ordinary owned-child primitive
       +-- Linux PTY session identity primitive where necessary
       +-- existing keyring with portable credential-reference metadata

One build preparation
  -> exact x64 AppImage + deb
  -> provenance / hashes / required notices
  -> real packaged-launcher proof
  -> physical per-environment and per-artifact acceptance
```

No Linux service layer, long-lived daemon, duplicated renderer state, separate product settings model, process registry database or auto-update subsystem is needed for v1. The expected package count remains unchanged.

## 10. Architecture delta

| Before | After | Safety boundary |
| --- | --- | --- |
| Older Linux process API beside newer main API | Main ordinary-child contract plus explicit PTY exception | Never kill an unowned/reused PID |
| Node-only shutdown path | Same lifecycle messages through both supported launchers | Ready is bind/recovery; stop completes at exit |
| Hidden window depends on Tray construction | Linux last-window close uses safe Quit | Failure remains reachable; no silent background promise |
| Manual runtime mode plus auto-update metadata gate | Manual runtime and manual distribution contract agree | Hashes/provenance/notices remain mandatory |
| Acceptance builds, then dist rebuilds | One identified preparation | No unchecked skip-build flag |
| Node-mode native proof treated broadly | Default utility launcher actually exercised | No source-tree native fallback |
| Arbitrary persisted custom environment values | Portable keyring references and write-only update inputs | No plaintext fallback or Linux-only format |

## 11. Performance transformation

The largest justified build optimization is structural: avoid invoking the build twice in the same preparation. Its improvement is measured by total wall time and actual build-count logs, not guessed from the Vite step. Preserve current main's bundling, lazy imports, highlight worker, idle controls and batching.

| Workload | Existing/target mechanism | Required measurement | Pass criterion |
| --- | --- | --- | --- |
| Cold startup | Current utility launcher, lazy optional services | Process launch -> bound/recovered server -> first usable window; separate milestones | Existing repository <1.5 s target on its defined fixture; report each OS, do not borrow macOS result |
| Streaming | Existing frame batching/virtualization | 500 messages, at least 1,000 live deltas | Existing <150 ms first paint, <4 ms delta work and no >32 ms scroll frame budgets |
| Session switching | Existing persisted replay base and bounded renderer state | Warm switch and cold DB/snapshot read separately | Existing <100 ms fixture target; record larger-history results separately |
| Idle resources | Existing leases/eviction | Five thread stores, full Electron process set, stable samples | Existing <500,000,000-byte gate; no missing PIDs, forced GC, unloaded app or fake pass |
| PTY stop | Owned session groups and bounded retry | Root + foreground/background jobs + unrelated sentinel | Correct complete ownership cleanup; no unrelated signal; timing and scan cost reported |
| Restart/failure | Retained owner and one stop attempt | 100 injected cycles across both launch modes | Zero duplicate live generations, zero false ready/clean stop |
| Packaging | One source-bound preparation | Cold and warm complete pipeline before/after | One actual build per combined run, identical required checks and equivalent packaged resources |

Use existing `apps/desktop/scripts/verify-performance.js` and `verify-preview.js`. Extend fixtures, not a new benchmark platform. Record at least the existing three-run gate; numerical before/after claims additionally need repeated like-for-like samples and noise disclosure. Do not optimize procfs scans or remove identity checks without measurements and an equally safe ownership mechanism.

## 12. Product transformation

### Behavior-preserving

Same provider/task/checkpoint/terminal semantics; same project data and account identity; same typed web/desktop flows. Current main's keyboard, reduced-motion, history, preview, connection-health and animation fixes are protected. Linux errors should identify the missing service or permission rather than suggesting global sandbox disabling.

### Intentional Linux v1 changes

- Closing the last real window requests safe Quit rather than relying on a potentially absent tray. Minimize remains a way to keep the window/task available.
- Linux updates remain manual, with a clear download/install route and no automatic background updater promises.
- Lifecycle failures provide one native recovery surface with retry/cancel and explicit unsafe-force disclosure; no invisible half-running application.
- Custom environment values use the same proposed portable credential-backed contract, not Linux-only plaintext compatibility.

These choices reduce settings and hidden states. Do not add a close-behavior preference, compositor support database, notification-daemon integration or update-channel toggle to preserve every hypothetical workflow.

### Deferred product ideas

Background execution after close, auto-update, ARM64, Flatpak/RPM/Snap, remote/mobile integration and system-service mode need separate demand and qualification. Their absence is not permission to brand this as a different TasteCode. Do not add a new feature merely to make the Linux branch appear more ambitious.

## 13. Reliability, security and correctness

Use the same renderer sandbox, context isolation, narrow bridge, CSP, server Origin/auth, canonical workspace checks and approval authority as main. Linux porting must not widen them. URL errors are surfaced without accepting file/smb/custom schemes for arbitrary external links. Preserve paths with spaces/non-ASCII and argv arrays; do not source `.bashrc`/`.zshrc` or run a shell string to resolve provider binaries.

Record and verify test-owned process identity before signalling. A PID existing later is not proof it is the same process. Preserve conservative UID/session/start-time checks and safe handling of procfs parse errors. A timeout means unproved cleanup; it never authorizes deleting a worktree that may still be used.

Real keyring proof requires the actual user D-Bus/Secret Service environment. Never replace it with plaintext storage when unavailable. Keep secrets out of argv, diagnostics and proof reports. Treat binary native dumps as unsanitized if the inherited general diagnostics feature still collects them; do not claim the text scrubber covers those files. A portable diagnostics simplification may reuse overall task G08, but no Linux-specific claim may overstate inherited privacy.

AppImage extraction/install tests execute only artifacts built from the identified trusted checkout. Do not run arbitrary downloaded artifacts or use root except the isolated, explicitly authorized deb installation workflow. No `--no-sandbox`, disabled security policies, globally relaxed AppArmor, or permissive filesystem permissions are an acceptance workaround.

## 14. Test and verification architecture

Keep three evidence layers distinct: deterministic contract tests; actual local process/PTY/socket/native integration; physical packaged/installed desktop behavior. Preserve the current Linux readiness, environment, terminal, provenance, dependency and license tests. Remove tests only when the corresponding unused update-channel feature is intentionally removed and remaining release integrity contracts are covered.

Use fresh temporary app/config/data/cache directories, distinct ports and disposable keyring references. Confirm no reads/writes against the user's normal profile. Inject failure at actual ownership boundaries: bind, keyring access, PTY setup/stop, provider late creation, metadata write and native process exit. An E2E test that only mocks those boundaries is not sufficient proof.

Cross-platform regressions must run on the merged source. A Linux conditional in shared code does not prove Windows/macOS are unaffected: imports, return types, timing and promise handling can still change. The manual workflow remains manual; run local equivalents or obtain explicit authorization before using hosted minutes.

## 15. Dependency, packaging and configuration policy

Keep pnpm 11.8.0 and the frozen lockfile. Reconcile the actual Node development/CI matrix rather than silently upgrading Node, TypeScript or Electron during integration. Do not flip `npmRebuild: false` blindly: prove the exact packaged native prebuilds. Preserve `.node` and node-pty helper unpacking, executable bits, GNU x64 native package and its license.

Linux v1 scope is **glibc x64 AppImage and deb**. Preserve configured deb dependency alternatives such as `libasound2t64 | libasound2`, and verify emitted package metadata rather than trusting configuration alone. Keep artifact architecture/version identity exact. Do not publish musl, ARM or another distribution format without its own qualification.

For manual updates, change only Linux-specific output/staging policy. Inspect pinned builder types/source for a supported way to suppress channel generation. If generation is unavoidable, leave the sidecar private and assemble the distribution from a strict allowlist; do not mutate global Windows/macOS publish behavior. General release reconciliation must still reject stale versions, wrong architectures and published-release mutation.

## 16. Things that look suspicious but must be protected

- PTY procfs/start-time/session safeguards, including safe failure and leader handling.
- Main's ordinary process ownership, failed-stop retry and close-based stdout settlement.
- Checkout guards and durable checkpoint refs; never release them to suppress a failing test.
- SQLite event log, replay snapshots/read models and recovery version markers.
- Main's `ThreadController`, `ProviderControls`, bounded transport, highlight worker, preview cleanup and completed animation fixes.
- Lazy Design/provider startup and existing performance scripts.
- Exact artifact provenance/hashes/licenses/architecture checks even after auto-update metadata deletion.
- Existing data/keyring identity and non-Linux window/updater policies.
- Physical checklist and old evidence as historical material, not current ready status.
- Parked adapters used by custom harnesses; Linux support does not authorize deleting product integrations.

## 17. Implementation dependency graph

```text
L00 branch reconciliation + current baseline
  +--> L01 ordinary process convergence --> L02 PTY ownership --> L03 server lifecycle --> L04 desktop supervisor/quit
  |                                                                                         |
  |                                                                                         +--> L05 Linux close policy
  +--> L07 manual update/distribution contract --> L08 single preparation/proof identity ------+--> L06 native runtime proof
  +--> L10 portable custom-env contract --> L11 credential persistence/migration --------------+
                                                                                             |
                                         L05 + L06 + L08 + L11 ------------------------------> L09 physical qualification
                                                                                             |
                                                                                             +--> L12 final release decision/deletion pass
```

L01/L02 edit process/terminal code and are sequential. L03/L04 share lifecycle boundaries and are sequential. L05 follows the safe quit path. L07/L08 share release scripts/manifests and are sequential. L10/L11 are sequential and must reuse the same portable design as the overall track. The credential and release tracks can proceed independently of the process track with explicit file ownership. Coordinate any shared manifest and desktop-entry edits before merging task branches.

If an identical shared fix lands upstream first, merge it and execute only its missing Linux qualification; delete the duplicate implementation task. Upstream acceptance of the overall planning PR is not a gate on this Linux work. Do not fork a second implementation merely to avoid waiting for review.

## 18. Phases and release-state definitions

### Unpacked qualification

A clean exact source builds a Linux x64 unpacked app. Actual packaged-resource/native proof passes through the default utility launcher. On the intended physical native Wayland desktop, window, dialogs, provider/PTY/keyring, lifecycle, preview and performance acceptance pass against the recorded `app.asar` and resource identity. This status **does not prove AppImage launch or deb installation/upgrade**.

### Release candidate

Both final AppImage and deb are built from one recorded clean source and prepared input identity. Exact names/version/arch, embedded provenance, hashes, resources/notices and deb dependencies pass. AppImage launch and installed deb workflows, manual upgrade/downgrade compatibility, cleanup and physical acceptance pass against those exact artifact hashes. Required common product blockers on advertised features are resolved. The candidate remains private/unpublished until release authority approves.

### Shipped release

An authorized publisher approves and publishes the exact qualified artifacts and truthful support/release notes. Downloaded artifact hashes match the approved manifest. Installation and the published manual-update route are verified. Do not call this shipped merely because a branch/PR/build/upload exists. This task grants no publication authority.

| Phase | Entry gate | Tasks | Binary exit gate |
| --- | --- | --- | --- |
| 0: Reconcile | Exact refs and isolated worktree | L00 | Main/other Linux deltas classified; merged source and root baseline recorded |
| 1: Safe ownership | Baseline and conflict decisions fixed | L01–L05 | No unowned termination, duplicate live core owner or false ready/stop; failed cleanup retry works |
| 2: Smaller release contract | Manual Linux v1 decision fixed | L07/L08, L10/L11 in parallel where disjoint | No auto-update channel in Linux distribution; one preparation; secret-safe portable config |
| 3: Unpacked | Clean integrated source | L06 + unpacked parts of L09 | Actual native/default-launcher and physical unpacked evidence passes |
| 4: Candidate | Unpacked qualified, final two artifacts available | Remaining L09 | Both artifact/install/upgrade paths and advertised OS environments pass with exact hashes |
| 5: Decision | All required gates resolved | L12 | Explicit qualified/unqualified decision and limitations; no automatic publishing |

## 19. Atomic implementation cards

### Shared execution rules

Read current AGENTS and rules before changes. Follow merge-not-rebase rules, preserve unrelated work, and keep every implementation on a new branch. All paths below are exact inspected scope or explicitly proposed new tests/results. Extend existing tests rather than create duplicate suites. Run focused feedback first, then `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` at integration. Commands are not evidence until actually executed.

### L00 — Reconcile the three Linux lines with current main

**Priority/confidence:** P0 / High. **Current -> target:** divergent source lines -> documented current Linux implementation baseline. **Scope/inspect:** refs in section 1, AGENTS/rules, complete branch diffs, manifests, changed proc/server/desktop files and main's audit/performance records. **Change:** new isolated implementation branch and `docs/gpt-6-defacto/linux-reconciliation.md`; production conflict resolution only during the later implementation run. **Delete:** no branch, no user work. **Contracts:** Linux support in the same product; all newer main fixes preserved. **Prerequisites:** none.

**Steps:** (1) Fetch current refs and record new SHAs if they advanced. (2) Compute merge-base and direct-tree diffs for main, both release lines and relevant foundation history. (3) Classify every Linux delta as still required, already upstream, superseded, test-only or unknown; unknown is not permission to delete. (4) Create an implementation branch from the chosen candidate and merge current main with an ordinary merge commit. (5) Resolve ordinary process/supervisor/store/orchestrator conflicts using current main structure and portable contracts in L01–L04; port Linux behavior, not old files. (6) Inspect unique `8891956...` work; reproduce required behavior/tests without indiscriminate cherry-picking. (7) Run frozen install/root gates and record failures before subsequent refactors.

**Edges/non-goals:** no wholesale ours/theirs resolution, no source reset, no assumption that a conflict-free merge is semantically correct. If the overall root plan later exists on main, keep this branch's Linux plan for execution; any eventual upstream Linux proposal should retain upstream's root plan and archive this Linux plan under docs rather than silently replace it.

**Acceptance:** each changed subsystem has an explicit reconciliation result; exact integrated SHA known; no unexplained dropped newer behavior. **QA/benchmark:** baseline existing real-Electron scripts where available. **Rollback:** abort only this isolated unresolved merge or revert later bounded changes; never rewrite published history. **Risks:** stale and nonconflicting semantic changes. **Expected simplification:** duplicate work identified, no speculative LOC claim. **Product/performance:** preserve main improvements.

### L01 — Replace obsolete ordinary child APIs with current main's contract

**Priority/confidence:** P0 / High. **Scope/change:** `packages/proc/src/kill.ts`, `index.ts`, `cli.ts`, `jsonrpc.ts` and actual imports in adapters, server preview/custom/background/headless code. **Delete:** `ownProcessTree`/`ownedProcessSpawnOptions`/ordinary `terminateTree` exports only after all ordinary consumers converge. **Preserve:** `spawnOwned`, awaitable/retryable `killTree`, group registration, Windows semantics and bounded framing. **Dependencies:** L00.

**Steps:** (1) Inventory every ordinary child creation and termination call, distinguishing it from native PTY creation. (2) Keep main's `spawnOwned` implementation as the ordinary owner. (3) Convert candidate-only callers to that API, passing argv/env/cwd without shell parsing. (4) Await termination in setup failure, dispose, cancellation and timeout paths where later code assumes quiescence. (5) Keep close-based output settlement and bounded stderr/protocol buffers. (6) Delete zero-consumer old API aliases; do not leave compatibility wrappers just to avoid updating a few imports. (7) Typecheck every adapter consumer, not only proc.

**Edges:** spawn error before PID, child exits before listener, descendants survive leader, failed kill/retry, Windows taskkill failure, final stdout arriving after exit. **Non-goals:** no PTY API merger, generic process manager, new OS service or provider protocol rewrite.

**Tests/commands:** proc, server and changed adapter tests/typechecks; real owned child tree and unrelated sentinel process; root gates. **Acceptance:** zero ordinary consumers of obsolete API, failed termination retained/retryable, no unhandled promise, unrelated process alive. **Rollback:** primitive/callers together after test-owned cleanup. **Risks:** timing and ownership semantics. **Net simplification:** one ordinary API set; LOC measured after deletion. **Performance:** no claimed speedup. **Product:** reliable cancel/dispose across Linux and other platforms.

### L02 — Integrate safe PTY sessions with retryable terminal ownership

**Priority/confidence:** P0 / High. **Scope/change:** Linux PTY portions of `packages/proc/src/kill.ts`, corresponding tests, `apps/server/src/terminal.ts`/tests and checkout cleanup integration. **Delete:** duplicate/permanently failed attempt state, not process identity safeguards. **Preserve:** session/group/start-time/UID checks, failed-stop checkout exclusion, bounded output/retained status and absolute offsets. **Prerequisite:** L01.

**Steps:** (1) Preserve a terminal owner from native spawn until actual exit. (2) Attach Linux PTY session identity when proven; fail conservatively if setup/identity cannot be established. (3) Model one in-flight stop attempt separately from the persistent exit observation; concurrent callers join it, failure permits retry. (4) Use the candidate's conservative session/group termination behavior; preserve safe leader ordering and resume-on-error behavior. (5) Retain owner and checkout guard after timeout/EPERM/unproved cleanup; forbid replacement in that protected checkout. (6) Flush final output and notify exit once when it actually happens. (7) Reset global close-all attempts on rejection without losing individual owners.

**Edges/tests:** shell exits while job remains; foreground/background jobs change PGID; session setup race; PID reused; zombies; malformed procfs; permissions; native kill throws; deadline then late exit; concurrent close; temporarily stopped leader after exception. Assert unrelated same-name process remains alive. **Non-goals:** no blanket negative-PID kill, `pkill`, daemon, cgroup requirement or disabling protections for speed.

**Commands/QA:** proc/server suites; actual Linux PTY job-control fixture and Windows/macOS regression suites for shared changes. **Acceptance:** ten failure/retry cycles leave no owned descendants or duplicate events and never release active checkout protection. **Benchmark:** report cleanup latency/procfs work; do not remove checks to meet an invented microbudget. **Rollback:** retain live owners until cleanup; revert code only after test resources stop. **Impact:** recoverable terminal/quit; net source reduction unknown.

### L03 — Reconcile ready/drain behavior in the reusable server

**Priority/confidence:** P0 / High. **Scope/change:** `apps/server/src/server.ts`, `main.ts`, candidate `shutdown.ts`, readiness/shutdown tests, orchestrator admission/disposal and terminal integration. **Delete:** early textual-ready authority, library process exits and unconditional zero-exit finally. **Preserve:** main's new disposal fences, checkpoint guards, SQLite/read-model behavior and optional lazy services. **Dependencies:** L02 and candidate readiness tests from L00.

**Steps:** (1) Expose `ready` resolving after actual bind and required recovery, with actual port for zero-port fixtures. (2) Reject/clean partially initialized ownership on failure; no ready before required barriers. (3) Make close share an attempt and stop admission before joining pending starts/resumes. (4) Await providers, PTYs and relevant background/checkpoint work; queue empty is not worker idle. (5) Close storage/release lease only after quiescence is established. If a worker remains unproved, retain protection and an actionable blocked shutdown. (6) Permit retry of unfinished idempotent cleanup after failure; never reopen admission implicitly. (7) Entry points determine process policy and preserve failure; a timeout/forced exit is not a clean stop receipt.

**Edges:** EADDRINUSE, recovery rejects after bind, close during startup, repeated signals, late provider startup, failed native close, storage-close failure after work stopped. **Tests:** existing readiness/shutdown/late-disposal regressions, real socket/temporary DB lease contention, concurrent close sharing. **Commands:** server tests/typecheck/root gates.

**Acceptance:** one ready boundary, no worker access after DB closure, no new owner against protected live state, truthful failure. **QA/benchmark:** record startup and shutdown phases; optional provider discovery must not block ready. **Rollback:** entry and server interface together, no DB deletion. **Risks:** partial shutdown remains unusable but must stay visible. **Expected simplification:** one server lifecycle instead of patched per-entry semantics. **Product:** no false “ready” or “stopped.”

### L04 — Await the actual core process and unify native Quit

**Priority/confidence:** P0 / High. **Scope/change:** `apps/desktop/src/server-supervisor.ts`, tests, `main.ts` launch/quit/readiness integration and shared internal message shape. **Delete:** candidate ChildProcess-only replacement, release-before-exit, stdout-control parsing and competing quit attempts. **Preserve:** utility default, legacy fallback while supported, external dev server non-ownership, restart/backoff limits and window state. **Prerequisite:** L03.

**Steps:** (1) Extend current main's wrapper with typed message delivery/listeners and an exit observation, not a new process service. (2) Utility child listens through `process.parentPort`; Node-mode child through Node IPC. Validate normalized payload and generation. (3) Keep child handle/generation until confirmed exit; concurrent stop calls share a promise. (4) On graceful timeout or failed kill, retain ownership and refuse automatic replacement; a later explicit retry can retry unfinished cleanup. Initially retain the candidate's explicit 12 s grace/1.5 s exit-check policy pending measured tuning. (5) Route native menu/app/updater Quit through one guarded attempt, awaiting preview cancellation and core stop. (6) Failure leaves native Retry/Cancel reachable; force exit is explicitly labelled unclean. Cancel does not recreate already-disposed services. (7) Final app quit occurs once after successful cleanup.

**Edges:** stale child messages, malformed receipt, no IPC standalone mode, ready before listener, reentrant Quit, second-instance during stop, error then late exit, updater request during work. **Tests/QA:** both actual launcher modes; fake and real error/late-exit fixtures; native dialog keyboard access; repeated Quit. **Commands:** desktop/server/proc suites, root gates. **Acceptance:** zero duplicate live core generations, no early concurrent-stop success and no invisible failure. **Rollback:** launch/message/supervisor/quit callers together. **Risks:** Electron event reentrancy. **Impact:** one retained owner and one Quit path; startup budget unchanged.

### L05 — Make Linux window lifecycle independent of tray availability

**Priority/confidence:** P1 / Medium incidence, High policy clarity. **Scope/change:** desktop `main.ts`, `background-lifecycle.ts`/tests, `background-tray.ts`/tests only if zero remaining Linux need, `window-presence.ts`/tests and Linux settings/help text. Inspect early desktop identity, application menu and external URL helper. **Delete:** Linux hide-on-close/tray-liveness dependency; remove Linux-only tray creation if unused. **Preserve:** Windows tray and macOS behavior, Linux minimize, correct identity, external http/https policy and second-instance focus. **Prerequisite:** L04.

**Steps:** (1) Make last real Linux window close request shared Quit rather than hide. Hidden preview/capture windows do not count as recovery windows. (2) Ensure cleanup failure keeps a reachable native recovery surface. (3) Keep minimize and second-instance restore distinct from quit. (4) Preserve/set the configured desktop-entry identity before Chromium/portal initialization where required; verify executable/desktop ID agreement rather than invent a new name. (5) Check external URL errors are handled and unsupported schemes denied. (6) Remove obsolete Linux tray branches only after checking other-platform consumers. (7) Document the intentional no-background-after-close v1 policy.

**Edges/QA:** native Wayland with no tray host, tray host present, fractional scaling, minimized window, repeated launch, launch from desktop menu versus shell, capture in flight, active provider/PTY and failed stop. **Tests/commands:** desktop lifecycle/window/URL tests plus actual COSMIC/GNOME behavior and root gates. **Acceptance:** user cannot lose the only reachable app surface while it silently keeps running; non-Linux tests unchanged. **Non-goals:** no close-behavior toggle, host monitor, system daemon or compositor plugin. **Rollback:** restore hiding only with a deliberate supported-recovery policy. **Net simplification:** fewer Linux states and potentially unused tray code. **Performance:** neutral. **Product:** predictable close/minimize.

### L07 — Align manual Linux updates and the distribution manifest

**Priority/confidence:** P1 / High. **Scope/change:** `apps/desktop/src/app-updater.ts`/tests (preserve manual), Linux builder/publish staging config, `tools/scripts/linux-release-evidence.js`, `linux-release-shared.js`, related release tests and Linux release documentation. **Expected delete:** `linux-updater-metadata.js` and `linux-updater-metadata.test.js` only after full consumer search. **Preserve:** Windows/macOS auto-updater, exact binary integrity/provenance, versions/architectures/licenses and general publisher immutability. **Dependency:** L00.

**Steps:** (1) Inventory all imports and distribution/uploader consumers of Linux channel files and blockmaps. (2) Declare the v1 Linux contract manual-only; runtime mode stays `manual`. (3) Inspect pinned electron-builder configuration/types for Linux-only channel suppression. If generation cannot be suppressed, keep sidecars in private build output and curate distribution into a separate allowlisted staging directory. (4) Remove mandatory YAML/channel verification and channel-only parser/helper code. (5) Delete dedicated metadata module/tests after zero surviving consumers. (6) Add tests: Linux manual mode never loads/calls updater; distribution rejects Linux YAML/zip/blockmap sidecars, stale version, wrong arch and unexpected files; both required x64 binaries remain mandatory. (7) Verify the manual download/install action uses the existing approved HTTPS route and clearly explains manual installation.

**Edges:** generic publish settings shared with other OSes, generated AppImage internals versus externally distributed sidecars, stale files left by a prior build, prerelease version names. **Non-goals:** no claim that updater libraries cannot support Linux, no future-channel compatibility framework, no automatic release upload.

**Commands/QA:** release-tool tests, desktop updater tests, pinned builder package generation and manual upgrade in isolated environments. **Acceptance:** runtime and distribution advertise exactly manual updating; eliminated parser has no consumer; binary hashes/provenance still fail on tampering. **Rollback:** restore the update-channel feature and verifier together only under a new qualified policy. **Risks:** hidden publishing consumer. **Simplification:** up to 586 dedicated added lines are deletion candidates; report actual net result. **Performance:** fewer release checks for a nonexistent runtime feature; measure time. **Product:** accurate update expectations.

### L08 — Build once and bind every proof to its inputs

**Priority/confidence:** P1 / High. **Scope/change:** `tools/scripts/linux-acceptance.js`, `build-provenance.js`, `linux-release-evidence.js`, `linux-release-shared.js`, desktop dist scripts/manifest, related Node tests; existing physical result import/export only if identity validation is missing. **Delete:** duplicate build invocation and stale-report acceptance. **Preserve:** frozen install, root gates, clean source, license/native/resource/deb checks. **Dependencies:** L07; coordinate main's portable release-preparation change if already available.

**Steps:** (1) Use one Node entry to prepare clean source, licenses, build and preload, then package the requested targets. Standalone dist invokes the same complete preparation. (2) The combined acceptance run consumes its just-created prepared output in the same invocation; no unchecked public skip-build flag or timestamp cache. (3) Record full source SHA, lock/input identity, target/version and relevant prepared-resource hashes. (4) Verify each final artifact's embedded provenance and SHA-256, and emitted deb dependencies. (5) Ensure automated and physical reports include source, artifact/resource identity, OS/session/desktop, command/result and explicit manual status. (6) Reject report/artifact mismatch, changed version/SHA, stale output, unexpected architecture and partial target set. (7) Keep automated completion distinct from human acceptance; reuse existing reports where they already meet this contract.

**Edges:** docs-only source change still needs precise recorded provenance, dirty worktree, stale preload, parallel outputs, replaced artifact after manual QA, blocked D-Bus. **Tests/commands:** existing Node release/provenance/license/environment tests plus mismatch fixtures; root gates; actual two-target build. **Benchmark:** count one build and record cold/warm total duration. **Acceptance:** all reports identify the actual tested inputs; no status promotion from static proof alone. **Rollback:** revert scripts and rebuild, invalidate old evidence. **Risks:** reuse becoming an unsafe cache. **Simplification:** one preparation owner, separate useful evidence types. **Product:** reproducible qualified candidate.

### L06 — Exercise native functionality through the default packaged utility server

**Priority/confidence:** P0 release gate / High. **Scope/change:** `apps/desktop/src/native-binding-proof.ts`, runner/tests, actual packaged core launcher/proof integration and release proof documentation. **Delete:** fallback-only qualification inference. **Preserve:** Node-mode proof while advertised, profile isolation, existing native package versions and sandbox. **Dependencies:** L03/L04, L08.

**Steps:** (1) Produce an identified unpacked application. (2) Launch its actual desktop/core-server path with disposable HOME-independent app config/data/cache directories, not the user's normal profile. (3) Execute a narrowly authorized/test-only proof request through that core instance, recording utility launch mode and native resolved paths inside packaged resources. (4) Exercise SQLite read/write, PTY spawn/write/read/resize/exit and disposable keyring write/read/delete. (5) Stop through the real lifecycle channel and verify all owned resources are gone. (6) Run the fallback runner separately while supported. (7) Repeat on the final extracted/launched AppImage and installed deb; do not assume unpacked resources prove the installation path.

**Edges:** locked/missing keyring, actual D-Bus session missing, asar resolution accidentally using checkout, node-pty helper not executable, path spaces/non-ASCII, native crash. **Tests/commands:** existing native runner plus actual-launcher proof; desktop/server suites and root gates. **QA:** visible real terminal/credential features in the app after machine proof. **Acceptance:** real native functions pass under the default shipped launcher, cleanup is proven and missing environment is BLOCKED. **Non-goals:** no sandbox disabling, public admin RPC or real user credential. **Rollback:** prior qualified binary, preserved data. **Risks:** native ABI/OS service differences. **Impact:** proof only, no numerical improvement claimed.

### L10 — Define the shared write-only custom environment contract

**Priority/confidence:** P1 / High. **Scope/change:** `packages/contracts/src/domain.ts`, `protocol.ts` and tests; server custom-harness DTO mapping and existing settings editor consumers. **Delete:** raw environment values from normal read results. **Preserve:** provider/command/args/cwd, omission-means-unchanged and existing count/null-byte limits. **Dependencies:** L00; reuse an identical portable upstream/overall implementation if present.

**Target:** public `environmentKeys`; optional write `environmentUpdates: { set: Record<string,string>; unset: string[] }`; server-only keyring-reference metadata. No platform-specific schema branch. Values are write-only; omitted updates preserve them, empty updates do nothing, set/unset overlap rejects. Windows environment-key equivalence is tested separately from Unix case sensitivity.

**Steps:** (1) Enumerate all custom launcher, verifier and background-model consumers. (2) Separate stored, public-read and secret-bearing write types so serializers cannot accidentally return values. (3) Add replacement/removal controls to the existing editor without pre-filling values. (4) Explain that all custom values, including non-secrets, require keyring availability; no inaccurate secret classifier. (5) Add sentinel tests for success and error payloads before persistence migration.

**Edges/tests:** PATH keys/casing, blank valid values, unset absent entry, simultaneous edits, verify-before-save and unsupported native size. **Commands:** contracts/server/web tests and typechecks. **Acceptance:** no sentinel value in read/validation responses; unchanged metadata still round-trips; same contract on all OSes. **Non-goals:** no vendor credential import, separate Linux store or new vault. **Rollback:** only before migration without a reference-capable reader; afterwards retain compatibility. **Risks:** intentional editor behavior change. **Simplification:** no secret/non-secret guesswork or platform schema fork. **Performance:** no speedup. **Product:** safer custom harness setup.

### L11 — Migrate custom environment values into the existing keyring

**Priority/confidence:** P1 / High. **Scope/change:** server `custom-harnesses.ts`, `custom-harness-launch.ts`, narrow strict operations in `credentials.ts`, verifier/background callers and tests. **Delete:** value serialization, plaintext backup/journal, value-bearing errors. **Preserve:** existing keyring service/data paths, launch argv and portable contract. **Dependencies:** L10.

**Steps:** (1) Version metadata and assign server-owned namespaced references per environment key. (2) Stage new references and a small metadata-only recovery record; write/verify keyring values; atomically commit reference metadata; then remove old entries. (3) On restart, compare committed references to the recovery record: committed-new cleans old entries, otherwise clean staged entries and retain old metadata. (4) Apply that process to every old environment value; never erase original config before successful keyring writes. (5) Resolve values only immediately before intended launch/verification; redact known values before truncating child errors. (6) Distinguish missing key from unavailable service and failed deletion; current swallow-all helpers cannot prove cleanup. (7) User-directed harness removal retains retryable reference-only cleanup obligations if native deletion fails.

**Edges/tests:** crash after each boundary, locked Secret Service, native size limit, new credential write fails, atomic rename fails, concurrent launch/save, deletion failure, repeated migration and Unicode/case rules. Sentinel must be absent from config/temp/journal/DB/read DTO/log/argv and present only in intended child environment. **Commands/QA:** server/contracts/root suites, real disposable keyring proof on Linux and cross-platform format tests. **Acceptance:** no plaintext fallback; blocked migration leaves recoverable old config; migration/retry deterministic; no false cleanup success. **Rollback:** use a reference-capable reader, never reconstruct plaintext metadata. **Risks:** OS credential limitations. **Net simplification:** one shared secret primitive; LOC may increase for safety. **Product:** secure custom launch, not a Linux fork.

### L09 — Qualify actual physical and installed Linux workflows

**Priority/confidence:** P0 release gate / High. **Scope/change:** existing physical checklist and source/artifact-bound results, not production code unless sent back to an owning task. **Delete:** ambiguous source-only ready status. **Preserve:** current documented support matrix and user data. **Dependencies:** L05/L06/L08/L11 and required shared blocker fixes.

**Steps:** (1) Capture actual distro/version/kernel/glibc/GPU/session/compositor, D-Bus/keyring availability and installed artifact hash. (2) On physical Pop!_OS COSMIC native Wayland, run the full checklist below; separately qualify advertised Ubuntu 24.04/GNOME. (3) Test unpacked, real AppImage launch and installed deb; extracted AppImage alone does not prove the AppImage runtime. (4) Exercise first run from desktop launcher and shell, second instance, minimize/restore/close, dialogs, file picker, external URLs, scaling/multiple monitors and clipboard. (5) Use configured provider start/approval/stop/restart, custom environment, PTY job control, preview/capture cleanup, checkpoint restore and saved branch flows. (6) Inject port conflict, server crash, keyring lock, failed PTY stop and interrupted migration. (7) Run real performance scripts. (8) Install previous -> candidate manually, confirm data preservation, then uninstall and document intentional retained user data.

**Edges:** test host is not 24.04 or compositor/session differs. Do not edit the qualifier to pass; record exploratory results and add a new supported matrix entry only with its own evidence. XWayland results do not count as native Wayland proof. **Acceptance:** every advertised environment/artifact combination passes required gates with exact identity; any missing physical/resource/account access is BLOCKED. **Commands:** `pnpm acceptance:linux` only if that root script remains the documented entry after reconciliation; otherwise use the exact inspected script command; native/performance/preview verifiers and installer tools. **Rollback:** known qualified artifact, data preserved, no user profile reset. **Risks:** runtime environment differs from mocks. **Impact:** qualification, not code optimization.

### L12 — Final proof, maintenance handoff and deletion challenge

**Priority/confidence:** P0 release decision / High. **Scope/change:** concise final result in existing release documentation and reconciliation ledger. **Delete:** only proven zero-consumer residue left after L01/L05/L07; no extra cleanup campaign. **Dependencies:** all required qualification gates.

**Steps:** (1) Freeze exact integrated source and verify no unreviewed changes after artifact/physical proof. (2) Run root gates and cross-platform regressions again; confirm native proof uses the default launcher. (3) Verify final distribution contains precisely the approved manual Linux files and that all identities match. (4) Record actual LOC/dependency/concept/build changes with counting exclusions; do not call deleted tests a production LOC win. (5) Check there is no Linux-specific backend, schema, process daemon, branding or duplicated provider code. (6) Explain who owns each remaining Linux-specific branch and how to reproduce failures without the original Linux maintainer. (7) List inherited product blockers separately from Linux platform results; do not advertise affected capabilities as qualified when their common security/correctness gates remain open. (8) State unpacked-qualified, RC-qualified or unqualified with reasons. Publication requires separate explicit authority.

**Tests/QA:** verification matrix and physical checklist, exact downloaded-file check only if an authorized publisher later publishes; no publication during this task. **Acceptance:** source/artifact/environment-bound decision, zero unsupported claims, no critical/high unresolved defect on the advertised path. **Rollback:** ordinary revert/previous compatible artifact, no force push or data loss. **Risks:** proof drift and optimistic handoff status. **Net simplification:** one maintainable platform delta with unused contracts removed. **Performance/product:** only measured gains and actually demonstrated workflows reported.

## 20. Verification matrix and physical checklist

| Area | Automated contract | Physical/installed proof | Binary gate |
| --- | --- | --- | --- |
| Source reconciliation | Full branch and consumer diff, root gates | Not applicable | Newer main behavior and required unique Linux tests preserved |
| Ordinary children | Spawn ownership, failed-stop retry, bounded output | Real child tree + unrelated sentinel | Only owned processes stop; no promise ignored where cleanup is required |
| PTY sessions | Setup/identity/retry/late-exit cases | Foreground/background jobs, shell exit, stop failure | No orphan owned job, unrelated signal or premature checkout release |
| Readiness/drain | Deferred bind/recovery, port conflict, late creates, DB lease | Launch/crash/retry/quit during active work | No false ready/clean stop or overlapping core generations |
| Both launchers | Utility payload and Node IPC integration | Default packaged launcher; fallback separately | Native and lifecycle proof names actual launcher |
| Window lifecycle | Last real window, preview exclusions, second-instance state | COSMIC/GNOME, no tray host, minimize/restore, scales/monitors | No hidden unreachable running app |
| URLs/dialogs | Schemes and own-renderer checks | File chooser, external browser/error, Unicode/spaces | Safe navigation and usable native dialogs |
| Keyring/custom env | Sentinel migration/error/readback tests | Real Secret Service save/read/delete, locked service | No plaintext fallback or false cleanup proof |
| Packaging | Exact names/version/arch, provenance/hashes/notices/deb fields | Real AppImage and installed deb | Same approved source; required resources resolve inside artifact |
| Manual updates | No updater load/calls; no channel sidecars in distribution | Manual upgrade retains profile/tasks/settings | No advertised automatic update path |
| Performance | Existing real-component fixtures | Full Electron process memory + native Wayland interaction | Per-OS documented budgets, no forced GC/unload cheating |
| Recovery/data | SQLite restart/checkpoint/queue regressions | Kill/relaunch, saved branch, restore, terminal retained state | No lost work or unsafe automatic resubmission |
| Cross-platform | Desktop/proc/server/web regression suites | Windows/macOS smoke for shared changes | Linux support does not regress other supported platforms |

Each physical result must record tester, time, source SHA, artifact SHA-256/resource hash, exact environment, scenario, actual outcome, sanitized evidence and PASS/FAIL/BLOCKED. Screenshots prove visible behavior, not process cleanup; process inventories prove owned cleanup, not Wayland usability. Both are necessary for their respective claims.

Minimum physical sequence: desktop-menu launch -> first-run setup -> real provider task -> approval -> terminal foreground/background jobs -> minimize/second launch/restore -> preview -> keyring operation -> close during work -> verify cleanup -> relaunch/recovery -> manual upgrade -> uninstall/data-retention check. Inject failure separately, not only a happy-path screenshot tour.

## 21. Migration and rollback strategy

Branch integration is an ordinary merge into an isolated Linux work branch, not a rebase of main or either published Linux line. Shared contract changes land with callers and tests. Keep the root plan track-specific during execution; a future upstream Linux code PR must not accidentally replace an accepted overall root plan.

Lifecycle/process changes do not justify a DB migration. Preserve event decoding, checkpoint refs, user paths and the provider's opaque resume identity. If shutdown is forced, mark it unclean and re-run recovery/ownership checks on restart; do not relabel the previous attempt successful.

Custom environment migration is versioned and one-way with respect to plaintext exposure. Rollback requires a reference-capable reader. Metadata-only recovery records allow cleanup after interrupted keyring/config updates; no raw-value backup file is allowed. Locked/unavailable keyring leaves migration blocked and old data preserved.

Manual-update simplification does not change application data. Previous and candidate binaries must be tested for compatible data handling; uninstall retains data according to product policy. Do not use profile deletion as a recovery or benchmark shortcut. No automatic rollback service is needed.

## 22. Quantified expected impact

| Metric | What is established | Target / limit |
| --- | --- | --- |
| Linux candidate divergence | 18 ahead / 114 behind current reviewed main | Reconciled current source, not a promise to delete 114 commits |
| Product/app/package count | Same 3 apps / 12 packages in current architecture | No increase; no separate Linux product |
| Ordinary process APIs | Main and candidate have different API sets | One current ordinary-child API plus a justified PTY exception |
| Linux update parser/test additions | 329 + 257 = 586 added lines in inspected delta | Candidate deletion only after zero-consumer/manual-policy gate; net production/test counts reported separately |
| Linux update mode | Manual in candidate source | Still manual; runtime/distribution contract agrees |
| Builds in combined acceptance | Build then rebuilding dist preparation | One actual preparation; elapsed savings unknown until measured |
| Default native launcher proof | Existing runner proves Node mode | Actual utility runtime and advertised fallback both qualified |
| Plain custom env values after successful migration | Existing schema can serialize them | Zero values in config/read DTOs/logs/argv; intended child env receives them |
| Native/physical pass count in this audit | Zero executions | No release claim until required matrix passes |
| Whole authored LOC/runtime multiplier | Unmeasured | No 10x/100x numerical claim |

Deleting unused feature machinery is a real simplification; deleting identity guards, tests or physical proof to improve counts is not.

## 23. Risks and unknowns

The candidate's name does not resolve branch ancestry. The latest main may advance again before implementation. Current user worktree and test OS may differ from the remote snapshot and current 24.04 qualifier. Native D-Bus/keyring, portals, graphics driver, AppImage runtime, glibc and installed-path permissions require actual evidence. Utility-process behavior and pinned native packages need testing, not inference from fallback success.

Manual-close and write-only-environment choices intentionally alter UX and must be reflected in release notes. Shared fixes must not create Linux-only schemas. Auto-update metadata may have a hidden general uploader consumer; verify before deletion. Main's inherited diagnostics/provider-policy issues need truthful product-level disposition rather than assuming platform tests settle them. Published-release permissions and external provider terms remain independent of technical readiness.

## 24. Deliberate non-goals

No separate TasteCode, Linux-specific backend, renderer fork, process daemon, systemd dependency, package-manager migration, Rust rewrite, ORM, state-manager replacement, automatic updater, ARM64, musl or additional Linux package formats in v1. No global desktop/tray behavior change on Windows/macOS. No shell initialization for PATH, permissive sandbox flags, global OS security relaxation, secret plaintext fallback, blanket process killing or unreviewed user-data migration.

No repeat implementation of current main's ThreadController, ProviderControls, frame/transport bounds, highlight worker, preview cleanup, checkpoint refs or animation plans. No effort-slider modifications overlapping #1129/#1130. No arbitrary deletion of hidden adapters or the physical checklist. No hosted Actions, public release, repository visibility change or main push from this planning task.

## 25. Final first-principles challenge and handoff

The second pass removed a separate Linux architecture, a universal process manager, a tray-host monitor, a background daemon, a future-only updater parser, a new benchmark platform and duplicate main refactors. PTY session safety survives because deleting it would remove correctness, not accidental complexity. Provenance and physical checks survive because manual updating does not eliminate distribution integrity or native desktop behavior.

The cascading sequence is the simplification: merge current ownership work -> remove older ordinary APIs -> make one stop path truthful -> make one Linux close policy predictable; choose manual updates -> remove channel/blockmap-only contract -> keep a smaller exact-artifact manifest; prepare once -> every proof refers to the same inputs. Credential safety is portable shared work, not a Linux product fork.

A future maintainer should describe the Linux delta as **platform identity/window policy, PTY session safety, two x64 package targets and reproducible physical evidence**. Anything beyond that must earn its place with a current requirement and a test.

### Short implementation-agent prompt

> Read AGENTS/rules and `gpt-6-defacto.md` on `docs/gpt-6-defacto-linux-20260914`. Create an isolated Linux implementation branch; never push main, rebase/force-push or publish. Start with L00: recheck current main and all three Linux lines, because `b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b` was 18 ahead/114 behind `759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9` and was not descended from the other release branch. Preserve newer main code; port Linux behavior instead of copying old files. Execute ready cards in dependency order with narrow commits and real tests. Keep utility-process default, safe PTY identity, manual Linux updates, same TasteCode identity/data/contracts, and no separate Linux product. Report PASS/FAIL/BLOCKED with exact source/artifact/environment. Unpacked qualification is not RC or shipped. Missing physical proof blocks the corresponding release claim; never bypass it with flags or invented results.

### Fixed-source evidence index

L links pin the Linux candidate; M links pin current reviewed main. Future implementation must recheck drift. External primary evidence and fetched blob identities are in section 5. This plan records source observations and proposed work, not executed application validation.

[L01]: https://github.com/Leonxlnx/tastecode/blob/b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b/apps/desktop/package.json
[L02]: https://github.com/Leonxlnx/tastecode/blob/b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b/apps/desktop/src/server-supervisor.ts
[L03]: https://github.com/Leonxlnx/tastecode/blob/b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b/packages/proc/src/kill.ts
[L04]: https://github.com/Leonxlnx/tastecode/blob/b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b/apps/server/src/terminal.ts
[L05]: https://github.com/Leonxlnx/tastecode/blob/b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b/apps/server/src/shutdown.ts
[L06]: https://github.com/Leonxlnx/tastecode/blob/b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b/apps/desktop/src/background-tray.ts
[L07]: https://github.com/Leonxlnx/tastecode/blob/b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b/apps/desktop/src/background-lifecycle.ts
[L08]: https://github.com/Leonxlnx/tastecode/blob/b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b/apps/desktop/scripts/run-native-binding-proof.js
[L09]: https://github.com/Leonxlnx/tastecode/blob/b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b/apps/desktop/src/app-updater.ts
[L10]: https://github.com/Leonxlnx/tastecode/blob/b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b/tools/scripts/linux-release-evidence.js
[L11]: https://github.com/Leonxlnx/tastecode/blob/b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b/tools/scripts/linux-updater-metadata.js
[L12]: https://github.com/Leonxlnx/tastecode/blob/b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b/tools/scripts/linux-updater-metadata.test.js
[L13]: https://github.com/Leonxlnx/tastecode/blob/b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b/tools/scripts/linux-acceptance.js
[L14]: https://github.com/Leonxlnx/tastecode/blob/b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b/tools/scripts/build-provenance.js
[M01]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/desktop/src/main.ts
[M02]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/desktop/src/server-supervisor.ts
[M03]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/packages/proc/src/kill.ts
[M04]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/server/src/terminal.ts
[M05]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/packages/contracts/src/domain.ts
[M06]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/server/src/custom-harnesses.ts
[M07]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/server/src/custom-harness-launch.ts
