# Design Agent v0.5 validation — 2026-09-16

Branch: `codex/design-agent-v05`, based on main `8d9ac8d1`.
Draft PR: [#1159](https://github.com/Leonxlnx/tastecode/pull/1159).

## Four single-prompt runs

All four tasks were created through the TasteCode desktop UI using Computer Use, Astra Medium,
isolated application storage and fresh project directories. Each contains exactly one submitted
user prompt, no queued follow-ups and only the final briefing confirmation. No failed task was
re-prompted. The server used port 4315 and the renderer used port 5185.

| Site         | Result                               | Evidence / limitation                                                                                                                                                                                                                                      |
| ------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fieldwork    | Stopped during assets                | A hero photograph incorrectly listed the footer as another consuming section because the footer contained its credit. Exact section validation correctly rejected it. The asset prompt now distinguishes credits from image usage; no live rerun was made. |
| Orbit        | Completed                            | Built and passed its automated review, but that review originally saw partial captures. Full desktop/mobile captures were subsequently inspected.                                                                                                          |
| Atelier Fern | Built; preview stage failed          | Requested port 4174 was already occupied. The corrected static preview selected an available port and served this site successfully. Full desktop/mobile captures were subsequently inspected; the original task did not reach automated review.           |
| Clearpath    | Completed after one automatic repair | Preserved the existing brand and explicit hero reference. The repair supplied supplemental full-page screenshots before its final review passed.                                                                                                           |

These are not four uninterrupted passing runs. The PR remains draft because the asset clarification
and preview recovery have not been exercised by another complete Design run. Mobile menu interaction
and motion behavior were not independently verified in the final manual review.

## Reference and asset evidence

The external library contains ten individually reviewed desktop/mobile pairs from Meridian,
Ritovex and Scalient. The roughly one thousand raw generated images remain preserved; they are
not all approved catalog entries. Fieldwork and Atelier selected five Meridian pairs, Orbit
selected four Ritovex/Scalient pairs, and Clearpath retained its explicit Ritovex hero selection.
Selected paths and hashes were recorded before the completed flows cleared their active state.
Runtime tests cover random group selection, explicit choices, actual image attachment transport,
path validation and restart integrity. The generated sites use real attributed photography.

## Follow-up: navigation and failed-run handling

The supplied 24.7-second recording shows the previous project's drawer collapsing when a chat
in another project is selected. `ProjectRow` was mirroring the active-project flag into its open
state. It now only opens the newly active project; it preserves every other manual expansion.
The regression check covers project switching, leaving the active chat, manual collapse and
returning to a collapsed project. Computer Use verified switching from Atelier to Clearpath and
back while both drawers remained open.

[Before: recording frame](sidebar-before.png) · [After: both drawers remain open](sidebar-switch.png)

The Fieldwork validation failure also exposed a missing terminal turn event after the single
automatic correction was exhausted. That path now records a failed turn and failed phase activity
before reporting the error, so it cannot leave an unfinished turn in saved history. Its regression
also verifies queued user work still drains after failure. Existing historical error messages are
retained; these fixes do not relabel the earlier site runs as successful.

The isolated application was restarted with the updated server and desktop capture code. The
asset instructions now keep external URLs separate from attribution prose and permit truthful
local generation identifiers instead of requiring invented public URLs.

## Local checks

Windows checks passed: `pnpm lint`, `pnpm typecheck`, `VITEST_MAX_WORKERS=2 pnpm test`,
and `pnpm build`. The full suite includes 1,491 renderer tests, 712 server tests, 158 desktop tests
and 125 Design Agent tests. The complete 192-test orchestration suite also passed separately;
the two affected correction tests and all 125 Design Agent tests passed after the final prompt
and accepted-output refinements. Lint and type checking were repeated for those refinements.
Logs are retained outside the repository in `E:/TasteCode-backups/v05-*-verified.log` and
`v05-*-latest.log`.

Local inputs and native capture results are retained under
`E:/TasteCode-v05-clean/evidence/`. Library configuration is documented in
[DESIGN-REFERENCES.md](../../DESIGN-REFERENCES.md). No external design skill was used.

## Capture and preview regression checks

The old native capture clipped a document-sized rectangle to the visible viewport. The replacement
uses `Page.captureScreenshot` with `captureBeyondViewport` on a private offscreen Electron window,
and instant scrolling before capture. This follows the
[Chrome protocol capture API](https://chromedevtools.github.io/devtools-protocol/1-3/Page/#method-captureScreenshot).
Existing local-origin restrictions, size bounds, cancellation and cleanup remain in place.

A native Electron smoke check using the compiled production capture owner produced all six full-page
images below. Each has one H1 and no undersized interactive targets reported by the DOM audit.
The final visual inspection found all sections present without obvious clipping. This is visual
evidence, not a claim of pixel-perfect reference matching or complete interaction coverage.

| Site         | Desktop pixels | Mobile pixels | Screenshots                                                       |
| ------------ | -------------- | ------------- | ----------------------------------------------------------------- |
| Orbit        | 1440 × 3145    | 390 × 3833    | [Desktop](orbit-desktop.png) · [Mobile](orbit-mobile.png)         |
| Clearpath    | 1440 × 2072    | 390 × 2165    | [Desktop](clearpath-desktop.png) · [Mobile](clearpath-mobile.png) |
| Atelier Fern | 1440 × 3920    | 390 × 4560    | [Desktop](atelier-desktop.png) · [Mobile](atelier-mobile.png)     |

Desktop capture/settle regression tests: 43 passed. Server preview-runner tests: 38 passed,
including two previews requesting the same port while retaining independent site ownership.
A live Atelier preview also verified the occupied-port fallback.

The isolated server normalized Windows PATH casing at startup to work around an existing
base-branch CLI launch issue owned by another contributor. No provider implementation was changed.
No hosted CI, deployment or release was started. A verified pre-change backup remains outside
the repository. Automatic approval review rejected deleting the earlier test storage; the four
new tasks instead used fresh isolated storage, and the old data remains inactive.
