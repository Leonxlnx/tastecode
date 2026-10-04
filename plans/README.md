# Animation improvement plans

Plans `001`–`010` were written against commit `bfc88477`. Plans `011`–`019` were written against
commit `ef9fd57f` after live Electron checks of the `feat/perf-impr` worktree.

## Plans

| Plan                                                | Title                                 | Audit item             | Severity | Status |
| --------------------------------------------------- | ------------------------------------- | ---------------------- | -------- | ------ |
| [001](001-stop-composer-height-animation.md)        | Stop animating composer height        | Finding 1              | HIGH     | DONE   |
| [002](002-make-keyboard-search-motion-instant.md)   | Make keyboard search motion instant   | Finding 2              | HIGH     | DONE   |
| [003](003-remove-model-check-bounce.md)             | Remove the model check bounce         | Finding 3              | HIGH     | DONE   |
| [004](004-remove-fast-mode-bolt-keyframes.md)       | Remove fast-mode bolt keyframes       | Finding 5              | MEDIUM   | DONE   |
| [005](005-stop-effort-slider-width-animation.md)    | Stop animating effort-slider width    | Finding 6              | MEDIUM   | DONE   |
| [006](006-unify-send-control-press-motion.md)       | Unify send-control press motion       | Finding 7              | MEDIUM   | DONE   |
| [007](007-restore-sheet-entry-motion.md)            | Restore sheet entry motion            | Missed opportunity 1   | LOW      | DONE   |
| [008](008-animate-notice-presence.md)               | Animate notice presence               | Missed opportunity 2   | MEDIUM   | DONE   |
| [009](009-explain-terminal-layout-change.md)        | Explain the terminal layout change    | Missed opportunity 3   | MEDIUM   | DONE   |
| [010](010-preserve-reduced-motion-feedback.md)      | Preserve reduced-motion feedback      | Finding 4              | MEDIUM   | DONE   |
| [011](011-own-model-search-styles.md)               | Own model-search styles               | Live visual finding 1  | HIGH     | DONE   |
| [012](012-warm-model-selector-on-intent.md)         | Warm model picker on intent           | Live latency finding 1 | HIGH     | DONE   |
| [013](013-remove-unneeded-icon-transform-motion.md) | Remove unneeded icon transform motion | Motion finding 1       | MEDIUM   | DONE   |
| [014](014-gate-hover-reveals.md)                    | Gate hover reveals                    | Input finding 1        | MEDIUM   | DONE   |
| [015](015-fill-workspace-row.md)                    | Fill the workspace row                | Live layout finding 1  | HIGH     | DONE   |
| [016](016-hide-collapsed-rail-shadow.md)            | Hide collapsed rail shadow            | Live layout finding 2  | MEDIUM   | DONE   |
| [017](017-keep-layout-motion-on-compositor.md)      | Keep layout motion on compositor      | Motion finding 2       | HIGH     | DONE   |
| [018](018-restore-hover-selection-sync.md)          | Restore hover selection sync          | Interaction finding 1  | HIGH     | DONE   |
| [019](019-render-prepared-surfaces-directly.md)     | Render prepared surfaces directly     | Live latency finding 2 | HIGH     | DONE   |

## Recommended execution order

Plans `001`–`019` are complete. Their execution order was:

1. `001` and `002` remove motion from the two highest-frequency paths.
2. `003` through `005` calm and speed up the model picker.
3. `006` makes primary press feedback consistent across app areas.
4. `007` restores occasional sheet entry after `002` removes the dead shared `step-in` references.
5. `008` and `009` add bounded motion to notices and terminal layout changes.
6. `010` integrates the final selectors into one reduced-motion feedback allowlist.
7. `011` fixes the raw native search control before any timing work is judged.
8. `012` warms the lazy model picker without moving it into the startup bundle.
9. `013` and `014` remove broad icon movement and touch-sticky hover states.
10. `015` and `016` repair the two measured layout defects.
11. `017` keeps sidebar and workspace motion on compositor properties.
12. `018` restores pointer-selection sync after the audit regression.
13. `019` applies the proven resolved-component warm path to terminal and workspace surfaces.

## Dependencies and overlap

- `010` depended on every earlier plan and ran after `001`–`009` were DONE.
- `002` and `007` both edit the sheet/palette area of `apps/web/src/styles/app.css`; run `002` first.
- `003`, `004`, and `005` all edit the model-selector area of `app.css`; run them in number order.
- `008` and `009` both edit `App.tsx` and `app.css`; run them in number order and keep each change
  in its stated scope.
- No plan may modify the current sidebar work in `Sidebar.tsx`, `sidebar-motion.test.ts`, or
  `sidebar-theme.test.ts` unless its own steps explicitly name that file. Plan `007` tests the sheet
  through sidebar behavior but does not change sidebar source.
- `011` must finish before `012` so the first-open timing check sees the final search control.
- `013` and `014` both edit `apps/web/src/styles/app.css`; run them in number order.
- `015` and `017` both edit `apps/web/src/ui/workspace-panel.css`; run them in number order.
- `016` and `017` both test sidebar CSS; keep their assertions separate.
- `018` restores interaction semantics only. Do not use it to add hover animation.
- `019` follows `012` and reuses its resolved-component pattern without changing startup timing.

All plans are DONE after mechanical checks and live Electron feel checks.
