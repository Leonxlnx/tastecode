# Claude handoff: reference production and Design Taste plugin

Date: 2026-10-09, Europe/Berlin. This is a requested handoff, not an instruction to resume image generation automatically.

## Read this first

The reference collection and standalone plugin are separate deliverables from the TasteCode application. Do not conflate their counts, their branches, or their verification.

- The current private plugin is **Design Taste 0.2.0**, in `E:/design-taste`, remote `https://github.com/Leonxlnx/design-taste.git`.
- It contains **1,129 approved website desktop/mobile pairs plus 200 approved dashboard desktop/mobile pairs**, totaling **2,658 WebPs** and **870 composition groups**.
- The large external production collection is `E:/TasteCode-reference-library`. It intentionally retains originals, rejected attempts, individual unpaired generations and proof. These are not all approved, and this external folder is not the plugin repository.
- The original website collection has **3,724 unique proven ImageGen outputs**, of which **2,258** are currently active approved-pair images and **1,466** are inactive. The separate dashboard collection adds **400** approved generated images. Do not claim that all retained images are approved references or that the older collection contains 1,500 approved pairs.
- The native TasteCode dashboard worktree contains the 400 new dashboard images but a much smaller legacy website library. It does **not** contain the plugin's entire 2,258-image website expansion.
- The shared `D:/personalharness` checkout is still at old September 13 commit `e4f8b126`, 382 commits behind current main, and has no `packages/design-agent/references/library` directory. Current nightly and the clean handoff checkout do contain the native library. This is a stale-checkout distinction, not evidence of a rewrite or lost assets; do not overwrite its uncommitted work.
- A fresh read-only audit on October 9 rehashed every catalog image in the plugin, its two installed caches, and the preserved native worktree. The full local inventory is `E:/TasteCode-reference-library/production/2026-10-09-handoff/asset-plugin-inventory.json`. No originals, app state, installed configuration or Git working tree were changed.

## Current Git state of the private plugin

Verified with live `git ls-remote` on October 9:

| Item                            | Value                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------- |
| Repository                      | `https://github.com/Leonxlnx/design-taste.git`, private                      |
| Local checkout                  | `E:/design-taste`                                                            |
| Local branch                    | `codex/dashboard-reference-library`                                          |
| Local HEAD                      | `933f1cf92254018e1f5ce804af762cde42b14086`                                   |
| Remote main                     | `d2ba0763dd1f9f5068c2f356067dac0547ebe321`                                   |
| Local changes                   | None                                                                         |
| HEAD versus remote-main content | Entire trees identical; commit identities differ because the work was merged |
| Remaining remote branches       | `main`, `codex/dashboard-reference-library`                                  |
| Original merged PR              | `https://github.com/Leonxlnx/design-taste/pull/1`                            |

There is no unpublished asset or code diff in this plugin checkout. Do not create a redundant "push everything" commit. The remote feature branch is redundant by content, but this audit did not delete it.

## Where everything is

| Path                                                                                      | Purpose                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E:/TasteCode-reference-library/sites.json`                                               | Original 55 submitted URL entries, 54 unique hosts; Karo appears twice. Old per-entry status fields are historical.                                  |
| `E:/TasteCode-reference-library/<page-slug>/originals/`                                   | Original site captures, including dated capture directories. Not generated references.                                                               |
| `E:/TasteCode-reference-library/<page-slug>/generated/`                                   | Website ImageGen PNGs, including retained rejected/alternate/unpaired variants.                                                                      |
| `E:/TasteCode-reference-library/<page-slug>/manifest.json` and dated `production-*.jsonl` | Capture geometry, inputs, prompts, output hashes, chronological generation and pair-review decisions. Actual filenames vary by historical page.      |
| `E:/TasteCode-reference-library/catalog.json`                                             | External production selection; not the standalone plugin catalog.                                                                                    |
| `production/2026-10-01/`                                                                  | Earlier expansion reports, queues and proof.                                                                                                         |
| `production/2026-10-02/`                                                                  | Whole-site continuation, canonical source audit, label inventory, proposed catalog, export staging and quarantine.                                   |
| `production/2026-10-02/generated-gallery.html`                                            | Website gallery. Historical entries and production labels need their review state interpreted correctly.                                             |
| `production/2026-10-03-plugin-audit/`                                                     | Final website provenance, semantic/group corrections, similarity and host-install verification.                                                      |
| `production/2026-10-04-dashboards/generated/`                                             | Exactly the 400 approved canonical dashboard PNGs at the completed checkpoint.                                                                       |
| `production/2026-10-04-dashboards/attempts/`                                              | Rejected or superseded dashboard outputs; never count these as approved additions.                                                                   |
| `production/2026-10-04-dashboards/workers/`                                               | 24 canonical worker ledgers plus request/helper files. Only approved canonical records count.                                                        |
| `production/2026-10-04-dashboards/online-originals/`                                      | Public-source dashboard/app input images, separate from generated outputs.                                                                           |
| `production/2026-10-04-dashboards/generated-gallery.html`                                 | Finished 200-card, 400-image dashboard gallery.                                                                                                      |
| `E:/design-taste/library/images-20261002/`                                                | Portable approved website WebPs bundled in the plugin.                                                                                               |
| `E:/design-taste/library/dashboard-images/`                                               | Portable approved dashboard WebPs bundled in the plugin.                                                                                             |
| `E:/tc-dashboard-agent/packages/design-agent/references/library/`                         | Preserved native TasteCode integration's legacy website catalog plus new dashboard catalog. Read as historical source, not current shared-app state. |

All relative `production/...` paths in this handoff are under `E:/TasteCode-reference-library`.

## Website collection: exact counts and proof

The October 3 native-origin audit established:

| Measurement                                           | Count |
| ----------------------------------------------------- | ----: |
| Raw files in page `generated/` subtrees               | 3,726 |
| Unique byte hashes                                    | 3,724 |
| Duplicate file aliases                                |     2 |
| Unique desktop images                                 | 1,824 |
| Unique mobile images                                  | 1,900 |
| Current approved complete responsive pairs            | 1,129 |
| Active images in approved pairs                       | 2,258 |
| Inactive unique images                                | 1,466 |
| Native completed ImageGen proof gaps                  |     0 |
| Exact collisions with scanned original/input captures |     0 |

These are generated edits, not 3,724 untouched screenshots renamed as output. The audit joined current PNG hashes to preserved native result bytes from completed image-generation events. It scanned 17,657 original/capture/input raster lengths and found no candidate with an equal target byte length; consequently no exact source-byte identity existed. Origin proof is independent of visual approval, pairing and generation-date completeness.

The 1,466 inactive images are:

| State                                       | Images | What to do                                                                                      |
| ------------------------------------------- | -----: | ----------------------------------------------------------------------------------------------- |
| Rejected or needs correction                |    767 | Preserve original rejection evidence; do not silently promote.                                  |
| Held                                        |    385 | Read the exact reason and source geometry before deciding whether another attempt is justified. |
| Individually reviewed without approved pair |    154 | Inspect the missing/failed counterpart and approve the complete pair explicitly.                |
| Unreviewed                                  |     78 | Full image and source/pair review is required.                                                  |
| Excluded                                    |     50 | Mostly threshold padding or already-covered content; no count credit.                           |
| Superseded                                  |     32 | Keep out of active sampling.                                                                    |

Separate quarantine contains 138 proven outputs. Eight hashes also exist under collection aliases, so quarantine adds 130 unique hashes, giving 3,854 combined historical hashes. These are not an extra 138 approved assets. Six active aliases also have rejected history; their later counterpart repairs or corrected source reviews were reconciled chronologically. See `provenance-active-quarantine-history.json` rather than inferring current rejection from a filename.

Canonical website evidence:

- `production/2026-10-02/collection-labels.json` and `collection-labels-summary.json`.
- `production/2026-10-03-plugin-audit/provenance-report.json` and `provenance-report.md`.
- `production/2026-10-03-plugin-audit/provenance-hash-facts.json`.
- `production/2026-10-03-plugin-audit/provenance-active-quarantine-history.json`.
- `E:/design-taste/library/provenance.json`: portable sanitized links for all 2,258 bundled website images.

Raw proof logs are private. Do not publish raw session logs, account files, inline tool-result payloads or credentials. The portable provenance files are attestations with hashes and event metadata; a clone alone cannot replay private original events.

## Source-site coverage and the honest completion boundary

`source-coverage-all54.json` and its Markdown companion record all 54 supplied hosts, not just the original 25 pilot hosts. The final known queue had zero genuinely untouched useful candidates. **53 hosts have approved pairs. MaestroClass did not**: its supplied page/sitemap was unavailable, and historical fragments did not establish a complete authentic responsive source. No fabricated substitute was counted.

This means the recorded source discovery/queue was processed, not that every conceivable current subpage of every live website has been exhaustively captured forever. The sites may have changed since October 2. Existing held sources and unavailable pages remain visible and are not falsely counted complete.

The source audit reports 1,129 approved pairs across all runs, 517 current-run pairs, 19 held/already-attempted source pointers, and 25 settled repair pointers. All 49 repair inputs had final decisions: 24 approved paired repairs and 25 held/rejected. Repair results received no "new source" credit. Parent source aliases and native component representatives were not counted twice.

For exact source URLs and page-slug coverage, use [website-sources.json](website-sources.json). For unresolved detail, use:

- `production/2026-10-02/source-coverage-all54-residual-classification.json` and `.md`.
- `production/2026-10-02/source-coverage-all54.json`.
- The specific page's chronological ledger and exact source hashes.

## Labels, grouping and duplicate control

Each portable approved reference has ID, family, group, source URL, cue, tags, review status/notes, pair evidence, desktop/mobile paths, width/height/format and SHA-256. Dashboard references also carry surface, full-screen scope, source name and domain.

Website families are hero, about, feature, how_it_works, social_proof, stats, faq, cta, pricing, contact and footer. The plugin contains 960 whole-section references and 169 native-component references. Components do not silently count as full landing-page sections.

Current website sampling uses **670 groups and 110 hero groups**. Older external reports say 674 groups; four confirmed equivalent groups were subsequently merged in the plugin. The raw cross-ledger evidence inventory reports 677 groups and is not the current sampler count. Consult `library/catalog-corrections.json` for the recorded label/group changes. Avoid globally replacing old report numbers without preserving their measurement scope/date.

Website similarity screening compared 636,756 reference pairs using both viewports. Nine flagged cross-group candidates were visually checked; five were distinct and retained. An additional Stodio match was found through provenance. Twenty-two mixed-content references had both widths reviewed and descriptions corrected. Exact duplicate checks are stronger than perceptual heuristics: the current plugin has zero repeated image hashes, but no audit proves that every semantic near-duplicate is impossible.

The user explicitly wanted randomness over actual reference compositions. Selection uses `node:crypto.randomInt`, first choosing a composition group, then a variant. A group with many CMS/photos does not get extra probability merely by having more variants. Preserve stable IDs and group mappings, avoid repeated redraws until a familiar style appears, and keep both responsive counterparts together.

## Dashboard expansion

The completed dashboard target was 200 pairs, 200 desktop plus 200 mobile, across 200 distinct source hashes/composition groups:

- 43 user-supplied app views: `input-inventory.json`, IDs `dash-uNNN`.
- 56 public-source views: `online-sources.json`, IDs `dash-oNNN`.
- 101 further public-source views: `online-sources-extra.json`, IDs `dash-eNNN`.

The public sources include app/project/productivity, creative/media, developer/observability, commerce, operations, health and mobile screens. Source manifests and the final catalog retain exact source URLs and native/derived viewport evidence. The second responsive viewport is often a generated adaptation of the observed source, not a claim that the original product supplied a native desktop/mobile pair. The Plane open-panel example is explicitly composite-derived and its radar schematic.

All 400 approved canonical PNGs were independently matched to actual native completed ImageGen result bytes from 12 relevant session logs. The sanitized proof is `provenance-events/sanitized-native-event-proof.json`; `proof-summary.json` reports 400 unique completed-event matches, zero gaps/mismatches/incomplete pairs/stability failures.

Worker reviews cover every generated image. Independent review covered 27 pairs/54 images; five concrete defects were fixed and rechecked. All 19,900 two-viewport pairwise comparisons were screened; four candidates were visually distinguished. Current final inventory had no unlisted files, missing files or metadata issues. These checks do not amount to independent exhaustive OCR or proof of no semantic similarity.

Canonical records are only `workers/user-[a-z].json`, `online-[a-z].json` and `extra-[a-z].json` with explicit approved records. Do not count `*-task.json`, request receipts, attempts, pending/skipped files, superseded generations or the excluded incomplete source o041.

## PNG to WebP pipeline

Preserve original generated PNGs externally for provenance and future review. Bundle portable approved WebPs only. Website export uses libwebp quality 90, compression level 6, unchanged image dimensions; dashboard export additionally strips metadata. The PNG and WebP intentionally have different hashes because the encoding is lossy.

| Bundle            | Images | Image bytes |
| ----------------- | -----: | ----------: |
| Plugin websites   |  2,258 | 231,634,486 |
| Plugin dashboards |    400 |  42,203,164 |
| Combined          |  2,658 | 273,837,650 |

The dashboard source PNGs total 509,061,415 bytes. All approved PNGs/WebPs were decoded during production verification. One original Plane WebP had an FFmpeg alpha-decoder issue and was verified in the native viewer with an exact exception record; its generated outputs decoded normally. Six sampled website PNG/WebP comparisons had SSIM 0.9896 to 0.9983. This sample is not a per-file perceptual-fidelity score for the entire library.

Useful scripts, inspect before rerunning because some write reports/catalogs:

| Script                                                             | Function / caveat                                                                                                                                                                                                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `production/2026-10-02/tools/capture-site.mjs`                     | Headless isolated Chrome/CDP capture, allowlisted original host, desktop/mobile and selector/interaction states. Creates owned profiles/output folders. Never connect it to the user's browser.                                                |
| `.../tools/save-image.mjs`                                         | Validates actual native output PNG and evidence, refuses overwriting different bytes, appends generation/pair review to the page ledger.                                                                                                       |
| `.../tools/audit-source-coverage-all54.mjs`                        | Reconciles source/ledger/catalog coverage. Writes audit reports.                                                                                                                                                                               |
| `.../tools/inventory-collection-labels.mjs`                        | Full collection labeling inventory; does not itself grant visual approval.                                                                                                                                                                     |
| `.../tools/export-generated.mjs`                                   | Exports the proposed approved catalog to local repo staging. Carries legacy compatibility files. Has historical machine paths; do not run blindly against the old dirty shared checkout.                                                       |
| `.../tools/verify-portable-export.mjs`                             | Checks staged legacy native export through pinned runtime, hashes and decode proof. Its old Markdown status is stale.                                                                                                                          |
| `production/2026-10-03-plugin-audit/provenance-imagegen-audit.mjs` | Reconciles native ImageGen origin; depends on private local evidence and writes audit files. Avoid unnecessary raw-log reprocessing.                                                                                                           |
| `.../audit-similarity.mjs`                                         | Perceptual website similarity screening. Human/agent image review must adjudicate matches.                                                                                                                                                     |
| `production/2026-10-04-dashboards/export-dashboard-library.mjs`    | Selects canonical approved records, requires completed-event proof and containment, exports dashboard WebPs/catalog/provenance. Default target is `E:/design-taste/library`; `DASHBOARD_EXPORT_LIBRARY` can redirect an owned staging library. |
| `.../verify-dashboard-export.mjs`                                  | Loads actual plugin code, verifies all dashboard image hashes, uniqueness/provenance and portable metadata. Writes `verify-export-report.json`.                                                                                                |
| `.../quality-audit-final-inventory.mjs`                            | Canonical record/file/label completeness and orphan check.                                                                                                                                                                                     |
| `.../quality-audit-scan.mjs`, `.../quality-audit-visual.mjs`       | Dashboard similarity/review evidence.                                                                                                                                                                                                          |
| `.../build-gallery.mjs`                                            | Rebuilds dashboard gallery.                                                                                                                                                                                                                    |

Historical scripts can contain fixed destinations or obsolete checkpoint assumptions. Read them and use owned staging before any future mutation. Never infer completion from filenames like `attempt0`, and never rename a rejected attempt to look approved.

## Plugin architecture and workflow

The plugin is zero-dependency Node ESM, requires Node 20+, and needs private Git access for installation. It supplies references and workflow, not a separate coding model, image-generation backend or hosted service.

| File                                                                         | Responsibility                                                                                                       |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/library.mjs`                                                            | Catalog loading, path containment, verified image hashes, website/app intent, scope and group-first random sampling. |
| `src/mcp.mjs`                                                                | Stdio MCP server; tools `library_status`, `sample_sections`, `view_reference`. No TCP listener or network requests.  |
| `src/cli.mjs`                                                                | Local status/sample/view debugging.                                                                                  |
| `skills/design-taste/SKILL.md`                                               | Authored workflow consumed by host coding agents. It is this project's own skill, not the unrelated GPT Taste skill. |
| `library/catalog.json`                                                       | 1,129 approved website pairs.                                                                                        |
| `library/catalog-corrections.json`                                           | Audited label/composition-group changes.                                                                             |
| `library/provenance.json`                                                    | Website PNG/native-event to bundled-WebP links.                                                                      |
| `library/dashboard-catalog.json`                                             | 200 reviewed complete app-screen pairs.                                                                              |
| `library/dashboard-provenance.json`                                          | Dashboard provenance links.                                                                                          |
| `plugin.json`, `mcp.json`, `.agents/plugins/marketplace.json`                | Codex/agent-plugin declarations.                                                                                     |
| `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json` | Claude Code declarations; `${CLAUDE_PLUGIN_ROOT}` resolves the local server.                                         |
| `README.md`, `docs/dashboard-tutorial.md`, `docs/verification.md`, `NOTICE`  | Installation, usage, evidence/limits and source attribution.                                                         |
| `test/library.test.mjs`, `test/mcp.test.mjs`                                 | Data/selection integrity and real stdio MCP behavior.                                                                |

Workflow intent:

1. Read prompt and project, preserve existing brand and stack, and distinguish website versus dashboard/app. A landing page marketing a dashboard is still a website.
2. Select relevant section families randomly, or one complete dashboard screen by default. User-provided references take priority. Whole landing pages normally use at least eight appropriate sections; explicit smaller scopes override that. Dashboards have no eight-section requirement.
3. Actually inspect both desktop and mobile image pixels. Use the chosen source's geometry and creative details; adapt brand/copy/project imagery lightly. Do not invent the overall composition from nothing while claiming to follow references.
4. Build working responsive controls; dashboard navigation, filters, sorting, forms, charts and details must form a coherent task. Label synthetic data honestly.
5. Add meaningful action/state motion, keyboard access and reduced-motion handling. Static reference images do not prove animation works.
6. Use host ImageGen if available, otherwise appropriate available image search. Do not require missing proprietary client artwork to complete a fictional demo, and do not invent real customer endorsements or ownership.
7. Start a preview on an available `127.0.0.1` port, inspect desktop/mobile, polish and recheck. Never return only a preview JSON plan when an actual running preview was requested.
8. Report actual changes/tests in normal prose. No mandatory initial questionnaire, final catch-all question or rigid phase-response JSON gate belongs to the plugin workflow.

## Install and use in Claude

Existing verified cache:
`C:/Users/User/.claude/plugins/cache/design-taste-private/design-taste/0.2.0`.

Fresh October 9 inspection confirms its manifest is version 0.2.0, all 2,658 image hashes match, and the library/CLI/MCP/skill bytes match the source checkout. This proves cache contents, not that a particular already-open chat has reloaded them. Historical October 4 actual-user installation recorded the plugin enabled. This audit did not mutate settings or start any host.

```text
claude plugin marketplace add https://github.com/Leonxlnx/design-taste.git
claude plugin install design-taste@design-taste-private --scope user
```

For an existing registered installation:

```text
claude plugin marketplace update design-taste-private
claude plugin update design-taste@design-taste-private --scope user
```

Open a new Claude Code session, then invoke `/design-taste:design-taste` with a real build request. For isolated local development, use `claude --plugin-dir "E:/design-taste"`. No TasteCode instance is required.

The Codex cache is also preserved and fresh-hash-verified at `E:/Codex/.codex/plugins/cache/design-taste-private/design-taste/0.2.0`; the user is moving to Claude, so no need to restart or modify Codex.

Local inspection/check commands from `E:/design-taste`:

```text
node src/cli.mjs status
node src/cli.mjs sample --surface dashboard --request "Build a delivery operations dashboard with filters and a detail drawer"
node src/cli.mjs sample --families hero,about,feature,feature,how_it_works,social_proof,faq,cta,footer
node src/cli.mjs view <selected-reference-id> mobile
npm test
npm run check
```

The `sample` command makes a new random draw. Do not repeatedly rerun it merely to reproduce checks for an already-selected project.

## Native TasteCode versus plugin counts: important discrepancy

Fresh October 9 hashing of the preserved native worktree found:

| Library                       | Entries | Complete pairs | Images |
| ----------------------------- | ------: | -------------: | -----: |
| Native legacy website catalog |     172 |            144 |    316 |
| Native dashboard catalog      |     200 |            200 |    400 |
| Native total                  |     372 |            344 |    716 |
| Standalone plugin total       |   1,329 |          1,329 |  2,658 |

The native legacy website catalog has 10 reviewed entries and 162 candidates; its schema lacks the newer explicit `assetType` field. Absence of that field is not proof those rasters are original screenshots. Native legacy loading/review policy differs from the stricter standalone plugin loader. The dashboard import preserved the existing native website catalog deliberately rather than silently replacing it. Do not claim all 372 native entries are fully reviewed complete pairs.

All 400 native dashboard WebPs match the plugin. The native dashboard catalog hash is `a23a016090588dd1cffc14dc5667b0046379948a6924ad2099a3b614c5ee393b`; the plugin catalog is `98278a715f9a394b90a27ec83c0306fe2ab93c5a00324d1748a6e414659739b1`. Stored proof verifies parsed JSON equivalence and a Prettier-only formatting difference, with the other 401 imported files unchanged.

If the user later requests full native website parity, plan a distinct integration against the current product architecture. Do not copy the private plugin library into an unrelated current branch without checking scope, packaging size, licensing/attribution, legacy IDs, pairing/review behavior and tests.

## What was actually verified and what was not

Historical October 3/4 checks in `E:/design-taste/docs/verification.md`:

- Six plugin tests and syntax checks passed, including exact 200-dashboard-pair invariant, all bundled hashes, group weighting, routing, scope, source priority, containment and corrupt/invalid input recovery.
- Real stdio MCP initialized, listed and called all three tools, and retrieved image payloads.
- Fresh private-Git installations were exercised in Codex CLI 0.154.0 and Claude Code 2.1.280; both hosts discovered the skill and connected the plugin server. All installed images were hash-verified, and all 400 dashboard payloads were retrieved.
- These installation checks did not send paid model requests.
- An independent Forma Studio dashboard demo used one real random MCP selection (`dash-u011`), inspected both viewports, and implemented the interface manually through the authored workflow.
- Its 13 headless checks passed: coherent records/charts, filter/search/sort, empty state, editing/creation validation, local persistence, export, navigation, keyboard/dialog focus, reduced motion, mobile editing and no overflow at 320/390/768/1440. Five screenshots were reviewed.

Demo: `production/2026-10-04-dashboards/workflow-demo`. Read its README. `node server.mjs` starts an owned server on a free loopback port; do not assume its recorded old URL is still live. `verification.json` and `mcp-proof.json` are the evidence. `select-reference.mjs` was run once; rerunning it changes the draw.

An additional autonomous model-driven build test **did not pass**. It was blocked by Windows sandbox provisioning/restricted-token execution. The final report says `extra-model-build-test-blocked-by-host-sandbox`, not a plugin functional failure or an E2E success. Do not bypass that sandbox or claim the requested autonomous build ran. See `plugin-verification/model-e2e/supported-sandbox/final-report.json`.

Still not established by these assets/plugin reports:

- A complete real-model, image-capable native TasteCode dashboard build end to end.
- A paid Claude model conversation completing a website solely from plugin invocation.
- macOS plugin/app execution on this Windows machine.
- Packaged app behavior merely because source-level/native MCP checks passed.
- Exhaustive semantic near-duplicate exclusion, pixel-identical geometry, or correct chart arithmetic inferred from static reference pixels.
- Ownership/licensing of arbitrary real-subject production imagery; source attribution is preserved, and generated references guide composition.

The fresh October 9 audit repeated hashes and manifest/runtime equality only; it did not rerun the historical browser/host/model tests. The local `E:/TasteCode-reference-library/production/2026-10-09-handoff/asset-plugin-inventory.json` names report dates and scopes.

## Stale artifacts that must not mislead the next agent

1. `E:/TasteCode-reference-library/README.md` preserves old 500+500 pause and early expansion snapshots. Those instructions/counts are historical, not the current active queue.
2. `sites.json` status strings still include `in-progress` from early collection. The October 2 all-54 coverage report is the later authoritative queue audit.
3. `production/2026-10-02/repo-export-validation.md` says a 761-pair staged export failed pending restaging. That was an intermediate artifact and is superseded for the standalone plugin by final October 3 provenance, corrected 1,129-pair catalog and October 4 verification. Do not treat it as proof the current plugin is broken, and do not erase the failure history.
4. Older 674/677 group counts describe different pre-correction or raw-ledger measurements. The current standalone website sampler reports 670.
5. The shared application checkout predates the native reference directory. Current nightly, the private plugin and the preserved native worktree still contain the expected libraries and hash correctly; update from the correct remote branch only after protecting local edits.

## Suggested next actions for Claude

1. Read the overall project handoff and current repository instructions, inspect live branches/PR ownership, and determine what the user wants to work on next. Do not start another overnight image run just because historical queues exist.
2. For the immediate switch, use the already-installed Claude plugin or `--plugin-dir` and a new chat. Verify `library_status` before a real build.
3. If evaluating output quality, use one recorded random draw, inspect both actual images, implement a real task and test controls/motion/mobile. Preserve the selected reference throughout polish.
4. If extending the collection, select genuinely new source geometry or repair a specific held item with a documented reason. Preserve originals and rejected attempts. Maintain complete pairs, full source-to-output hashes, explicit visual review and true composition grouping; never pad counts with crops, trivial variants or unpaired files.
5. If synchronizing the app and plugin, treat that as an explicit new parity feature. Reconcile the current app architecture and existing legacy references before import. Keep source screenshots and raw account/session data out of public Git.
6. Keep claims precise: reviewed/generated/paired/active/native/derived and tested/untested mean different things.

No image generation, app/browser launch, process stop, installation update, credential access or branch mutation occurred during this handoff audit.
