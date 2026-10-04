# 015 — Fill the workspace row

- **Status**: DONE
- **Commit**: ef9fd57f
- **Severity**: HIGH
- **Category**: responsive layout
- **Estimated scope**: 4 files, about 80 lines moved or tested

## Problem

On a new chat before a workspace panel mounts, `.workspace-layout` creates an implicit grid row that
shrink-wraps its only child. Live Electron geometry measured a 691px workspace but a 289px stage, so
the composer sits near the top with a large dead area below. The first attempted fix added an explicit
row to `workspace-panel.css`, but a clean Electron reload still computed `display: block` and
`grid-template-rows: none`. That file belongs to the lazy workspace-panel chunk and is not loaded on
the normal chat path. The always-mounted layout therefore cannot depend on it for base CSS.

```css
/* apps/web/src/ui/workspace-panel.css:4 — current, but lazy */
.workspace-layout {
  position: relative;
  display: grid;
  width: 100%;
  height: 100%;
  grid-template-columns: minmax(0, 1fr) 0px;
}
```

## Target

Move all `.workspace-layout` and `.workspace-layout > .stage` rules that govern the always-mounted
App shell from lazy `workspace-panel.css` into always-loaded `app.css`. Keep the explicit row track:

```css
.workspace-layout {
  grid-template-columns: minmax(0, 1fr) 0px;
  grid-template-rows: minmax(0, 1fr);
}
```

The stage must fill the available height with or without a mounted/open workspace panel.

## Repo conventions to follow

- `apps/web/src/main.tsx` always imports `app.css`; `workspace-panel.css` remains lazy by design.
- The child `.stage` already uses `min-height: 0` and owns internal rows in `app.css`.
- Use `minmax(0, 1fr)` to keep nested overflow bounded.

## Steps

1. Move the base `.workspace-layout`, `.workspace-layout.is-panel-open`,
   `.workspace-layout.is-panel-expanded`, `.workspace-layout > .stage`, and expanded-stage rules from
   `apps/web/src/ui/workspace-panel.css` to `apps/web/src/styles/app.css` without changing values.
2. Move the responsive `max-width: 900px` layout/stage overrides and the reduced-motion stage rule to
   `app.css`. Leave workspace-panel-only rules in the lazy file.
3. Keep `grid-template-rows: minmax(0, 1fr)` on the always-loaded base rule.
4. Update `workspace-panel-motion.test.ts` and `workspace-panel-layout.test.ts` to read the layout
   contract from `app.css` and assert that lazy `workspace-panel.css` no longer owns `.workspace-layout`.

## Boundaries

- Do NOT change Composer offsets or add viewport-height calculations.
- Do NOT change workspace panel widths.
- Do NOT add animation to the row track.
- Do NOT eagerly load the full workspace-panel stylesheet.

## Verification

- **Mechanical**: `./node_modules/.bin/vitest run apps/web/src/styles/workspace-panel-motion.test.ts apps/web/src/ui/workspace-panel-layout.test.ts` passes.
- **Feel check**: at wide and 582px widths, start a new chat. The stage fills the window and the composer
  is near vertical center. Open and close the workspace panel and terminal; no content jumps out of bounds.
- **Done when**: on a clean reload before the workspace panel has ever opened, computed
  `.workspace-layout` is `display: grid`, its row is the full available height, and `.stage` and
  `.workspace-layout` heights match within one CSS pixel.
