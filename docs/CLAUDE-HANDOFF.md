# TasteCode and Design reference library: Claude handoff

Prepared at Leon's explicit request on **2026-10-09 (Europe/Berlin)**. This is an intentional exception to the repository's usual prohibition on handoff snapshots. It records this long-running work and the independently checked current state so another agent can take over. It is not a new product specification or a claim that every open issue is solved. Recheck live GitHub state before acting.

## 1. Read this first

- **The working product has three different states:** published installers, `main` source, and `nightly` source. A merged fix does not update an installed app. A tag or draft release does not deliver an update.
- **Do not start by pulling, resetting or cleaning `D:/personalharness`.** That checkout is old and dirty. It is at `e4f8b126da6dc000c968863f6722fd0f44f45685`, dated September 13, with 17 modified tracked files and seven top-level untracked entries. Their ownership and unpublished contents need reconciliation. It is not the current product source.
- **Do not stop or restart Leon's running TasteCode/Codex/browser sessions.** Prior installation/restart permission was for specific earlier tests, not blanket permission to disrupt today's work. Inspect before running any process-changing command.
- All dashboard/reference task changes described below are already pushed and merged. Do not recreate them from the old checkout or blindly push every local branch.
- **Latest public desktop release checked today: `v0.1.1`.** The `v0.1.2` draft is not ready merely because it contains two installers. Its description calls it an unsigned packaging proof; its macOS digest differs from the earlier reported signed build. See section 10 and the release inventory.
- **Latest checked `main`: `f9e5549a`**. **Latest checked `nightly`: `1db6e765`** before this documentation PR. They diverge after `3e67df35`: 13 main-only commits and 49 nightly-only commits. New main settings work must eventually be merged into nightly without deleting the extra provider code.
- The 200 dashboard pairs are present on nightly and in the private plugin. The native app does **not** contain the private plugin's entire website library.
- Do not describe synthetic tests as real model generation, source builds as installers, or sample visual review as exhaustive independent review.

### Supporting files

- [Current PRs, issues, releases and remote branches](handoff/2026-10-09/github-inventory.md).
- [Reference-library and plugin inventory](handoff/2026-10-09/assets-and-plugin.md).
- Machine-only workspace inventory: `E:/TasteCode-reference-library/production/2026-10-09-handoff/local-workspaces.md`. This stays local because it enumerates unrelated working directories and unpublished work.
- The same local handoff directory holds machine-readable audit results. Do not upload raw sessions, app databases, credential settings or arbitrary untracked files with it.

## 2. People, preferences and authority

Leon owns product direction and Windows delivery (`Leonxlnx` on GitHub). Blueemi handles much of the visual UI and macOS signing/notarization; verify the live PR author/assignee instead of assuming ownership from a nickname. Multiple agents and humans work concurrently.

Leon wants autonomous, concrete execution, small progress updates and no repeated approval questions for already authorized work. He explicitly authorized the necessary task branches, worktrees, PRs, manual CI and merges. PR #1403 recorded that standing policy. Read the current target branch's `AGENTS.md` and `rules/`; the old primary checkout still contains obsolete rules asking for separate approval. This handoff does not authorize unrelated account actions, recurring CI, secret exposure, or Rust/mobile integration.

Product preferences repeatedly stated in the conversation:

1. Design mode should take one user prompt and proceed without initial or closing clarification questions. Infer missing details and preserve supplied constraints.
2. Show useful normal progress text. Internal phase prompts, JSON protocols, task notifications and synthetic messages must not appear as user-authored chat messages.
3. Reference selection must actually be random among eligible compositions. Avoid repeatedly producing the same hero/page skeleton. Generation retries must not increase one layout's chance of selection.
4. Preserve distinctive reference composition and creative elements. Adapt branding, copy and incidental details lightly; do not discard the design and invent generic sections.
5. Implement responsive HTML/CSS/components, not screenshots used as the finished interface. Inspect both desktop and mobile reference images.
6. Marketing landing pages generally need at least eight meaningful sections when appropriate to the request. Dashboards are operating interfaces and must not inherit that minimum.
7. Include visible, purposeful motion. Dashboards need functional filters, sorting, tabs, navigation, drawers and charts, keyboard behavior and reduced-motion support.
8. Use image generation when available, otherwise suitable obtainable online assets. Never invent clients, actual portfolio work, artist identities, permission claims or measured product proof.
9. Occupied preview ports should recover automatically on an available `127.0.0.1` port. Preserve other projects and running tasks.
10. Tests and release claims must be exact. Leon was frustrated by repeated prompts, premature success claims and preventable failures. One prompt per manually started test, then monitor; never repeatedly submit the same request.
11. Do not use unrelated GPT-taste or third-party design skills for this workflow. The project-owned reference system and the separately authored `design-taste` plugin are the intended resources.

## 3. Project map

| Project / location                                  | Purpose                                                                        | Important distinction                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `https://github.com/Leonxlnx/tastecode`             | Public desktop product, server, renderer, providers and native Design workflow | `main` public-beta source; `nightly` full integration                  |
| `D:/personalharness`                                | Shared Git repository and old primary checkout                                 | Dirty, old, many registered worktrees; preserve it                     |
| `E:/tc-claude-handoff-20261009`                     | Clean, task-owned checkout used to write this handoff                          | Based on nightly, documentation changes only                           |
| `E:/tc-dashboard-agent`                             | Completed native dashboard implementation checkout                             | Final approved head `be743812`; merged nightly tree matches it         |
| `E:/tc-dashboard-sync`                              | Completed main-to-nightly provider-preserving synchronization                  | Head `2ae82ee3`, merged in #1392                                       |
| `E:/tc-checkpoint-path-fix`                         | Windows repository identity bug fix                                            | Head `89d055cb`, merged in #1404                                       |
| `E:/tc-dashboard-contracts`                         | Optional saved API connection identity contract                                | Standalone #1395, already merged                                       |
| `E:/tc-dashboard-windows-gates`                     | Windows child-process cleanup and portable updater tests                       | Standalone #1394, already merged                                       |
| `E:/tc-dashboard-ci-proof`                          | Retained manual three-source CI workflow checkout                              | Its remote task branch was removed after proof; logs remain            |
| `E:/tc-task-authorization-policy`                   | Standing task-authorization policy                                             | #1403, already merged                                                  |
| `E:/design-taste` / private `Leonxlnx/design-taste` | Standalone reference-driven Codex/Claude plugin                                | Full active website pool plus all dashboard pairs                      |
| `E:/TasteCode-reference-library`                    | External production assets, captures, generation records and reports           | Not the application repo; raw captures and rejected attempts stay here |
| `.../production/2026-10-02`                         | Website production/export/provenance work                                      | Some earlier reports are superseded; use final evidence                |
| `.../production/2026-10-04-dashboards`              | Dashboard generation, verification, gallery and demo                           | Main completed-work evidence directory                                 |
| `.../production/2026-10-09-handoff`                 | Current read-only audits and local transfer bundle                             | Contains the local-only workspace inventory                            |

Do not delete old worktrees or branches based on their names. Some contain other agents' uncommitted work. The separate local inventory lists every registered worktree and flags uncertainty.

## 4. Branch model and current integration gap

`main` intentionally ships only Codex, Claude Code and Grok. Since October 3, the other provider implementations are absent from main's source, not merely hidden. `packages/adapter-acp` remains there as protocol infrastructure for Grok MCP. Do not restore the whole provider roster to main without an explicit product decision.

`nightly` retains Codex, Claude Code, Grok, Cursor, OpenCode, Antigravity, Pi, ACP surfaces and direct API connections. Shared features must work with a direct API provider alone; provider-specific capabilities must stay inside adapters. Image-based Design currently rejects engines that declare no image input before any paid inference or persisted Design run.

The Rust/GPUI rewrite is archived separately on `archive/rust-rewrite-2026-08-15`. Rust and mobile branches are excluded from broad instructions such as "push everything." Neither is part of this handoff's integration work.

The October 4 task merged main through `3e67df352fce161c08707052819df98d0b2c7fcc` into nightly. Main subsequently received 13 commits affecting fonts, searchable pickers, Appearance, Profile underlines, Keybinds and General settings, plus their evidence. Nightly has not received those yet. The handoff documentation does not merge them automatically: preserving the reviewed UI and extra provider behavior requires a focused sync and appropriate tests.

### Completed task PRs

| PR                | Result                                                                                  | Destination / evidence                                        |
| ----------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| #1394             | Wait for Windows process exit after `taskkill`; portable updater permission tests       | Main; historical local four-gate pass, 4,091 tests / 18 skips |
| #1395             | Optional saved API `connectionId` contract                                              | Nightly, separate shared-contract PR                          |
| #1403             | Persist task-scoped branch/PR/manual-CI authorization; stop repeated approval questions | Main merge `e29c3382`                                         |
| #1404             | Canonicalize Windows Git common-directory long/8.3 aliases                              | Main merge `3e67df35`                                         |
| #1392             | Sync main while preserving complete nightly roster, usage and API restart behavior      | Nightly merge `17aa22a3`                                      |
| #1393             | 200 dashboard pairs, dashboard planning, motion/controls, image-capability preflight    | Nightly merge `1db6e765`                                      |
| private plugin #1 | Plugin v0.2.0 with website/dashboard pools and tutorial                                 | Private repo main `d2ba0763dd1f9f5068c2f356067dac0547ebe321`  |

All are verified merged. The completed public task branches were deleted remotely after merge; their local checkouts were intentionally retained. #1392 used a normal merge to retain main ancestry. GitHub rejected rebase-merge for #1393's integration history, so it also used a normal merge. No published working branch was rebased or force-pushed.

## 5. Architecture and code entry points

TasteCode is a pnpm TypeScript monorepo. A local Node server owns provider sessions, orchestration, SQLite event history, worktrees, checkpoints, terminals and credentials. The Electron/web renderer is a thin typed WebSocket client. The protocol uses request IDs, validated boundaries and sequence numbers for gap recovery. Closing a renderer window and explicitly quitting the application have different lifecycle semantics.

| Area                                                  | Start here                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture / ongoing decisions                      | `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/PROVIDERS.md`                                                                                                |
| Human status / feature checklist                      | `docs/dashboard.html`, `docs/feature-inventory.html`                                                                                                          |
| Server session orchestration and Design state machine | `apps/server/src/orchestrator.ts` and its tests                                                                                                               |
| Design types, prompts and validation                  | `packages/design-agent/src/`                                                                                                                                  |
| Durable state                                         | `apps/server/src/store.ts`; event/recovery code and tests                                                                                                     |
| Checkpoint identity / retention                       | `apps/server/src/checkpoint.ts`, `checkpoint.test.ts`, `audit-regressions.test.ts`, `history-cli`                                                             |
| Preview port/process ownership                        | `apps/server/src/design-preview-runner.ts`, `design-static-preview.ts`, `preview-capture.ts`                                                                  |
| Transport / large-history failures                    | Server WebSocket handlers, renderer transport, history recovery tests                                                                                         |
| Provider implementations                              | `packages/adapter-*`; inspect actual captured protocol rather than assuming documentation matches                                                             |
| Per-chat composer state                               | `apps/web/src/App.tsx`, model catalog and session settings code/tests                                                                                         |
| Internal history filtering                            | `packages/adapter-claude-code/src/history.ts`, provider history normalization, orchestration-origin handling                                                  |
| Frontend / settings                                   | `apps/web/src/ui/`, `apps/web/src/styles/`, `apps/web/src/theme.ts`                                                                                           |
| Packaged app / updater                                | `apps/desktop/src/main.ts`, `app-updater.ts`, `github-release-provider.ts`, `release-updater.ts`, `update-download.ts`, `prepared-update.ts`, `dmg-update.ts` |
| Release preparation                                   | `docs/RELEASING.md`, `tools/scripts/*release*`, `check-update-feed.js`, desktop scripts/package build config                                                  |
| Native reference catalog                              | `packages/design-agent/references/library/{catalog.json,dashboard-catalog.json,dashboard-provenance.json}`                                                    |

Some roadmap text is old planning language (for example "M4 next" and proposed licensing). Do not treat it as fresher evidence than current implementation, merged PRs and release metadata. This handoff is also dated, not self-updating.

## 6. Design Agent workflow as implemented

This is a persisted multi-phase workflow, not one unlimited model turn. The user still submits only one initial request; internal phases and bounded correction turns account for extra provider calls. Keep those internal turns distinguishable from genuine user messages in history.

1. **Preflight and brief.** Check declared image input capability before inference. Classify the requested surface and extract goal, content, brand, constraints and assumptions. `workflow.ts` instructs autonomous completion with no questions. Compatibility parsing for old question records still exists; do not infer that new runs should ask them.
2. **Select references.** Use eligible reviewed references for the required layout families. Selection uses `node:crypto` randomness, chooses groups before revisions, avoids duplicate groups where possible and freezes the deck for the run. Explicit references and existing branding take precedence. Desktop/mobile paths and hashes persist so later phases inspect the same images.
3. **Brand.** Inspect selected references and existing brand inputs; derive typography, palette and reusable tokens. Contrast repair should fix recoverable combinations without erasing the requested identity.
4. **Page blueprint.** Map required content and interactions onto selected compositions. A product dashboard gets its complete shell, navigation and data views; a landing page about a dashboard remains a marketing page. The user-facing scope wins over product keywords.
5. **Assets.** Generate images when supported or acquire suitable assets. Preserve supplied media and record acquisition/provenance. Do not require screenshots of nonexistent software: when appropriate, revise those needs into real native components. Unobtainable actual client work is not permission to fabricate verified portfolio evidence.
6. **Build.** Implement actual accessible responsive code matching the reference geometry; apply branding and purposeful motion. Dashboard plans include data-bound controls, transitions, focus restoration and reduced motion. Clearly labeled demo metrics are allowed; unsupported objective product claims are not.
7. **Preview.** Start an owned process or static preview, allocate a free loopback port, update the command/URL consistently and verify readiness. Do not kill unrelated listeners to free the preferred port. Surface the actual URL, not an internal preview-plan object.
8. **Review and bounded repair.** Capture desktop/mobile output, run source-quality and visual checks, fix observed problems, and report unresolved findings honestly when the repair budget ends. Never loop indefinitely or re-prompt the entire build ten times.
9. **Ordinary follow-up.** Exit phase-only JSON constraints for normal questions or later coding requests. Keep the user's original text visible and hide internal wrappers/task notifications from user-authored bubbles.

Useful source files include `brief.ts`, `workflow.ts`, `reference-library.ts`, `reference-directions.ts`, `brand-phase.ts`, `palette.ts`, `page-phase.ts`, `assets.ts`, `asset-phase.ts`, `build-phase.ts`, `motion-guidance.ts`, `review-phase.ts`, `source-quality.ts` and `artifact-store.ts`. Project artifacts under `.taste/` include the brief, brand/page/assets reports and saved run context; inspect only the affected project and redact before sharing.

The small exported phase list in `run.ts` is not the whole orchestration implementation: `orchestrator.ts` also manages repair, resumption, stale callbacks, correction budgets and the preview lifecycle. Read both before changing behavior.

## 7. Images, counts and provenance

**Do not conflate source screenshots, generated PNGs, approved WebPs, responsive pairs and layout groups.** They are different counts.

| Collection                          | Count / state                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Historical generated website images | 3,724 ImageGen outputs with recorded provenance                                                                             |
| Active website plugin pool          | 2,258 WebPs = 1,129 desktop/mobile pairs across 670 groups                                                                  |
| Historical inactive website images  | 1,466 retained externally, not sampled or bundled as active references                                                      |
| New dashboard outputs               | 400 genuine generated images = 200 desktop + 200 mobile                                                                     |
| Dashboard source mix                | 43 supplied-image pairs + 56 online-reference pairs + 101 additional online-reference pairs                                 |
| Dashboard export                    | 400 WebPs, 42,203,164 bytes, versus 509,061,415 bytes of canonical PNGs                                                     |
| Full private plugin                 | 1,329 pairs, 2,658 WebPs, 870 groups                                                                                        |
| Native nightly app                  | 172 website reference records / 316 WebPs + 200 dashboard records / 400 WebPs = 372 records / 716 WebPs, 344 paired records |

The native app's smaller website bundle is intentional historical scope, not evidence that the full private plugin has been copied into the app. The remaining native website import is a separate decision and validation task.

### Dashboard quality work completed

- 24 canonical worker manifests, 200 pairs, 400 approved PNGs; no missing files, unlisted canonical files or metadata/proof drift in the final inventory.
- All 400 PNGs matched completed native ImageGen output events across 12 generation sessions. Source screenshots are not counted as generated output.
- WebP exports preserve dimensions, use quality 90 and strip metadata. Original generated PNGs remain outside the product repository for provenance.
- Exact duplicate checks cover all files. Workers reviewed all generated outputs; independent review examined 27 pairs/54 images. There were 19,900 paired-similarity comparisons, four flagged candidates judged distinct, and five repaired defects.
- This is **not** a guarantee that every possible semantic near-duplicate was independently reviewed. Similar designs can pass pixel hashes; keep the distinction explicit.
- Labels include identity, viewport, surface/family, group, source and generation/review provenance. Do not admit `attempt0` files merely because they exist.
- The repository exports contain generated approved images, not original captured websites or rejected attempts.

Inactive website breakdown: 767 rejected/correction outputs, 385 held, 154 reviewed but unpaired, 78 unreviewed, 50 excluded and 32 superseded. Preserve them externally. Reinstatement requires checking the specific reason, pairing, generation proof, duplicate risk, visual quality and manifest eligibility. Do not bulk-approve all 1,466 or regenerate them blindly.

The dashboard gallery is `E:/TasteCode-reference-library/production/2026-10-04-dashboards/generated-gallery.html`. The older website gallery is under `production/2026-10-02/generated-gallery.html`. See the asset appendix for precise final manifests and continuation scripts; old top-level README/report counts can be stale.

## 8. Standalone plugin and tutorial

The private `Leonxlnx/design-taste` repository provides plugin version **0.2.0**, with `library_status`, `sample_sections` and `view_reference` MCP tools, project-owned workflow instructions, a CLI, catalogs and approved WebPs. Both Codex and Claude installations were verified. A previous session may retain an older MCP process; an old session's library count is not necessarily the installed version. Do not restart the user's app merely to refresh it.

Repository entry points: `README.md`, `docs/dashboard-tutorial.md`, `docs/verification.md`, `src/library.mjs`, `src/cli.mjs`, `src/mcp.mjs`, plugin manifests and `skills/design-taste/SKILL.md`.

Validation commands in `E:/design-taste`: `npm test`, `npm run check`, and the documented CLI/MCP smoke commands. Six Node tests, syntax checks and actual stdio MCP calls passed in the completed work. Installed content and all 400 dashboard image payloads were checked for both hosts. Consult the fresh asset appendix for today's hash comparison.

Installed roots previously verified:

- Codex: `E:/Codex/.codex/plugins/cache/design-taste-private/design-taste/0.2.0`.
- Claude: `C:/Users/User/.claude/plugins/cache/design-taste-private/design-taste/0.2.0`.

An additional autonomous CLI model-build attempt encountered the Windows sandbox and did not complete. It is a recorded limitation, not a successful end-to-end build. Do not disable security to make a proof look green.

The external `workflow-demo` is a manually implemented reference-guided FormaStudio dashboard using a real random MCP draw (`dash-u011`). Thirteen headless checks passed: filtering/sorting, create/edit, local persistence/export, keyboard/focus, reduced motion and 320/390/768/1440 layouts. It illustrates the workflow and tutorial; it is not native TasteCode model-generation acceptance. Its old preview URL is not guaranteed to remain live.

## 9. Exact verification and known limits

The authoritative completed Windows run is [37228489532](https://github.com/Leonxlnx/tastecode/actions/runs/37228489532), workflow source `daee14ae6daa8d1a62576cde3c99954f042230e9`:

| Exact source                                         | Lint / typecheck / test / build | Passed | Existing skips | Failed |
| ---------------------------------------------------- | ------------------------------- | -----: | -------------: | -----: |
| Main fix `0fd03b2aabb7f2952826dd5d6a9d25559b17928d`  | All passed                      |  4,092 |             18 |      0 |
| Parent `67c7383cd579dce77677dd17a336f2b7f1f2b70c`    | All passed                      |  4,395 |             18 |      0 |
| Dashboard `edc92ea9c82c40b1c7e0b6f12aa329b2fa05f79e` | All passed                      |  4,445 |             18 |      0 |

Totals include 63 root Node script passes. Desktop executed in all three jobs: 368 passed, 10 existing skips within each total. The real Windows 8.3 regression ran and passed in all jobs; it was not skipped. Workers were limited to two and package concurrency to one. No test/workflow deadlines were increased; the existing server timeout remained 20 seconds.

Final merged nightly has the same product source, tests, configuration, dependencies and bundled assets as the tested dashboard SHA. Follow-ups changed only three status documents and two recorded screenshots. Its entire tree matched the final approved feature head `be743812` at completion. Today's main UI changes are newer and are not covered by that claim.

The earlier run [37226390998](https://github.com/Leonxlnx/tastecode/actions/runs/37226390998) failed a **real production bug**: long and 8.3 Windows aliases identified one Git common directory differently. Retention could then group incomplete checkpoint sets separately. Replacing `realpathSync` with `realpathSync.native` fixed the shared identity. A failing-before/passing-after local regression, original retention/GC assertions and all 36 checkpoint/audit tests established the fix. Do not weaken the original equality assertion or lowercase arbitrary paths instead.

Earlier local suites also suffered host timing failures. They remain failed evidence; the cause of the machine slowdown was not proven. A scoped longer-timeout diagnostic was not a full gate pass. The fresh hosted run above is the final full proof.

The last native browser/server smoke at `a02c6ab3490e55003aa2a95f977b8ccca690bea9` used isolated data, private headless Chromium and a synthetic local API endpoint. Two unsupported Design attempts added no inference requests and persisted no Design runs. Ordinary follow-ups preserved two API identities, models, messages and tool context across an owned server restart. Four completed turns, six fake API requests and 72 synthetic tokens; 14 stable fingerprints; no browser exceptions or leftover queued work. Owned processes were stopped.

**Still unverified for this dashboard feature:** completed generation with a real image-capable provider, visual fidelity/motion produced by that live model, OS keyring behavior, packaged Electron acceptance and macOS acceptance. Existing unit tests and the standalone demo do not remove those requirements before a release claim.

Key evidence under `production/2026-10-04-dashboards/`:

- `completion-verification.json`, `quality-audit-final-inventory.json`, `quality-audit-report.json`, `export-report.json`.
- `provenance-events/sanitized-native-event-proof.json`.
- `native-import-proof.json`, `native-formatted-catalog-proof.json`, `native-final-bundle-smoke.json`.
- `windows-ci-37228489532/verification-summary.json` and `full-run-logs.zip` (54 extracted files).
- `checkpoint-identity-before.log`, `checkpoint-identity-after.log`.
- `dashboard-native-runtime-smoke/2026-10-04T16-35-10-079Z/report.json`.
- `nightly-runtime-smoke/2026-10-04T14-47-56-196Z/report.json`.
- `plugin-verification/`, `workflow-demo/verification.json` and `mcp-proof.json`.

## 10. Releases, installer history and update behavior

Read `docs/RELEASING.md` before proposing a release. Source package version 0.1.2 does not mean 0.1.2 is published or installed. The fresh GitHub inventory includes assets, hashes, authors and release state.

- Published 0.1.1 is from `d2b3754cdb72090db3a80868f617d2e48dc8effc`. Historical proof covers Windows Beta 9 update/install/relaunch with chat/settings preservation, and a maintainer-reported signed/notarized macOS update. Automatic macOS relaunch and authenticated model calls were not established by those tests.
- Beta 7 through 0.1.1 select the newest publication, not the GitHub Latest badge. Publishing a newer-dated incomplete/older release can break their updater. The source fix chooses the highest semantic version and uses the release feed, but it is not retroactively installed in old clients.
- A Linux-only Beta 8 proof previously displaced the Windows/macOS release and was returned to draft. Do not republish it or delete/replace old bridge assets casually.
- Beta 7 and later can use Settings → About. Beta 9 added the sidebar update control. Older Beta 6 installs that missed the bridge can require manual installation.
- Windows signing was explicitly left unsigned when no trusted certificate/service was available. Do not claim unsigned installers are signed or that SmartScreen cannot warn.
- Blueemi owns actual macOS Developer ID signing, notarization, stapling and platform proof. Cross-building an unsigned DMG is not that proof.
- The current 0.1.2 draft targets old `9be8346d...`, describes itself as an unsigned packaging proof and contains September 23 assets. Both installers being present does not establish matching approved source, signing, notarization, update preservation or current model support. An earlier pasted signed-DMG hash `a764f74b...` differs from the current draft asset `435963ed...`. Reconcile provenance before any publication.
- Build both platforms from one agreed source SHA/version, validate licenses/native bindings/assets/checksums, test installed upgrades with isolated profiles, then publish compatible assets together. Do not label October 4 dashboard work as included in existing draft installers.

## 11. Historical user-visible bugs to regression-test

These are concrete reports from this conversation, not a fresh declaration that they all still fail. Implementation changes and release proofs exist for many, but confirm against the actual target build and provider.

| Report                                                 | Investigation / relevant boundary                                | Regression expectation                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Project switches collapse or lose chats                | Session selection, persisted history, renderer mount/reconnect   | Switch among active chats without cancelling work or showing false empty history                   |
| App disappears when launching agent/CLI exits          | Desktop/server process ownership and detachment                  | Installed app lifecycle independent of the shell that launched it                                  |
| Missing old chats after reinstall/profile changes      | App data paths, profile selection, migrations                    | Preserve real data; do not confuse a fresh profile with data deletion                              |
| Grok → Astra switch says project unavailable           | Workspace resolution and provider initialization                 | Valid projects remain usable; truly missing paths get actionable recovery                          |
| Repeated opening/closing questions in Design           | Brief protocol and ordinary-turn transition                      | One initial user prompt; autonomous brief; no generic final confirmation                           |
| Internal prompt/XML/JSON appears as user messages      | Origin metadata, provider history import, task notifications     | Show actual user text and normal progress, hide internal protocol wrappers                         |
| Preview `EADDRINUSE`, ignored requested port           | Preview reservation, command/env/URL rewrite, ready checks       | Automatically use free loopback port without killing unrelated servers                             |
| Asset gate demands nonexistent artist/client work      | Asset planning vs truthful input constraints                     | Acquire obtainable assets or explicit labeled concept/native components; do not fabricate evidence |
| Valid generated PNG rejected for embedded SVG metadata | Raster signature/metadata validation                             | Validate rendered format; preserve generation proof without false positives                        |
| Font destination is a directory                        | Asset validation and font acquisition                            | Validate actual file/directory requirements and repair manifest coherently                         |
| Palette 4.26:1 or copy-claim gate stops build          | Brand repair, advisory vs objective validation                   | Repair actionable issues within bounds; avoid impossible invention-driven requirements             |
| Very long Design run / repeated corrections            | Persisted phase attempts, corrective prompts, resume             | Bounded retries, transparent phase progress, completed work reused                                 |
| macOS install fails with `npm: command not found`      | Provider install distribution                                    | 0.1.1 historical fix/proof avoids assuming npm/Node on PATH                                        |
| Lost local server connection reopening long chat       | Bounded history frames, concurrent updates, recovery             | Chat reopens and subsequent RPCs stay responsive                                                   |
| Per-chat model/mode/approval reset                     | Session-level composer persistence                               | Retain provider/model, effort/speed, Design mode and approval configuration per chat               |
| Update asks for missing Beta 8 EXE on 0.1.1            | Release publication ordering vs semantic version                 | Current platform resolves correct highest compatible version with verified asset                   |
| Similar-looking generated sites / no animations        | Random group selection, fixed deck, actual visual implementation | Variety from real eligible groups and visible appropriate motion                                   |

## 12. Recommended next work, in order

1. **Read and verify.** Check current branches, PR/issue owners, package versions and installed app source. Read this handoff plus the two appendices and local inventory. Do not promise a release based only on old chat claims.
2. **Protect and reconcile local edits.** Identify the 17 tracked changes and other dirty worktrees; map them to merged PRs or still-owned work. Preserve unknown changes. Never `git add -A`, reset, clean, bulk-delete branches or push every ref.
3. **Sync newer main UI to nightly.** Normal merge, preserve full provider roster and dashboard catalog. Resolve docs explicitly and verify affected settings/API/Design flows. Keep public beta scope intact.
4. **Do real dashboard acceptance.** In an isolated project/profile, submit one dashboard prompt to an image-capable provider, inspect both selected references, monitor phase timings and generated desktop/mobile output, and exercise real controls/motion. Also check one marketing page about a dashboard to catch surface misclassification. No repeated blind prompts.
5. **Triage the live backlog with owners.** The appendix lists every open PR/issue and a suggested next step. Important is not synonymous with safe to merge; inspect current head, dependencies, provider scope, conflicts and tests. Do not merge Rust/mobile or unrelated contributor work under this handoff task.
6. **Resolve release provenance.** Choose an approved shared source commit and fresh version/build scope. Reconcile or replace the old draft only through verified artifacts; coordinate macOS proof with Blueemi. Test the update path from the actual public version before advertising it.
7. **Only then assess reference expansion.** The requested 200 dashboard pairs are complete. Additional generations or promotion of held website outputs should solve a specific coverage gap, not inflate counts. Native import of the larger private website pool is separate work.

## 13. Commands and operational traps

Use PowerShell/Node on Windows and cross-platform `node:path` in scripts. No `.sh` files. Node requirement is `>=22.18.0`, pnpm is pinned to `11.8.0`, TypeScript stays on 5.9.3. Recheck the selected checkout's package manifest before installing.

Read-only orientation:

```powershell
git status --short
git worktree list
git fetch origin --prune
git log -5 --oneline origin/main
git log -5 --oneline origin/nightly
git rev-list --left-right --count origin/main...origin/nightly
gh pr list --repo Leonxlnx/tastecode --state open --limit 200
gh issue list --repo Leonxlnx/tastecode --state open --limit 200
gh release list --repo Leonxlnx/tastecode --limit 100
```

In an **owned isolated checkout**, normal checks are:

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Resource-limited verification can use the already proven environment `VITEST_MAX_WORKERS=2` and `pnpm_config_workspace_concurrency=1`, recording those settings and actual outcomes. Do not increase deadlines to convert a failure into an unqualified pass.

`pnpm dev` starts the server, Vite and Electron together, normally on 4311/5183. **It can replace a running dev stack.** Running `tsc -b` in watched adapter directories can restart the server and kill live provider sessions. Use a separate checkout/data directory and free loopback ports for controlled tests; `tsc --noEmit -p ...` is safer for scoped checks in a shared watched checkout. Unset `ELECTRON_RUN_AS_NODE` in the child environment when actually launching Electron.

Windows `.cmd` shims require the repository's `spawnCli`; native `.exe` files should launch directly. Never hand-concatenate shell commands or credentials. Use `127.0.0.1`, not `localhost`. macOS test paths may need canonical `/private/var/...` TMPDIR. Keys belong in the OS credential store, not SQLite, fixtures or logs.

Keep CSP and WebSocket origin validation intact. A free loopback port is not a security boundary. No provider-specific branching in shared behavior except the existing approved voice-dictation exception. Avoid unstable callbacks in effect dependencies and transcript-wide work on every streamed delta.

The provenance archive contains sensitive original session context, and a supplied Downloads text attachment contains unrelated credentials. Do not open/copy it for design work; use sanitized provenance reports. No passwords, tokens, VPN material or raw user chat dumps belong in this handoff or a PR.

## 14. Scope of this handoff audit

This transfer checked GitHub metadata, repository history, current file locations, existing verification reports, artifact inventories and selected implementation entry points. It is not a fresh whole-codebase security audit, installer test, or execution of every open PR. The appendices distinguish current observations from historical evidence and suggested actions. Unknown ownership and platform proof remain unknown until checked.

The October 4 task is complete as source/plugin/assets work. The next agent should continue from the current remote source, not repeat generation or reconstruct the implementation from screenshots. Leon has explicitly asked for this Markdown transfer and for the completed handoff to be pushed.
