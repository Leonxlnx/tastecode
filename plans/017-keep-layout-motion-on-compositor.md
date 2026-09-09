# 017 — Keep layout motion on compositor

- **Status**: DONE
- **Commit**: ef9fd57f
- **Severity**: HIGH
- **Category**: render performance
- **Estimated scope**: 4 files, about 35 lines reviewed or tested

## Problem

Animating `grid-template-columns` makes Chromium perform layout on each frame when the sidebar or
workspace panel changes. Audit edits removed those track transitions; the child rail and panel already
provide transform/opacity motion and must remain the only animated path.

```css
/* apps/web/src/styles/app.css:25 — current corrected boundary */
.shell__body {
  display: grid;
  grid-template-columns: var(--rail-w) 1fr;
  /* The rail slides on its own layer; the grid itself snaps. */
}
```

```css
/* apps/web/src/ui/workspace-panel.css:4 — current corrected boundary */
.workspace-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 0px;
}
```

## Target

Keep both grid track changes instant. Preserve sidebar motion on `.rail { transform: translateX(...) }`
and workspace motion on `.workspace-panel { opacity; transform: translate3d(...) }`. Do not animate
width, grid tracks, left/right/top/bottom, or height for these two interactions.

## Repo conventions to follow

- Existing motion tokens remain `--dur-slow`, `--dur-reveal`, `--ease-rail`, and `--ease-out`.
- `sidebar-motion.test.ts` and `workspace-panel-motion.test.ts` are the CSS performance contracts.

## Steps

1. Keep `grid-template-columns` transitions absent from `.shell__body` and `.workspace-layout`.
2. Keep rail reveal transitions limited to transform.
3. Keep workspace panel transitions limited to opacity, transform, and delayed visibility.
4. Keep or strengthen the two static tests so future edits cannot restore layout-bound transitions.

## Boundaries

- Do NOT remove visible rail/panel motion.
- Do NOT change widths or responsive breakpoints.
- Do NOT add `will-change` to broad containers.

## Verification

- **Mechanical**: `./node_modules/.bin/vitest run apps/web/src/styles/sidebar-motion.test.ts apps/web/src/styles/workspace-panel-motion.test.ts apps/web/src/styles/reduced-motion-feedback.test.ts` passes.
- **Feel check**: repeatedly collapse/reveal the sidebar and open/close the workspace panel. The child
  surface glides while surrounding layout snaps once. Reduced motion removes the glide.
- **Done when**: a 120Hz requestAnimationFrame trace has no frame over 16.7ms in the tested interaction
  and computed transitions contain no grid-track property.
