# Reference fidelity and private beta 2 verification

Code merged in PRs #1202, #1203, #1204, #1205 and #1206. Verified runtime source:
`0f53966431c2e7878a51896687fe56392a51ca01`. The repository remains private.

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
repeated after the final font-verification and packaging-verifier changes. Final lint, typecheck,
build, 134 design-agent tests and 210 orchestration tests passed after restricting draw overrides
to the original user prompt and actual answers; inferred brief notes cannot pin the random choice.

A separate hidden Electron browser exercised a tall section, two rapid down/up cycles,
restored mid-page scroll, reduced-motion changes and cleanup. Fourteen recorded visibility
samples stayed fully visible after their first reveal. [Browser results](./motion-result.json).
The portable unit test covers initial visibility, observer lifecycle and remount behavior.

The Windows candidate's real packaged Design module loaded 172 references, verified all 316
image hashes, drew fourteen different groups, and returned ten font choices per category.
Packaged licenses, updater configuration, renderer and all 451 reference/resource files match
the source. Packaged PTY and OS keyring proofs passed. The tested export matches all 1,961
runtime/tooling files tracked by the main commit above.

## Windows provider startup correction — 2026-09-17

Private beta 3 (`714dce34`) corrects a packaged Windows startup failure: copying `process.env`
made its `Path` key case-sensitive, and adding a second `PATH` discarded System32. Shared CLI
discovery, provider launch and terminal environments now preserve and normalize that path.
Missing-program errors no longer claim that the project directory is unavailable. The packaged
native proof now launches a real system command through the same helper as providers.

All four local gates passed. The first full test run overlapped installer compression and hit
two existing one-second startup waits in `audit-regressions.test.ts`; the isolated six-test
suite and a full rerun without compression both passed, without changing those tests. Final
server checks: 774 passed; desktop: 172; web: 1,521. Focused regression checks: 45 passed, one skip.

The real beta 3 package passed reference/license/renderer verification, native PTY and keyring
proofs, and launch checks for Codex, Claude Code and Grok. Codex returned eight models including
Astra and a signed-in account. The installed app was then started using persistent Windows
environment paths, with no development server or Codex-session-only home override. Its own
WebSocket API confirmed successful model/account requests and all 99 existing chats. Both
history profiles were backed up before their earlier merge; the installer keeps the normal
installed profile. No website-generation prompts were submitted for this verification.

Installer: `TasteCode-0.1.0-beta.3-win-x64.exe`, 510,237,506 bytes, SHA-256
`b21ab908fcaba2f9d264f7a926b53e3668afce6a0b43eb3eb8a8a0322981fe16`.
Built with `--publish never`, installed locally, and left running. It remains unsigned and
has not completed the separate clean-machine qualification. The public beta update feed
still returns 404 until release hosting is configured. No hosted CI or public release ran.

## Mid-tone palette correction — 2026-09-17

An installed beta 3 coffee-site run failed in Brand with `light.onAccent on accent is 4.26:1`.
The captured recipe used `#70805D` and a derived `#5C6C49` hover. Starting with white text
failed on the accent; changing only the text failed on hover. The greedy repair could not
cross that intermediate state and incorrectly reported an unrepairable palette.

The generator now chooses white or black text against the immutable accent first, then uses
the existing repair for hover. The original recipe passes through the real Brand parser with
24 color records; its accent remains `#70805D` and hover becomes `#6A7A56`. All 864 combinations
of a 216-color RGB grid, light/dark themes, and quiet/defined surfaces passed. Locked inaccessible
colors still produce an explicit conflict. The new regression failed before the fix and passed
after it. The Design package has 137 passing tests, including the explicit button-text lock.

The user's installed app, running tasks, settings and project files were not changed. This is
a source correction awaiting the next approved app update, not a live retry of the failed site.

## Earlier beta 2 candidate and remaining release checks

`TasteCode-0.1.0-beta.2-win-x64.exe` was built locally with `--publish never`.
Size: 510,237,171 bytes. SHA-256:
`b10bba1b44e43a4ff601639564d7793d414f40e0fa8659e0e72f2dd2afa7fa06`.

This is an unsigned Windows testing candidate, not a published or clean-machine-qualified
release. The existing installer install/uninstall gate requires an isolated hosted Windows
runner and was not bypassed. No hosted CI was dispatched. No macOS artifact was produced on
Windows; macOS packaging and native validation still require Apple Silicon macOS.

The user's current app and active tasks were left running. Existing generated websites were
not edited. New real-provider website runs and final visual acceptance remain with the user;
passing workflow tests does not prove every future model output is visually faithful or smooth.
Public asset redistribution and release approval remain separate gates; no public release or
repository-visibility change was made.
