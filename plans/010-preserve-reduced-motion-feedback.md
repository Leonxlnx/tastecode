# 010 — Preserve reduced-motion feedback

- **Status**: DONE
- **Commit**: bfc88477
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: 4 files, about 120 lines

## Problem

The global reduced-motion safety rule changes every animation and transition to `0.01ms`. It stops
movement, but it also removes opacity and color feedback that explains an occasional sheet, notice,
fast-mode state, or send/stop state.

```css
/* apps/web/src/styles/tokens.css:496 — current */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Removing this safety net without explicit replacements would turn many spatial animations back on.
This plan therefore keeps a still-by-default baseline and adds a small, named allowlist for feedback
that uses only opacity, color, fill, background color, border color, or box shadow.

## Target

Keep the universal `0.01ms` and single-iteration defaults for unclassified motion. Add higher-
specificity component overrides for these safe cases only:

```css
/* target: apps/web/src/styles/app.css */
@media (prefers-reduced-motion: reduce) {
  .sheet__scrim,
  .sheet__panel,
  .profile-page,
  .settings__panel {
    animation: fade-in var(--dur-fast) var(--ease-out) both !important;
  }

  .notice {
    transform: none !important;
    transition: opacity var(--dur-fast) var(--ease-out) !important;
  }
  .notice[data-state='closing'] {
    transform: none !important;
    transition-duration: var(--dur-press) !important;
  }

  .model-selector__fast {
    transition:
      color var(--dur-press) var(--ease-out),
      background-color var(--dur-press) var(--ease-out),
      border-color var(--dur-press) var(--ease-out),
      box-shadow var(--dur-press) var(--ease-out) !important;
  }
  .model-selector__fast-icon svg {
    transition: fill var(--dur-press) var(--ease-out) !important;
  }
  .model-selector__fast:active {
    transform: none !important;
  }

  .orb {
    transition:
      background-color var(--dur-press) var(--ease-out),
      box-shadow var(--dur-press) var(--ease-out),
      color var(--dur-press) var(--ease-out) !important;
  }

  .spinner,
  .orb--stop.is-stopping .orb__icon--stop {
    animation: none !important;
  }
}
```

```css
/* target: apps/web/src/ui/pull-requests/pull-requests.css */
@media (prefers-reduced-motion: reduce) {
  .pr-send-button {
    transition:
      background-color var(--dur-press) var(--ease-out),
      box-shadow var(--dur-press) var(--ease-out),
      color var(--dur-press) var(--ease-out) !important;
  }
}
```

The exact 180ms sheet/settings/notice entry and 140ms state feedback come from existing tokens.
Every movement transform remains disabled by component rules from plans 006–009 or by the global
still-by-default duration.

## Repo conventions to follow

- Execute this plan after plans 001–009. It integrates their final selectors and is the only plan
  with a dependency on the full set.
- Keep `--dur-fast: 180ms`, `--dur-press: 140ms`, and
  `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` unchanged.
- Preserve the existing explicit reduced-motion rules for transcript disclosures, workspace rail,
  media viewer, design brief, spinners, menus, and dither canvas.
- Safe feedback never includes transform, rotate, translate, filter, clip-path, layout, or infinite
  animation.

## Steps

1. Complete plans 001–009 first. If any remains TODO, STOP; do not build this allowlist against the
   old selectors.
2. In `apps/web/src/styles/tokens.css`, keep the four universal declarations unchanged. Rewrite the
   comment to state that this is the still-by-default fallback and that component CSS may override it
   only for finite opacity/color feedback.
3. In `apps/web/src/styles/app.css`, consolidate the component reduced-motion blocks added or changed
   by plans 003, 004, 006, 007, 008, and 009. Add the exact safe overrides shown in Target after the
   relevant base rules; higher specificity and `!important` must beat the universal fallback.
4. Ensure sheet/profile/settings reduced motion uses the existing `fade-in` keyframes, which change
   opacity only. Do not use `sheet-in` under reduced motion.
5. Ensure notice reduced motion preserves the plan 008 transition phases but forces transform none.
6. Ensure fast mode preserves only parent color/background/border/shadow and SVG fill. Remove rotate
   and transform from its reduced-motion transition properties, and force its active transform to
   `none`.
7. Ensure the main orb and PR sender preserve only non-spatial state properties. Their active
   transform must remain none under reduced motion from plan 006.
8. Explicitly stop `.spinner` and `.orb--stop.is-stopping .orb__icon--stop`; do not rely only on a
   one-iteration limit for continuous rotation or pulse.
9. In `apps/web/src/ui/pull-requests/pull-requests.css`, add the exact PR sender override shown in
   Target to the existing reduced-motion block.
10. Add `apps/web/src/styles/reduced-motion-feedback.test.ts`. Read `tokens.css`, `app.css`, and PR
    CSS. Assert the universal fallback still exists; assert every allowlisted duration is finite and
    at most `var(--dur-fast)`; assert allowlist transition properties contain no transform, rotate,
    translate, filter, clip-path, width, height, or grid property; assert sheet/settings use only
    `fade-in`; assert notice transform is none; and assert continuous spinner/pulse selectors are
    disabled.

## Boundaries

- Do NOT delete the universal safety fallback in this plan.
- Do NOT re-enable command-palette, chat-search, thread-find, hover-scale, rail, disclosure, streaming
  row, media-viewer, dither, or terminal movement.
- Do NOT add reduced-motion delays, infinite feedback, or a package dependency.
- Do NOT change non-reduced motion values.
- If plans 001–009 are not DONE or their target selectors differ, STOP and report the dependency
  instead of improvising.

## Verification

- **Mechanical**:
  - `pnpm --filter @harness/web exec vitest run src/styles/reduced-motion-feedback.test.ts src/styles/sheet-motion.test.ts src/styles/send-control-motion.test.ts src/ui/NoticePresence.test.tsx src/styles/terminal-motion.test.ts`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
  - Every command must exit 0.
- **Feel check**: Enable reduced motion in DevTools and macOS. Open Settings, change a settings page,
  trigger and dismiss a notice, toggle fast mode, send, stop, and open/close terminal. Sheets and
  notices may fade; fast/send state colors may settle for 140ms. Nothing may move, scale, rotate,
  shimmer, pulse, or slide. Disable reduced motion and confirm the normal plans still behave as
  specified.
- **Done when**: Reduced motion is still by default, keeps a small set of useful finite feedback, and
  has no spatial or continuous motion.
