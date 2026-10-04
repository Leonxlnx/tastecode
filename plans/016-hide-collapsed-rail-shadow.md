# 016 — Hide collapsed rail shadow

- **Status**: DONE
- **Commit**: ef9fd57f
- **Severity**: MEDIUM
- **Category**: responsive layout
- **Estimated scope**: 2 files, under 25 lines

## Problem

At narrow widths the off-screen sidebar still paints its right shadow. Live Electron inspection at
582px showed the rail at `x: -320`, but `box-shadow: 12px 0 30px -18px` left a curved sliver at the
left edge.

```css
/* apps/web/src/styles/app.css:3325 — current */
.rail-slot .rail {
  position: absolute;
  z-index: 1;
  inset: 0 auto 0 0;
  width: min(86vw, 320px);
  box-shadow: var(--shadow-rail);
}
```

## Target

Remove the shadow from the generic narrow rail rule. The existing revealed-state owner remains:

```css
.rail-slot.is-collapsed.is-revealed .rail {
  box-shadow: var(--shadow-rail);
  transform: translateX(0);
}
```

## Repo conventions to follow

- Visibility-state decoration belongs on the explicit `.is-revealed` state.
- The hidden rail remains transform-based and pre-promoted for fast reveal.

## Steps

1. Remove only `box-shadow: var(--shadow-rail)` from the narrow `.rail-slot .rail` rule.
2. Add a sidebar CSS assertion that the narrow base rule has no shadow and the revealed state still has one.

## Boundaries

- Do NOT change rail width, transform, reveal timing, or backdrop behavior.
- Do NOT remove the revealed shadow.
- Do NOT change desktop rail appearance.

## Verification

- **Mechanical**: `./node_modules/.bin/vitest run apps/web/src/styles/sidebar-motion.test.ts apps/web/src/styles/sidebar-theme.test.ts` passes.
- **Feel check**: at 582px in light and dark themes, the closed rail leaves no sliver. Reveal it from
  the edge; the shadow appears only while the drawer is visible and vanishes after retract.
- **Done when**: hidden computed `box-shadow` is `none` and revealed computed shadow uses `--shadow-rail`.
