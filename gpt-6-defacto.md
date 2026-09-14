# GPT-6 De Facto Repository Transformation Plan

**Track: OVERALL TASTECODE. Planning only.**

Reviewed on 2026-09-14 against `main` at **`759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9`**. The commit is `docs: refresh dashboard after local delivery`, committed at 2026-09-14T16:10:19Z. This plan is not implementation evidence, a production-readiness certificate, or an instruction to merge itself.

Planning branch: `docs/gpt-6-defacto-overall-20260914`. Its proposed target is `main`; maintainers decide whether to accept the proposal. Production changes require later implementation branches and their own verification. Do not push to main, rebase published work, force-push, dispatch hosted Actions, publish releases, or change repository visibility.

The independent [Linux support plan](https://github.com/Leonxlnx/tastecode/blob/docs/gpt-6-defacto-linux-20260914/gpt-6-defacto.md) is based on `feat/linux-release-v1-main` at `b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b`. It is not a second application and is not this proposal's merge dependency. Shared fixes should have one implementation, not two competing copies.

## 0. Executive decision

**Retain the architecture. Finish its ownership boundaries instead of replacing them.** TasteCode already has the appropriate basic shape: a local server owns privileged execution and durable state; Electron owns native presentation and the server process; React consumes a provider-neutral protocol. SQLite, normalized provider events, shared contracts, existing process primitives, and a small desktop shell are justified boundaries.

The strongest remaining transformations are:

1. Replace three different interpretations of “ready/stopped” with one truthful server/process lifecycle. A log line, a successful signal request, and actual quiescence are not interchangeable.
2. Remove plaintext custom-harness environment values from the human-readable configuration and public read DTOs. Reuse the OS credential primitive rather than add another secret manager.
3. Stop treating a general diagnostics toggle as permission to collect and expose unsanitized native crash dumps. Keep bounded text diagnostics; make its privacy claim accurate.
4. Make existing validation and packaging consume one explicitly identified build. Root release-tool tests must not disappear when a workflow chooses recursive package tests.
5. Reconcile documentation, open issues, and release proof with present source. Numerous previous recommendations are already implemented. Repeating them would add churn, not quality.

This is a targeted transformation, not a rewrite. No evidence supports “100x faster,” a 90% source reduction, deleting the provider packages, replacing WebSocket, introducing an ORM, or moving to a different desktop runtime. Success is fewer independent lifecycle authorities and security failure modes, no lost work or unrelated-process termination, reproducible artifact proof, and measured performance without undoing existing optimizations.

**Critical priority ordering:** ownership safety before process consolidation; safety characterization before deletion; secret-safe persistence before exposing new custom-harness configuration flows; current artifacts before release claims. Product polish that overlaps live PRs is outside this plan.

## 1. Repository model

### Product and package boundaries

TasteCode is a local desktop workspace for coding agents. Users select a project and provider, start or resume tasks, review streamed work and approvals, inspect changes, use terminals, and recover history. Custom harnesses reuse known provider protocols. The direct-API implementation is a distinct capability, not a reason to make the entire product depend on a vendor CLI.

The inspected tree has **three application directories** (`apps/desktop`, `apps/server`, `apps/web`) and **twelve package directories**: nine provider adapters plus `contracts`, `design-agent`, and `proc`. These are directory counts, not twelve independently deployed services. The public beta roster and broader/nightly/custom-harness capability are deliberately different. A provider package absent from the default picker is not automatically dead code.

| Owner | Responsibilities | Must not absorb |
| --- | --- | --- |
| `apps/desktop` | Window, narrow native bridge, preview ownership, native diagnostics, updater, owned core-server lifetime | Domain orchestration, provider credentials, another persistence model |
| `apps/server` | RPC authorization/validation, providers, tasks, PTYs, checkouts, history, settings and credential references | React state or presentation-specific session authority |
| `apps/web` | Interaction, rendered snapshots, bounded live deltas, recoverable drafts and connection state | Durable task authority or privileged filesystem access |
| `packages/contracts` | Domain and wire schemas/types | Electron or provider implementation dependencies |
| `packages/proc` | Bounded protocol framing and owned process execution | A new generic application lifecycle framework |
| Provider adapters | Vendor translation, native account/setup behavior and session control | UI callbacks or unrelated provider-specific branches in shared orchestration |
| `packages/design-agent` | Design-specific workflows, loaded on demand | A mandatory startup service |

The stack is TypeScript/Node, pnpm workspaces, React/Vite, Electron/electron-builder, `ws`, Zod, built-in `node:sqlite`, `node-pty`, and OS keyring bindings. The manifests pin pnpm 11.8.0; the root engine is Node >=22.18.0. Read the repository's current Node development guidance rather than silently switching runtimes. Electron is declared as `^43.4.0`, electron-builder as `26.15.3`, and electron-updater as `6.8.9`; those declarations are not proof of the exact installed versions without the lockfile and artifact inventory.

### Critical flows

- **Startup:** desktop applies paths/identity, obtains the single-instance lock, creates its native window and starts the server. The default packaged server now uses `utilityProcess.fork`; a legacy Node-mode launch remains behind `HARNESS_LEGACY_SERVER_PROCESS`. The renderer uses the same typed server transport as the web surface.
- **Task:** renderer request -> validated server method -> checkout/task ownership -> provider adapter -> normalized events -> SQLite event log/read models -> ordered push -> `ThreadController`/frame store -> rendered thread. Provider resume identity is distinct from the TasteCode thread ID.
- **Reconnect:** per-connection sequence gaps trigger reconciliation. Already transmitted mutations can be indeterminate; unsent requests can remain queued. Blindly replaying a sent mutation is not a safe simplification.
- **Terminal:** server owns the native PTY, coalesces output and retains bounded status/output with absolute offsets. Renderer reconnect reads retained state rather than resubmitting installation/login commands.
- **Persistence and recovery:** SQLite owns durable threads, events and projections. Checkpoints have durable Git refs. Checkout guards coordinate destructive operations at the real checkout root. Failed process cleanup must continue protecting the affected checkout.
- **Native preview:** privileged capture has a bounded owner and isolated execution; cancellation and storage/cache cleanup are part of the result. It is not an ordinary untrusted renderer iframe.

Sources: [architecture][S01], [root manifest][S02], [desktop manifest][S03], [server manifest][S04], [web manifest][S05], [desktop entry][S06], [server entry][S07], [server][S08], [store][S09], [transport][S10], [thread controller][S11].

## 2. Evidence and baselines

### Evidence classification

**MEASURED / directly observed from the remote snapshot** means a fetched manifest, tree entry, source expression, or Git comparison. It does not mean code ran. **INFERRED** is an architectural consequence requiring execution to establish incidence or magnitude. **UNKNOWN** is explicitly unmeasured.

| Baseline | Classification | Scope and limitation |
| --- | --- | --- |
| Main source SHA above | Observed | Ref re-read during this audit; later work must check for drift |
| 3 app directories; 12 package directories; 9 provider IDs | Observed | Tree and contracts, not deployed-process count |
| Both `pnpm-lock.yaml` and `bun.lock` are tracked | Observed | Tree sizes 229,985 and 113,559 bytes respectively; not runtime memory or authored source LOC |
| Manual CI uses `pnpm -r test`; root `test` also runs Node release-tool tests | Observed | A real difference in test coverage selection, not a failed CI execution |
| Default desktop core process is a utility process | Observed | `startOwnedServer` / `launchUtilityServer` |
| Main `ServerSupervisor.stop()` is synchronous and discards its handle before exit confirmation | Observed | Runtime frequency/consequences not measured |
| Main server logs listening before the actual bind event; entry exits zero in `finally` after close | Observed | Binding failure and cleanup-failure repros are implementation gates |
| Custom environment values are accepted as strings and serialized with config | Observed | Demonstrates a possible plaintext path, not discovery of actual user credentials |
| Real Electron performance verifier already exists | Observed | Historical report is not a run on this source/OS |
| Whole authored LOC, unused dependency graph, cycles, installed graph sizes | UNKNOWN | No complete local checkout or repository-wide analyzer execution |
| Startup, replay, render, idle CPU/memory, build durations on this source | UNKNOWN | No application benchmark ran in this audit |
| Current signed/installed release behavior on Windows/macOS/Linux | UNKNOWN | Source and unit-test files cannot prove installed behavior |

### Previous work is an input, not a backlog to repeat

[Audit delivery record][S12] reports 19 findings and 9 prevention items delivered on 9 September. Its native validation was macOS arm64, with important Windows, packaged-account and signing limits. Its existence does not establish validation of this new head. Source inspection confirms important changes now exist: `ThreadController`, bounded `ProviderControls` leases, owned process-group cleanup, bounded protocol framing/transport, preview cleanup propagation, durable checkpoint refs and history maintenance.

The [animation plan index][S13] marks plans 001–019 done. The current highlighter has a worker runtime. `Orchestrator.#readHistory` uses a persisted replay snapshot base plus a tail; therefore the older statement “every cold open necessarily parses all historical deltas” must not be copied as a current universal fact. The remaining cost of large completed-history snapshots still needs measurement.

Open issues #996, #1001 and #958 contain older descriptions of transport parsing, preview cleanup and renderer highlighting respectively. Some associated implementation is now present. Do not close these issues automatically: separate **code present**, **contract test present**, and **required physical/artifact proof present**. Issue #1014's custom-environment concern is still supported by the inspected schema/store. Claims in #950 about direct credential-file manipulation are not supported by the fetched current `auth.ts`/`limits.ts`: these now use the Claude CLI/structured SDK path. That does not itself certify provider-policy compliance.

Open PRs #1129 and #1130 cover effort-slider interaction and its stacked compact design. Do not change their files as generic “product improvement,” and do not assume a combined worktree test validates each isolated PR.

### Baseline capture required before implementation

G00 records exact SHA, clean worktree, lockfile hash, OS/arch, Node/pnpm/Electron versions, command exit codes, authored/generated/test line counts separately, direct and transitive dependency inventories separately, and cold/warm build timings. Exclude `.git`, generated `dist`, dependencies, licenses, lockfiles, images and performance-result directories from authored production LOC. Count runtime ownership paths and temporary states as well as lines. A smaller file caused only by moving code does not pass a simplification claim.

## 3. Tool, skill and agent coverage

The GitHub connection permitted source/tree/branch reads, default-branch code search, fixed-SHA file reads, commit comparisons, issues/PR inspection, and branch/document/PR writes. Default-branch search was not used as evidence of Linux-branch absence. Git comparisons were interpreted correctly as merge-base comparisons; ahead/behind counts are not direct-tree patch statistics.

A local container provided Git, Node, Python and text tools. A direct Git remote request failed name resolution. No authenticated full checkout was established. pnpm and the requested coding-agent executables were not available there. No dependency installation, test suite, build, benchmark, runtime reproduction, browser, native Electron or physical desktop test was run. Local static document checks would not substitute for those operations.

The installed plugin catalog and local skill environment were searched. Five relevant guidance tracks were consulted: `react-best-practices`, `verification`, `agent-browser-verify`, `investigation-mode`, and `deep-research`. Browser verification was read as verification guidance, not executed. The investigation guidance was not treated as an instruction to deploy TasteCode on Vercel. There were fewer than five dedicated repository-review skills. **Thermo Nuclear Code Review / the corresponding Cursor skill was not found and was not used.** No callable subagent launcher was available; no parallel agents are claimed.

The missing specialist coverage was supplied by separate, non-redundant audit tracks: architecture/ownership; deletion and abstraction; frontend state/rendering; runtime resources; build/release; correctness/concurrency; security/privacy; tests/evidence; product flows; persistence/recovery; provider/API boundaries; and history/branch archaeology. This is broad source forensics with targeted deep reads, not a claim that every source line or dependency was exhaustively audited.

## 4. Current architecture and sources of complexity

The package graph is mostly justified. The more consequential duplication is **authority duplication**:

- Server bind state, textual readiness, benchmark readiness and renderer reconnect each infer readiness separately.
- `kill()` acceptance, supervisor handle removal, server `close()` completion, PTY exit and checkout-release decisions express different stopping milestones.
- A comment labels environment values non-secret while the runtime schema/persistence accepts arbitrary values.
- Text-log scrubbing is adjacent to raw native dumps, creating an overly broad apparent privacy boundary.
- Root validation, recursive package validation, packaging validation, and manual proof can describe different inputs without making the distinction obvious.
- Historical issue text and dated handoff snapshots can look more authoritative than current source and source-bound proof.

Do not collapse meaningful boundaries to remove these discrepancies. In particular, React snapshots are not duplicates of the durable event log in the same sense as two durable authorities; they are bounded projections. PTY sessions are not ordinary child processes. A provider controls lease is not an obsolete cache merely because another map also contains provider state.

## 5. External architecture comparison

External evidence was checked on 2026-09-14. Comparisons are narrow architectural observations, not claims of equal scale, security or performance.

| Project / primary evidence | Verified observation | Lesson for TasteCode; anti-lesson |
| --- | --- | --- |
| [T3 Code internals](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md), fetched content blob `6ca41871679aaa83465050ac72f1efa5d14923b7` | The execution environment owns files, providers, terminals and credentials. Event/receipt/projection persistence precedes side effects. Client sharing serves its web/mobile/multi-environment requirements. | Preserve server ownership and truthful drain milestones. Do not import its additional client-runtime, remote compatibility or orchestration layering without those requirements. |
| [OpenCode server documentation](https://opencode.ai/docs/server/) | A headless server serves clients; its OpenAPI schema generates the SDK; a health endpoint exposes status/version. | TasteCode's existing server/client separation is an asset. A small lifecycle contract is useful; replacing typed WebSocket with HTTP/SSE would be a migration, not an established improvement. |
| [VS Code utility-process owner](https://github.com/microsoft/vscode/blob/main/src/vs/platform/utilityProcess/electron-main/utilityProcess.ts), fetched content blob `c1dd46b4c1771f1b59bda15b78198085f63b5155`, `registerListeners`, `postMessage`, `kill` | Spawn, messages, exit, crash and stream decoding have explicit handling. | Inspect distinct milestones rather than infer them from strings. Do not copy its service/telemetry/disposable framework, or assume its kill contract proves TasteCode's domain workers drained. |

[Electron utility-process documentation](https://www.electronjs.org/docs/latest/api/utility-process) and [parentPort documentation](https://www.electronjs.org/docs/latest/api/parent-port) establish that the utility child receives messages through `process.parentPort` with a message-event payload, unlike Node child IPC. Kill returns a boolean, not a domain shutdown receipt. Implement and test the exact pinned runtime; do not silently apply newer package defaults.

These comparisons strengthen the existing ownership architecture. They do not justify a framework migration or a new service.

## 6. Master findings

### Prioritized index

| ID | Category | Severity / confidence | Impact | Effort | Prerequisites / tasks |
| --- | --- | --- | --- | --- | --- |
| F01 | Readiness and shutdown correctness | High / High source, unmeasured incidence | Remove false-ready and false-clean-success states | Medium | G00 -> G01/G02 |
| F02 | Desktop process ownership | High / High | Retain an owner until exit; integrate current utility runtime | Medium | G02 -> G03/G04 |
| F03 | PTY failure recovery | High / High | Retry failed stop without releasing checkout protection | Medium | G00 -> G05 -> G02 |
| F04 | Custom-harness privacy | High / High | Remove an actual plaintext persistence/readback path | Medium-high | G00 -> G06 -> G07 |
| F05 | Diagnostics privacy/retention | Medium / High source | Remove false scrubbed-dump implication and bound text writes | Small-medium | G00 -> G08 |
| F06 | Validation/build divergence | Medium / High | Same contracts and source identity in local/manual/artifact verification | Small-medium | G00 -> G09 |
| F07 | Proof differs from default runtime | High release gate / High | Do not ship on a Node-mode-only native proof | Medium | G01–G05, G09 -> G10 |
| F08 | Redundant configuration and stale authority | Medium / High drift; Low dead-consumer confidence | Fewer competing instructions/locks, no repeated completed work | Small | G00 -> G11 |
| F09 | Performance evidence boundary | Medium / High | Preserve measured optimizations; identify remaining structural bottlenecks honestly | Bounded investigation | G00 -> G12; no speculative rewrite |

### F01 — Truthful server lifecycle

**Evidence:** [server entry][S07], signal handlers; [server][S08], server creation, listening log and `close`. Main announces listening before the bind event. The signal handler uses `server.close().finally(() => process.exit(0))`. Library-level socket failure calls process exit. Close currently finalizes storage/lease in a `finally` path even when owned cleanup rejects.

**Problem/root cause:** lifecycle responsibility crosses the reusable server, CLI entry and desktop without one explicit contract. Failure can look like successful shutdown; readiness is textual rather than a bind/recovery boundary.

**Target:** one `ready` promise and one shared close attempt. Readiness follows actual binding plus required recovery. Shutdown rejects new work, settles existing owned work, and releases durable resources only once quiescence is established. Entry points decide their process policy; the reusable server never unconditionally terminates its host.

**Delete/change/add:** delete pre-bind readiness authority, successful-finally exit, and library process exits. Add a small typed lifecycle result, not a framework. Preserve all wire/domain behavior, existing leases and failed-stop checkout guards. Intentional behavior change: failures surface as failures and may leave the app in a blocked recovery state rather than claiming it stopped.

**Impact:** fewer independent lifecycle interpretations; LOC unknown and may initially grow. No latency improvement claimed. Risks: shutdown hangs, partial initialization, double disposal, hidden work after a timeout. Verify late bind, EADDRINUSE, close-during-start, concurrent close, cleanup failure/retry and no worker access after storage closure. Roll back the isolated lifecycle commits only after verifying no replacement process has been started against an unclean owner. **Priority P0 for lifecycle correctness, not a claim of an exploited critical vulnerability.**

### F02 — Supervisor completion is not signal acceptance

**Evidence:** [main supervisor][S14], `stop`; [desktop entry][S06], `startOwnedServer` and `launchUtilityServer`. Main supports the new utility-process launcher but stop returns before physical exit and releases its handle. Linux has an older asynchronous ChildProcess-only implementation; copying that class over main would regress the new launch path.

**Target:** extend the existing minimal process wrapper with typed messaging and exit observation. Concurrent stops share one attempt. Keep the handle and generation until confirmed exit. Preserve backoff/max-restart/healthy-reset behavior, both launch modes and development-server non-ownership. Never start a replacement while an old generation is unresolved.

**Delete:** readiness recognition through stdout and duplicate shutdown adapters after reconciliation. **Add:** only ready/stopping/failure notifications necessary for truthful ownership. **Behavior change:** Quit waits; failed cleanup offers retry/cancel or explicit force, not a silent restart. Complexity decreases by merging authorities, not by erasing states that distinguish live from dead. Performance must preserve startup budgets. Tests cover both IPC transports, split log chunks, old-generation callbacks, failed kill and repeated Quit. Roll back the supervisor and its callers together. **Priority P0, High confidence.**

### F03 — Failed PTY stop cannot be a permanently cached attempt

**Evidence:** [terminal owner][S15], `close`, `closeThread`, `closeAll`, closing maps. Current code protects checkouts while waiting for real exit, which is good. But the active record is removed after requesting kill and `closeAll` retains its rejected promise, preventing a genuinely fresh cleanup attempt.

**Target:** separate a retained PTY owner/exit promise from a retryable stop attempt. Keep the native handle available until exit, re-attempt bounded termination after failure, and preserve checkout exclusion. Ordinary child groups and PTY job sessions remain different execution primitives.

**Delete:** the permanently rejected global-close cache and owner-dropping transitions. **Preserve:** 4 ms batching, bounded tail/status retention, absolute output offsets, final output and exactly one exit notification. No automatic command replay, no blanket `pkill`, no reused-PID signalling. LOC impact unknown. Verify kill throws, no exit before deadline, later exit, retry, concurrent close, tail flush and protected worktree operations. No runtime speedup claimed; product improvement is recoverable Stop/Quit. Roll back without clearing protection for a still-live PTY. **Priority P0, High confidence.**

### F04 — Arbitrary custom environment values are not non-secret by declaration

**Evidence:** [domain schema][S16], `CustomHarnessSchema.environment`; [custom store][S17], `#write`; [custom launch][S18], `launchEnvironment`/`runCustomHarness`; [credentials][S19]. Arbitrary values are accepted and serialized into config; errors can contain child output. File mode 0600 is valuable but does not make plaintext a credential reference.

**Target decision:** persist all custom environment **values** through the existing OS credential store, not a classifier that guesses which values are secrets. Keep the human-readable executable/argv/cwd metadata, environment key names and server-owned references only. Public reads return configured key names, never values. Updates are explicit set/unset operations; omitted values mean unchanged. This intentionally changes the environment editor to write-only values and may require unlocking the keyring even for non-secret custom settings. That tradeoff is deliberate and must be disclosed.

**Delete:** arbitrary environment values from config serialization and public read DTOs, secret-bearing error details, ambiguous secret/non-secret classification. **Add:** narrow schema/persistence migration and credential bindings, reusing `readCredential`/`writeCredential`; do not rename the existing `PersonalHarness` keyring service. Preserve non-secret environment functionality, argv separation and custom executable selection. Existing command/argv strings remain user-controlled and must explicitly warn against embedding credentials; this task does not claim it can detect every arbitrary secret in arbitrary text.

**Migration:** staged credential writes, atomic metadata commit, reference-only recovery journal; never write plaintext backups. Locked/unavailable keyring blocks affected launch/migration instead of falling back to plaintext. Rollback may restore old application code only if it can read the migrated reference format, otherwise retain the new reader; never downgrade references into plaintext. Sentinel tests across disk, reads, logs, argv, child environment, restart and deletion prove the result. Expected source size can increase; eliminated exposure is the benefit. **Priority P1, High confidence.**

### F05 — Diagnostics must not imply a binary dump is scrubbed

**Evidence:** [LocalDiagnostics][S20], `record` and `setEnabled`; [desktop entry][S06], diagnostics initialization sets `crashDumps` to the diagnostics directory and starts `crashReporter`. The text scrubber only transforms strings; toggling the preference off does not undo an already-started reporter. Independent stat/append operations are not a strict aggregate byte bound under concurrent writes.

**Target decision:** general diagnostics is bounded, serialized, redacted text only. Remove automatic native crash-dump activation from that preference. Keep old dumps outside the directory opened/exported as sanitized diagnostics; disclose that existing raw files may remain and require explicit user deletion. No dump scrubber, upload service or new telemetry dependency.

**Preserved:** local opt-in text errors, actionable diagnostics and normal application behavior. **Intentional change:** native dump collection is no longer implicitly enabled by the general toggle. This needs maintainer acceptance because it trades native crash detail for a simpler privacy contract. Serialize bounded text writes, truncate before append, and ensure disabling prevents queued later writes. Verify concurrent floods, disable/re-enable, private directory permissions, injected native failure and previous-dump migration. Rollback must not re-enable raw collection under an old consent without review. **Priority P1, Medium severity, High source confidence.**

### F06 — One command-level validation contract and one identified build

**Evidence:** [root manifest][S02], root tests; [manual CI][S21], recursive tests; [desktop manifest][S03], dist builds; [Linux acceptance][L01], full build followed by a dist script that builds again. The duplicate Linux build is observed; its elapsed cost is unknown. Main's independent dist entry point should remain self-contained.

**Target:** root commands define required validation. Manual CI calls the root test command without enabling automatic workflows. A single-process release-preparation path builds once and passes that build directly into packaging/proof, recording its source and input identity. Standalone dist still prepares its own inputs. Do not introduce a user-controlled skip-check flag or trust a timestamp-only cache.

**Delete:** repeated build invocation within the same acceptance pipeline and alternate incomplete test selection. Preserve license checks, native proof and exact artifact checks. No monorepo build orchestrator or new cache service. Verify root-test failure fails manual command selection, changed source cannot reuse old preparation, and isolated dist still builds. Benchmark cold/warm pipelines, not just `tsc`. Rollback scripts together; never reuse now-unidentified artifacts. **Priority P1, High confidence.**

### F07 — Proof must exercise the default shipped runtime

**Evidence:** [native proof runner][L02] launches the packaged executable with `ELECTRON_RUN_AS_NODE=1`; [main desktop entry][S06] defaults to a utility process. A native module loading in one launch mode is not proof of the normal app path, its shutdown messaging, permissions or packaging resolution.

**Target:** final artifact proof launches the real packaged application/core-server path in an isolated profile and exercises real SQLite, PTY and disposable OS credentials. Retain Node-mode proof only while that fallback remains supported. Artifact hashes, source provenance, OS/arch and launcher identity accompany every result. No source-tree fallback, no public credential use, no “pass” from a unit mock.

**Delete:** inference that Node-mode-only proof qualifies the normal app. No new product service is required. Verify native module resolution inside packaged resources, PTY I/O/resize/exit, keyring save/read/delete, server readiness and shutdown; then manual installed-app flows. Rollback means reverting the binary and preserving user data, not claiming old proof validates a new binary. **Priority P0 as a release gate; implementation follows lifecycle work.**

### F08 — Remove stale authority and only proven redundant tooling

**Evidence:** root contains both lockfiles and a `rustfmt.toml` while current production is TypeScript; prior Bun work and archived Rust work explain possible history. [Architecture][S01] contains older directory references; [audit record][S12], [animation index][S13] and dated HANDOFF contain different kinds of evidence.

**Target:** current architecture describes the actual tree; historical reports remain explicitly historical. Reconcile issue acceptance criteria with implementation and unresolved proof. The root `packageManager`/frozen pnpm graph remains authoritative. Delete `bun.lock` and `rustfmt.toml` only after full tracked-consumer and history checks show they are not part of a supported workflow. If a supported consumer exists, retain and document it rather than deleting on appearance.

Do not delete Bun support for user projects, provider install commands or preview tools. Do not remove adapters hidden from the beta picker, native fallback launch, compatibility decoders, Linux physical checklist, lockfiles' license records, or generated attribution to improve a LOC score. Documentation simplification has no claimed runtime speedup. **Priority P2; exact deletion requires G11's binary consumer gate.**

### F09 — Qualify existing performance work before inventing another system

**Evidence:** [performance instructions][S22], `ThreadController`, [PushBus][S23], worker highlighter, replay snapshot path, lazy provider/design imports and completed animation work. The reviewed architecture already attacks major streaming/startup costs.

**Target:** use the existing real-Electron gate, add only missing adversarial fixtures, and measure cold persisted-history access separately from warm replay. Preserve existing optimizations unless a like-for-like experiment demonstrates an improvement. Pagination, a worker for SQLite, changing the protocol, or deleting fast validators is **not authorized by this finding alone**.

G12 is a bounded qualification task. It must either record passing budgets with no production change, or produce a specific measured follow-up identifying the hottest operation and an approved acceptance bound. No unbounded “optimize performance” implementation card is hidden here. **Priority P2; High confidence in the evidence gap, no quantified speedup.**

## 7. Deletion ledger

| Candidate deletion | Why it can disappear | Prerequisite | Explicit protection |
| --- | --- | --- | --- |
| Readiness inferred from log text | A typed ready receipt and actual bind own it | G01/G03 | Human-readable logs may remain |
| Zero-success exit in a close `finally` | Failure must remain failure | G02 | Successful exit semantics remain |
| Supervisor handle removal before confirmed exit | Owner persists through stop | G03 | Keep restart limits/backoff |
| Permanently rejected PTY close attempt | Attempts can retry; physical exit is separate | G05 | Never release an occupied checkout |
| Plain custom environment values in JSON/public reads | Server credential references replace them | G06/G07 | Preserve keys, command/cwd/argv and launch values |
| Automatic raw crash reporting under general diagnostics | Text-only consent is explainable | G08 + maintainer acceptance | Preserve private old files unless user explicitly deletes |
| Incomplete recursive-only CI test selection | Root command owns coverage | G09 | Workflow stays manual |
| Second build in one Linux acceptance run | One identified preparation owns artifacts | G09, Linux equivalent | Standalone dist still prepares itself |
| Current-looking references to absent architecture directories | Actual tree owns the model | G11 | Preserve historical record, not duplicated current authority |
| Root `bun.lock`, `rustfmt.toml` | Possible obsolete tool-specific state | G11 consumer/history gate | No automatic deletion; no loss of user-project Bun support |
| Older Linux ordinary-process API after integration | Current `spawnOwned`/async `killTree` owns ordinary children | Linux reconciliation | Preserve PTY session/generation safety |

No entire application or provider package is approved for deletion. There is no measured production LOC reduction estimate.

## 8. DRY and duplication elimination

DRY here means one authority per contract, not one helper per vaguely similar operation. Use the existing `packages/proc` primitives for ordinary owned processes. Keep terminal session identity separate. Keep one server lifecycle promise rather than matching strings in multiple callers. Reuse OS credentials and existing atomic configuration patterns. Route all required root tests through one entry command. Let one build identity flow to package/proof reports.

Do not unify unrelated permission decisions merely because they both accept a URL or path. Preview navigation, OS external opening, trusted renderer identity, API workspace access and provider consent have different trust boundaries. Do not merge different provider protocols into a universal adapter with many mode flags.

## 9. Target architecture

```text
Native shell                           React/web client
  window + narrow IPC                    Transport + ThreadController
  one core-process owner                 bounded projections / live frame store
            |                                       |
            +-- typed ready/stop channel            +-- existing typed WS
            |                                       |
            +--------------- local server ----------+
                               |
                request admission + owned task lifetimes
                    /          |          \
              adapters       PTYs       preview/design work
                    \          |          /
                    durable events + checkout guards
                               |
                      SQLite + Git refs

Custom executable metadata -> credential references -> OS keyring
                                                      |
                                         launch-only environment materialization
```

The server's lifecycle is small and explicit: starting -> ready -> stopping -> stopped, with a failed stop retaining ownership and admitting no new work. These are operational states, not new persisted domain states. A successful stop requires owned work to be quiescent; a deadline is not quiescence. After a partial shutdown, “cancel quit” keeps the native recovery surface, not a promise that already-disposed services are usable.

Use no new runtime package. A small internal process-message type may live in `packages/proc`; it is not another public RPC layer. The renderer's existing connection model stays intact.

## 10. Architecture delta

| Current | Target | What stays the same |
| --- | --- | --- |
| Log text + socket + process spawn imply readiness | Bound/recovered server sends one ready receipt | Startup overlap and lazy code loading |
| Stop request can release the handle immediately | Stop attempt retains owner and awaits exit | Existing process groups, deadlines and restart policy |
| Terminal owner partly replaced by a closing promise | Native identity persists; failed attempt is retryable | Output/status recovery and checkout exclusion |
| Config stores arbitrary environment values | Metadata and keyring references only | User-selected executable and protocol arguments |
| General diagnostics includes raw crash-dump directory | General diagnostics is text-only and bounded | Local opt-in, no required telemetry service |
| Validation entry points choose different test sets | Root command is the coverage contract | Manual hosted workflows |
| Proof can target a different launch mode | Proof records/exercises the actual shipped launcher | Existing native and Electron fixtures |

## 11. Performance transformation

### Measurement discipline

Run the same source fixture, production build, machine, power state, profile and provider stubs before/after. Record warm/cold distinction and all samples. Keep OS/arch-specific results separate. The existing native gate's three runs are its minimum; a before/after claim should additionally use at least ten alternated samples for the targeted metric, publish medians/p95 and noise, and avoid comparing a quiet baseline with an overloaded candidate.

| Area | Suspected or observed cost | Mechanism / planned action | Benchmark and success threshold | Risks |
| --- | --- | --- | --- | --- |
| Lifecycle | Repeated restart/reconnect and ambiguous shutdown | Delete false-ready/replacement-owner paths | 100 injected lifecycle cycles: no duplicate live owner, no false ready, no acknowledged clean stop with remaining owned work | More truthful failures may initially look slower |
| Startup | Already optimized utility launch, bundled local shell, lazy features | Preserve; typed ready must not serialize optional discovery | Existing <1.5 s cold-start target remains; report startup milestones separately | Waiting for every provider would regress startup |
| Streaming/render | Existing frame batching, virtualization, worker highlighting | Qualify, do not rewrite | 500-message fixture; first paint <150 ms, delta work <4 ms, no scroll frame >32 ms; use existing gate definitions | Test fixture must mount real components |
| Switching/history | Large completed history may still scale despite persisted replay snapshots | G12 measures cold DB replay, snapshot decode and wire bytes separately | Existing <100 ms switch target for gate fixture; additionally report 10k/100k-event cold histories without assuming they pass | Pagination changes scroll/replay semantics and is a separate decision |
| Idle resources | Multiple task stores, provider controls and retained histories | Preserve idle eviction and leases | Existing stable full-app <500,000,000-byte memory gate; no missing process samples | Forced GC/unloading would invalidate comparison |
| Build/acceptance | Duplicate build invocation in Linux pipeline | Build once and reuse within the same trusted preparation | One actual build invocation per acceptance run; unchanged gates/artifact contents; report elapsed time before/after | Unsafe stale-build reuse |
| Developer loop | Root vs package commands/duplicate tool state | One documented command set; conditional obsolete-lock deletion | Fresh clone and incremental cycle both work with frozen pnpm lock; no unexplained dependency drift | Optional workflows may still consume the second lock |
| Operations | Native failure not represented by source tests | Actual packaged-launcher proof and explicit recovery | Zero owned-process/credential-test leftovers after proof; no user-profile mutation | OS service availability is a BLOCKED result, not PASS |

The documented budgets are **targets inherited from repository architecture**, not measurements from this audit. No new cache, global state manager, custom incremental compiler, distributed queue or database worker is approved without measurements showing why the simpler existing path cannot meet its requirement.

## 12. Product transformation

### A. Behavior-preserving

Preserve provider selection, configured project branches, retained terminal output, restart recovery, approvals, diff/checkpoint semantics, keyboard behavior, themes, reduced motion and bounded streaming. Readiness must not wait for optional model catalogs or Design. A setup failure should remain localized to the provider/feature that failed.

### B. Intentional product changes in this proposal

- Startup/quit failures become actionable and truthful. A native recovery surface distinguishes “could not start,” “stopping,” and “could not confirm cleanup”; it never tells the user to reinstall for every recoverable port/permission error.
- Custom environment values become write-only credential-backed inputs; configured keys remain visible, values do not return through normal reads. Explain locked-keyring recovery without suggesting plaintext files or argv.
- General diagnostics promises bounded text logs only. Old raw dumps are not relabeled scrubbed.

These are separate acceptance decisions, not hidden refactors. They reuse existing native dialogs, notices and settings patterns; no new dashboard is required.

### C. Deliberately speculative / not implementation-authorized

A new task-status dashboard, activity analytics (#25), remote/mobile support, a new provider onboarding wizard and new direct-API context features may have product value. None is necessary to fix the verified issues above. Their product demand and branch scope must be established separately. Do not launch parked API features merely to make this plan appear ambitious.

## 13. Reliability, security and correctness

Trust boundaries remain the renderer/native bridge, server socket, user workspace, provider subprocess, keyring and preview guest. Preserve Origin/auth checks, canonical path policy, redaction-before-truncation, approval identity, isolated previews, CSP and process ownership. Never signal arbitrary PIDs from a stale report, scan-and-kill by executable name, disable Chromium sandboxing, or run user shell initialization to discover PATH.

For credentials, do not turn `hasCredential` returning false on any native error into permission to overwrite/delete or fall back. Add a narrow result that distinguishes absent from unavailable where a migration requires it. Likewise, current `removeCredential` swallows all errors; deletion/migration proof cannot claim successful removal merely because that helper returned. Preserve backward compatibility for its existing callers while introducing strict failure reporting only where needed. Clear reference ownership only after verified cleanup or a recorded, retryable metadata-only cleanup obligation.

For shutdown, a rejected worker-disposal attempt does not establish that SQLite can no longer be accessed. Retain admission fences and checkout ownership across failure. Ensure every non-idempotent operation has either its existing receipt/idempotency behavior or an explicit indeterminate result; never add automatic mutation retries as a cleanup convenience.

For provider terms, [current Claude guidance](https://code.claude.com/docs/en/legal-and-compliance) distinguishes third-party API/SDK integrations from an end user's authentication in an unmodified Claude Code binary, and restricts credential intermediation. Current source uses CLI auth and a structured SDK usage path. G13 must document the exact shipped mode and obtain the appropriate maintainer/legal release decision. This is not a blanket assertion that all subscription use is forbidden, or that current code is legally approved.

## 14. Testing and QA architecture

Keep tests at observable contract boundaries. Existing focused unit tests and regression suites protecting checkout guards, replay, limits, native capture and provider errors are valuable. Do not delete them merely because an implementation changes. Replace tests asserting obsolete helper internals only after equivalent behavior coverage exists.

**Required layers:** pure validators/message parsing; lifecycle state tests with deterministic deferred work; real local socket/process/PTY integration; SQLite restart/migration tests with temporary databases; public contract parity; production renderer interactions; real packaged native proof; installed-app/manual OS behavior. A mock PTY cannot prove process-group termination, and a DOM fixture cannot prove Wayland activation or native permissions.

Fixtures use temporary profiles, distinct ports, disposable credential references and test-owned process identities. Never the user's actual TasteCode database or provider accounts. Record owned resource identities before testing, verify cleanup afterwards, and treat a missing keyring/display/native dependency as BLOCKED. A new codebase-wide analyzer may produce an inventory, but no analyzer recommendation is automatically a deletion approval.

## 15. Dependency, tooling and configuration simplification

Keep pnpm and TypeScript project references. Keep built-in SQLite rather than add an ORM/native database driver. Keep Zod at trust boundaries and the tested fast-validation path where justified. Keep electron-builder/native prebuild policy until exact artifacts prove a change is needed; `npmRebuild: false` is not by itself a defect.

No production dependency additions are expected for G01–G11. OS credentials already exist. Serialize diagnostics with a small promise chain, not a logging framework. Store lifecycle messages in one existing package, not a new workspace. Do not collapse all nine adapters into one file or all server modules into the entry point.

Manual CI's Node version, root engine and development documentation should be reconciled against an explicit tested matrix, not blanket upgraded during this work. License inventory must follow the actual packaged graph, including native platform binaries; do not treat the root manifest as the whole distribution graph.

## 16. Suspicious-looking code that should not be changed

- `ThreadController` maps protect different in-flight/history/queue lifetimes. Fewer maps alone is not a correctness argument.
- Fast validators and canonical schemas deliberately coexist with parity checks. Remove neither before a benchmark and boundary-coverage proof.
- Persisted replay snapshots/read models are reconstructible performance projections, not competing durable authorities.
- `PushBus` reuses serialized events and has one-renderer fast paths. Do not normalize these away for aesthetic symmetry.
- Idle provider leases, lazy Design loading, highlight workers and warmed resolved components already solve real cost.
- Durable checkpoint refs, real-checkout guards, provider resume IDs and failure-retained ownership are essential recovery state.
- PTY identity/session safeguards must not be replaced by ordinary `child.kill()`.
- Hidden provider packages can serve nightly/custom harnesses. Absence from the beta picker is insufficient deletion evidence.
- The legacy server launcher stays until fallback users and native proof are evaluated. “Legacy” is not synonymous with unused.
- `PersonalHarness` keyring service and `TasteCode` data directories preserve existing user data. Do not rename them with the visible product name.
- Existing preview cancellation/cleanup and reduced-motion behavior are protected, as are #1129/#1130's active scope.

## 17. Implementation dependency graph

```text
G00 baseline/source fence
  +--> G01 truthful readiness -------------------------+
  +--> G05 PTY retry/ownership --> G02 server drain ----+--> G03 supervisor --> G04 quit/recovery
  +--> G06 custom-env contract --> G07 persistence -----+
  +--> G08 diagnostics --------------------------------+
  +--> G09 validation/build ---------------------------+--> G10 packaged proof
  +--> G11 authority/tooling cleanup                   |
  +--> G12 performance qualification ------------------+--> G13 final cross-platform decision
```

G01 and G02 both edit the server lifecycle: implement G01 first, then G02 after G05's ownership contract. G03/G04 share desktop entry/supervisor; do not edit them concurrently. G06/G07 are serial, with the contract change reviewed separately. G08 can run independently except its small desktop-entry integration must land before G04's final integration tests. G09 is independent but coordinate manifest edits with any dependency change. G11 must not delete a file an active task still consumes.

A cheaper-agent coordinator should give each independent task one branch and explicit file ownership. Re-measure after G03/G04 and G09. Do not split generic “review everything” agents across identical scopes.

## 18. Implementation phases and binary gates

| Phase | Entry gate | Work | Exit gate |
| --- | --- | --- | --- |
| 0: Source and baseline | Exact current head, instructions and live PR scope captured | G00 | Baseline file records commands and explicit PASS/FAIL/BLOCKED; no unexplained dirty work |
| 1: Ownership | Baseline exists; no production release claim | G01, G05, G02, G03, G04 in graph order | All lifecycle scenarios pass on real local processes; old owner cannot overlap replacement |
| 2: Privacy | Contract review agrees on intentional changes | G06/G07, G08 | No sentinel values in config/read DTOs/logs/argv; failed migration leaves recoverable state; diagnostics claim matches contents |
| 3: Delivery simplicity | Ownership and privacy branches integrated without unrelated overwrites | G09, G11 | Root gate coverage preserved; one preparation per acceptance; conditional deletions have consumer proof |
| 4: Artifact and performance | Clean exact source, known build identity | G10, G12 | Real packaged runtime proof plus per-OS performance results; unknowns remain visibly blocked |
| 5: Acceptance | All required previous gates resolved | G13 | Cross-platform/manual/product/security decision recorded; no release publication is automatic |

A failed gate stops dependent work but not independent investigation. It does not authorize bypassing tests, disabling a feature silently, or expanding the task into a rewrite.

## 19. Atomic implementation cards

### Common execution contract

Each card's “no deletion” means no additional file is approved for removal beyond explicitly named concepts. All new test filenames below are **proposed**, not asserted to exist. Discover current equivalents and extend them rather than duplicate suites. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` are the final required root commands; focused package commands below shorten feedback but do not replace root gates. Rollbacks are ordinary revert commits, never force-push or user-data deletion. No task dispatches hosted Actions.

### G00 — Freeze the source and capture a reproducible baseline

**Priority/confidence:** P0 / High. **Rationale/current -> target:** remote source analysis becomes a local, repeatable starting point without pretending prior macOS evidence validates this head.

**Scope/inspect:** AGENTS, rules, root/package manifests, lockfile, manual workflows, architecture, audit/performance documents, current PRs and history. **Change:** only `docs/gpt-6-defacto/baseline.md` and a minimal fixture/report runner only if existing scripts cannot capture the required metric. **Delete:** none. **Contracts:** no user files, account state, runtime behavior or release permissions change. **Dependencies:** none.

**Steps:** (1) Fetch refs, record HEAD/base and clean status; merge an advanced target according to repository rules, never rebase published work. (2) Establish the declared package manager/runtime. (3) Run frozen installation, then each root gate independently and retain exit codes. (4) Count authored production/tests/generated content separately using tracked files; enumerate dependency consumers and existing benchmark entry points. (5) Run existing performance fixtures with isolated profiles; capture cold/warm build durations and process identities. (6) Record hardware/OS/version, source/lock hashes, missing capabilities and failure reproduction commands.

**Edges/non-goals:** dirty unrelated work requires a separate worktree, not reset/stash of someone else's changes. No failed-install workaround using a different lock manager. No claim that unavailable native services passed.

**Tests/commands/QA:** root gates; existing `verify-performance.js 3` and `verify-preview.js` on supported native machines. **Acceptance:** every baseline has exact input identity and explicit outcome; no application change. **Rollback/risks:** remove only generated test resources; do not remove evidence of failures. **Expected net simplification:** one baseline, not new infrastructure. **Performance/product impact:** measurement only.

### G01 — Expose actual server readiness

**Priority/confidence:** P0 / High. **Current -> target:** pre-bind log/constructor success -> bound and mandatory-recovery-complete `ready` promise.

**Scope/inspect/change:** `apps/server/src/server.ts`, `apps/server/src/main.ts`, current readiness/integration tests; propose `apps/server/src/server-readiness.test.ts` only if absent. Inspect recovery initialization and data-lease acquisition. **Delete:** early ready assertion and library-level process exit on bind failure. **Contracts:** same configured port semantics, Origin/auth/validation and optional lazy startup. **Prerequisite:** G00.

**Steps:** (1) Create a deferred ready promise before listeners can fire. (2) Resolve it with the actual bound address after both listening and mandatory recovery barriers. Port zero tests use the real allocated port. (3) Reject on bind or required initialization failure; trigger owned partial cleanup. (4) Entry awaits ready before announcing readiness. (5) Keep human logs separate and retain optional provider/catalog work off the mandatory readiness barrier. (6) Reject or settle deterministically when close races with startup.

**Edges:** EADDRINUSE, early close, repeated error/listening, recovery failure after bind, no unhandled rejection when parent exits early. **Non-goals:** no HTTP health framework, no waiting for every provider, no protocol migration.

**Tests/commands:** server package tests/typecheck; deferred socket/recovery fixtures plus a real occupied-port process. **QA/benchmark:** compare startup milestones to G00; typed readiness must not add optional discovery to the critical path. **Acceptance:** zero ready receipts before the two required barriers; each startup failure has one actionable outcome and no retained lease after verified cleanup. **Rollback:** revert entry and server interface together. **Risks:** cleanup ordering and readiness deadlock. **Net simplification:** one readiness authority. **Performance:** neutral target. **Product:** no false startup success.

### G05 — Retain PTY ownership and make failed stop retryable

**Priority/confidence:** P0 / High. **Current -> target:** dropped active handle/permanently rejected close-all -> retained PTY owner with shared in-flight attempt, separately observed physical exit.

**Scope/change:** `apps/server/src/terminal.ts`, `terminal.test.ts`; inspect orchestrator close/checkouts and current `packages/proc/src/kill.ts`. **Delete:** permanent rejected-attempt cache and early handle release, not output/status retention. **Preserve:** absolute offsets, bounded tail, exactly one terminal exit, no writes to closed PTY, checkout exclusion. **Prerequisite:** G00.

**Steps:** (1) Keep the native handle and identity in one terminal record through stopping. (2) Concurrent close joins the same attempt. (3) First termination requests stop; a bounded wait returns failure without deleting ownership. (4) A later retry starts a fresh attempt if still live. (5) Actual exit settles cleanup and final output once, even when a deadline already fired. (6) Reset the close-all attempt on rejection; retain per-terminal records. (7) Block replacement/checkout release until all relevant records are physically settled.

**Edges:** synchronous native kill throw, late final stdout, timeout then exit, retry after exit, two terminals in one checkout, close-all while launch is pending. **Non-goals:** no global process scan/kill, no user-command restart, no replacing PTY session identity with ordinary child semantics.

**Tests/commands:** server terminal and checkout regression suites, proc suite; real test-owned PTY shell with descendant and independent sentinel process. **QA:** ten repeated fail/retry cycles, no duplicate terminal event, no surviving owned process, unrelated sentinel alive. **Acceptance:** failed attempts remain retryable and never grant unsafe checkout access. **Rollback:** revert only after all test-owned PTYs stop. **Risks:** PID/session mistakes and late events. **Simplification:** one retained terminal owner instead of authority split across records/promises. **Performance:** output budgets unchanged. **Product:** reliable Stop/Quit/retry.

### G02 — Drain server ownership before closing storage

**Priority/confidence:** P0 / High. **Current -> target:** close with unconditional final storage cleanup and successful exit -> shared, retryable drain with truthful failure.

**Scope/change:** server entry/server close; orchestrator disposal admission boundaries; terminal integration; data-lease tests. Propose a small `shutdown.ts` only if it eliminates duplicated entry logic; reuse the Linux version's intent, not its transport assumptions. **Delete:** success-in-finally exit and uncontrolled process exit from library code. **Preserve:** existing generation fences, failed-stop checkout guards and all successful shutdown behavior. **Dependencies:** G01, G05.

**Steps:** (1) Close request admission and prevent new owned provider/PTY/design work. (2) Join pending create/resume operations; late results must be stopped before attaching. (3) Await owned workers and checkpoint work; do not equate an empty queue with an idle worker. (4) After verified quiescence, close sockets/storage and release the lease exactly once. (5) If quiescence is unproved, keep ownership/protection and report a retryable blocked shutdown; do not reopen admission. (6) Concurrent calls return the same attempt; a completed failure allows a deliberate retry of unfinished idempotent cleanup. (7) Entry reports nonzero failure without an unconditional zero exit; forced termination is a separate explicit operator policy, not “clean stop.”

**Edges:** partial initialization, failed native cleanup, repeated signals, storage-close exception after workers already stopped, stop while provider start awaits I/O. **Non-goals:** no transaction around external I/O, no new persistent workflow engine.

**Tests/commands:** `pnpm --filter @harness/server test`, server typecheck; real temporary DB/lease contention test. **Acceptance:** no worker accesses closed storage; failed stop retains the relevant guard; no second owner acquires protected state; exit/status reflects actual result. **Benchmark:** shutdown phases/deadlines recorded, not an assumed speedup. **Rollback:** revert entry/close together and preserve recovery state. **Risks:** blocked shutdown must remain visible. **Simplification/product:** one drain barrier and no false success.

### G03 — Make the existing supervisor awaitable in both launch modes

**Priority/confidence:** P0 / High. **Scope/change:** `apps/desktop/src/server-supervisor.ts`, its tests, `main.ts` launch wrappers; server shutdown/ready messaging; a tiny internal message type in `packages/proc` if shared. **Delete:** stdout readiness authority and release-before-exit. **Preserve:** utility default, legacy fallback, external dev-server non-ownership, backoff/restart limits. **Dependencies:** G01/G02.

**Target interface:** retain existing wrapper and add `postMessage(message)`, `onMessage(listener)`, and an exit observation usable by `stop(): Promise<void>`. Do not create a new workspace or generic IPC bus. Parent sends `{ type: 'shutdown', generation }`; child returns typed ready or shutdown-failure messages. Physical exit remains the final owner-release event.

**Steps:** (1) Assign a launch generation; register exit/error/message listeners before accepting readiness. (2) Utility wrapper uses `postMessage`/`process.parentPort`; Node-mode wrapper uses child IPC/`process.on('message')`. Normalize only the message payload. (3) Validate message shape and ignore obsolete generations. (4) Share the in-flight stop promise, retain handle after failure, and clear ownership only on exit. (5) Use bounded graceful wait, initially preserving the existing Linux 12 s grace and 1.5 s exit-check policy as explicit constants pending measurement. (6) Suppress automatic replacement while ownership is unresolved. (7) Preserve stdout/stderr for diagnostics with correct partial-chunk handling, not control semantics.

**Edges/tests:** ready before parent handler; malformed receipt; error then exit; kill false/throw; stop twice; late exit; old-generation message; no IPC in standalone CLI. Unit fixtures plus real packaged utility and Node-mode integration. **Commands:** desktop/server/proc tests and typechecks, root gates at integration. **Acceptance:** concurrent stop cannot resolve earlier than the actual shared attempt; no overlap of live generations. **Rollback:** supervisor and launch/message callers together. **Non-goals:** no debug API, no change to domain WS. **Impact:** fewer ownership interpretations; startup neutral; reliable recovery.

### G04 — Integrate truthful Quit and recovery into the native shell

**Priority/confidence:** P1 / High. **Scope/change:** `apps/desktop/src/main.ts`, native menu/quit tests and existing diagnostic/error presentation. **Delete:** callers that treat synchronous stop as completion and string matching as readiness. **Preserve:** platform close/minimize semantics, second-instance behavior, window persistence, preview cancellation and updater flow. Linux-specific close-policy decisions belong to the Linux track. **Dependencies:** G03, G08 integration.

**Steps:** (1) Route explicit app Quit, menu Quit, updater Quit and OS quit initiation through one guarded native quit attempt. (2) Prevent reentrant native quit while cleanup runs; keep a recovery window/dialog reachable. (3) Await preview cancellation and server stop, then permit final app quit exactly once. (4) On failure, show a sanitized reason and Retry/Cancel; expose force exit only as an explicit unsafe-cleanup choice with a warning that work may remain. Cancel does not resurrect disposed server services. (5) A failed start offers retry after ownership/port conflict is resolved rather than unconditional reinstall advice. (6) Keep startup benchmark completion tied to typed ready, not logs.

**Edges:** second-instance during start/stop, updater install request while active task, close of hidden capture window, repeated Quit, server never started, external dev server. **Non-goals:** no new dashboard, no renderer-owned process controller, no automatic task resubmission.

**Tests/commands:** desktop suite and real Electron fixture with deterministic failing child; root gates. **QA:** keyboard-only native dialog, light/dark visible surface, menu/tray/update quit, cancel/retry, preview in flight; all OSes. **Acceptance:** one cleanup attempt at a time, success only after actual exit, failure always reachable, no duplicated active task. **Rollback:** revert UI and lifecycle integration together. **Risks:** reentrant Electron events/updater interactions. **Simplification:** one quit path. **Performance:** no normal-path regression. **Product:** understandable recovery instead of ambiguous frozen/reconnecting state.

### G06 — Define write-only custom environment updates

**Priority/confidence:** P1 / High. **Scope/change:** `packages/contracts/src/domain.ts`, `protocol.ts`, matching protocol tests, server custom-harness DTO mapper and current custom-harness settings form consumers. Keep the schema change in a narrowly reviewed contracts PR. **Delete:** plaintext environment values from list/get/read results. **Preserve:** command/args/cwd/provider fields and omission-means-unchanged updates. **Prerequisite:** G00; consumer search must cover custom harness verification/background use.

**Target:** public reads contain `environmentKeys: string[]`; write input contains optional `environmentUpdates: { set: Record<string,string>; unset: string[] }`. Server-only stored bindings map keys to opaque credential references. A missing updates object preserves values; empty set/unset is a no-op; overlapping set/unset keys are rejected. Values never return in success/error payloads. Keep existing max counts/length/null-byte validation and explicitly resolve Windows environment-key equivalence without changing Unix case sensitivity.

**Steps:** (1) Enumerate every read/write consumer and pin its behavior. (2) Define separate stored/public/write schemas so a secret-bearing write type cannot accidentally become a response type. (3) Add configured-key and replacement/removal controls to the existing editor; no value prefill. (4) Document all custom values being credential-backed, including non-secrets. (5) Add exhaustive protocol/redaction tests before implementing persistence.

**Edges:** unset absent key, blank but valid value, PATH casing on Windows, duplicate keys, simultaneous edit, verify-before-save. **Non-goals:** no arbitrary secret detector, new credential provider or vendor-token import. **Commands:** contracts/web/server tests and typechecks. **Acceptance:** serialized read responses and validation errors never include a sentinel value; old metadata fields behave unchanged. **Rollback:** keep readers compatible until migration decision, do not revert after G07 without a reference-capable reader. **Impact:** removes secret classification/readback concepts, may add source; no speedup; intentional safer settings UX.

### G07 — Implement credential-backed custom environment storage and migration

**Priority/confidence:** P1 / High. **Scope/change:** `custom-harnesses.ts`, `custom-harness-launch.ts`, `credentials.ts` narrow strict operations, custom-harness verification/background callers and tests. Reuse existing atomic-file utilities where applicable. **Delete:** environment value serialization, plaintext migration backups, value-bearing child-error exposure. **Dependencies:** G06.

**Steps:** (1) Define version-2 metadata with per-key references under a dedicated custom-environment namespace while retaining the existing keyring service. (2) For replacement, stage new references and a small **reference-only** recovery record, write keyring entries, atomically commit new metadata, then remove obsolete entries. (3) Recovery compares committed references: committed-new means clean old entries; otherwise clean staged entries and retain old metadata. Never journal values. (4) Migrate every version-1 environment entry through the same sequence; do not rewrite the old config until keyring writes and verification succeed. (5) Materialize values only in final launch/verification calls, keeping argv free of them and replacing known sentinel values before truncating errors. (6) Distinguish missing/unavailable keyring and report retryable cleanup failures; do not use a swallow-all delete result as proof. (7) Remove bindings/credentials on user-directed harness deletion with retryable metadata-only cleanup obligations.

**Edges/tests:** locked service, oversized value rejected by native backend, partial writes, crash at each boundary, shared launch while edit commits, concurrent saves, deletion failure, Unicode and case rules. Test config, temp files, journals, SQLite, read DTOs, logs and argv for sentinel absence; only the intended child environment receives it. **Commands:** server/contracts suites, root gates; disposable real-keyring test on each OS. **Acceptance:** no plaintext config rewrite or fallback; deterministic restart recovery; existing version-1 config preserved on blocked migration. **Rollback:** reference-capable code required; never export secrets back to old config. **Risks:** keyring limits/availability. **Expected simplification:** one credential primitive and no secret classifier; LOC may grow. **Product:** safe custom launch without secret readback.

### G08 — Make general diagnostics text-only and strictly bounded

**Priority/confidence:** P1 / High source. **Scope/change:** `apps/desktop/src/local-diagnostics.ts`, `main.ts` diagnostics initialization/open path, existing settings wording, diagnostics tests. **Delete:** automatic `crashReporter.start`/crash-directory routing from the general preference and raw-dump inclusion in that surface. **Preserve:** opt-in text errors and no mandatory upload. **Dependency:** G00, intentional-behavior acceptance.

**Steps:** (1) Identify the text-only directory opened by the general diagnostics action. (2) Remove raw dump collection from that toggle; keep legacy raw files outside its claimed sanitized contents. (3) Move only known text-log files when migrating; never recursive-delete an old directory. (4) Serialize record operations; bound a scrubbed entry before append and rotate/check within that serial owner. (5) Add a preference generation so queued writes after disabling do not occur. (6) Document that legacy native dumps are unsanitized and remain until explicit deletion; no promise to scrub binaries. (7) Keep diagnostic failures from crashing normal work.

**Edges/tests:** hundreds of concurrent errors, full log, disabled during queued writes, mkdir/rename failure, prior reporter started in an old process, links in old directories. **Commands:** desktop tests/typecheck/root gates. **QA:** inspect a packaged directory containing a disposable fake old dump and redaction sentinels; general Open Diagnostics exposes only the text surface. **Acceptance:** strict documented byte bound, no write after disable generation, no raw-dump consent implied. **Rollback:** do not restore implicit collection without renewed approval. **Risks:** reduced native crash detail is deliberate. **Simplification:** removes one collection lifecycle, no logging service. **Performance:** bounded serialized writes. **Product:** accurate privacy control.

### G09 — Align root gates and build exactly once per preparation

**Priority/confidence:** P1 / High. **Scope/change:** root `package.json`, `.github/workflows/ci.yml`, desktop build/dist scripts and the Linux acceptance consumer in its separate branch; existing release-tool tests. **Delete:** recursive-only CI test selection and repeated build inside one preparation. **Preserve:** manual workflow trigger, independent dist, license verification and exact resource/native checks. **Prerequisite:** G00.

**Steps:** (1) Change the manual workflow test command to root `pnpm test` so Node release-tool tests and workspace tests both execute. (2) Document one root gate contract. (3) Factor release preparation into one Node entry that owns clean-source checks, license validation, build, preload and packaging; independent dist invokes that full path. (4) Within the same acceptance invocation reuse the just-created prepared inputs directly, not through a public unchecked skip flag. (5) Record source SHA, lockfile hash, target/version and prepared resource hashes. (6) Reject changed inputs or stale preparation before packaging/proof. (7) Keep packaging-only platform behavior in builder configuration, not another general build system.

**Edges/tests:** dirty source, version-only change, stale preload, concurrent target outputs, changed lockfile, missing native prebuild, intentional failing root test. **Commands:** root gates and release-tool Node tests; do not dispatch the workflow. **Benchmark:** cold and warm acceptance logs count actual build executions and total elapsed time. **Acceptance:** one build per combined preparation, root-test failure cannot be skipped, clean standalone dist remains complete. **Rollback:** scripts/manifests together; discard only generated artifacts with obsolete identity. **Risks:** cache-like reuse accidentally trusting stale output. **Simplification:** one preparation owner; no runtime change. **Product:** trustworthy reproducible release candidate.

### G10 — Prove native modules through the actual packaged core process

**Priority/confidence:** P0 release gate / High. **Scope/change:** desktop `native-binding-proof.ts`, its runner/tests, actual utility launch/proof integration, existing release verification documentation. **Delete:** Node-mode-only inference, not its fallback test while supported. **Dependencies:** G01–G05, G09.

**Steps:** (1) Package a clean identified artifact. (2) Start its real application/core-server launcher in a disposable profile; proof commands are local test-only or authenticated/narrow and unavailable to untrusted renderer content. (3) Record launcher, Electron/Node versions and exact module resolved paths. (4) Exercise SQLite, a real PTY write/read/resize/exit and a disposable keyring save/read/delete. (5) Exercise typed ready and graceful shutdown; confirm child/descendant cleanup and profile isolation. (6) Repeat the native loading proof under Node fallback if it remains supported. (7) Produce source+artifact+OS-bound machine-readable results and separately mark required installed/manual checks.

**Edges:** keyring unavailable/locked, asar resolution, unpacked spawn-helper permissions, installed path with spaces/non-ASCII, app packaged but resources accidentally resolved from checkout. **Non-goals:** no sandbox disabling, no real user secret, no public release/upload.

**Tests/commands:** existing `verify:native-bindings` runner plus the new actual-launch path; root tests; native OS fixtures. **Acceptance:** both the default launcher and all advertised fallback paths have actual evidence; missing service is BLOCKED, not PASS; zero owned test leftovers. **Rollback:** restore previous binary while preserving data; invalidate proof on artifact changes. **Risks:** platform-specific native ABI/permissions. **Impact:** stronger qualification, no measured runtime optimization.

### G11 — Reconcile current authority and conditionally remove dead tooling

**Priority/confidence:** P2 / High drift, conditional deletion. **Scope/change:** `docs/ARCHITECTURE.md`, current handoff/status pointers, relevant package-manager documentation, optionally root `bun.lock`/`rustfmt.toml`. **Delete:** obsolete current directory references; conditional tool files only after the test below. **Preserve:** historical audit findings and proof limits, user-project Bun handling, archived branch, physical Linux checklist. **Dependency:** G00.

**Steps:** (1) Search the full tracked tree and recent relevant history for each candidate and its tool, including scripts/workflows/agents/docs. (2) Record each actual supported consumer. (3) If no supported consumer remains, delete the candidate and obsolete root-only instructions in one commit; otherwise retain it and explicitly identify the authority. (4) Correct the current architecture tree without rewriting historical reports as current truth. (5) Build an issue reconciliation table: source change/test/artifact proof/missing requirement; suggest precise status updates rather than closing from a title. (6) Re-check live #1129/#1130 and do not overwrite their scope.

**Edges/tests:** indirect script use, optional maintained Bun install path, native proof scripts outside workspace tests, documentation describing user projects rather than TasteCode build. **Commands:** tracked-consumer searches, frozen pnpm install/root gates after any tool deletion. **Acceptance:** each deleted item has a documented zero-supported-consumer result and a working canonical workflow; no claimed runtime gain. **Rollback:** restore deleted config/lock in an ordinary commit, no data migration. **Risks:** incomplete search. **Simplification:** fewer current authorities, potentially two dead root files; source/dependency count otherwise unchanged. **Product:** clearer maintainership after Linux owner departure.

### G12 — Qualify remaining structural performance costs without speculative refactors

**Priority/confidence:** P2 / High evidence gap. **Scope/change:** existing real-Electron performance fixtures/results and narrowly missing benchmark fixtures; no production optimization is pre-authorized. Inspect `ThreadController`, `thread-state-cache`, history snapshot/read path, highlighter worker, Activity details and `PushBus` before declaring a missing mechanism. **Delete:** duplicate planned work found already implemented, not tested optimizations. **Dependency:** G00 and integrated lifecycle changes for final measurements.

**Steps:** (1) Run the real 500-message/stream/switch/idle fixture. (2) Add a tool-heavy collapsed turn and long code fences only if absent from the current fixture. (3) Create temporary 10k and 100k-event histories; distinguish first snapshot creation, persisted snapshot read, tail replay, wire size, reducer work and first usable frame. (4) Capture profiler traces and retained heap/process identities. (5) Re-run each failing workload to distinguish measurement noise from structural cost. (6) Either record PASS/no production change or produce one bounded follow-up specifying exact hot symbol, fixture, alternative and acceptance threshold. Stop; do not invent a paginator/database worker during qualification.

**Edges:** active approvals, background running threads, scroll anchoring, theme change, reduced motion, sleep/reconnect, transient GPU retirement. **Commands:** documented performance/preview scripts; filtered benchmark entry commands discovered in G00, not guessed flags. **Acceptance:** all required samples retained; budgets not weakened to pass; no forced GC/unload; unresolved workloads clearly block the relevant claim. **Rollback:** remove only added benchmark resources. **Risks:** fixture not representative. **Simplification:** avoids redundant architecture; runtime effect unclaimed. **Product:** prevents fast-demo/slow-real-history regressions.

### G13 — Final cross-platform, product and release decision

**Priority/confidence:** P0 release gate / High. **Scope/change:** source-bound verification result and existing release/status documentation only; fixes go back to their owning card. **Delete:** no code by default. **Preserve:** user data, provider boundaries, manual release authority. **Dependencies:** required preceding cards and any accepted intentional behavior changes.

**Steps:** (1) Freeze the integrated source and clean build identity. (2) Run root gates plus actual packaged-launcher proof. (3) On Windows/macOS and the separately qualified Linux targets, exercise launch/second instance/window/tray/quit, provider start/approval/stop, reconnect, terminal recovery, saved branch and checkpoint restore, preview cancellation, credentials and diagnostics. (4) Prove failure cases rather than only happy paths: occupied port, killed server, locked keyring, failed PTY stop, interrupted migration, update quit during work. (5) Verify screenshots, keyboard/screen-reader names, themes and reduced motion in production builds. (6) Record exact Claude binary/SDK/auth mode against current primary guidance and obtain the appropriate release decision; do not infer policy approval from technical success. (7) Re-measure baseline differences and perform one final consumer/deletion pass.

**Acceptance:** every advertised capability has source+artifact+environment-bound evidence; no Critical/High unresolved correctness issue in that supported path; all missing QA is marked BLOCKED; no release is published automatically. Parked/nightly-only features retain explicit scope. **Commands:** all root gates, native/Electron proof scripts, documented installer verification. **Rollback:** previous qualified binary plus preserved data and compatible readers; never downgrade a migrated credential config into plaintext. **Risks:** proof from the wrong build, provider-account permission and packaging differences. **Impact:** qualification only, not a promise of numerical improvement.

## 20. Verification matrix

| Transformation | Unit/integration contract | Benchmark | Visual/manual | Observability and binary acceptance |
| --- | --- | --- | --- | --- |
| G01 readiness | Delayed bind/recovery; occupied port; early close | Startup milestones | App does not claim ready while unusable | One typed receipt after both barriers |
| G02 drain | Late start/resume; concurrent close; failed cleanup; DB lease | Phase durations recorded | Failure/retry remains reachable | No storage access after close; no false clean exit |
| G03/G04 supervisor/quit | Both message transports; old generation; kill failure; reentrancy | Existing startup gate | Quit/menu/update/retry/cancel on each OS | No replacement before old owner resolves |
| G05 PTY | Throw/timeout/retry/late exit/tail flush | Existing terminal batching | Close terminal and retry stop during real work | Owned descendants gone; unrelated process alive; one exit |
| G06/G07 environment | Sentinel secrecy, migration interruption, strict native failure | Setup/launch latency reported | Write-only editor; locked keyring recovery | No values in config/reads/logs/argv; cleanup verified or pending |
| G08 diagnostics | Concurrent bounded writes; disable generation; old dump | Flood remains bounded | Opened surface contains only claimed text logs | No implicit native collection; no raw-dump scrub claim |
| G09 preparation | Root-test inclusion; input identity mismatch; single build | Cold/warm total elapsed | No hosted run required | Every proof references the produced artifact |
| G10 native proof | Runner failure/missing-service handling | No speedup claim | Real installed PTY/keyring, utility default | Exact artifact/launcher/OS; no checkout fallback |
| G11 deletion | Consumer/history checks; canonical install | Developer loop if meaningful | Documentation reflects actual tree | Zero supported consumers for each removal |
| G12/G13 quality | Existing regression suites preserved | Existing budgets + adversarial history reports | Keyboard, themes, reduced motion, recovery | PASS/FAIL/BLOCKED per source and environment |

Every result should contain task ID, exact source SHA, clean status, lock/input identity, command, exit code, environment, relevant artifact SHA-256, raw report location, and explicit limitations. Do not put user secrets or full home paths in shareable reports.

## 21. Migration and rollback strategy

Most lifecycle changes require no data migration. Land them in reversible narrow commits, updating callers with the contract. Keep old/new internal ready-message parsing compatibility only across supported independently launched versions; a bundled desktop/server normally changes together, so do not invent permanent protocol-version negotiation for that pair.

Credential migration is the exception: new values must never be written back to plaintext on rollback. Use versioned metadata, staged references and a reference-only recovery record. A compatible reader must remain available. Keyring unavailability is not permission to discard the old config or fabricate success. Test crash/restart after each write boundary, not only an all-success migration.

For binary rollback, preserve data directories, provider state and checkpoint refs; use an already-qualified prior artifact and ensure schema compatibility. A forced shutdown or manual deletion invalidates “clean shutdown” proof. Do not implement a universal rollback engine.

## 22. Quantified expected impact

| Quantity | Established now | Target / not a measured result |
| --- | --- | --- |
| Application/package boundary count | 3 app directories / 12 package directories | Intentionally unchanged |
| Runtime dependencies added by planned core changes | No implementation yet | Zero new production dependencies expected |
| Readiness authorities | Multiple inspected paths | One semantic ready boundary with transport-specific delivery |
| Owner-release condition | Signal/handle removal and exit differ | Confirmed physical exit, with failure-retained ownership |
| Plain custom environment values in config/read responses | Schema permits them | Zero after successful migration; no secret detection claim for arbitrary argv |
| Automatically enabled raw dumps under general diagnostics | Present in source path | Zero after accepted diagnostics change |
| Builds in combined Linux acceptance | Build followed by dist rebuilding | One trusted preparation; elapsed gain must be measured |
| Root-only release tests in current manual CI selection | Not selected by `pnpm -r test` | Included through root command |
| Obsolete root tooling files | Two candidates | 0–2 deletions, only after consumer gate |
| Authored LOC / runtime improvement | UNKNOWN | No numeric reduction or multiplier asserted |

A smaller number of failure states and one source-bound release decision are meaningful gains even if privacy and lifecycle tests increase total repository LOC.

## 23. Risks and unknowns

Source changes after the pinned head, unpublished user work, installer behavior, native runtime compatibility and physical desktops remain outside this audit's proof. The Linux candidate is substantially behind main; whole-file copying can remove later fixes. Current open issue text is not reliable defect truth without source reconciliation. Provider terms and vendor experimental APIs can change independently of this repo. OS keyring limits and deletion errors need real tests. Shutdown after partial failure is intrinsically different from restoring a fully running app; the UI must not hide that difference.

The performance budgets may expose platform-specific failures on the latest integrated source. Record and fix them rather than claiming old macOS results cover all systems. An exhausted or inaccessible QA environment is BLOCKED, not an architectural reason to disable security or weaken acceptance.

## 24. What this plan deliberately does not do

No Electron-to-Tauri/Rust rewrite, new server framework, ORM, global state manager, event-sourcing platform, microservice split, remote/mobile expansion, provider merger, general secret vault, logging service, dependency-upgrade campaign, mass file reshuffle or arbitrary LOC target. No new animation/effort-slider work overlapping live PRs. No removal of safety tests or checkout ownership to shorten code. No automatic closure of historical issues, launch approval, release upload or hosted CI dispatch.

No unconditional history-pagination/highlighter/provider-control rewrite: the current code already contains relevant optimizations and G12 must establish the residual problem. No requirement to implement every speculative product idea before shipping a qualified supported subset.

## 25. Final first-principles challenge and handoff

The plan was challenged for symptom treatment, architecture cargo cult, redundant abstractions, unmeasured micro-optimization and unnecessary migration. The second pass removed new state-management infrastructure, a separate Linux product, speculative database workers, repeated audit fixes, repeated motion work, universal process abstraction, automatic secret classification and a new benchmark framework.

The cascading sequence is intentional: truthful readiness removes log parsing; retained process/PTY ownership makes retry semantics local; that lets the shell use one quit path; one prepared build makes multiple evidence reports agree; current-source reconciliation eliminates tasks already completed. Keyring integration adds necessary safety work but eliminates an unsafe persistence/readback path; it is not presented as a LOC reduction.

An engineer should explain the target in one sentence: **the server owns work and data, the shell owns its server, both acknowledge lifecycle truth, and public settings never return launch credentials.** No new service or product architecture is needed.

### Short implementation-agent prompt

> Work in a new implementation branch based on the current intended target, never main. Read AGENTS/rules and `gpt-6-defacto.md` from `docs/gpt-6-defacto-overall-20260914`. Recheck source drift from `759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9` and live PR overlap. Execute G00, then only ready cards in the dependency graph, one bounded commit/PR per contract. Preserve newer work and the explicitly protected implementations. Do not use the Linux branch as a wholesale replacement for main. Run actual validation and report PASS/FAIL/BLOCKED with source/artifact identity. Do not claim improvements without measurements, migrate secrets back to plaintext, rebase/force-push, dispatch Actions, publish releases or merge. Stop dependent work at a failed gate, not at a vague “production-ready” assertion.

### Fixed-source evidence index

All TasteCode S references below are pinned to the reviewed main commit. L references are deliberately pinned to the separate Linux candidate. External links above are retrieval-date evidence; their content blob identities are stated where available. Historical reports document historical runs, not results from this planning pass.

[S01]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/docs/ARCHITECTURE.md
[S02]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/package.json
[S03]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/desktop/package.json
[S04]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/server/package.json
[S05]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/web/package.json
[S06]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/desktop/src/main.ts
[S07]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/server/src/main.ts
[S08]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/server/src/server.ts
[S09]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/server/src/store.ts
[S10]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/web/src/transport.ts
[S11]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/web/src/thread-controller.ts
[S12]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/docs/AUDIT-FIXES.md
[S13]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/plans/README.md
[S14]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/desktop/src/server-supervisor.ts
[S15]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/server/src/terminal.ts
[S16]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/packages/contracts/src/domain.ts
[S17]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/server/src/custom-harnesses.ts
[S18]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/server/src/custom-harness-launch.ts
[S19]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/server/src/credentials.ts
[S20]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/desktop/src/local-diagnostics.ts
[S21]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/.github/workflows/ci.yml
[S22]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/docs/PERFORMANCE-CHECKS.md
[S23]: https://github.com/Leonxlnx/tastecode/blob/759d8141ebc8bdd4fe17b3dbaa026fe62a4711b9/apps/server/src/push-bus.ts
[L01]: https://github.com/Leonxlnx/tastecode/blob/b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b/tools/scripts/linux-acceptance.js
[L02]: https://github.com/Leonxlnx/tastecode/blob/b1e4a1d95ab199b5c2539f3f5b7d40e95baea29b/apps/desktop/scripts/run-native-binding-proof.js
