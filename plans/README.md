# Animation improvement plans

These plans were written against commit `bfc88477`. They are specifications only; product source was
not changed while writing them.

## Plans

| Plan                                              | Title                               | Audit item           | Severity | Status |
| ------------------------------------------------- | ----------------------------------- | -------------------- | -------- | ------ |
| [001](001-stop-composer-height-animation.md)      | Stop animating composer height      | Finding 1            | HIGH     | DONE   |
| [002](002-make-keyboard-search-motion-instant.md) | Make keyboard search motion instant | Finding 2            | HIGH     | DONE   |
| [003](003-remove-model-check-bounce.md)           | Remove the model check bounce       | Finding 3            | HIGH     | DONE   |
| [004](004-remove-fast-mode-bolt-keyframes.md)     | Remove fast-mode bolt keyframes     | Finding 5            | MEDIUM   | DONE   |
| [005](005-stop-effort-slider-width-animation.md)  | Stop animating effort-slider width  | Finding 6            | MEDIUM   | DONE   |
| [006](006-unify-send-control-press-motion.md)     | Unify send-control press motion     | Finding 7            | MEDIUM   | DONE   |
| [007](007-restore-sheet-entry-motion.md)          | Restore sheet entry motion          | Missed opportunity 1 | LOW      | DONE   |
| [008](008-animate-notice-presence.md)             | Animate notice presence             | Missed opportunity 2 | MEDIUM   | DONE   |
| [009](009-explain-terminal-layout-change.md)      | Explain the terminal layout change  | Missed opportunity 3 | MEDIUM   | DONE   |
| [010](010-preserve-reduced-motion-feedback.md)    | Preserve reduced-motion feedback    | Finding 4            | MEDIUM   | DONE   |

## Recommended execution order

Execute `001` through `009` in number order, then execute `010` last.

1. `001` and `002` remove motion from the two highest-frequency paths.
2. `003` through `005` calm and speed up the model picker.
3. `006` makes primary press feedback consistent across app areas.
4. `007` restores occasional sheet entry after `002` removes the dead shared `step-in` references.
5. `008` and `009` add bounded motion to notices and terminal layout changes.
6. `010` integrates the final selectors into one reduced-motion feedback allowlist.

## Dependencies and overlap

- `010` depends on every earlier plan and must remain TODO until `001`–`009` are DONE.
- `002` and `007` both edit the sheet/palette area of `apps/web/src/styles/app.css`; run `002` first.
- `003`, `004`, and `005` all edit the model-selector area of `app.css`; run them in number order.
- `008` and `009` both edit `App.tsx` and `app.css`; run them in number order and keep each change
  in its stated scope.
- No plan may modify the current sidebar work in `Sidebar.tsx`, `sidebar-motion.test.ts`, or
  `sidebar-theme.test.ts` unless its own steps explicitly name that file. Plan `007` tests the sheet
  through sidebar behavior but does not change sidebar source.

After each plan, update only its row and file status from `TODO` to `DONE` after all mechanical and
feel checks pass. Do not mark a plan DONE from static checks alone.
