# 007 — Restore sheet entry motion

- **Status**: DONE
- **Commit**: bfc88477
- **Severity**: LOW
- **Category**: Missed opportunities
- **Estimated scope**: 2 files, about 45 lines

## Problem

Settings, rollback, checkout-discard, welcome, and sidebar-confirm sheets all use `.sheet__panel`.
That rule still names `step-in`, but the keyframes were deleted with the old onboarding flow. The
browser therefore ignores the declaration and every occasional sheet panel appears in one frame.

```css
/* apps/web/src/styles/app.css:669 — current */
.sheet__scrim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  border: 0;
  cursor: default;
  animation: fade-in var(--dur-fast) var(--ease-out);
}
.sheet__panel {
  position: relative;
  width: 100%;
  max-width: 460px;
  max-height: 100%;
  overflow-y: auto;
  background: var(--bg-rail);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-dialog);
  box-shadow: var(--shadow-modal);
  animation: step-in 220ms var(--ease-out);
}
/* There is no @keyframes step-in in current source. */
```

## Target

Give sheets their own centered 220ms entry. Start at opacity 0, `translateY(2px)`, and `scale(0.97)`;
end at the existing final layout. Under reduced motion, keep only the 180ms opacity fade. Do not
restore motion to the keyboard command palette.

```css
/* target */
.sheet__panel {
  animation: sheet-in 220ms var(--ease-out) both;
}

@keyframes sheet-in {
  from {
    opacity: 0;
    transform: translateY(2px) scale(0.97);
  }
}

@media (prefers-reduced-motion: reduce) {
  .sheet__panel {
    animation: fade-in var(--dur-fast) var(--ease-out) both !important;
  }
}
```

## Repo conventions to follow

- Use `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` and `--dur-fast: 180ms` from
  `apps/web/src/styles/tokens.css:204`.
- A modal is centered, so the default center transform origin is correct.
- `apps/web/src/styles/app.css:8174` starts trigger-owned menus at `scale(0.97)`; use the same
  non-zero physical scale here.
- Plan 002 removes dead `step-in` use from keyboard surfaces. Use the new name `sheet-in` only.

## Steps

1. In `apps/web/src/styles/app.css`, change `.sheet__panel` from `step-in` to
   `sheet-in 220ms var(--ease-out) both`.
2. Add the exact `@keyframes sheet-in` block shown in Target beside the sheet rules.
3. Add the exact reduced-motion override shown in Target beside those rules. It must reference
   `fade-in`, not `sheet-in`, and keep `!important` so it overrides the global still-by-default
   duration with a finite opacity-only fade.
4. Add `apps/web/src/styles/sheet-motion.test.ts`. Assert the sheet uses `sheet-in`, the keyframes
   start at `scale(0.97)` and `translateY(2px)`, reduced motion swaps to `fade-in`, and no source uses
   `animation: step-in`.

## Boundaries

- Do NOT change sheet markup, focus traps, scrim behavior, z-index, geometry, or close behavior.
- Do NOT add exit motion in this plan.
- Do NOT apply `sheet-in` to command palette, search, menus, or PR dialogs.
- Do NOT add a dependency.
- If `.sheet__panel` no longer names missing `step-in` after commit `bfc88477`, STOP and report the
  drift. Line-only movement from earlier plans is safe.

## Verification

- **Mechanical**:
  - `pnpm --filter @harness/web exec vitest run src/styles/sheet-motion.test.ts src/ui/Settings.test.tsx src/ui/Sidebar.test.tsx`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
  - Every command must exit 0.
- **Feel check**: Open Settings, rollback history, and one discard confirmation. At normal speed the
  panel must settle quickly from the center with no bounce. At 10% playback it must start at `0.97`,
  not zero. With reduced motion, only opacity may change. Cmd/Ctrl+K must remain instant.
- **Done when**: Every `.sheet__panel` has a working entry, and no keyboard surface gains motion.
