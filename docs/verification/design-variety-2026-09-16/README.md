# Reference fidelity and private beta 2 verification

Code merged in PRs #1202, #1203, #1204 and #1205. Verified runtime source:
`2d6072e6795f7a465932c5663f22291056d80919`. The repository remains private.

[Earlier same-day checks](./earlier-checks.md) retain the prior model-picker, follow-up,
security and app-restart evidence. The results below cover the later overnight changes.

## Changes

- New runs retain reference geometry, line breaks, labels, borders, spacing and media count.
  Page records measurable geometry; Build and Review compare it at desktop/mobile widths.
  Existing asset provenance and SVG-substitution checks remain enforced. Pattern matching
  cannot decide whether a border belongs to a reference; visual Review makes that comparison.
- A persisted `node:crypto.randomInt` draw selects from forty verified font families: ten
  sans, ten serif, ten display and ten mono. Explicit user fonts and existing identities win.
  Acquisition must obtain actual fonts; Build verifies a loaded FontFace as well as the font
  API check, which alone could accept a fallback. [Official source checks](./font-sources.json).
- Fixing `url` metadata and complete-capture discovery exposes 172 composition groups,
  316 original image files, 144 mobile pairs and 24 heroes. Every bundled sampling pool has
  at least ten distinct groups and files; sparse topics use compatible image geometry with
  its real layout family retained. These are not claims of ten native pricing/contact layouts.
  Revisions do not get extra votes. [Inspected hero overview](./hero-gallery.png).
- Build receives a tested native reveal implementation. It prepares only offscreen elements,
  observes before entry, plays once, and restores visibility on cleanup or reduced motion.
  It never hides already painted content to start a late opacity-zero entrance.

## Checks

An isolated source export combined current main with the changes without touching the running
app. All four gates passed: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
Design-agent: 134 tests; web: 1,521; server: 772; desktop: 172. Adapter/package suites passed
with their existing skips. Release-tool checks: 41 passed, one skipped. Targeted checks were
repeated after the final font-verification and packaging-verifier changes.

A separate hidden Electron browser exercised a tall section, two rapid down/up cycles,
restored mid-page scroll, reduced-motion changes and cleanup. Fourteen recorded visibility
samples stayed fully visible after their first reveal. [Browser results](./motion-result.json).
The portable unit test covers initial visibility, observer lifecycle and remount behavior.

The Windows candidate's real packaged Design module loaded 172 references, verified all 316
image hashes, drew fourteen different groups, and returned ten font choices per category.
Packaged licenses, updater configuration, renderer and all 451 reference/resource files match
the source. Packaged PTY and OS keyring proofs passed. The tested export matches all 1,961
runtime/tooling files tracked by the main commit above.

## Candidate and remaining release checks

`TasteCode-0.1.0-beta.2-win-x64.exe` was built locally with `--publish never`.
Size: 510,237,067 bytes. SHA-256:
`6abc8a284d597cf61cf9019f7811f2ce31f4ef0aa5d4240343c3ca2a9d14a496`.

This is an unsigned Windows testing candidate, not a published or clean-machine-qualified
release. The existing installer install/uninstall gate requires an isolated hosted Windows
runner and was not bypassed. No hosted CI was dispatched. No macOS artifact was produced on
Windows; macOS packaging and native validation still require Apple Silicon macOS.

The user's current app and active tasks were left running. Existing generated websites were
not edited. New real-provider website runs and final visual acceptance remain with the user;
passing workflow tests does not prove every future model output is visually faithful or smooth.
Public asset redistribution and release approval remain separate gates; no public release or
repository-visibility change was made.
