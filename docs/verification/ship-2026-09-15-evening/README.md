# Evening local delivery — 2026-09-15

## Merged changes

- [#1152](https://github.com/Leonxlnx/tastecode/pull/1152): SQLite startup warning.
- [#1154](https://github.com/Leonxlnx/tastecode/pull/1154): medium-weight sidebar chat titles.
- [#1155](https://github.com/Leonxlnx/tastecode/pull/1155): centered theme cards.
- [#1156](https://github.com/Leonxlnx/tastecode/pull/1156): real request in the appearance code preview.
- [#1157](https://github.com/Leonxlnx/tastecode/pull/1157): custom accent and background colors.

## Local checks

Each change passed pnpm lint, pnpm typecheck, pnpm test, and pnpm build. Later runs used VITEST_MAX_WORKERS=2 to avoid CPU contention in the Shiki grammar test. The unrestricted theme-card test run failed that unrelated token assertion; the focused test and complete bounded run passed. No hosted CI was started.

## Live checks

A separate macOS Electron app, server data folder, browser profile, and loopback ports were used. SQLite created and read a database record and kept unrelated warnings visible. Before-and-after screenshots show chat-title weight, theme-card layout, and preview text. Custom colors accepted valid hex input, rejected invalid input, selected presets, supported arrow-key changes, and survived a full application restart.

The custom-color integration required two small corrections: the app test now uses the new picker, and circle radii use the shared CSS token.

## Source accounting

The starting snapshot contained 23 changed files. Every starting source file matches the assembled delivery, except the intentional circle-token correction. The app test correction and screenshots are additional validation changes. Original files and worktree metadata were unchanged at the equivalence check. Rust and mobile worktrees were excluded.

## Pending live check

[#1153](https://github.com/Leonxlnx/tastecode/pull/1153) restores native macOS title-bar drag regions. All four checks passed on current main. A real window-drag result is still needed: the UI tool emitted a native move warning and did not change window bounds. The source edits remain preserved.
